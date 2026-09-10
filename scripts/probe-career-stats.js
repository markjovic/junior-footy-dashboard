#!/usr/bin/env node
// scripts/probe-career-stats.js
//
// READ-ONLY. Writes no file, commits nothing, touches no season file.
// career_stats_design.md §2 and §8: measure, before any design decision, what
// publicProfileStatistics actually returns for a whole career.
//
// FOUR MEASUREMENTS (§2, minus the budget — see below):
//   1. the exact form of seasonStatistics[].name
//   2. whether seasons from other sports appear on the afl tenant
//   3. whether club.name carries the league suffix "(Eastern Football Netball League)"
//   4. which per-season statistic values are really returned (APPEARANCE,
//      GOAL_COUNT, BEST_PLAYER — and anything else)
//
// THE WAF BUDGET IS NOT MEASURED BY DEFAULT. §2 lists it as a fourth unknown;
// Mark deferred it on 2026-09-10. The walk is paced at 100 calls per 80 s, the
// figure walk-registrations.js has never tripped. PROBE_BURST=true fires a
// bounded unpaced burst on publicProfileStatistics ONLY, and only when asked.
//
// ⚠️ THE BURST MEASURES THE COUNT, NOT THE RECOVERY. registrations_design.md §8
// warned that lib/playhq.js's retry path may absorb a block and hide it: it
// does — gqlPost detects the HTML 403, waits a flat 80 s and retries, so the
// call still succeeds. It also increments counters.blocked, so the block is
// visible in summary() without writing a second transport. Recovery was
// measured at 76-77 s on 2026-09-05 and is not re-measured here.
//
// THE QUERY IS fetch-stats.js's Q_PROFILE_STATS, COPIED VERBATIM. It has run in
// production since August, so the base walk cannot fail validation. Every extra
// field is a separate TRIAL on its own call, one field group at a time — a
// rejected field fails the WHOLE query (measured 2026-08-16), so combining them
// would lose every answer to whichever one is wrong.
//
// COHORT SOURCE: data/registrations.json.gz, the walker's own file. It is one
// object per profile id carrying name and from.compName, which is exactly a
// cohort spread across the five competitions, and reading it costs one 1.4 MB
// gunzip. lib/store.js is deliberately NOT used: store.load would parse a whole
// 20 MB players file to pick twenty uuids out of it.
//
// Env: PROBE_PER_COMP (4), PROBE_EXTRA_IDS (csv), PROBE_RAW (3),
//      PROBE_BURST (false), PROBE_BURST_CALLS (250),
//      PROBE_RATE (100) / PROBE_WINDOW_MS (80000).
//
// Exit codes: 0 = the probe ran (whatever it found). 1 = it could not start —
// no cohort file — or threw. A lost session is NOT exit 1: lib/playhq.js warns
// and proceeds, so the failure shows as every player failing, which is what the
// per-player lines and the ok/blocked counters are for.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const playhq = require('./lib/playhq');
const { gqlPost, sleep } = playhq;

const VERSION = 'probe-career-stats v1 2026-09-10 read-only';

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const REG_LEGACY = path.join(ROOT, 'data', 'registrations.json');

const PER_COMP = Math.max(1, Number(process.env.PROBE_PER_COMP || 4));
const RAW_LIMIT = Math.max(0, Number(process.env.PROBE_RAW || 3));
const RATE = Math.max(1, Number(process.env.PROBE_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.PROBE_WINDOW_MS || 80000));
const BURST = String(process.env.PROBE_BURST || 'false') === 'true';
const BURST_CALLS = Math.max(1, Number(process.env.PROBE_BURST_CALLS || 250));

const log = (...a) => console.log(...a);

