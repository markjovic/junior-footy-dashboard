#!/usr/bin/env node
// scripts/probe-registration-budget.js
//
// Two measurements the registrations walker (registrations_design.md §8) needs
// before its constants are set. READ-ONLY: no writes, no commits.
//
// 1. THE CALL BUDGET FOR publicProfileTeams. The rate limit is per-operation
//    (discoverGrade did not trip at volumes that blocked discoverGame), so the
//    1.5 req/s figure measured for discoverGame on 2026-09-05 may not apply here.
//    Method: fire publicProfileTeams sequentially with NO pacing until the WAF
//    blocks, and count. lib/playhq.js absorbs a block with a fixed 80 s wait and
//    retries, so the block itself is seen through the exported counters — the
//    `blocked` counter ticks during the call that hit it. After the wait the run
//    continues into a second window so the count can be compared: a similar
//    second number means a budget that refills; a much smaller one means the
//    first block shortens the next window.
//
//    ⚠️ Recovery time is NOT measured here. The library waits a flat 80 s, so
//    anything this script timed would read 80 s by construction. The measured
//    figure stays 76–77 s (2026-09-05).
//
// 2. PRE-SEASON RECORDS, if any exist. Every registration returned whose season
//    status is not COMPLETED or ACTIVE is printed RAW — the first look at what a
//    registration looks like before a club assigns teams. Expected answer in
//    September: none. Then, for each such season (up to five),
//    discoverTeams(filter:{seasonID}) — does an UPCOMING season return teams at
//    all before assignment? The club trigger in the design relies on the answer.
//
//    ⚠️ The discoverTeams field selection is taken from the fields
//    playhq_api_reference_updates.md §6 describes (id, name, grade, organisation),
//    not from a query text in the docs. A rejected field fails the whole query;
//    if that happens the error body is printed and measurement 2b is recorded as
//    NOT MEASURED rather than guessed.
//
// MODES (PROBE_MODE)
//   budget    (default) measurement 1 then 2a/2b — the 2026-09-07 run; ~800 calls
//   upcoming  SKIPS measurement 1 (the budget is known: 147 unpaced calls, then
//             a block; 100 per 80 s runs clean). Asks discoverTeams for EVERY
//             manifest season whose state is upcoming — no player sample needed —
//             and samples PROBE_MAX players paced at 100/80 s for raw pre-season
//             records. This is the mode to run the morning a 2027 season appears.
//
// USAGE
//   PROBE_COMP="WFNL 2026" node scripts/probe-registration-budget.js
//   PROBE_MODE=upcoming PROBE_MAX=300 node scripts/probe-registration-budget.js
//
// ⚠️ THE BUDGET IS SHARED ACROSS RUNS. Do not dispatch this within a few minutes
// of discovery or a results run, and expect the next PlayHQ run after it to open
// with a block.
//
// Exit 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-registration-budget v2 2026-09-10 upcoming-mode';

const fs = require('fs');
const store = require('./lib/store');
const { gqlPost, summary, logSummary } = require('./lib/playhq');

const COMP    = (process.env.PROBE_COMP || 'WFNL 2026').trim();
const MAX     = Math.max(50, Math.min(2000, Number(process.env.PROBE_MAX || 600)));
const WINDOWS = Math.max(1, Math.min(4, Number(process.env.PROBE_WINDOWS || 2)));
const RAW_LIMIT = 10;
const MODE = (process.env.PROBE_MODE || 'budget').trim() === 'upcoming' ? 'upcoming' : 'budget';
// Pacing for upcoming mode only: the known-safe 100 calls per 80 s.
const PACE_N = 100, PACE_MS = 80000;
const paceTimes = [];
async function pace() {
  const now = Date.now();
  while (paceTimes.length && now - paceTimes[0] >= PACE_MS) paceTimes.shift();
  if (paceTimes.length >= PACE_N) { await new Promise(r => setTimeout(r, PACE_MS - (now - paceTimes[0]) + 5)); return pace(); }
  paceTimes.push(Date.now());
}

