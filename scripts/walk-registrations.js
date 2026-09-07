#!/usr/bin/env node
// scripts/walk-registrations.js
//
// Where is each of our players for NEXT season? registrations_design.md (v2,
// approved 2026-09-07). One call per person — publicProfileTeams(profileID) —
// walked as a DAILY SLICE of the cohort, not a sweep:
//
//   cohort   every distinct person in the most recent season WITH A PLAYERS FILE
//            of each tracked competition (the 2026 files today; a 2027 UPCOMING
//            entry has no file and is never the cohort season)
//   due      never checked; or checked 7+ days ago with no tracked registration
//            found; or checked 28+ days ago with one found (the transfer check);
//            or flagged by the club trigger
//   budget   ceil(cohort / 7) calls per run, and a wall-clock cap — the remainder
//            simply rolls to tomorrow, in due order
//   pace     100 calls per 80 s. Measured 2026-09-07: this operation blocks at
//            ~147 unpaced calls (2.07 req/s) and runs clean at 1.88 req/s; the
//            WAF rule is a RATE over about a minute, not a count. 75/min is 40%
//            under the lowest reading. playhq_api_reference_updates.md §12.
//
// THE CLUB TRIGGER. Registration is to a club; the team is assigned later. Each
// run makes one discoverTeams(filter:{seasonID}) call per UPCOMING tracked season
// and counts teams per club. A club whose count has RISEN since the last run has
// started assigning, so every cohort player whose club that was is marked due
// now. ⚠️ The player's club comes from the API, not from core.json's teamClub /
// teamOrg maps: those are keyed on a differently normalised team name and resolve
// only ~60% of a cohort (measured WFNL 2026: 4,688 of 7,675). Each profile
// response carries the player's OWN cohort-season registration, whose
// organisation is the club — harvested into `from.club` before that record is
// dropped as already stored.
//
// STORAGE. data/registrations.json, written whole by this script and nothing
// else. Not core.json (a walk must never touch the manifest), not a season file
// (never in a results run's checkout).
//
// WHICH REGISTRATIONS ARE "NEXT SEASON". v1 kept any season whose startDate was
// after the cohort season's startDate. Measured on the first real run
// (2026-09-07, 5,714 answers, no 2027 season in existence): 62 "next-season
// tracked" and 1,145 "outside" registrations, every one of them ACTIVE — they were
// CONCURRENT seasons. EFNL 2026 starts 2025-10-01, so a school or VAFA season
// starting April 2026 read as "later". v2 keeps a season only if it starts AFTER
// THE COHORT SEASON ENDS (startDate > endDate, both from the manifest), which
// excludes anything overlapping. Never year against year: an AFL season's
// startDate precedes the year in its name.
//
// FILE_VERSION 2 marks that rule. A version-1 file is migrated on load: every
// record that stored a tracked or other registration is made due again so the
// walk re-decides it under the new rule; harvested clubs are kept.
//
// Exit codes: 0 = changed, commit. 2 = nothing changed. 1 = fatal.
//
// Env: WALK_TIME_BUDGET_MS (default 100 min), WALK_RATE / WALK_WINDOW_MS (the
// token bucket, defaults 100 / 80000), WALK_DAILY_FRACTION (default 7).

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');

const VERSION = 'walk-registrations v3 2026-09-07 other-dates';
const FILE_VERSION = 2;

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'registrations.json');

const RECHECK_UNFOUND_DAYS = 7;
const RECHECK_FOUND_DAYS = 28;
const DAILY_FRACTION = Math.max(1, Number(process.env.WALK_DAILY_FRACTION || 7));
const TIME_BUDGET_MS = Number(process.env.WALK_TIME_BUDGET_MS || 100 * 60 * 1000);
const RATE = Math.max(1, Number(process.env.WALK_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.WALK_WINDOW_MS || 80000));
const RAW_UPCOMING_LIMIT = 10;
const DAY_MS = 86400000;

// Same shape probe-preseason-roster.js and probe-registration-budget.js used
// successfully on afl. No wrapper; inline fragment; ID!.
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

// ⚠️ Field selection from playhq_api_reference_updates.md §6's description, not
// from a measured query text. A rejected field fails the whole query; the club
// trigger then logs it and skips — the weekly re-check still covers assignment.
const Q_TEAMS = `query DiscoverTeams($seasonID: ID!) {
  discoverTeams(filter: { seasonID: $seasonID }) {
    id
    name
    organisation { id name }
  }
}`;

const log = (...a) => console.log(...a);

// ISO timestamps this script wrote itself. Parsed by parts — never new Date(str).
function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(String(iso || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0));
}
const isoAt = (ms) => new Date(ms).toISOString();