// ── The base query — fetch-stats.js Q_PROFILE_STATS, unmodified ──────────────
const Q_BASE = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id }
        club { id name }
        totalStatistics {
          count
          details { value }
        }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          totalStatistics {
            count
            details { value }
          }
        }
      }
    }
  }
  publicProfile(profileID: $profileID) {
    id
    firstName
    lastName
  }
}`;

// ── Trials — each is the base query with ONE substitution, run alone ─────────
//
// `find` must appear exactly once in Q_BASE. A trial whose `find` does not
// match is reported rather than silently skipped: a trial that never ran is not
// a trial that passed.
const TRIALS = [
  {
    id: 'T1 season detail',
    why: 'The selection walk-registrations.js proves on DiscoverTeam.season. ' +
         'I am INFERRING that publicProfileStatistics hangs the same season type. ' +
         'If it does, one call buys the league name, the status and the dates that ' +
         "§3's refresh cadence needs and the base query cannot supply.",
    find: 'season { id }',
    with: 'season { id name startDate endDate status { value } competition { id name } }',
  },
  {
    id: 'T2 season sport',
    why: 'GUESS. Settles measurement 2 outright — whether the afl tenant filters ' +
         'other sports out, or simply returns them and nothing says which is which.',
    find: 'season { id }',
    with: 'season { id sport { name } }',
  },
  {
    id: 'T3 season organisation',
    why: 'GUESS. The league as an organisation id would join a career season to ' +
         'the manifest without parsing a name.',
    find: 'season { id }',
    with: 'season { id organisation { id name } }',
  },
  {
    id: 'T4 statistic label',
    why: 'GUESS. If details carries a human label as well as the enum value, the ' +
         'career table can print PlayHQ\'s own wording for a statistic we have ' +
         'never seen before.',
    find: `totalStatistics {
          count
          details { value }
        }`,
    with: `totalStatistics {
          count
          details { value name }
        }`,
  },
  {
    id: 'T5 career totals',
    why: 'GUESS, and the valuable one. The PlayHQ page shows a career total ' +
         '(398 games, 630 goals). If a field serves it, §4 stores it instead of ' +
         'summing seasons, and the strip cannot disagree with PlayHQ.',
    find: `    seasonStatistics {`,
    with: `    careerStatistics { count details { value } }
    seasonStatistics {`,
  },
];

// ── Token bucket — the shape walk-registrations.js has never tripped ─────────
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

// ── Cohort ──────────────────────────────────────────────────────────────────
function readCohort() {
  let raw = null;
  if (fs.existsSync(REG_PATH)) raw = zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8');
  else if (fs.existsSync(REG_LEGACY)) raw = fs.readFileSync(REG_LEGACY, 'utf8');
  if (raw === null) return null;
  const r = JSON.parse(raw);
  return r && r.players ? r : null;
}

// Deterministic: walked players first (their record is known real), then uuid
// order, so two runs on the same file pick the same people.
function select(cohort, perComp, extraIds) {
  const byComp = new Map();
  for (const [uuid, rec] of Object.entries(cohort.players)) {
    const comp = rec.from && rec.from.compName ? rec.from.compName : '(no competition)';
    if (!byComp.has(comp)) byComp.set(comp, []);
    byComp.get(comp).push({ uuid, name: rec.name || null, comp, walked: !!rec.at });
  }
  const picked = [];
  const seen = new Set();
  for (const id of extraIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = [...byComp.values()].flat().find(p => p.uuid === id);
    picked.push(known || { uuid: id, name: null, comp: '(supplied)', walked: false });
  }
  for (const comp of [...byComp.keys()].sort()) {
    const list = byComp.get(comp).sort((a, b) =>
      (a.walked === b.walked ? 0 : a.walked ? -1 : 1) || (a.uuid < b.uuid ? -1 : 1));
    for (const p of list) {
      if (picked.filter(x => x.comp === comp).length >= perComp) break;
      if (seen.has(p.uuid)) continue;
      seen.add(p.uuid);
      picked.push(p);
    }
  }
  return picked;
}

// ── One call ────────────────────────────────────────────────────────────────
// Returns { ok, seasons, profile, reason }. A 403 on this operation is DATA,
// not an expired session — lib/playhq.js has publicProfileStatistics in
// AUTH_403_IS_DATA and throws rather than refreshing. Catch it per player.
async function askProfile(uuid, query) {
  let json;
  try {
    json = await gqlPost(query || Q_BASE, { profileID: uuid }, 'publicProfileStatistics');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    return { ok: false, reason: /403 not accessible/.test(msg) ? 'private (403)' : msg, json: null };
  }
  if (json && json.errors && json.errors.length) {
    return { ok: false, reason: String(json.errors[0].message || 'error').slice(0, 200), json };
  }
  const block = json && json.data ? json.data.publicProfileStatistics : null;
  return {
    ok: true,
    json,
    seasons: (block && block.seasonStatistics) || [],
    career: block ? block.careerStatistics : undefined,
    profile: (json && json.data && json.data.publicProfile) || null,
  };
}

const statLine = (arr) => (arr || [])
  .map(s => `${s.details && s.details.value}=${s.count}`).join(' ');

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== ${VERSION} ===`);
  log(`pace: ${RATE} calls / ${WINDOW_MS / 1000}s${BURST ? `  BURST ENABLED (${BURST_CALLS} calls, unpaced)` : ''}`);

  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')).manifest || [];
  } catch (e) {
    log(`⚠️ could not read data/core.json (${e.message}) — every season will read as NOT held`);
  }
  const heldIds = new Set(manifest.filter(m => m.seasonId).map(m => m.seasonId));
  const compOf = new Map(manifest.filter(m => m.seasonId).map(m => [m.seasonId, m.compName || null]));
  log(`manifest: ${manifest.length} entries, ${heldIds.size} season id(s) this project holds`);

  const cohort = readCohort();
  if (!cohort) {
    console.error('FATAL: data/registrations.json.gz is not present or has no players.');
    console.error('It is the cohort source. Either dispatch Walk registrations first,');
    console.error('or pass profile ids directly with extra_profile_ids.');
    process.exit(1);
  }
  const extraIds = String(process.env.PROBE_EXTRA_IDS || '')
    .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const people = Object.keys(cohort.players).length;
  const walked = Object.values(cohort.players).filter(r => r.at).length;
  log(`cohort file: ${people} people, ${walked} walked at least once (version ${cohort.meta && cohort.meta.version})`);

  const picked = select(cohort, PER_COMP, extraIds);
  log(`\nselected ${picked.length} player(s): up to ${PER_COMP} per competition` +
      (extraIds.length ? `, including ${extraIds.length} supplied id(s) — a supplied id already in the cohort counts inside its own competition's quota` : ''));
  for (const p of picked) log(`  ${p.uuid}  ${(p.name || '(name unknown)').padEnd(24)} ${p.comp}`);

  // ── The walk ──────────────────────────────────────────────────────────────
  log('\n── per player ──');
  let calls = 0, answered = 0, failed = 0;
  const failures = [];
  const rows = [];          // one per season registration, flattened
  const perPlayer = [];     // { uuid, name, seasons, held, notHeld }
  const raws = [];
  let burstFired = 0;

  for (const p of picked) {
    await pace();
    calls++;
    const r = await askProfile(p.uuid);
    if (!r.ok) {
      failed++;
      failures.push(`${p.uuid} (${p.comp}): ${r.reason}`);
      log(`  ${p.uuid} ${(p.name || '').padEnd(20)} FAILED — ${r.reason}`);
      continue;
    }
    answered++;
    if (raws.length < RAW_LIMIT) raws.push({ p, json: r.json });

    let held = 0, notHeld = 0, regs = 0;
    for (const block of r.seasons) {
      for (const reg of (block.statistics || [])) {
        regs++;
        const sid = reg.season ? reg.season.id : null;
        const isHeld = !!(sid && heldIds.has(sid));
        if (isHeld) held++; else notHeld++;
        rows.push({
          uuid: p.uuid,
          label: block.name || null,
          seasonId: sid,
          held: isHeld,
          heldComp: isHeld ? compOf.get(sid) : null,
          club: reg.club ? reg.club.name : null,
          clubId: reg.club ? reg.club.id : null,
          totals: reg.totalStatistics || [],
          teams: reg.teamStatistics || [],
        });
      }
    }
    perPlayer.push({ uuid: p.uuid, name: p.name, comp: p.comp, blocks: r.seasons.length, regs, held, notHeld });
    log(`  ${p.uuid} ${(p.name || '').padEnd(20)} ${String(r.seasons.length).padStart(2)} season block(s), ` +
        `${regs} registration(s), ${held} held here / ${notHeld} not`);
  }

  if (failures.length) {
    log(`\n${failures.length} player(s) did not answer:`);
    for (const f of failures.slice(0, 10)) log('  ' + f);
  }

  // ── Raw ───────────────────────────────────────────────────────────────────
  if (raws.length) {
    log(`\n── RAW: the first ${raws.length} answer(s), exactly as returned ──`);
    for (const { p, json } of raws) {
      log(`\n--- ${p.uuid} ${p.name || ''} (${p.comp}) ---`);
      log(JSON.stringify(json));
    }
  }

  // ── ANSWERS ───────────────────────────────────────────────────────────────
  log('\n═══ ANSWERS — the four measurements ═══');

  // 1. the form of seasonStatistics[].name
  const labels = [...new Set(rows.map(r => r.label).filter(Boolean))].sort();
  const patterns = [
    ['"League, YYYY"  (comma)', /^.+,\s*\d{4}$/],
    ['"League YYYY"   (space)', /^.+\s\d{4}$/],
    ['"YYYY"          (bare)', /^\d{4}$/],
  ];
  log(`\n1. seasonStatistics[].name — ${labels.length} distinct label(s) over ${rows.length} registration(s)`);
  const unmatched = [];
  const counted = new Set();
  for (const [name, re] of patterns) {
    const hits = labels.filter(l => !counted.has(l) && re.test(l));
    hits.forEach(l => counted.add(l));
    log(`   ${name}: ${hits.length}`);
  }
  for (const l of labels) if (!counted.has(l)) unmatched.push(l);
  log(`   matching none of those: ${unmatched.length}`);
  for (const l of unmatched.slice(0, 10)) log(`     NO PATTERN: ${JSON.stringify(l)}`);
  log('   every distinct label:');
  for (const l of labels.slice(0, 60)) log(`     ${JSON.stringify(l)}`);
  if (labels.length > 60) log(`     … and ${labels.length - 60} more`);
  const years = labels.map(l => (/(\d{4})\s*$/.exec(l) || [])[1]).filter(Boolean).sort();
  if (years.length) log(`   trailing year present on ${years.length}/${labels.length}; earliest ${years[0]}, latest ${years[years.length - 1]}`);

  // 2. other sports
  // ⚠️ Test the label with the AFL compound REMOVED first. "Western Football
  // Netball League" is an AFL league, and a bare /netball/ test flagged five of
  // six fixture labels — an answer produced entirely by the test.
  const SPORT = /netball|basketball|cricket|hockey|softball|baseball|touch\b|volleyball|soccer|futsal|rugby|lacrosse|tennis/i;
  const deAfl = (l) => String(l).replace(/football\s+(and\s+)?netball/gi, 'football');
  const sportHits = labels.filter(l => SPORT.test(deAfl(l)));
  log(`\n2. seasons from other sports on the afl tenant`);
  log(`   labels matching a non-AFL sport word: ${sportHits.length}`);
  for (const l of sportHits.slice(0, 20)) log(`     ${JSON.stringify(l)}`);
  log('   ⚠️ INFERRED from wording only. A netball league can be named without the word,');
  log('      and an AFL club name can contain it ("Football Netball Club"). T2 settles it if accepted.');

  // 3. the league suffix on club.name
  const clubs = [...new Set(rows.map(r => r.club).filter(Boolean))].sort();
  const suffixed = clubs.filter(c => /\([^)]+\)\s*$/.test(c));
  const suffixes = [...new Set(suffixed.map(c => (/\(([^)]+)\)\s*$/.exec(c) || [])[1]))].sort();
  log(`\n3. club.name — ${clubs.length} distinct club(s)`);
  log(`   carrying a trailing "(...)" suffix: ${suffixed.length} of ${clubs.length}`);
  log(`   distinct suffixes: ${suffixes.length}`);
  for (const s of suffixes.slice(0, 25)) log(`     (${s})`);
  const bare = clubs.filter(c => !/\([^)]+\)\s*$/.test(c));
  log(`   clubs with NO suffix: ${bare.length}`);
  for (const c of bare.slice(0, 15)) log(`     ${JSON.stringify(c)}`);
  log(`   nulls: ${rows.filter(r => !r.club).length} registration(s) with no club`);

  // 4. which statistic values are returned
  const tally = (arrs) => {
    const m = new Map();
    for (const a of arrs) for (const s of (a || [])) {
      const v = (s.details && s.details.value) || '(no details.value)';
      m.set(v, (m.get(v) || 0) + 1);
    }
    return m;
  };
  const totalsTally = tally(rows.map(r => r.totals));
  const teamTally = tally(rows.flatMap(r => (r.teams || []).map(t => t.totalStatistics)));
  log(`\n4. statistic values actually returned`);
  log('   totalStatistics:');
  for (const [v, n] of [...totalsTally.entries()].sort((a, b) => b[1] - a[1])) log(`     ${v.padEnd(24)} ${n}`);
  log('   teamStatistics.totalStatistics:');
  for (const [v, n] of [...teamTally.entries()].sort((a, b) => b[1] - a[1])) log(`     ${v.padEnd(24)} ${n}`);
  const KNOWN = new Set(['APPEARANCE', 'GOAL_COUNT', 'BEST_PLAYER']);
  const novel = [...totalsTally.keys(), ...teamTally.keys()].filter(v => !KNOWN.has(v));
  log(`   NOT among APPEARANCE / GOAL_COUNT / BEST_PLAYER: ${novel.length ? [...new Set(novel)].join(', ') : 'none'}`);
  const missingTotals = rows.filter(r => !r.totals || !r.totals.length).length;
  log(`   registrations with an EMPTY totalStatistics: ${missingTotals} of ${rows.length}`);

  // ── Shape and cost, for §3 and §4 ─────────────────────────────────────────
  log('\n── shape and cost (career_stats_design.md §3 and §4) ──');
  const seasonCounts = perPlayer.map(p => p.regs).sort((a, b) => a - b);
  if (seasonCounts.length) {
    const sum = seasonCounts.reduce((a, b) => a + b, 0);
    const med = seasonCounts[Math.floor(seasonCounts.length / 2)];
    const zeros = seasonCounts.filter(n => n === 0).length;
    log(`   registrations per player: min ${seasonCounts[0]}, median ${med}, max ${seasonCounts[seasonCounts.length - 1]}, mean ${(sum / seasonCounts.length).toFixed(1)}`);
    // A player who answers with nothing drags the mean the size projection
    // rests on, so it is stated rather than left inside the average.
    log(`   players who answered with NO registrations at all: ${zeros} of ${seasonCounts.length}` +
        (zeros ? ` — excluding them the mean is ${(sum / (seasonCounts.length - zeros)).toFixed(1)}` : ''));
    log(`   the design estimated ~5 seasons per person and 36 MB plain / 4-5 MB gzipped for 40,002 people`);
    log(`   at the measured mean that is ${(40002 * (sum / seasonCounts.length) * 180 / 1e6).toFixed(1)} MB plain on the same 180 bytes/season assumption`);
  }
  const heldRows = rows.filter(r => r.held).length;
  log(`   registrations in a season this project holds: ${heldRows} of ${rows.length} (the rest is what a career view adds)`);
  log(`   registrations with a NULL season id: ${rows.filter(r => !r.seasonId).length} — these cannot be joined to the manifest`);
  const multiClub = perPlayer.filter(p => p.regs > p.blocks).length;
  log(`   players with more registrations than season blocks (two clubs in one season): ${multiClub}`);
  const multiTeam = rows.filter(r => (r.teams || []).length > 1).length;
  log(`   registrations with more than one team: ${multiTeam}`);

  // ── TRIALS ────────────────────────────────────────────────────────────────
  // On the richest answering player, so an accepted trial shows real values.
  const richest = perPlayer.slice().sort((a, b) => b.regs - a.regs)[0];
  const trialUuid = richest ? richest.uuid : (picked[0] && picked[0].uuid);
  log(`\n═══ TRIALS — one candidate field group per call, never combined ═══`);
  log(`trial profile: ${trialUuid} ${richest ? `(${richest.regs} registrations)` : '(no player answered; using the first selected)'}`);

  for (const t of TRIALS) {
    const occurrences = Q_BASE.split(t.find).length - 1;
    if (occurrences !== 1) {
      log(`\n${t.id}: NOT RUN — its anchor appears ${occurrences} time(s) in the base query, not once. This is a defect in the probe, not an answer.`);
      continue;
    }
    const q = Q_BASE.replace(t.find, t.with);
    await pace();
    calls++;
    const r = await askProfile(trialUuid, q);
    log(`\n${t.id}`);
    log(`  why: ${t.why}`);
    log(`  asked for: ${t.with.replace(/\s+/g, ' ').trim()}`);
    if (r.ok) {
      log('  ACCEPTED');
      const first = (r.seasons && r.seasons[0]) || null;
      if (t.id.startsWith('T5')) log(`    careerStatistics: ${r.career === undefined ? '(absent from the response)' : JSON.stringify(r.career)}`);
      if (first) {
        const reg0 = (first.statistics || [])[0] || {};
        log(`    first season block: ${JSON.stringify({ name: first.name, season: reg0.season, club: reg0.club })}`);
        log(`    first totals: ${statLine(reg0.totalStatistics) || '(none)'}`);
      } else {
        log('    ⚠️ accepted but returned no season blocks — that is not the same as the field working');
      }
    } else {
      log(`  REJECTED — ${r.reason}`);
    }
  }

  // ── Optional unpaced burst ────────────────────────────────────────────────
  if (BURST) {
    log(`\n═══ UNPACED BURST — publicProfileStatistics only ═══`);
    log('Measures CALLS BEFORE THE FIRST BLOCK. Recovery is not measured: gqlPost');
    log('absorbs a block with a flat 80 s wait, and recovery was measured at 76-77 s');
    log('on 2026-09-05. The block is detected through summary().blocked.');
    const pool = Object.keys(cohort.players).filter(u => !picked.some(p => p.uuid === u));
    const t0 = Date.now();
    let fired = 0, blockedAt = 0;
    const before = playhq.summary().blocked;
    for (const uuid of pool.slice(0, BURST_CALLS)) {
      fired++;
      calls++;
      await askProfile(uuid);
      if (playhq.summary().blocked > before) { blockedAt = fired; break; }
    }
    const secs = (Date.now() - t0) / 1000;
    // ⚠️ Never print a rate computed on a zero elapsed time. The first fixture
    // run reported "Infinity req/s", which is the kind of figure that gets read
    // as a measurement.
    const rate = secs >= 0.05 ? `${(fired / secs).toFixed(2)} req/s` : 'rate not computable — elapsed time too small to divide by';
    if (blockedAt) {
      log(`  BLOCKED on burst call ${blockedAt} after ${secs.toFixed(1)}s — ${secs >= 0.05 ? `${(blockedAt / secs).toFixed(2)} req/s` : 'rate not computable'}`);
      log('  (elapsed INCLUDES the 80 s the transport waited out, so the rate BEFORE the block was higher)');
    } else {
      log(`  no block in ${fired} call(s) over ${secs.toFixed(1)}s — ${rate}`);
      log('  ⚠️ A CLEAN BURST DOES NOT PROVE A BUDGET. It proves this many calls at this rate did not trip it.');
    }
    burstFired = fired;
  }

  log(`\n── summary ──`);
  log(`calls ${calls} = ${picked.length} player(s) + ${TRIALS.length} trial(s)` +
      (burstFired ? ` + ${burstFired} burst` : '') +
      `; answered ${answered}, failed ${failed}`);
  playhq.logSummary('probe-career-stats');
  log('Read-only: nothing was written. Exit 0.');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
