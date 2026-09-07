// scripts/verify-discover-seasons.js
//
// Verifies that scripts/discover-seasons.js preserves what the manifest already
// holds instead of rebuilding it from the API alone: the per-season completeness
// flags (storage_ingestion_design.md §6.1a) and, from v2, EVERY key it did not
// itself derive — `state` and `stateAt` for off-season mode, or anything added
// later. Measured 2026-09-07: v2 of the script wiped those on every run.
// From v3 it also checks the season `state` the script derives — PlayHQ's status
// first, the local backstop second (offseason_mode_design.md).
//
// It runs the REAL script end to end as a child process, with only the network
// stubbed — a stubbed scripts/lib/playhq.js returning canned GraphQL responses.
// Everything else is the committed code. Testing a reimplementation of the
// manifest builder would prove nothing about what actually runs.
//
// It works in a temporary tree, so the repository's config.json and data/ are
// never read or written.
//
// Run: node scripts/verify-discover-seasons.js    Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-discover-seasons v3 2026-09-07';
console.log(`=== ${VERSION} ===`);

const REAL = path.join(__dirname, 'discover-seasons.js');
if (!fs.existsSync(REAL)) {
  console.error(`FATAL: ${REAL} not found. Run from the repository root.`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-verify-'));
const CORE = path.join(TMP, 'data', 'core.json');
fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'seasons'), { recursive: true });
fs.copyFileSync(REAL, path.join(TMP, 'scripts', 'discover-seasons.js'));