// ── Token bucket: at most RATE calls in any rolling WINDOW_MS ────────────────
const callTimes = [];
async function pace() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] >= WINDOW_MS) callTimes.shift();
  if (callTimes.length >= RATE) {
    const wait = WINDOW_MS - (now - callTimes[0]) + 5;
    await sleep(wait);
    return pace();
  }
  callTimes.push(Date.now());
}

// ── Cohort ────────────────────────────────────────────────────────────────────
// Per organisation: the tracked manifest entry with the greatest startDate that
// has a players file. Returns [{ seasonId, compName, org, startDate }].
function cohortSeasons(manifest) {
  const byOrg = new Map();
  for (const m of manifest) {
    if (!m.compName || !m.seasonId || !m.org) continue;
    if (!fs.existsSync(path.join(store.SEASONS_DIR, `${m.seasonId}-players.json`))) continue;
    const cur = byOrg.get(m.org);
    if (!cur || String(m.startDate || '') > String(cur.startDate || '')) byOrg.set(m.org, m);
  }
  return [...byOrg.values()].map(m => ({
    seasonId: m.seasonId, compName: m.compName, org: m.org,
    startDate: m.startDate || '', endDate: m.endDate || '',
  }));
}

function loadRegistrations() {
  if (!fs.existsSync(OUT_PATH)) {
    return { meta: { version: 1, walkedAt: null, cohortSeasons: [], clubTeams: {} }, players: {} };
  }
  const r = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  r.meta = r.meta || { version: 1 };
  r.meta.clubTeams = r.meta.clubTeams || {};
  r.players = r.players || {};
  if ((r.meta.version || 1) < FILE_VERSION) {
    let redo = 0;
    for (const rec of Object.values(r.players)) {
      if ((rec.tracked && rec.tracked.length) || (rec.other && rec.other.length)) {
        rec.tracked = []; rec.other = []; rec.nextCheck = null; redo++;
      }
    }
    log(`migrated registrations.json v${r.meta.version || 1} -> v${FILE_VERSION}: ${redo} record(s) with a stored registration made due again`);
    r.meta.version = FILE_VERSION;
  }
  return r;
}

// Why a player is due, or null. Triggered players sort first, then never-checked,
// then by nextCheck.
function dueKey(rec, nowMs) {
  if (rec.triggered) return 0;
  if (!rec.at) return 1;
  const nc = parseIso(rec.nextCheck);
  if (nc === null || nc <= nowMs) return 2 + (nc === null ? 0 : nc);
  return null;
}

