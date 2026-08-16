// scripts/verify-backfill.js
//
// Verifies scripts/backfill.js and scripts/fetch-results.js by EXECUTING them,
// with only the network stubbed. storage_ingestion_design.md §6.1.
//
// It copies the real backfill.js, fetch-results.js, lib/results-engine.js and
// lib/store.js into a temporary tree, stubs lib/playhq.js with canned GraphQL
// responses, and runs each script as a child process. Everything except the
// network is the committed code, so this tests what actually runs rather than a
// reimplementation of it. The repository's own data/ and config.json are never
// opened.
//
// Covers the success path and the failure paths. Every guard is deliberately
// tripped: a live season, a season with compName null, an unknown organisation,
// an unknown season, and phase B.
//
// Run: node scripts/verify-backfill.js     Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-backfill v6 2026-08-16 fixture-supersede';
console.log(`=== ${VERSION} ===`);

const SCRIPTS = __dirname;
for (const f of ['backfill.js', 'fetch-results.js', 'lib/results-engine.js', 'lib/store.js']) {
  if (!fs.existsSync(path.join(SCRIPTS, f))) {
    console.error(`FATAL: scripts/${f} not found. Run from the repository root.`);
    process.exit(1);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-verify-'));
// ── Per-season fixture helpers ──────────────────────────────────────────────
// The storage layout moved from data/orgs/<org>-<kind>.json to
// data/seasons/<seasonId>-core.json plus <seasonId>-players.json on 2026-08-12.
// per_season_storage_design.md. These write the new shape.
const SEASONS = path.join(TMP, 'data', 'seasons');
const sCore = (id) => path.join(SEASONS, `${id}-core.json`);
const sPlayers = (id) => path.join(SEASONS, `${id}-players.json`);
function writeSeason(seasonId, org, comps, o) {
  o = o || {};
  fs.mkdirSync(SEASONS, { recursive: true });
  const matches = o.matches || [], players = o.players || [];
  fs.writeFileSync(sCore(seasonId), JSON.stringify({
    meta: { seasonId, org, comps, generatedAt: new Date().toISOString(),
            phases: { results: matches.length > 0, players: players.length > 0,
                      matches: matches.length, players_n: players.length } },
    matches, roster: o.roster || {}, gradeMeta: o.gradeMeta || {},
  }));
  fs.writeFileSync(sPlayers(seasonId), JSON.stringify({
    meta: { seasonId, generatedAt: new Date().toISOString(), count: players.length }, players,
  }));
}
const CORE = path.join(TMP, 'data', 'core.json');
const GRADES = path.join(TMP, 'data', 'grades.json');
const EFNL_CUR = sCore('2dcbf383');
const EFNL_ARC = sCore('75d8a232');
const YJFL_CUR = sCore('cda2f0ec');

fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
for (const f of ['backfill.js', 'fetch-results.js']) {
  fs.copyFileSync(path.join(SCRIPTS, f), path.join(TMP, 'scripts', f));
}
for (const f of ['results-engine.js', 'store.js']) {
  fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(TMP, 'scripts', 'lib', f));
}

// ── The stub. Only the network. ──────────────────────────────────────────────
// Two seasons of one grade. 2025 is completed and its dates are in the past, so
// it exercises the season-ended bypass; 2026 is current and would pass the guard
// anyway. Round 1 of each has two final games.
fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'), `
'use strict';
const SEASONS = {
  '75d8a232': { year: '2025', gradeId: '1debae74', dates: ['2025-04','2025-08'], current: false },
  'ca9cc98b': { year: '2024', gradeId: '25a4f589', dates: ['2024-04','2024-08'], current: false },
  '2dcbf383': { year: '2026', gradeId: '6f964e7b', dates: ['2026-04','2026-08'], current: true  },
  'cda2f0ec': { year: '2026', gradeId: '9a9a9a9a', dates: ['2026-04','2026-08'], current: true  },
};
const byGrade = {};
for (const [sid, s] of Object.entries(SEASONS)) byGrade[s.gradeId] = { sid, ...s };

function logo(code) {
  return { sizes: [{ url: 'https://x/production/afl/' + code + '-1111-2222-3333-444455556666/logo.png',
                     dimensions: { width: 64, height: 64 } }] };
}
function team(name, code) { return { id: name, name, logo: logo(code) }; }
function stats(g, b, s) {
  return { statistics: [ { count: g, type: { value: 'TOTAL_GOALS' } },
                         { count: b, type: { value: 'TOTAL_BEHINDS' } },
                         { count: s, type: { value: 'TOTAL_SCORE' } } ] };
}

async function gqlPost(query, vars) {
  if (query.includes('gradeListDiscoverSeason')) {
    const s = SEASONS[vars.id];
    if (!s) throw new Error('stub: unknown seasonID ' + vars.id);
    return { data: { discoverSeason: { id: vars.id, name: s.year,
      competition: { organisation: { name: 'EFNL', logo: logo('383836bb') } },
      grades: [{ id: s.gradeId, name: 'U12 Mixed A', age: { name: 'U12', value: 'U12' },
                 gender: { name: 'Mixed', value: 'MIXED' } }] } } };
  }
  if (query.includes('gradeRounds')) {
    const g = byGrade[vars.gradeID];
    if (!g) throw new Error('stub: unknown gradeID ' + vars.gradeID);
    // Lets a test drive a mid-loop failure without touching the real code.
    if (process.env.STUB_FAIL_SEASON && process.env.STUB_FAIL_SEASON === g.sid) {
      throw new Error('stub: forced failure for season ' + g.sid);
    }
    // One round per grade by default, which is every existing test's expectation.
    // STUB_ROUNDS=3 serves a three-round sequence so the round WALK can be
    // exercised — with one round the loop runs once and cannot demonstrate
    // stopping or continuing at all.
    const mk = (n) => ({ id: 'r' + n + '-' + g.gradeId, name: 'Round ' + n,
      abbreviatedName: null, number: String(n),
      current: g.current && n === (process.env.STUB_ROUNDS === '3' ? 3 : 1),
      isFinalsRound: false, provisionalDates: [] });
    const rounds = process.env.STUB_ROUNDS === '3' ? [mk(1), mk(2), mk(3)] : [mk(1)];
    return { data: { discoverGrade: { id: vars.gradeID, name: 'U12 Mixed A', dates: g.dates,
      rounds } } };
  }
  // STUB_RENAME='true' appends a suffix to every team name while keeping the
  // fixture ids identical — PlayHQ's mid-season rename, reproduced.
  const REN = (n) => process.env.STUB_RENAME === 'true' ? n + ' - LP' : n;
  if (query.includes('discoverFixtureByRound')) {
    // Round 2 is the round under test. STUB_R2 selects its shape:
    //   placeholder  one PENDING game dated in the PAST — the SEJ dummy fixture
    //   future       one PENDING game dated far ahead — genuinely not played
    //   undated      one PENDING game with no date at all
    //   empty        no games — a bye, which already has its own handling
    const r2 = process.env.STUB_R2 || '';
    if (r2 && /^r2-/.test(String(vars.roundID))) {
      if (r2 === 'empty') return { data: { discoverFixtureByRound: { games: [] } } };
      const date = r2 === 'placeholder' ? '2020-01-05'
                 : r2 === 'future'      ? '2099-01-05'
                 : null;
      return { data: { discoverFixtureByRound: { games: [
        { id: 'dummy-' + vars.roundID, home: team('Dummy 1', 'aaaa1111'), away: team('Dummy 2', 'bbbb2222'),
          result: { home: stats(0, 0, 0), away: stats(0, 0, 0) },
          status: { value: 'PENDING' }, date,
          allocation: { court: { venue: null } } },
      ] } } };
    }
    return { data: { discoverFixtureByRound: { games: [
      { id: 'g1-' + vars.roundID, home: team(REN('Blackburn U12'), '383836bb'), away: team(REN('Norwood U12'), 'aaaa1111'),
        result: { home: stats(10, 5, 65), away: stats(8, 3, 51) },
        status: { value: 'FINAL' }, date: '2025-04-05',
        allocation: { court: { venue: { name: 'Morton Park', suburb: 'Blackburn',
          state: 'VIC', latitude: -37.8, longitude: 145.1 } } } },
      { id: 'g2-' + vars.roundID, home: team(REN('Vermont U12'), 'bbbb2222'), away: team(REN('Mitcham U12'), 'cccc3333'),
        result: { home: stats(12, 6, 78), away: stats(4, 2, 26) },
        status: { value: 'FINAL' }, date: '2025-04-05',
        allocation: { court: { venue: { name: 'Vermont Reserve', suburb: 'Vermont',
          state: 'VIC', latitude: -37.8, longitude: 145.2 } } } },
    ] } } };
  }
  throw new Error('stub: unexpected query');
}
module.exports = {
  gqlPost,
  refreshSession: async () => {},
  sleep: async () => {},
  logSummary: () => {},
};
`);

const MANIFEST = () => ([
  { org: '383836bb', orgName: 'EFNL', seasonId: '2dcbf383', seasonName: '2026',
    compName: 'EFNL 2026', status: 'ACTIVE', retired: false, endDate: '2026-09-30',
    phases: { results: false, players: false } },
  { org: '383836bb', orgName: 'EFNL', seasonId: '75d8a232', seasonName: '2025',
    compName: 'EFNL 2025', status: 'COMPLETED', retired: true, endDate: '2025-09-30',
    phases: { results: false, players: false } },
  { org: '383836bb', orgName: 'EFNL', seasonId: 'ca9cc98b', seasonName: '2024',
    compName: 'EFNL 2024', status: 'COMPLETED', retired: true, endDate: '2024-10-13',
    phases: { results: false, players: false } },
  { org: '4f9a099e', orgName: 'YJFL', seasonId: 'cda2f0ec', seasonName: '2026',
    compName: 'YJFL 2026', status: 'ACTIVE', retired: false, endDate: '2026-09-30',
    phases: { results: false, players: false } },
  { org: '0f20da4f', orgName: 'Unnamed org', seasonId: 'ffff9999', seasonName: '2024',
    compName: null, status: 'COMPLETED', retired: true, endDate: '2024-09-30',
    phases: { results: false, players: false } },
]);

function reset(manifest) {
  fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
  fs.mkdirSync(SEASONS, { recursive: true });
  fs.writeFileSync(CORE, JSON.stringify({
    manifest: manifest || MANIFEST(),
    clubs: {}, teamClub: {}, teamOrg: {},
    // Two competitions' worth of each collision-prone core key, so a scoped run
    // that replaces rather than merges is visible.
    compLogos: { 'EFNL 2026': 'http://x/efnl.png', 'YJFL 2026': 'http://x/yjfl.png' },
    // Three deliberately different lastRound entries, because engine v14 must
    // treat them three different ways in one pass:
    //   EFNL 2026  covered by a VIP-only run  -> REBUILT, 14 must become 1
    //   YJFL 2026  not covered by a VIP run   -> KEPT at 16
    //   U12|A      pre-v14 two-segment key    -> DROPPED
    // The legacy key is the one that catches a naive merge: its first segment is
    // an age, an age is never a compName, so a keep-if-not-covered test alone
    // preserves it forever.
    lastRound: {
      'EFNL 2026|U12|6f964e7b': 14,
      'YJFL 2026|U14|9a9a9a9a': 16,
      'U12|A': 14,
    },
    teamLogos: { 'Ivanhoe': 'http://x/iv.png' },
  }, null, 2));
  fs.writeFileSync(CONFIG(), JSON.stringify({
    competitions: [
      { name: 'EFNL 2026', seasonID: '2dcbf383', vip: true,  excludeGrades: [] },
      { name: 'YJFL 2026', seasonID: 'cda2f0ec', vip: false, excludeGrades: [] },
    ],
    organisationCodes: ['383836bb', '4f9a099e'],
  }, null, 2));
  writeSeason('2dcbf383', '383836bb', ['EFNL 2026'], {});
  writeSeason('cda2f0ec', '4f9a099e', ['YJFL 2026'], {
    // home and away were absent here until 2026-08-13. No record the engine
    // writes has ever lacked them — the id's last two segments ARE them — and
    // without them rebuildRoster keyed this team as "YJFL 2026|undefined|U14".
    // Added so the fixture is a shape the writer can actually produce, which is
    // what lets the rawGrade-fallback assertion in 4a mean anything.
    matches: [{ id: 'YJFL 2026|U14|B|16|Ivanhoe|Kew', compName: 'YJFL 2026',
                age: 'U14', rawGrade: 'B', round: 16,
                home: 'Ivanhoe', away: 'Kew' }],
    roster: { 'YJFL 2026|Ivanhoe|U14': { grade: 'B' } },
    gradeMeta: { 'YJFL 2026|U14|B': { r: 1 } },
  });
}
const CONFIG = () => path.join(TMP, 'config.json');

let LAST = null;   // the most recent child run, dumped when an assertion fails
function run(script, env) {
  const r = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: TMP, encoding: 'utf8', env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  LAST = { script, env, code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  return { code: r.status, out: LAST.out };
}

// Printed once, on the first failure. Without it a red job says which assertion
// failed and nothing about why — the child's own error is invisible.
let dumped = false;
function dumpLast() {
  if (dumped || !LAST) return;
  dumped = true;
  console.log(`\n--- output of the last child run (scripts/${LAST.script}, exit ${LAST.code}) ---`);
  const lines = LAST.out.split('\n');
  for (const l of lines.slice(-60)) console.log(`  | ${l}`);
  console.log('--- end ---\n');
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); dumpLast(); }
}

// ── 1. The backfill writes a completed season into the archive ───────────────
console.log('\n1  Backfilling EFNL 2025 creates the archive');
reset();
let r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025' });
ok('exit 0 (changed)', r.code === 0, `exit ${r.code}`);
ok('version line printed', /backfill v\d+ \d{4}-\d{2}-\d{2}/.test(r.out),
  'a minimum shape, not an exact string — a pinned date needs editing every session');
ok('season-ended guard reported as bypassed', /season-ended guard BYPASSED/.test(r.out));
ok('the completed season was fetched anyway',
  /fetching anyway \(backfill\)/.test(r.out), 'the guard would have skipped it');
ok('archive created', fs.existsSync(EFNL_ARC));
const arc = fs.existsSync(EFNL_ARC) ? read(EFNL_ARC) : { matches: [], meta: {} };
ok('archive holds the 2025 matches',
  arc.matches.length === 2 && arc.matches.every(m => m.compName === 'EFNL 2025'),
  `${arc.matches.length} matches`);
ok('match id carries the right compName AND the grade id',
  (arc.matches[0] || {}).id && arc.matches[0].id.startsWith('EFNL 2025|U12|1debae74|1|'),
  (arc.matches[0] || {}).id);
ok('archive carries a 2025 roster', Object.keys(arc.roster || {}).some(k => k.startsWith('EFNL 2025|')));
ok('every match carries the PlayHQ gradeId',
  arc.matches.length > 0 && arc.matches.every(m => m.gradeId === '1debae74'),
  JSON.stringify((arc.matches[0] || {}).gradeId));
// The id's third segment must BE the grade id, not the parsed rawGrade. Built
// from rawGrade, a re-fetched round no longer matches the record already stored
// and every re-fetch adds a duplicate — proven by execution on 2026-08-12.
ok('the id segment IS the grade id, not rawGrade',
  String((arc.matches[0] || {}).id).split('|')[2] === '1debae74',
  String((arc.matches[0] || {}).id).split('|')[2]);
ok('rawGrade is still on the record for display',
  (arc.matches[0] || {}).rawGrade === 'A', JSON.stringify((arc.matches[0] || {}).rawGrade));
ok('archive carries 2025 gradeMeta', !!(arc.gradeMeta || {})['EFNL 2025|U12|A']);
ok('per-season completeness recorded',
  (arc.meta.phases || {}).results === true && arc.meta.phases.players === false,
  JSON.stringify(arc.meta.phases));

// ── 2. It did not damage anything outside its scope ──────────────────────────
console.log('\n2  Nothing outside the backfilled season was touched');
const core1 = read(CORE);
ok('YJFL file still has its match', read(YJFL_CUR).matches.length === 1);
// Engine v13 refused to write lastRound at all from a backfill, because the key
// had no season in it and a retired season's rounds would have overwritten the
// live season's value for the same age and grade name. v14's key carries the
// compName, and the compName carries the season, so the backfilled season writes
// its own entry and cannot reach the live one.
ok('the backfilled season got its OWN lastRound entry',
  core1.lastRound['EFNL 2025|U12|1debae74'] === 1, JSON.stringify(core1.lastRound));
ok('the LIVE season entry is untouched at 14',
  core1.lastRound['EFNL 2026|U12|6f964e7b'] === 14,
  'a backfill must not reach the live season — this is what writeLastRound:false used to buy');
ok("lastRound kept the other organisation's entry",
  core1.lastRound['YJFL 2026|U14|9a9a9a9a'] === 16, JSON.stringify(core1.lastRound));
ok('the pre-v14 two-segment key was DROPPED, not kept',
  core1.lastRound['U12|A'] === undefined,
  'an age is never a compName, so keep-if-not-covered alone would preserve it forever');
ok('and the drop was reported', /dropped 1 pre-v14 key/.test(r.out));
ok('compLogos kept both competitions',
  Object.keys(core1.compLogos).length >= 2, JSON.stringify(Object.keys(core1.compLogos)));
ok('grades.json holds the 2025 grades',
  fs.existsSync(GRADES) && read(GRADES).some(g => g.seasonID === '75d8a232'));

// ── 3. Idempotency ───────────────────────────────────────────────────────────
console.log('\n3  Re-running the same backfill duplicates nothing');
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025' });
ok('exit 2 (no change)', r.code === 2, `exit ${r.code}`);
ok('still 2 matches, not 4', read(EFNL_ARC).matches.length === 2,
  `${read(EFNL_ARC).matches.length} matches`);

// ── 4. The scheduled run still works, and keeps its guard ────────────────────
console.log('\n4  fetch-results.js is unchanged in behaviour');
reset();
r = run('fetch-results.js', { VIP_ONLY: 'true' });
ok('exit 0', r.code === 0, `exit ${r.code}`);
ok('engine version printed and accepted',
  /engine v\d+ 202[0-9]-[0-9][0-9]-[0-9][0-9]/.test(r.out), 'the check is a minimum major version, not an equality');
ok('season-ended guard NOT bypassed', !/season-ended guard BYPASSED/.test(r.out));
ok('2026 matches written to current', read(EFNL_CUR).matches.length === 2,
  `${read(EFNL_CUR).matches.length} matches`);
const core4 = read(CORE);
// THIS ASSERTION IS THE OPPOSITE OF v13's. Up to v13 a VIP-only run left
// lastRound entirely alone, because the key had no competition and a scoped run
// could only compute a partial map. v14's key carries the competition and the
// merge is per competition, so a VIP-only run MUST now rebuild the competitions
// it covered and keep every other competition exactly as stored. Both halves are
// asserted: rebuilding without keeping is the defect that has been fixed four
// times in four writers, and keeping without rebuilding is the stale-value bug
// the flag existed to tolerate.
ok('VIP-only run REBUILT its own competition — 14 became 1',
  core4.lastRound['EFNL 2026|U12|6f964e7b'] === 1,
  `${JSON.stringify(core4.lastRound)} — 14 here means the scoped run did not write`);
ok('VIP-only run KEPT the competition it could not see',
  core4.lastRound['YJFL 2026|U14|9a9a9a9a'] === 16,
  'this is the merge-not-replace defect, fixed four times in four writers');
ok('VIP-only run reported one covered competition',
  /lastRound: 1 rebuilt for 1 covered competition\(s\), 1 kept/.test(r.out));
ok('no YJFL key was invented from a scope that never saw YJFL matches',
  !Object.keys(core4.lastRound).some(k => k === 'YJFL 2026|U12|9a9a9a9a'),
  JSON.stringify(Object.keys(core4.lastRound)));
ok('compLogos MERGED — YJFL entry survived a VIP-only run',
  core4.compLogos['YJFL 2026'] === 'http://x/yjfl.png', 'this is the second fix');

// ── 4a. A full run rebuilds lastRound, and must not ratchet ─────────────────
console.log('\n4a  A full run rebuilds lastRound from every competition');
reset();
r = run('fetch-results.js', {});   // no VIP_ONLY — covers both competitions
ok('exit 0', r.code === 0, `exit ${r.code}`);
const core4a = read(CORE);
ok('lastRound rebuilt from this season, not ratcheted up',
  core4a.lastRound['EFNL 2026|U12|6f964e7b'] === 1,
  `${JSON.stringify(core4a.lastRound)} — 14 here would mean a stale value survived`);
ok('the other competition is present, not deleted',
  core4a.lastRound['YJFL 2026|U12|9a9a9a9a'] === 1, JSON.stringify(core4a.lastRound));
// The YJFL fixture has one PRE-EXISTING stored match at U14 round 16 with no
// gradeId on it. The roster therefore has no gradeId for those teams either, so
// rosterGrade() falls back to the rawGrade — exactly as index.html does. The key
// is keyed on 'B', not on a grade id, and that is correct rather than a gap.
ok('a record with no gradeId keys on its rawGrade, matching the reader',
  core4a.lastRound['YJFL 2026|U14|B'] === 16, JSON.stringify(core4a.lastRound));
ok('every key has exactly three segments',
  Object.keys(core4a.lastRound).every(k => k.split('|').length === 3),
  JSON.stringify(Object.keys(core4a.lastRound)));
ok('every key starts with a compName that has a year in it',
  Object.keys(core4a.lastRound).every(k => /^[A-Z]+ \d{4}\|/.test(k)),
  JSON.stringify(Object.keys(core4a.lastRound)));
ok('both competitions were fetched', /2 competition-season\(s\)/.test(r.out));

// ── 5. Failure path: a live season ───────────────────────────────────────────
console.log('\n5  Guards must refuse rather than produce something wrong');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2026' });
ok('refuses a live season', r.code === 1 && /not retired/.test(r.out), `exit ${r.code}`);
ok('wrote no archive', !fs.existsSync(EFNL_ARC));

// ── 6. Failure path: compName is null ────────────────────────────────────────
reset();
r = run('backfill.js', { BACKFILL_ORG: '0f20da4f', BACKFILL_SEASON: '2024' });
ok('refuses a season with compName null', r.code === 1 && /compName: null/.test(r.out),
  `exit ${r.code}`);
ok('wrote no file for it', !fs.existsSync(sCore('ffff9999')));

// ── 7. Failure paths: bad inputs ─────────────────────────────────────────────
reset();
r = run('backfill.js', { BACKFILL_ORG: 'deadbeef', BACKFILL_SEASON: '2025' });
ok('refuses an unknown organisation', r.code === 1 && /no manifest entries/.test(r.out));
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '1999' });
ok('refuses an unknown season', r.code === 1 && /no season named/.test(r.out));
r = run('backfill.js', { BACKFILL_ORG: 'nope', BACKFILL_SEASON: '2025' });
ok('refuses a malformed organisation code', r.code === 1 && /8-character/.test(r.out));
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025', BACKFILL_PHASE: 'B' });
ok('refuses phase B', r.code === 1 && /not implemented/.test(r.out));

// ── 8. Dry run ───────────────────────────────────────────────────────────────
console.log('\n6  Dry run resolves and stops');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: '2025', BACKFILL_DRY_RUN: 'true' });
ok('exit 2', r.code === 2, `exit ${r.code}`);
ok('reported the season it would fetch', /EFNL 2025/.test(r.out));
ok('wrote nothing', !fs.existsSync(EFNL_ARC));

// ── 8. season: all ───────────────────────────────────────────────────────────
console.log('\n8  season "all" does every RETIRED season and skips the live one');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: 'all',
                         BACKFILL_SEASON_DELAY_MIN: '0' });
ok('exit 0', r.code === 0, `exit ${r.code}`);
ok('two seasons attempted, not three', /season 1\/2/.test(r.out) && /season 2\/2/.test(r.out),
  'the ACTIVE 2026 season must be excluded');
ok('oldest first', r.out.indexOf('season 1/2: EFNL 2024') < r.out.indexOf('season 2/2: EFNL 2025'));
// A season per file now, so "both seasons" means two files, not one file with
// two entries in it.
const s2025 = read(sCore('75d8a232')), s2024 = read(sCore('ca9cc98b'));
ok('both seasons written as separate files',
  fs.existsSync(sCore('75d8a232')) && fs.existsSync(sCore('ca9cc98b')));
ok('both have completeness recorded',
  s2025.meta.phases.results === true && s2024.meta.phases.results === true,
  `${JSON.stringify(s2025.meta.phases)} / ${JSON.stringify(s2024.meta.phases)}`);
ok('and neither contains the other season',
  s2025.matches.every(m => m.compName === 'EFNL 2025') &&
  s2024.matches.every(m => m.compName === 'EFNL 2024'));
ok('the live season file is untouched — backfill never fetches it',
  read(EFNL_CUR).matches.length === 0, `${read(EFNL_CUR).matches.length} matches`);
ok('no archived record leaked into current',
  !read(EFNL_CUR).matches.some(m => String(m.compName).match(/202[45]/)));
// "all" backfills 2025 and 2024. Each writes its own season's entry; neither may
// touch the live 2026 season or the other organisation.
{
  const lr = read(CORE).lastRound;
  ok('each backfilled season has its own entry',
    lr['EFNL 2025|U12|1debae74'] === 1 && lr['EFNL 2024|U12|25a4f589'] === 1,
    JSON.stringify(lr));
  ok('the live season is still 14 after two backfills',
    lr['EFNL 2026|U12|6f964e7b'] === 14, JSON.stringify(lr));
  ok('the other organisation is still 16', lr['YJFL 2026|U14|9a9a9a9a'] === 16);
}

// ── 8a. A failure part-way through stops and keeps what was written ──────────
console.log('\n8a  A season failing mid-loop stops, and earlier seasons survive');
reset();
r = run('backfill.js', { BACKFILL_ORG: '383836bb', BACKFILL_SEASON: 'all',
                         BACKFILL_SEASON_DELAY_MIN: '0', STUB_FAIL_SEASON: '75d8a232' });
ok('exit 1', r.code === 1, `exit ${r.code}`);
ok('named the season that failed', /in EFNL 2025/.test(r.out));
ok('reported what is already safe', /Already written and safe: EFNL 2024/.test(r.out));
// Separate files now, so the completed season and the failed one are checked
// independently rather than by filtering one shared archive.
ok('the earlier season IS on disk',
  fs.existsSync(sCore('ca9cc98b')) &&
  read(sCore('ca9cc98b')).matches.some(m => m.compName === 'EFNL 2024'));
ok('the failed season was never written',
  !fs.existsSync(sCore('75d8a232')) ||
  !read(sCore('75d8a232')).matches.some(m => m.compName === 'EFNL 2025'));

// ── 9. Could these have failed? ──────────────────────────────────────────────
// A suite that passes against an empty fixture proves nothing. Assert the
// fixture really contains what the tests claim to check.
// ── 8. gradeMeta is dual-keyed, with a display label ────────────────────────
// Identity moves to the grade id; the rawGrade key stays until index.html reads
// the id. Writing the new shape before the reader understands it is what
// duplicated records earlier today.
console.log('\n8  gradeMeta carries both keys and a label');
{
  const { buildGradeMeta } = require(path.join(TMP, 'scripts', 'lib', 'results-engine.js'));
  const meta = buildGradeMeta([
    { id: 'a1', name: 'U8 - Eastern', ageName: 'U8', genderName: 'Mixed', compName: 'EFNL 2026' },
    { id: 'a2', name: 'U8 - West', ageName: 'U8', genderName: 'Mixed', compName: 'EFNL 2026' },
    { id: 'b1', name: 'U12 Girls A', ageName: 'U12', genderName: 'Girls', compName: 'EFNL 2026' },
    { id: 'c1', name: 'U10 Mixed - Pool 3', ageName: 'U10', genderName: 'Mixed', compName: 'YJFL 2026' },
  ]);
  ok('the grade-id key exists for every grade',
    ['EFNL 2026|U8|a1', 'EFNL 2026|U8|a2', 'EFNL 2026|U12 Girls|b1', 'YJFL 2026|U10|c1']
      .every(k => meta[k]));
  ok('the old rawGrade key still exists — index.html is untouched',
    !!meta['EFNL 2026|U12 Girls|A'] && !!meta['EFNL 2026|U8|']);
  ok('the old key keeps its exact shape', 
    JSON.stringify(Object.keys(meta['EFNL 2026|U12 Girls|A']).sort()) === '["g","lvl","r"]',
    JSON.stringify(meta['EFNL 2026|U12 Girls|A']));
  ok('two collapsed grades get DISTINCT id keys',
    meta['EFNL 2026|U8|a1'].r !== meta['EFNL 2026|U8|a2'].r,
    'ranks ' + meta['EFNL 2026|U8|a1'].r + ' and ' + meta['EFNL 2026|U8|a2'].r);
  ok('a blank rawGrade gets a real label', meta['EFNL 2026|U8|a2'].label === 'West',
    JSON.stringify(meta['EFNL 2026|U8|a2'].label));
  ok('a pool name survives', meta['YJFL 2026|U10|c1'].label === 'Pool 3',
    JSON.stringify(meta['YJFL 2026|U10|c1'].label));
  ok('a working label is left ALONE', meta['EFNL 2026|U12 Girls|b1'].label === 'A',
    JSON.stringify(meta['EFNL 2026|U12 Girls|b1'].label));

  // Labels must be UNIQUE within a competition and age. Prefixing alone is not
  // enough — four grades can share a rawGrade AND a prefix, which left SEJ 2022
  // with four ladders all labelled "AFLSE Premier". Found 2026-08-12 by sweeping
  // the real grades.json rather than by checking one competition.
  const m3 = buildGradeMeta([
    { id: 'p1', name: 'AFLSE - Chisholm U17 Premier A', ageName: 'U17', genderName: 'Boys', compName: 'SEJ 2022' },
    { id: 'p2', name: 'AFLSE - Chisholm U17 Premier B', ageName: 'U17', genderName: 'Boys', compName: 'SEJ 2022' },
    { id: 'p3', name: 'AFLSE - Chisholm U17 Premier C', ageName: 'U17', genderName: 'Boys', compName: 'SEJ 2022' },
  ]);
  const lbls = Object.values(m3).filter(v => v.gradeId).map(v => v.label);
  ok('four grades sharing a rawGrade AND a prefix still get distinct labels',
    new Set(lbls).size === lbls.length, lbls.join(' | '));
  ok('no label is left blank by the escalation', lbls.every(l => l && l.trim()));

  // A name ending in a bare gender word has nothing to distinguish it, so the
  // prefix is used: "Little Demons - U10 Mixed" beside "Little Demons Blue".
  const m4 = buildGradeMeta([
    { id: 'q1', name: 'Little Demons - U10 Mixed', ageName: 'U10', genderName: 'Mixed', compName: 'SEJ 2026' },
  ]);
  ok('a bare gender word becomes the prefix', m4['SEJ 2026|U10|q1'].label === 'Little Demons',
    JSON.stringify(m4['SEJ 2026|U10|q1'].label));

  // Could that have failed? A grade with no dash and no rawGrade must not
  // produce an empty label silently.
  const m2 = buildGradeMeta([{ id: 'z1', name: 'U8 Mixed Central', ageName: 'U8',
    genderName: 'Mixed', compName: 'YJFL 2026' }]);
  ok('a name with no dash still yields a label',
    !!(m2['YJFL 2026|U8|z1'] || {}).label, JSON.stringify((m2['YJFL 2026|U8|z1'] || {}).label));
}

// ── 9. rebuildRoster resolves on grade identity ─────────────────────────────
console.log('\n9  Roster conflicts are detected on the grade id');
{
  const { rebuildRoster } = require(path.join(TMP, 'scripts', 'lib', 'results-engine.js'));
  const R = (h, a, rg, gid, rd) => ({ compName: 'EFNL 2026', age: 'U8', rawGrade: rg,
    gradeId: gid, round: rd, home: h, away: a, isFinals: false });

  // Two genuinely separate grades that both parse to "". Detected on rawGrade
  // these compared EQUAL, so the conflict was invisible and currentGrade()
  // could return a grade the team was not in.
  let r = rebuildRoster([R('Norwood', 'A1', '', 'gN', 1), R('Norwood', 'B1', '', 'gS', 1)]);
  ok('two blank-rawGrade grades are now seen as a conflict',
    !!r['EFNL 2026|Norwood|U8'].gradeId, JSON.stringify(r['EFNL 2026|Norwood|U8']));

  // The lettered grade wins, and the id must follow it. The old code set the
  // winning LABEL while keeping the previous grade's id, so a team could be
  // stored as grade "A" carrying another grade's id — and index.html groups on
  // the id, so it would have appeared in the wrong ladder.
  r = rebuildRoster([R('Norwood', 'A1', '', 'gN', 1), R('Norwood', 'B1', 'A', 'gA', 1)]);
  ok('a lettered grade beats a blank one', r['EFNL 2026|Norwood|U8'].grade === 'A',
    JSON.stringify(r['EFNL 2026|Norwood|U8'].grade));
  ok('and the gradeId FOLLOWS the winning grade, not the loser',
    r['EFNL 2026|Norwood|U8'].gradeId === 'gA',
    JSON.stringify(r['EFNL 2026|Norwood|U8'].gradeId));

  // Could that have failed? Same grade twice must raise nothing at all.
  r = rebuildRoster([R('Norwood', 'A1', 'A', 'gA', 1), R('Norwood', 'B1', 'A', 'gA', 1)]);
  ok('the same grade twice is not a conflict',
    r['EFNL 2026|Norwood|U8'].grade === 'A' && r['EFNL 2026|Norwood|U8'].gradeId === 'gA');

  // A later round always wins outright, conflict or not.
  r = rebuildRoster([R('Norwood', 'A1', 'A', 'gA', 1), R('Norwood', 'B1', 'B', 'gB', 5)]);
  ok('a later round supersedes an earlier grade', r['EFNL 2026|Norwood|U8'].gradeId === 'gB',
    JSON.stringify(r['EFNL 2026|Norwood|U8']));
}

// ── 10b. buildGradeMeta carries the grade NAME ──────────────────────────────
// index.html identifies a GRADING grade by name and never loads grades.json, so
// the name has to travel in gradeMeta. Without it every grading grade silently
// behaves like an ordinary one — no error, no empty tab, just the wrong ladder.
// grade_attribution_split_design.md §2.3.
console.log('\n10b buildGradeMeta carries the grade name');
{
  const { buildGradeMeta } = require(path.join(TMP, 'scripts', 'lib', 'results-engine.js'));
  const meta = buildGradeMeta([
    { id: 'g1', compName: 'EFNL 2026', name: 'U13 Mixed GRADING', ageName: 'U13', genderName: 'Mixed' },
    { id: 'g2', compName: 'EFNL 2026', name: 'U13 Mixed A', ageName: 'U13', genderName: 'Mixed' },
  ]);
  const byId = {};
  for (const v of Object.values(meta)) if (v && v.gradeId) byId[v.gradeId] = v;
  ok('the grade-id entry carries name', byId.g1 && byId.g1.name === 'U13 Mixed GRADING',
    JSON.stringify(byId.g1));
  ok('and it is the NAME, not the label',
    byId.g1 && byId.g1.label !== byId.g1.name, JSON.stringify(byId.g1));
  ok('an ordinary grade carries its name too',
    byId.g2 && byId.g2.name === 'U13 Mixed A');
  // r: 0 and grading: true. The rank sequence must be UNDISTURBED — this is the
  // reasoning the original skip was protecting and it still has to hold.
  ok('a grading grade is unranked', byId.g1 && byId.g1.r === 0, String(byId.g1 && byId.g1.r));
  ok('and flagged, so r:0 is distinguishable from missing metadata',
    byId.g1 && byId.g1.grading === true, JSON.stringify(byId.g1));
  ok('the real grade keeps rank 1 — grading took no slot',
    byId.g2 && byId.g2.r === 1, String(byId.g2 && byId.g2.r));
  ok('an ordinary grade is NOT flagged', byId.g2 && byId.g2.grading === undefined);
  // Could that have failed? The label is UNRELIABLE, not useless — for
  // "U13 Mixed GRADING" labelOf happens to produce "Grading", so a label test
  // would appear to work here and fail on a format where the label is "A". The
  // flag is what identifies it, and this asserts the flag does not merely agree
  // with the label by accident.
  ok('the flag does not depend on the label matching',
    byId.g1 && byId.g1.grading === true &&
    byId.g2 && byId.g2.grading === undefined && /^[A-Z]$/.test(byId.g2.label || ''),
    `g1.label=${byId.g1 && byId.g1.label} g2.label=${byId.g2 && byId.g2.label}`);
}

// ── 11. A past-dated round with no results must not stop the walk ───────────
// unplayed_round_blocker_design.md. fetchGrade() used to break on the first round
// with games and no final result, on the assumption it was the leading edge of
// the season. A PLACEHOLDER breaks that assumption: SEJ 2026 round 10 of
// cb7b3db3 is one PENDING game, "Dummy U10 Girls 1 v Dummy U10 Girls 2", venue
// TBC, dated 2026-07-12 — the week a Lightning Premiership round robin replaced
// the fixture. It will never become final, so the walk stopped there permanently
// and rounds 11 to 14 were never fetched. Four rounds, eight real games.
//
// The stub serves three rounds and STUB_R2 sets what round 2 looks like. The
// existing tests all run with one round, which is why none of them exercised the
// walk at all.
console.log('\n11  A placeholder round does not stop the round walk');
{
  const R = (n) => `EFNL 2026|U12|6f964e7b|${n}|`;
  const roundsIn = (p) => (read(p).matches || [])
    .filter(m => !m.isBye && !m.isPartial)
    .map(m => String(m.id).split('|')[3])
    .filter((v, i, a) => a.indexOf(v) === i).sort();

  // PAST-DATED placeholder at round 2. Round 3 must still be reached.
  reset();
  let r = run('fetch-results.js', { VIP_ONLY: 'true', STUB_ROUNDS: '3', STUB_R2: 'placeholder' });
  ok('exit 0', r.code === 0, `exit ${r.code}`);
  ok('the placeholder is recognised by its date',
    /dated 2020-01-05 in the past — placeholder or abandoned, continuing/.test(r.out),
    'this is the branch the whole change adds');
  ok('round 3 WAS fetched despite round 2 having no results',
    roundsIn(EFNL_CUR).includes('3'), JSON.stringify(roundsIn(EFNL_CUR)));
  ok('round 1 is still there', roundsIn(EFNL_CUR).includes('1'));
  ok('the placeholder round itself stored NOTHING',
    !roundsIn(EFNL_CUR).includes('2'), JSON.stringify(roundsIn(EFNL_CUR)));
  // Not a bye. A bye asserts the grade had no game that week; it did play, in
  // another grade. Writing one would hide the gap from the audit.
  ok('and no bye sentinel was invented for it',
    !(read(EFNL_CUR).matches || []).some(m => m.isBye && String(m.id).includes('|2|')),
    'a bye would assert something false and hide the gap');
  // The consecutive scan must still stop at 1, because round 2 is genuinely
  // absent. That is what makes the branch run again next time.
  ok('the gap is left visible rather than papered over',
    roundsIn(EFNL_CUR).join(',') === '1,3', roundsIn(EFNL_CUR).join(','));

  // FUTURE-DATED. This is the behaviour being PRESERVED. Without this assertion
  // the fix could pass by simply never stopping, which would walk every unplayed
  // round of every grade on every run.
  reset();
  r = run('fetch-results.js', { VIP_ONLY: 'true', STUB_ROUNDS: '3', STUB_R2: 'future' });
  ok('a future-dated round still STOPS the walk',
    /scheduled, not yet played \(2099-01-05\) — stopping/.test(r.out));
  ok('so round 3 was NOT fetched',
    !roundsIn(EFNL_CUR).includes('3'), JSON.stringify(roundsIn(EFNL_CUR)));

  // UNDATED. No date is no evidence, and the safe reading of no evidence is the
  // behaviour that was already there.
  reset();
  r = run('fetch-results.js', { VIP_ONLY: 'true', STUB_ROUNDS: '3', STUB_R2: 'undated' });
  ok('an undated round falls back to stopping',
    /scheduled, not yet played — stopping/.test(r.out) &&
    !/dated .* in the past/.test(r.out));
  ok('and round 3 was NOT fetched', !roundsIn(EFNL_CUR).includes('3'));

  // A bye is a different thing again and already had its own handling. Asserted
  // so this change cannot have altered it.
  reset();
  r = run('fetch-results.js', { VIP_ONLY: 'true', STUB_ROUNDS: '3', STUB_R2: 'empty' });
  ok('a round with NO games is still a bye, not a placeholder',
    /bye — continuing/.test(r.out) && !/placeholder or abandoned/.test(r.out));
  ok('and a bye sentinel IS written for it',
    (read(EFNL_CUR).matches || []).some(m => m.isBye && String(m.id).includes('|2|')));
  ok('a bye does not stop the walk either', roundsIn(EFNL_CUR).includes('3'));

  // IDEMPOTENCY. A second run over a stored placeholder must add nothing.
  reset();
  run('fetch-results.js', { VIP_ONLY: 'true', STUB_ROUNDS: '3', STUB_R2: 'placeholder' });
  const before = (read(EFNL_CUR).matches || []).length;
  r = run('fetch-results.js', { VIP_ONLY: 'true', STUB_ROUNDS: '3', STUB_R2: 'placeholder' });
  ok('a second run duplicates nothing',
    (read(EFNL_CUR).matches || []).length === before,
    `${before} then ${(read(EFNL_CUR).matches || []).length}`);
  ok('and it walks past the placeholder again',
    /placeholder or abandoned, continuing/.test(r.out),
    'the gap is permanent, so this costs one call per run — by design');
}

// ── 12. A renamed team must SUPERSEDE its old record, not add beside it ──────
// Fix A of lastround/rename design. The match id embeds both team names, so when
// PlayHQ renames a team the next re-fetch of that round builds a DIFFERENT id and
// byId cannot tell it is the same fixture. Before engine v16 the old record
// survived and the new one was added beside it, so the ladder counted the game
// twice.
//
// Measured in SEJ 2026 U10 on 2026-08-13: sixteen phantom records in a5a8276d and
// six in cb7b3db3, one per renamed side, all on round 9 — the round that was the
// highest known when the rename landed. Every affected ladder gained a game in
// its P column.
//
// STUB_RENAME re-serves identical fixture ids under changed names.
console.log('\n12  A renamed team supersedes rather than duplicates');
{
  const count = (p) => (read(p).matches || []).filter(m => !m.isBye && !m.isPartial).length;
  const names = (p) => [...new Set((read(p).matches || [])
    .flatMap(m => [m.home, m.away]).filter(Boolean))].sort();

  reset();
  let r = run('fetch-results.js', { VIP_ONLY: 'true' });
  ok('exit 0 on the first run', r.code === 0, `exit ${r.code}`);
  const before = count(EFNL_CUR);
  ok('records stored under the original names', before === 2, `${before}`);
  ok('and they carry a gameId',
    (read(EFNL_CUR).matches || []).every(m => m.isBye || m.isPartial || !!m.gameId),
    JSON.stringify((read(EFNL_CUR).matches || []).map(m => m.gameId)));
  ok('the original names are stored',
    names(EFNL_CUR).includes('Blackburn'), JSON.stringify(names(EFNL_CUR)));

  // Same fixture ids, new names. THE assertion: the count must not grow.
  r = run('fetch-results.js', { VIP_ONLY: 'true', STUB_RENAME: 'true' });
  ok('exit 0 after the rename', r.code === 0, `exit ${r.code}`);
  ok('the record count did NOT grow',
    count(EFNL_CUR) === before,
    `${before} before, ${count(EFNL_CUR)} after — a grown count is the duplicate`);
  ok('the supersede was reported, not silent',
    /Superseded \d+ record\(s\) whose team name\(s\) changed/.test(r.out),
    'replacing stored data quietly is not something to find out later');
  ok('the NEW name is stored',
    names(EFNL_CUR).includes('Blackburn - LP'), JSON.stringify(names(EFNL_CUR)));
  ok('the OLD name is GONE',
    !names(EFNL_CUR).includes('Blackburn'), JSON.stringify(names(EFNL_CUR)));

  // Could it have failed? A run with no rename must supersede nothing, or the
  // assertion above would pass for any run at all.
  reset();
  run('fetch-results.js', { VIP_ONLY: 'true' });
  r = run('fetch-results.js', { VIP_ONLY: 'true' });
  ok('an unchanged re-run supersedes nothing',
    !/Superseded/.test(r.out), 'otherwise the check fires on every run and means nothing');
  ok('and still stores exactly two records', count(EFNL_CUR) === 2, `${count(EFNL_CUR)}`);

  // Records written before v16 have no gameId. They must behave exactly as they
  // did — indexed by id alone, never colliding on an empty gameId.
  reset();
  run('fetch-results.js', { VIP_ONLY: 'true' });
  {
    const f = read(EFNL_CUR);
    f.matches.forEach(m => { delete m.gameId; });
    fs.writeFileSync(EFNL_CUR, JSON.stringify(f));
    r = run('fetch-results.js', { VIP_ONLY: 'true' });
    ok('pre-v16 records with no gameId do not collapse together',
      count(EFNL_CUR) === 2, `${count(EFNL_CUR)} — an empty gameId must not be an index key`);
    ok('and they acquire a gameId when re-fetched',
      (read(EFNL_CUR).matches || []).every(m => m.isBye || m.isPartial || !!m.gameId),
      'this is what makes the fix need no migration');
    // The read-side `if (m.gameId)` guard. Two pre-v16 records both have no
    // gameId, so indexing them anyway would file both under the empty string and
    // report a duplicate that does not exist. That is cosmetic rather than
    // corrupting — it produces a wrong log line, not wrong data — which is why it
    // needs its own assertion instead of being covered by the count checks.
    ok('two gameId-less records are NOT reported as duplicates of each other',
      !/Pre-existing gameId duplicates found/.test(r.out),
      'an empty gameId is not an identity');
  }
}

// ── 10. lastRoundKey resolves through the ROSTER, not the record ─────────────
// The network stub serves one grade per season, so no run() test can produce a
// promoted team, and the whole suite passed with the roster lookup replaced by
// m.gradeId. That made the roster resolution an untested guard, so it is tested
// directly here — the same way buildGradeMeta and rebuildRoster are above.
console.log('\n10  lastRound keys on the grade a team is in NOW');
{
  const { lastRoundKey, rebuildRoster } = require(path.join(TMP, 'scripts', 'lib', 'results-engine.js'));

  // A promotion: Norwood plays grade B in R1 and grade A in R5. rebuildRoster
  // takes the later round, so the roster says A. index.html therefore counts
  // Norwood on the A ladder for BOTH matches.
  const M = (rg, gid, rd) => ({ compName: 'EFNL 2026', age: 'U12', rawGrade: rg,
    gradeId: gid, round: rd, home: 'Norwood', away: 'Vermont', isFinals: false });
  const roster = rebuildRoster([M('B', 'gB', 1), M('A', 'gA', 5)]);
  ok('the roster says the team is in the LATER grade',
    roster['EFNL 2026|Norwood|U12'].gradeId === 'gA',
    JSON.stringify(roster['EFNL 2026|Norwood|U12']));

  // The round-1 record still carries gradeId gB. Keying on the record would file
  // it under gB — a key index.html never builds, so no round tag renders and it
  // looks like a grade that has not played yet.
  ok('the R1 record keys on gA, not on its own gB',
    lastRoundKey(M('B', 'gB', 1), 'home', roster) === 'EFNL 2026|U12|gA',
    lastRoundKey(M('B', 'gB', 1), 'home', roster));
  ok('and so does the R5 record',
    lastRoundKey(M('A', 'gA', 5), 'home', roster) === 'EFNL 2026|U12|gA');

  // Could that have failed? A team that was never promoted must key on its own
  // grade, or the assertion above would pass for the wrong reason.
  const plain = rebuildRoster([M('A', 'gA', 1)]);
  ok('an unpromoted team keys on its own grade',
    lastRoundKey(M('A', 'gA', 1), 'home', plain) === 'EFNL 2026|U12|gA');

  // No gradeId anywhere: falls back to rawGrade, exactly as rosterGrade() does.
  const noId = rebuildRoster([{ compName: 'YJFL 2026', age: 'U14', rawGrade: 'B',
    round: 16, home: 'Ivanhoe', away: 'Kew', isFinals: false }]);
  ok('with no gradeId it falls back to rawGrade',
    lastRoundKey({ compName: 'YJFL 2026', age: 'U14', rawGrade: 'B', round: 16,
      home: 'Ivanhoe', away: 'Kew' }, 'home', noId) === 'YJFL 2026|U14|B');

  // A team absent from the roster must still produce a three-segment key rather
  // than "undefined" anywhere in it.
  ok('a team missing from the roster still yields three segments',
    lastRoundKey(M('A', 'gA', 1), 'home', {}) === 'EFNL 2026|U12|A');
  ok('the away side is keyed too, not just home',
    lastRoundKey(M('A', 'gA', 5), 'away', roster).split('|').length === 3);
}

// ── 13. A result must CLEAR the scheduled flag on the fixture it supersedes ──
// Engine v18. fetch-fixtures.js writes a scheduled record under the SAME match id
// the results engine builds, so when the game is played the result merges into it
// at `{ ...prev, ...m }`. A result record has no `scheduled` key, so there is
// nothing to overwrite `prev.scheduled` and `true` survives the spread.
//
// index.html splits on exactly that flag —
//   S.matches = d.matches.filter(m => !m.isBye && !m.scheduled)
// — so the record never reaches the results list, and isPlayed() is
// `!m.scheduled && ...`, so the finals view draws it as an unplayed fixture with
// blank scores. Correct scores, stored, invisible.
//
// AND IT NEVER SELF-CORRECTED. The scores merged in on the first run after the
// game, so every later run found prev[k] === m[k], reported `0 new, 0 updated`,
// and the workflow skipped the commit. The log was indistinguishable from a run
// with genuinely nothing to do, which is why this survived from whenever
// fetch-fixtures.js began writing finals fixtures until 2026-08-16.
//
// Measured on EFNL 2026 Veterans: four Semi Finals records stored with hScore
// 59, 33, 86 and 68, all four carrying `scheduled: true`, none on screen.
//
// THE FIXTURE SEEDS THE SCORES THE STUB WILL RETURN. That is the whole point: if
// the seeded scores differed, `scoreChanged` alone would count the update and the
// test would pass against the old code.
console.log('\n13  A result clears the scheduled flag on the fixture it supersedes');
{
  // The ids the engine builds for the stub's two round-1 games. cleanTeam strips
  // the U12 suffix and the pair is sorted, so these are Blackburn|Norwood and
  // Mitcham|Vermont — not the home/away order.
  const ID1 = 'EFNL 2026|U12|6f964e7b|1|Blackburn|Norwood';
  const ID2 = 'EFNL 2026|U12|6f964e7b|1|Mitcham|Vermont';
  const contaminated = () => ([
    { id: ID1, compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', gradeId: '6f964e7b',
      round: 1, gameId: 'g1-r1-6f964e7b', home: 'Blackburn', away: 'Norwood',
      hScore: 65, hG: 10, hB: 5, aScore: 51, aG: 8, aB: 3,
      date: '2025-04-05', time: '12:30:00', scheduled: true },
    { id: ID2, compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', gradeId: '6f964e7b',
      round: 1, gameId: 'g2-r1-6f964e7b', home: 'Vermont', away: 'Mitcham',
      hScore: 78, hG: 12, hB: 6, aScore: 26, aG: 4, aB: 2,
      date: '2025-04-05', time: '12:30:00', scheduled: true },
  ]);
  const byId = (p) => Object.fromEntries((read(p).matches || []).map(m => [m.id, m]));

  reset();
  writeSeason('2dcbf383', '383836bb', ['EFNL 2026'], { matches: contaminated() });

  // The fixture is real: both seeded records must actually be flagged, or every
  // assertion below passes for the wrong reason.
  {
    const b = byId(EFNL_CUR);
    ok('seeded two records, both flagged scheduled',
      !!b[ID1] && !!b[ID2] && b[ID1].scheduled === true && b[ID2].scheduled === true,
      'the defect cannot be reproduced without this');
    ok('and their scores already match what the stub returns',
      b[ID1].hScore === 65 && b[ID1].aScore === 51,
      'if they differed, scoreChanged alone would count the update and prove nothing');
  }

  const r = run('fetch-results.js', { VIP_ONLY: 'true' });
  ok('exit 0 — the promotion is a change worth committing', r.code === 0,
    `exit ${r.code}. Exit 2 means the repair is computed and then thrown away, ` +
    `which is the state the defect sat in`);

  const after = byId(EFNL_CUR);
  ok('the first record is no longer flagged scheduled',
    after[ID1] && after[ID1].scheduled === undefined,
    JSON.stringify(after[ID1] && after[ID1].scheduled));
  ok('and neither is the second',
    after[ID2] && after[ID2].scheduled === undefined,
    JSON.stringify(after[ID2] && after[ID2].scheduled));
  ok('the promotion was reported, not silent',
    /Promoted \d+ stored fixture\(s\) to results/.test(r.out),
    'a record changing class without a log line is how this went unnoticed');
  ok('the record count did NOT grow',
    (read(EFNL_CUR).matches || []).filter(m => !m.isBye && !m.isPartial).length === 2,
    'a promotion must supersede in place, never add beside');
  ok('scores survived the promotion',
    after[ID1].hScore === 65 && after[ID1].aScore === 51,
    `${after[ID1].hScore}-${after[ID1].aScore}`);
  ok('gameId survived the promotion', after[ID1].gameId === 'g1-r1-6f964e7b',
    String(after[ID1].gameId));

  // index.html's own split, run over what was actually written. This is the
  // assertion that matches the symptom: a promoted record must land in S.matches.
  const stored = read(EFNL_CUR).matches || [];
  ok('both records now reach S.matches',
    stored.filter(m => !m.isBye && !m.scheduled).length === 2,
    `${stored.filter(m => !m.isBye && !m.scheduled).length} — this is the page-side split verbatim`);
  ok('and neither is left in S.fixtures',
    stored.filter(m => m.scheduled).length === 0,
    `${stored.filter(m => m.scheduled).length}`);

  // A promoted record must also read as PLAYED, which is a separate test from the
  // split: the finals view uses isPlayed(), not the S.matches filter.
  const isPlayed = m => !m.scheduled && m.hScore !== null && m.hScore !== undefined;
  ok('a promoted record reads as played, so the finals view shows its score',
    stored.every(m => m.isBye || m.isPartial || isPlayed(m)),
    'blank score cells in the finals view are this test failing');

  // `provisional` must go with the flag. isProvSide() tests
  // `m.provisional && !m.hLogo`, and the logo strip runs on records that are no
  // longer scheduled — so a surviving flag renders a PLAYED team as a greyed
  // "Winner Game 1" placeholder the moment its logos are stripped.
  reset();
  writeSeason('2dcbf383', '383836bb', ['EFNL 2026'], {
    matches: contaminated().map(m => ({ ...m, provisional: true })),
  });
  run('fetch-results.js', { VIP_ONLY: 'true' });
  ok('provisional is cleared along with scheduled',
    (read(EFNL_CUR).matches || []).every(m => m.provisional === undefined),
    'otherwise a played team renders as a placeholder once its logos are stripped');

  // COULD THESE HAVE FAILED? A run with nothing to promote must promote nothing,
  // or the log assertion above fires on every run and means nothing at all.
  reset();
  run('fetch-results.js', { VIP_ONLY: 'true' });
  const r2 = run('fetch-results.js', { VIP_ONLY: 'true' });
  ok('a run with no scheduled records promotes nothing',
    !/Promoted \d+ stored fixture/.test(r2.out),
    'the promotion path must not fire on ordinary results');
  ok('and that run still reports no changes',
    r2.code === 2, `exit ${r2.code} — an ordinary re-run must not be made to look dirty`);

  // A genuine score change must still count on its own, independently of any
  // promotion. Seed a scheduled record with WRONG scores: both conditions are
  // true at once and the record must still be promoted and corrected.
  reset();
  writeSeason('2dcbf383', '383836bb', ['EFNL 2026'], {
    matches: contaminated().map(m => ({ ...m, hScore: 1, aScore: 1 })),
  });
  run('fetch-results.js', { VIP_ONLY: 'true' });
  {
    const b = byId(EFNL_CUR);
    ok('a stale scheduled record is both corrected and promoted',
      b[ID1].hScore === 65 && b[ID1].scheduled === undefined,
      `${b[ID1].hScore}, scheduled=${b[ID1].scheduled}`);
  }
}

console.log('\n7  The fixture is real');
reset();
ok('core seeded with two compLogos', Object.keys(read(CORE).compLogos).length === 2);
ok('core seeded with three lastRound keys', Object.keys(read(CORE).lastRound).length === 3,
  JSON.stringify(Object.keys(read(CORE).lastRound)));
ok('one seeded key is a pre-v14 two-segment key',
  Object.keys(read(CORE).lastRound).filter(k => k.split('|').length === 2).length === 1,
  'without this the drop test above proves nothing');
ok('EFNL current starts empty', read(EFNL_CUR).matches.length === 0);
ok('archive genuinely absent', !fs.existsSync(EFNL_ARC));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