// ── The stub. Only the network. ──────────────────────────────────────────────
// EFNL with a live 2026 season and a completed 2025 one whose end date is far
// enough in the past to be retired.
fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'), `
'use strict';
const COMPS = [{
  id: '23965e53', name: 'Community Football',
  organisation: { id: '383836bb', name: 'Eastern Football Netball League' },
  seasons: [
    { id: '2dcbf383', name: '2026', startDate: '2025-10-01', endDate: '2026-09-30',
      status: { name: 'Active', value: 'ACTIVE' } },
    { id: '75d8a232', name: '2025', startDate: '2024-10-01', endDate: '2025-09-30',
      status: { name: 'Completed', value: 'COMPLETED' } },
  ],
}];
// A section can replace the canned competitions by writing stub-comps.json.
// An array applies to every organisation; an object is keyed by organisation
// code, and a code with no entry gets an empty array — a legitimate PlayHQ answer.
function comps(code) {
  const p = require('path').join(__dirname, '..', '..', 'stub-comps.json');
  if (!require('fs').existsSync(p)) return COMPS;
  const o = JSON.parse(require('fs').readFileSync(p, 'utf8'));
  return Array.isArray(o) ? o : (o[code] || []);
}
async function gqlPost(query, vars, opName) {
  if (opName === 'discoverCompetitions') return { data: { discoverCompetitions: comps(vars.organisationID) } };
  if (opName === 'discoverOrganisation') {
    return { data: { discoverOrganisation: { id: '383836bb', type: 'ASSOCIATION',
      name: 'Eastern Football Netball League',
      address: { suburb: 'Boronia', state: 'VIC', postcode: '3155' } } } };
  }
  throw new Error('unexpected operation in stub: ' + opName);
}
module.exports = {
  gqlPost,
  refreshSession: async () => {},
  sleep: async () => {},
  logSummary: () => {},
};
`);

// config.json in the pre-migration shape the repo is actually in.
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  competitions: [{ name: 'EFNL 2026', seasonID: '2dcbf383', vip: true, excludeGrades: [] }],
  organisationCodes: ['383836bb'],
}, null, 2));

function writeCore(manifest) {
  fs.writeFileSync(CORE, JSON.stringify(manifest === null ? {} : {
    manifest,
    clubs: { Blackburn: 1 },
  }, null, 2));
}

function run() {
  const r = spawnSync(process.execPath, ['scripts/discover-seasons.js'], {
    cwd: TMP, encoding: 'utf8',
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout + r.stderr };
}

const read = () => JSON.parse(fs.readFileSync(CORE, 'utf8'));
const phasesOf = (id) => (read().manifest.find((m) => m.seasonId === id) || {}).phases;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 1. Phases already recorded must survive a discovery run ──────────────────
console.log('\n1  A backfilled season keeps its completeness flags');
writeCore([
  { org: '383836bb', seasonId: '75d8a232', compName: 'EFNL 2025', retired: true,
    phases: { results: true, players: false, matches: 4870, players_n: 0 } },
  { org: '383836bb', seasonId: '2dcbf383', compName: 'EFNL 2026', retired: false,
    phases: { results: true, players: true, matches: 5420, players_n: 44889 } },
]);
let r = run();
ok('script ran without a fatal error', r.code === 0 || r.code === 2, `exit ${r.code}`);
ok('version line printed', /v4 2026-09-07 season-state/.test(r.out));
ok('carry-forward count reported', /carried-forward phase records: 2/.test(r.out),
  (r.out.match(/carried-forward phase records: \d+/) || ['not printed'])[0]);
ok('2025 kept results=true', phasesOf('75d8a232') && phasesOf('75d8a232').results === true,
  JSON.stringify(phasesOf('75d8a232')));
ok('2025 kept players=false', phasesOf('75d8a232') && phasesOf('75d8a232').players === false);
ok('2025 kept its counts', phasesOf('75d8a232') && phasesOf('75d8a232').matches === 4870);
ok('2026 kept results and players', phasesOf('2dcbf383') &&
  phasesOf('2dcbf383').results === true && phasesOf('2dcbf383').players === true);

// ── 2. Could this have failed? ───────────────────────────────────────────────
// If the flags were being reset, they would read false here. Prove the fixture
// actually asserts something by checking the retired flag was recomputed — the
// script did do work, it did not simply copy the old manifest through.
console.log('\n2  The manifest was genuinely rebuilt, not copied');
const m2025 = read().manifest.find((m) => m.seasonId === '75d8a232');
ok('2025 recomputed as retired', m2025.retired === true);
ok('2025 file path points at the archive', m2025.file === 'data/orgs/383836bb-archive.json', m2025.file);
ok('compName resolved from the matched short name', m2025.compName === 'EFNL 2025', m2025.compName);
ok('2026 recomputed as live', read().manifest.find((m) => m.seasonId === '2dcbf383').retired === false);

// ── 3. A season never seen before starts false ───────────────────────────────
console.log('\n3  A season with no prior record starts false, not undefined');
writeCore([
  { org: '383836bb', seasonId: '2dcbf383', compName: 'EFNL 2026', retired: false,
    phases: { results: true, players: true, matches: 5420, players_n: 44889 } },
]); // 2025 deliberately absent
r = run();
ok('script ran', r.code === 0 || r.code === 2, `exit ${r.code}`);
ok('unseen 2025 defaults to false/false',
  phasesOf('75d8a232') && phasesOf('75d8a232').results === false &&
  phasesOf('75d8a232').players === false, JSON.stringify(phasesOf('75d8a232')));
ok('known 2026 still carried forward', phasesOf('2dcbf383').results === true);

// ── 4. No core.json at all ───────────────────────────────────────────────────
console.log('\n4  A fresh clone with no core.json must not crash');
fs.rmSync(CORE, { force: true });
r = run();
ok('script ran', r.code === 0 || r.code === 2, `exit ${r.code}`);
ok('core.json created', fs.existsSync(CORE));
ok('nothing carried forward', /carried-forward phase records: 0/.test(r.out));
ok('both seasons start false',
  phasesOf('2dcbf383').results === false && phasesOf('75d8a232').results === false);

// ── 5. Idempotency ───────────────────────────────────────────────────────────
// Re-running with nothing changed must report no change and exit 2. Under the
// previous behaviour a discovery run after a backfill always flipped the flags
// back to false, so it always reported a change and always committed.
console.log('\n5  Re-running after a backfill reports NO change');
writeCore([
  { org: '383836bb', seasonId: '75d8a232', compName: 'EFNL 2025', retired: true,
    phases: { results: true, players: false, matches: 4870, players_n: 0 } },
  { org: '383836bb', seasonId: '2dcbf383', compName: 'EFNL 2026', retired: false,
    phases: { results: true, players: true, matches: 5420, players_n: 44889 } },
]);
run();                       // settle any unrelated difference from the fixture
const settled = JSON.stringify(read().manifest);
r = run();                   // the run under test
ok('exit 2, no change', r.code === 2, `exit ${r.code}`);
ok('manifest byte-identical across runs', JSON.stringify(read().manifest) === settled);

// ── 6. Keys this script did not derive must survive ─────────────────────────
// Off-season mode writes `state` and `stateAt` onto manifest entries and runs
// discovery DAILY. If discovery rebuilt entries from the API alone, the state
// would be wiped every night and the feature would silently do nothing. The
// third key is deliberately made up, so the assertion is about the mechanism
// and not about a list of names. Against v2 of the script every line here fails.
console.log('\n6  Keys discovery does not derive survive a run; keys it does derive are recomputed');
writeCore([
  { org: '383836bb', seasonId: '75d8a232', compName: 'EFNL 2025', retired: true,
    status: 'COMPLETED', state: 'complete', stateAt: '2025-10-01T00:00:00.000Z',
    futureKey: { anything: 1 },
    phases: { results: true, players: false, matches: 4870, players_n: 0 } },
  // Stale derived fields, to prove the API side still wins: status and retired
  // are wrong here and must come back corrected.
  { org: '383836bb', seasonId: '2dcbf383', compName: 'EFNL 2026', retired: true,
    status: 'UPCOMING', state: 'active', stateAt: '2026-04-01T00:00:00.000Z',
    phases: { results: true, players: true, matches: 5420, players_n: 44889 } },
]);
r = run();
ok('script ran', r.code === 0 || r.code === 2, `exit ${r.code}`);
ok('carry-forward entry count reported', /carried-forward manifest entries: 2/.test(r.out),
  (r.out.match(/carried-forward manifest entries: \d+/) || ['not printed'])[0]);
const e25 = read().manifest.find((m) => m.seasonId === '75d8a232');
const e26 = read().manifest.find((m) => m.seasonId === '2dcbf383');
ok('2025 kept state', e25.state === 'complete', e25.state);
ok('2025 kept stateAt', e25.stateAt === '2025-10-01T00:00:00.000Z', e25.stateAt);
ok('2025 kept an unknown key', e25.futureKey && e25.futureKey.anything === 1, JSON.stringify(e25.futureKey));
ok('2026 kept state', e26.state === 'active', e26.state);
ok('2026 kept stateAt', e26.stateAt === '2026-04-01T00:00:00.000Z', e26.stateAt);
ok('2026 stale status recomputed from the API', e26.status === 'ACTIVE', e26.status);
ok('2026 stale retired recomputed from the API', e26.retired === false, String(e26.retired));
ok('2026 phases still carried', e26.phases && e26.phases.matches === 5420);
ok('a season absent from the prior manifest still gets a state and stateAt', (() => {
  writeCore([]); run();
  return read().manifest.every((m) => typeof m.state === 'string' && typeof m.stateAt === 'string');
})());

// ── 7. Season state ──────────────────────────────────────────────────────────
// PlayHQ's status decides; the backstop only ever promotes an ACTIVE tracked
// season to complete, and only with no scheduled fixture and 14+ quiet days.
console.log('\n7  Season state: PlayHQ status first, local backstop second');

const today = new Date().toISOString().slice(0, 10);
function daysAgo(n) {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * 86400000).toISOString().slice(0, 10);
}
const STUB = path.join(TMP, 'stub-comps.json');
const season = (id, name, status) => ({
  id, name, startDate: `${+name - 1}-10-01`, endDate: `${name}-09-30`,
  status: status === undefined ? null : (status === 'WEIRD' ? { name: 'Weird', value: 'DRAFT_THING' } : { name: status, value: status }),
});
function stubSeasons(list) {
  fs.writeFileSync(STUB, JSON.stringify([{ id: '23965e53', name: 'Community Football',
    organisation: { id: '383836bb', name: 'Eastern Football Netball League' }, seasons: list }]));
}
function writeSeasonFile(id, matches) {
  fs.writeFileSync(path.join(TMP, 'data', 'seasons', `${id}-core.json`),
    JSON.stringify({ meta: { seasonId: id }, matches, roster: {}, gradeMeta: {} }));
}
const result = (date) => ({ id: 'x', compName: 'EFNL 2026', round: 1, home: 'A', away: 'B', hScore: 1, aScore: 2, date });
const fixture = (date) => ({ ...result(date), hScore: null, aScore: null, scheduled: true });
const bye = () => ({ ...result(''), isBye: true });
const entry = (id) => read().manifest.find((m) => m.seasonId === id);
// EFNL 2026 is the tracked one (config.json names it), so the backstop reads its
// file. 75d8a232 has no compName in these fixtures unless matched — it is 2025,
// and config only names 2026, so it stays untracked... except the script matches
// short name "EFNL" to the organisation and builds compName for EVERY season of
// that organisation. So both are tracked. Use a third id for an untracked one by
// giving it no season file.
writeCore([]);

// 7a. PlayHQ COMPLETED -> complete, whatever the file says
stubSeasons([season('75d8a232', '2025', 'COMPLETED')]);
writeSeasonFile('75d8a232', [result(daysAgo(1)), fixture(daysAgo(-7))]);
r = run();
ok('7a COMPLETED -> complete even with a fixture on file', entry('75d8a232').state === 'complete', entry('75d8a232').state);
ok('7a stateAt set', /^\d{4}-\d{2}-\d{2}T/.test(entry('75d8a232').stateAt || ''), entry('75d8a232').stateAt);
ok('7a state count reported', /season state: \{"complete":1\}/.test(r.out), (r.out.match(/season state: .*/) || ['not printed'])[0]);

// 7b. ACTIVE with a scheduled fixture -> active, even if the last result is old
stubSeasons([season('2dcbf383', '2026', 'ACTIVE')]);
writeSeasonFile('2dcbf383', [result(daysAgo(30)), fixture(daysAgo(-5)), bye()]);
r = run();
ok('7b ACTIVE + fixture -> active', entry('2dcbf383').state === 'active', entry('2dcbf383').state);
ok('7b backstop line names the fixture', /backstop .*1 scheduled fixture\(s\) remain/.test(r.out));
const firstStateAt = entry('2dcbf383').stateAt;

// 7c. ACTIVE, no fixture, last result 5 days ago -> still active; stateAt unchanged
writeSeasonFile('2dcbf383', [result(daysAgo(5)), bye()]);
r = run();
ok('7c ACTIVE, quiet 5 days -> active', entry('2dcbf383').state === 'active', entry('2dcbf383').state);
ok('7c stateAt did not move while state held', entry('2dcbf383').stateAt === firstStateAt);
ok('7c no transition reported', /0 transition\(s\)/.test(r.out));

// 7d. ACTIVE, no fixture, last result exactly 14 days ago -> complete via backstop
writeSeasonFile('2dcbf383', [result(daysAgo(14)), bye()]);
r = run();
ok('7d ACTIVE, quiet 14 days -> complete', entry('2dcbf383').state === 'complete', entry('2dcbf383').state);
ok('7d transition logged', /STATE 2dcbf383 EFNL 2026 active -> complete \(backstop/.test(r.out));
ok('7d stateAt moved on the transition', entry('2dcbf383').stateAt !== firstStateAt);
ok('7d run reports a change (exit 0)', r.code === 0, `exit ${r.code}`);
const completeAt = entry('2dcbf383').stateAt;

// 7e. 13 days is NOT enough — the day before the cutoff stays active
writeSeasonFile('2dcbf383', [result(daysAgo(13)), bye()]);
r = run();
ok('7e quiet 13 days -> active (cutoff is inclusive at 14, not before)', entry('2dcbf383').state === 'active', entry('2dcbf383').state);
ok('7e reversal logged', /STATE 2dcbf383 EFNL 2026 complete -> active/.test(r.out));

// 7f. A late result arriving after a backstop-complete flips it back
writeSeasonFile('2dcbf383', [result(daysAgo(20)), bye()]);
run();
ok('7f setup: complete again', entry('2dcbf383').state === 'complete');
writeSeasonFile('2dcbf383', [result(daysAgo(20)), result(daysAgo(2)), bye()]);
r = run();
ok('7f late result -> back to active', entry('2dcbf383').state === 'active', entry('2dcbf383').state);

// 7g. ACTIVE with no season file at all -> active, from status alone
fs.rmSync(path.join(TMP, 'data', 'seasons', '2dcbf383-core.json'));
r = run();
ok('7g ACTIVE, no file -> active', entry('2dcbf383').state === 'active');
ok('7g reason is status alone', /backstop 2dcbf383 EFNL 2026: PlayHQ ACTIVE — active/.test(r.out));

// 7h. UPCOMING -> upcoming; a brand-new season is announced
stubSeasons([season('2dcbf383', '2026', 'ACTIVE'), season('aaaa1111', '2027', 'UPCOMING')]);
r = run();
ok('7h UPCOMING -> upcoming', entry('aaaa1111').state === 'upcoming', entry('aaaa1111').state);
ok('7h new season announced', /NEW season aaaa1111 EFNL 2027 status=UPCOMING/.test(r.out));
ok('7h existing season not announced as new', !/NEW season 2dcbf383/.test(r.out));

// 7i. Unrecognised status with a prior state -> prior kept, WARNING printed
stubSeasons([season('2dcbf383', '2026', 'WEIRD')]);
r = run();
ok('7i unrecognised status keeps prior state', entry('2dcbf383').state === 'active', entry('2dcbf383').state);
ok('7i status stored as-is', entry('2dcbf383').status === 'DRAFT_THING', entry('2dcbf383').status);
ok('7i WARNING printed', /WARNING 2dcbf383 EFNL 2026: status "DRAFT_THING" unrecognised — prior state kept/.test(r.out));

// 7j. Null status, no prior state -> active, WARNING printed. The configured
// 2026 season stays in the stub, or the config match fails and the run exits 1
// for a reason unrelated to state.
stubSeasons([season('2dcbf383', '2026', 'ACTIVE'), season('bbbb2222', '2027')]);
r = run();
ok('7j null status, no prior -> active', entry('bbbb2222').state === 'active', entry('bbbb2222').state);
ok('7j WARNING names the default', /WARNING bbbb2222 EFNL 2027: status null unrecognised, no prior state — defaulting to active/.test(r.out));

// 7k. An organisation with no competitions at all is not a failure. A second
// code is configured; the stub answers it with an empty array (462 of 1,175
// real organisations do exactly this).
const CONFIG = path.join(TMP, 'config.json');
const savedConfig = fs.readFileSync(CONFIG, 'utf8');
fs.writeFileSync(CONFIG, JSON.stringify({ ...JSON.parse(savedConfig), organisationCodes: ['383836bb', 'e0e0e0e0'] }));
const stubObj = {}; stubObj['383836bb'] = [{ id: '23965e53', name: 'Community Football',
  organisation: { id: '383836bb', name: 'Eastern Football Netball League' },
  seasons: [season('2dcbf383', '2026', 'ACTIVE')] }];
fs.writeFileSync(STUB, JSON.stringify(stubObj));
r = run();
ok('7k zero competitions -> ran, no failure exit', r.code === 0 || r.code === 2, `exit ${r.code}`);
ok('7k zero competitions -> no FAILED line', !/FAILED/.test(r.out));
ok('7k empty organisation reported as 0 comps, 0 seasons', /e0e0e0e0 .*0 comp\(s\), 0 season\(s\)/.test(r.out));
ok('7k the real season still resolved', entry('2dcbf383').state === 'active');
fs.writeFileSync(CONFIG, savedConfig);
fs.rmSync(STUB);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