async function main() {
  const startMs = Date.now();
  const NOW = isoAt(startMs);
  log(`=== ${VERSION} ===`);
  log(`today: ${NOW.slice(0, 10)}  pace: ${RATE} calls / ${WINDOW_MS / 1000}s  time budget: ${Math.round(TIME_BUDGET_MS / 60000)} min`);

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = core.manifest || [];
  const manifestById = new Map(manifest.filter(m => m.seasonId).map(m => [m.seasonId, m]));

  const cohort = cohortSeasons(manifest);
  if (!cohort.length) {
    log('No tracked season has a players file — nothing to walk.');
    process.exit(2);
  }
  for (const c of cohort) log(`  cohort season ${c.seasonId} ${c.compName} (from ${c.startDate})`);
  const cohortById = new Map(cohort.map(c => [c.seasonId, c]));

  const reg = loadRegistrations();
  // "Changed" means the players or the club counts moved — not the run stamp.
  const canon = (r) => JSON.stringify({ meta: { ...r.meta, walkedAt: undefined, lastRun: undefined, people: undefined }, players: r.players });
  const before = canon(reg);

  // Merge the cohort into the file. A person in two cohort seasons keeps the one
  // with the later startDate.
  let added = 0;
  for (const c of cohort) {
    const data = store.load([c.compName], { players: true });
    for (const p of data.players || []) {
      if (!p.uuid) continue;
      const cur = reg.players[p.uuid];
      if (!cur) {
        reg.players[p.uuid] = { name: p.name || null, at: null, nextCheck: null,
          from: { seasonId: c.seasonId, compName: c.compName, club: null, clubName: null }, tracked: [], other: [] };
        added++;
      } else if (!cur.from || String(cohortById.get(cur.from.seasonId)?.startDate || '') < c.startDate) {
        cur.from = { ...(cur.from || {}), seasonId: c.seasonId, compName: c.compName };
      }
    }
  }
  const people = Object.keys(reg.players).length;
  log(`cohort: ${people} people (${added} new to the file)`);

  // ── Club trigger ────────────────────────────────────────────────────────────
  const upcoming = manifest.filter(m => m.compName && m.seasonId && m.state === 'upcoming');
  let triggered = 0;
  for (const s of upcoming) {
    await pace();
    let json;
    try { json = await gqlPost(Q_TEAMS, { seasonID: s.seasonId }, 'DiscoverTeams'); }
    catch (e) { log(`  club trigger ${s.compName}: call failed — ${e.message}`); continue; }
    if (json.errors && json.errors.length) {
      log(`  club trigger ${s.compName}: query rejected — ${String(json.errors[0].message).slice(0, 160)}`);
      continue;
    }
    const counts = {};
    for (const t of json?.data?.discoverTeams || []) {
      const o = t.organisation?.id;
      if (o) counts[o] = (counts[o] || 0) + 1;
    }
    const prev = reg.meta.clubTeams[s.seasonId] || {};
    const risen = Object.keys(counts).filter(o => (counts[o] || 0) > (prev[o] || 0));
    log(`  club trigger ${s.compName}: ${Object.values(counts).reduce((a, b) => a + b, 0)} team(s) across ${Object.keys(counts).length} club(s); ${risen.length} club(s) with more teams than last run`);
    if (risen.length) {
      const set = new Set(risen);
      for (const rec of Object.values(reg.players)) {
        if (rec.from?.club && set.has(rec.from.club) && !rec.triggered) { rec.triggered = true; triggered++; }
      }
      for (const o of risen.slice(0, 10)) log(`      ${o} ${core.clubs?.[o]?.name || ''}: ${prev[o] || 0} -> ${counts[o]}`);
    }
    reg.meta.clubTeams[s.seasonId] = counts;
  }
  if (!upcoming.length) log('  club trigger: no upcoming tracked season — skipped');
  if (triggered) log(`  ${triggered} player(s) marked due by the club trigger`);

  // ── Selection ───────────────────────────────────────────────────────────────
  const due = [];
  let neverChecked = 0, unfoundDue = 0, foundDue = 0;
  for (const [uuid, rec] of Object.entries(reg.players)) {
    const k = dueKey(rec, startMs);
    if (k === null) continue;
    due.push({ uuid, rec, k });
    if (rec.triggered) continue;
    if (!rec.at) neverChecked++;
    else if (rec.tracked && rec.tracked.length) foundDue++;
    else unfoundDue++;
  }
  due.sort((a, b) => a.k - b.k);
  const budget = Math.ceil(people / DAILY_FRACTION);
  const plan = due.slice(0, budget);
  log(`due: ${due.length} (triggered ${triggered}, never checked ${neverChecked}, unfound re-check ${unfoundDue}, found re-check ${foundDue}); budget ${budget}; walking ${plan.length}`);

  // ── Walk ────────────────────────────────────────────────────────────────────
  let calls = 0, answered = 0, notFound = 0, errored = 0, stoppedForTime = false;
  let clubsHarvested = 0, trackedFound = 0, otherFound = 0, noOwnRecord = 0;
  const errorSamples = [], noOwnSamples = [];
  const byStatus = {};
  const rawUpcoming = [];

  for (const { uuid, rec } of plan) {
    if (Date.now() - startMs > TIME_BUDGET_MS) { stoppedForTime = true; break; }
    await pace();
    calls++;
    let json;
    try { json = await gqlPost(Q_PROFILE, { profileID: uuid }, 'PublicProfileTeams'); }
    catch (e) { errored++; if (errorSamples.length < 5) errorSamples.push(`${uuid}: thrown — ${e.message}`); continue; } // left as it was; due again next run

    const at = isoAt(Date.now());
    if (json.errors && json.errors.length) {
      const msg = String(json.errors[0].message || '');
      if (/NOT_FOUND|failed to find profile/i.test(msg)) {
        notFound++;
        rec.at = at; rec.missing = true; rec.triggered = false;
        rec.nextCheck = isoAt(Date.now() + RECHECK_FOUND_DAYS * DAY_MS);
      } else { errored++; if (errorSamples.length < 5) errorSamples.push(`${uuid}: ${msg.slice(0, 160)}`); }
      continue;
    }
    answered++;
    delete rec.missing;

    const teams = json?.data?.publicProfileTeams || [];
    const fromSeason = cohortById.get(rec.from?.seasonId);
    // A registration is next season only if its season starts after ours ENDS.
    // Fall back to our startDate if the manifest lacks an endDate — that is the
    // v1 rule and over-includes, so it is logged once below.
    const fromEnd = fromSeason ? (fromSeason.endDate || fromSeason.startDate) : '';
    const tracked = [], other = [];
    let sawOwn = false;
    for (const t of teams) {
      const sid = t.season?.id || null;
      const st = t.season?.status?.value || null;
      byStatus[st || '(none)'] = (byStatus[st || '(none)'] || 0) + 1;

      // Harvest before you strip: the player's own cohort-season record names
      // their club. Take it, then drop the record as already stored.
      if (sid && sid === rec.from?.seasonId) {
        sawOwn = true;
        if (t.organisation?.id) {
          if (!rec.from.club) clubsHarvested++;
          rec.from.club = t.organisation.id;
          rec.from.clubName = t.organisation.name || null;
        }
      }
      const start = String(t.season?.startDate || '');
      if (!start || start <= fromEnd) continue;         // own season, earlier, or concurrent

      if (st && st !== 'COMPLETED' && st !== 'ACTIVE' && rawUpcoming.length < RAW_UPCOMING_LIMIT) rawUpcoming.push(t);

      if (sid && manifestById.has(sid)) {
        const m = manifestById.get(sid);
        const clubName = t.organisation?.name || null;
        tracked.push({ seasonId: sid, compName: m.compName || null, status: st,
          club: t.organisation?.id || null, clubName,
          team: t.name && t.name !== clubName ? t.name : null, name: t.name || null });
      } else {
        // Dates travel with outside registrations so the panel can tell a season
        // from a carnival: the first real run (2026-09-07) found "AFL Nines at
        // Byron", a two-day event in October, as a player's only post-season
        // registration. A departure line needs a season, not a weekend.
        other.push({ league: t.season?.competition?.name || null, season: t.season?.name || null, status: st,
          startDate: start || null, endDate: t.season?.endDate || null });
      }
    }
    rec.tracked = tracked;
    rec.other = other;
    rec.at = at;
    rec.triggered = false;
    rec.nextCheck = isoAt(Date.now() + (tracked.length ? RECHECK_FOUND_DAYS : RECHECK_UNFOUND_DAYS) * DAY_MS);
    if (tracked.length) trackedFound++;
    if (other.length) otherFound++;
    if (!sawOwn) {
      noOwnRecord++;
      if (noOwnSamples.length < 5) noOwnSamples.push(`${uuid} ${rec.name || ''} (${rec.from?.compName}): ${teams.length} registration(s), seasons ${teams.map(t => `${t.season?.competition?.name || '?'} ${t.season?.name || '?'}`).join('; ') || 'none'}`);
    }

    if (calls % 500 === 0) log(`  ${calls} calls — answered ${answered}, not found ${notFound}, errors ${errored}`);
  }
  // A triggered flag must not survive an unwalked run forever: anyone still
  // flagged was simply beyond today's budget and stays flagged for tomorrow.

  log('\n--- summary ---');
  log(`calls ${calls}  answered ${answered}  not found ${notFound}  errors ${errored}` + (stoppedForTime ? '  STOPPED FOR TIME' : ''));
  log(`clubs harvested this run: ${clubsHarvested}; players with a next-season tracked registration: ${trackedFound}; with an outside one: ${otherFound}`);
  if (Object.keys(byStatus).length) log(`registration statuses seen: ${JSON.stringify(byStatus)}`);
  if (cohort.some(c => !c.endDate)) log(`⚠️ a cohort season has no endDate in the manifest — falling back to the startDate rule for it, which over-includes concurrent seasons`);
  if (noOwnRecord) {
    log(`${noOwnRecord} answered player(s) returned no registration for their own cohort season — club not harvested; first ${noOwnSamples.length}:`);
    for (const l of noOwnSamples) log('  ' + l);
  }
  if (errorSamples.length) { log('first error(s):'); for (const l of errorSamples) log('  ' + l); }
  if (rawUpcoming.length) {
    log(`first ${rawUpcoming.length} pre-season record(s) RAW — is name the club (unassigned) or a team (assigned)?`);
    for (const t of rawUpcoming) log('  ' + JSON.stringify(t));
  }
  const remaining = Object.values(reg.players).filter(r => dueKey(r, Date.now()) !== null).length;
  log(`still due after this run: ${remaining}`);

  reg.meta.version = FILE_VERSION;
  reg.meta.walkedAt = NOW;
  reg.meta.cohortSeasons = cohort.map(c => c.seasonId);
  reg.meta.people = people;
  reg.meta.lastRun = { calls, answered, notFound, errored, triggered, stoppedForTime };

  if (typeof logSummary === 'function') logSummary('walk-registrations');
  if (canon(reg) === before) { log('No change — exit 2'); process.exit(2); }
  const out = JSON.stringify(reg);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, out);
  log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${(out.length / 1024).toFixed(0)} KB) — exit 0`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