// Same shape probe-preseason-roster.js v2 used successfully on afl 2026-09-04.
const Q_PROFILE = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    ... on DiscoverTeam {
      id
      name
      season { id name startDate endDate status { value } competition { id name } }
      organisation { id name }
    }
  }
}`;

const Q_TEAMS = `query DiscoverTeams($seasonID: ID!) {
  discoverTeams(filter: { seasonID: $seasonID }) {
    id
    name
    grade { id name }
    organisation { id name }
  }
}`;

const nowMs = () => Date.now();

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log(`READ-ONLY — no writes, no commits. mode: ${MODE}\n`);

  const data = store.load([COMP], { players: true });
  const seen = new Set();
  const uuids = [];
  for (const p of data.players || []) {
    if (p.uuid && !seen.has(p.uuid)) { seen.add(p.uuid); uuids.push(p.uuid); }
  }
  if (!uuids.length) {
    console.error(`No player uuids for "${COMP}". Set PROBE_COMP to a season that has players.`);
    process.exit(1);
  }
  console.log(`${uuids.length} distinct people in ${COMP}; firing up to ${MAX} calls, ` +
    `stopping after ${WINDOWS} block(s) or when the list runs out.\n`);

  let knownSeasons = new Set();
  let upcomingSeasons = [];
  try {
    const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
    knownSeasons = new Set((core.manifest || []).map(m => m.seasonId).filter(Boolean));
    upcomingSeasons = (core.manifest || []).filter(m => m.seasonId && m.state === 'upcoming');
  } catch (e) {
    console.warn(`⚠️ manifest unreadable (${e.message}) — tracked/untracked split will be wrong`);
  }
  if (MODE === 'upcoming') {
    console.log(`manifest seasons with state=upcoming: ${upcomingSeasons.length}` +
      (upcomingSeasons.length ? ' — ' + upcomingSeasons.map(m => `${m.seasonId} ${m.compName || m.orgName + ' ' + m.seasonName}`).join(', ') : ''));
    if (!upcomingSeasons.length) console.log('  (none — discovery has not recorded a 2027 season yet; 2b will read NOT MEASURED)');
    console.log('');
  }

  // ── Measurement 1: calls to block ─────────────────────────────────────────
  const windows = [];          // { calls, seconds, rate }
  let windowCalls = 0;
  let windowStart = nowMs();
  let blockedSeen = summary().blocked;
  let answered = 0, notFound = 0, errored = 0, registrations = 0;
  const byStatus = new Map();
  const preSeason = [];        // raw records whose status is not COMPLETED/ACTIVE
  const preSeasonIds = new Map(); // seasonId -> label

  for (let i = 0; i < Math.min(MAX, uuids.length); i++) {
    if (MODE === 'upcoming') await pace();
    const before = summary().blocked;
    let json;
    try { json = await gqlPost(Q_PROFILE, { profileID: uuids[i] }, 'PublicProfileTeams'); }
    catch (e) { errored++; }
    const after = summary().blocked;

    if (after > before) {
      // The block landed inside this call. The calls BEFORE it are the window.
      const secs = (nowMs() - windowStart - 80000 * (after - before)) / 1000;
      windows.push({ calls: windowCalls, seconds: Math.max(0, secs) });
      console.log(`  BLOCK after ${windowCalls} unpaced call(s) in ${Math.max(0, secs).toFixed(0)}s ` +
        `(${(windowCalls / Math.max(1, secs)).toFixed(1)} req/s while it lasted)`);
      windowCalls = 0;
      windowStart = nowMs();
      blockedSeen = after;
      if (windows.length >= WINDOWS) { if (json) tally(json); break; }
    }
    windowCalls++;
    if (json) tally(json);
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1} calls — answered ${answered}, not found ${notFound}, errors ${errored}`);
  }

  function tally(json) {
    if (json.errors && json.errors.length) {
      if (/NOT_FOUND|failed to find profile/i.test(String(json.errors[0].message || ''))) notFound++;
      else errored++;
      return;
    }
    answered++;
    for (const t of json?.data?.publicProfileTeams || []) {
      registrations++;
      const st = t.season?.status?.value || '(none)';
      byStatus.set(st, (byStatus.get(st) || 0) + 1);
      if (st !== 'COMPLETED' && st !== 'ACTIVE') {
        if (preSeason.length < RAW_LIMIT) preSeason.push(t);
        if (t.season?.id) preSeasonIds.set(t.season.id,
          `${t.season?.competition?.name || '?'} ${t.season?.name || '?'} [${st}]` +
          (knownSeasons.has(t.season.id) ? ' TRACKED' : ''));
      }
    }
  }

  // An unfinished window still says something: "N calls and no block".
  const openWindow = windowCalls;

  console.log('\nMEASUREMENT 1 — publicProfileTeams call budget');
  console.log('─'.repeat(72));
  if (MODE === 'upcoming') {
    console.log(`  SKIPPED — paced at ${PACE_N}/${PACE_MS / 1000}s; the budget was measured 2026-09-07 (147 unpaced, then a block).`);
    if (windows.length) console.log(`  ⚠️ yet ${windows.length} block(s) occurred at that pace — the budget has CHANGED; re-run in budget mode.`);
  } else if (!windows.length) {
    console.log(`  ${openWindow} unpaced call(s) in ${((nowMs() - windowStart) / 1000).toFixed(0)}s and NO block.`);
    console.log('  Either the budget for this operation exceeds the calls made, or the');
    console.log('  latency alone kept the rate under it. Raise PROBE_MAX before concluding.');
  } else {
    windows.forEach((w, i) => console.log(`  window ${i + 1}: ${w.calls} calls before the block, ${w.seconds.toFixed(0)}s`));
    if (openWindow) console.log(`  then ${openWindow} more call(s) after the last block, unblocked when the run stopped`);
    const first = windows[0].calls;
    console.log(`\n  discoverGame measured 108–150 (2026-09-05). This operation: ${windows.map(w => w.calls).join(', ')}.`);
    if (windows.length > 1) {
      const ratio = windows[1].calls / Math.max(1, first);
      console.log(ratio > 0.7
        ? '  Second window similar to the first — a budget that refills after the block.'
        : '  Second window much shorter — the first block shortens the next; pace conservatively.');
    }
    console.log(`  Walker constant to set: ≤ ${Math.floor(Math.min(...windows.map(w => w.calls)) * 0.75)} calls per 80s.`);
  }
  console.log(`\n  answered ${answered}  not found ${notFound}  errors ${errored}  registrations ${registrations}` +
    (answered ? ` (${(registrations / answered).toFixed(1)} per player)` : ''));
  if (byStatus.size) {
    console.log('  season status of every registration returned:');
    for (const [k, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(6)}  ${k}`);
  }

  // ── Measurement 2: pre-season records ─────────────────────────────────────
  console.log('\nMEASUREMENT 2a — registrations in a season that is neither COMPLETED nor ACTIVE');
  console.log('─'.repeat(72));
  if (!preSeason.length) {
    console.log('  None. Expected in September: no 2027 season exists yet. Re-run once one does;');
    console.log('  that run is the first look at a pre-assignment record.');
  } else {
    console.log(`  ${preSeasonIds.size} such season(s); first ${preSeason.length} record(s) RAW:`);
    for (const t of preSeason) console.log('  ' + JSON.stringify(t));
    console.log('\n  What to read off them: is `name` the club name (registered, unassigned),');
    console.log('  a team name (assigned), or something else; is `organisation` the club.');
  }

  // In upcoming mode the manifest's upcoming seasons are asked directly, whether
  // or not any sampled player has registered in them.
  for (const m of upcomingSeasons) if (!preSeasonIds.has(m.seasonId)) {
    preSeasonIds.set(m.seasonId, `${m.compName || m.orgName + ' ' + m.seasonName} [manifest: upcoming] TRACKED`);
  }
  console.log('\nMEASUREMENT 2b — does discoverTeams return teams for such a season?');
  console.log('─'.repeat(72));
  if (!preSeasonIds.size) {
    console.log('  NOT MEASURED — no such season to ask about.');
  } else {
    let n = 0;
    for (const [sid, label] of preSeasonIds) {
      if (n++ >= 5) break;
      let json;
      try { json = await gqlPost(Q_TEAMS, { seasonID: sid }, 'DiscoverTeams'); }
      catch (e) { console.log(`  ${sid} ${label}: call failed — ${e.message}`); continue; }
      if (json.errors && json.errors.length) {
        console.log(`  ${sid} ${label}: NOT MEASURED — query rejected: ${String(json.errors[0].message).slice(0, 200)}`);
        continue;
      }
      const teams = json?.data?.discoverTeams || [];
      const orgs = new Set(teams.map(t => t.organisation?.id).filter(Boolean));
      const graded = teams.filter(t => t.grade?.id).length;
      console.log(`  ${sid} ${label}: ${teams.length} team(s), ${graded} with a grade, ${orgs.size} club(s)`);
      for (const t of teams.slice(0, 5)) {
        console.log(`      ${t.name}  grade=${t.grade?.name || '-'}  org=${t.organisation?.id || '-'} ${t.organisation?.name || ''}`);
      }
      if (!teams.length) console.log('      → no teams yet: the club trigger will see this season go from 0 to N when clubs assign.');
    }
  }

  if (typeof logSummary === 'function') logSummary('probe-registration-budget');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
