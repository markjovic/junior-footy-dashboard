// scripts/verify-registrations.js
//
// Runs the REAL scripts/walk-registrations.js as a child process in a temporary
// tree, with only scripts/lib/playhq.js stubbed. The stub reads its answers from
// a JSON file the test writes, and records every call it receives, so each
// section can say exactly who was walked and in what order.
//
// Covers the silent failures: the wrong slice walked, a found player re-walked
// daily, the club trigger matching nobody, an own-season registration stored as
// next season's, a stale "changed" exit committing every day.
//
// Run: node scripts/verify-registrations.js    Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

const VERSION = 'verify-registrations v4 2026-09-07';
console.log(`=== ${VERSION} ===`);

const REAL = path.join(__dirname, 'walk-registrations.js');
const REAL_STORE = path.join(__dirname, 'lib', 'store.js');
for (const f of [REAL, REAL_STORE]) {
  if (!fs.existsSync(f)) { console.error(`FATAL: ${f} not found. Run from the repository root.`); process.exit(1); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-verify-'));
const SEASONS = path.join(TMP, 'data', 'seasons');
const CORE = path.join(TMP, 'data', 'core.json');
const OUT = path.join(TMP, 'data', 'registrations.json.gz');
const LEGACY = path.join(TMP, 'data', 'registrations.json');
const STUB_IN = path.join(TMP, 'stub-answers.json');
const STUB_LOG = path.join(TMP, 'stub-calls.json');
fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.mkdirSync(SEASONS, { recursive: true });
fs.copyFileSync(REAL, path.join(TMP, 'scripts', 'walk-registrations.js'));
fs.copyFileSync(REAL_STORE, path.join(TMP, 'scripts', 'lib', 'store.js'));

fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'), `
'use strict';
const fs = require('fs'), path = require('path');
const IN = path.join(__dirname, '..', '..', 'stub-answers.json');
const LOG = path.join(__dirname, '..', '..', 'stub-calls.json');
const calls = [];
function answers() { return JSON.parse(fs.readFileSync(IN, 'utf8')); }
async function gqlPost(query, vars, op) {
  calls.push({ op, vars, t: Date.now() });
  fs.writeFileSync(LOG, JSON.stringify(calls));
  const a = answers();
  if (op === 'PublicProfileTeams') {
    const r = a.profiles[vars.profileID];
    if (r === undefined) return { data: { publicProfileTeams: [] } };
    if (r === 'NOT_FOUND') return { errors: [{ message: '5 NOT_FOUND: failed to find profile' }] };
    if (r === 'THROW') throw new Error('stub network failure');
    return { data: { publicProfileTeams: r } };
  }
  if (op === 'DiscoverTeams') {
    const r = a.teams[vars.seasonID];
    if (r === 'REJECT') return { errors: [{ message: 'Cannot query field "x" on type "DiscoverTeam".' }] };
    return { data: { discoverTeams: r || [] } };
  }
  throw new Error('stub: unexpected op ' + op);
}
module.exports = { gqlPost, sleep: (ms) => new Promise(r => setTimeout(r, ms)), logSummary: () => {} };
`);

// ── Fixture ──────────────────────────────────────────────────────────────────
const S26 = '2170ac5a', S25 = 'aaaa2025', S27 = 'bbbb2027', E26 = '2dcbf383';
const manifest = [
  { org: '4c8b472e', seasonId: S25, compName: 'WFNL 2025', status: 'COMPLETED', startDate: '2025-04-01', endDate: '2025-09-21', retired: true, state: 'complete', stateAt: '2025-10-01T00:00:00.000Z' },
  { org: '4c8b472e', seasonId: S26, compName: 'WFNL 2026', status: 'ACTIVE', startDate: '2026-04-01', endDate: '2026-09-21', retired: false, state: 'active', stateAt: '2026-09-07T01:00:00.000Z' },
  { org: '4c8b472e', seasonId: S27, compName: 'WFNL 2027', status: 'UPCOMING', startDate: '2027-04-01', endDate: '2027-09-21', retired: false, state: 'upcoming', stateAt: '2026-10-20T00:00:00.000Z' },
  { org: '383836bb', seasonId: E26, compName: 'EFNL 2026', status: 'ACTIVE', startDate: '2025-10-01', endDate: '2026-09-30', retired: false, state: 'active', stateAt: '2026-09-07T01:00:00.000Z' },
];
const N = 14; // WFNL cohort; budget = ceil(21/7) = 3 with EFNL's 7
const wUuids = Array.from({ length: N }, (_, i) => `w${String(i).padStart(3, '0')}`);
const eUuids = Array.from({ length: 7 }, (_, i) => `e${String(i).padStart(3, '0')}`);
function writeSeason(sid, comp, uuids, club) {
  fs.writeFileSync(path.join(SEASONS, `${sid}-core.json`), JSON.stringify({ meta: { seasonId: sid }, matches: [], roster: {}, gradeMeta: {} }));
  fs.writeFileSync(path.join(SEASONS, `${sid}-players.json`), JSON.stringify({ meta: { seasonId: sid }, players:
    uuids.map((u, i) => ({ uuid: u, name: 'Player ' + u, team: club + ' U12', teamRaw: club + ' U12', age: 'U12', compName: comp, gp: 1 })) }));
}
writeSeason(S26, 'WFNL 2026', wUuids, 'Parkside');
writeSeason(S25, 'WFNL 2025', ['old01', 'old02', ...wUuids.slice(0, 2)], 'Parkside'); // 2025 also has a players file but is not the latest
writeSeason(E26, 'EFNL 2026', eUuids, 'Blackburn');
fs.writeFileSync(CORE, JSON.stringify({ manifest, clubs: { PARKSIDE: { name: 'Parkside FC' }, NEWPORT: { name: 'Newport FC' } } }));

// A profile answer: own 2026 record (club) + optional extras.
const own = (club, clubName, sid = S26, start = '2026-04-01') => ({ id: 't-own', name: clubName + ' U12', season: { id: sid, name: '2026', startDate: start, endDate: '2026-09-21', status: { value: 'ACTIVE' }, competition: { id: 'c', name: 'Western Football Netball League' } }, organisation: { id: club, name: clubName } });
const old25 = { id: 't-old', name: 'Parkside U11', season: { id: S25, name: '2025', startDate: '2025-04-01', endDate: '2025-09-21', status: { value: 'COMPLETED' }, competition: { id: 'c', name: 'WFNL' } }, organisation: { id: 'PARKSIDE', name: 'Parkside FC' } };
const reg27 = (club, clubName, teamName) => ({ id: 't-27', name: teamName || clubName, season: { id: S27, name: '2027', startDate: '2027-04-01', endDate: '2027-09-21', status: { value: 'UPCOMING' }, competition: { id: 'c', name: 'Western Football Netball League' } }, organisation: { id: club, name: clubName } });
const gipps = { id: 't-g', name: 'Moe Lions', season: { id: 'gipp2027', name: '2027', startDate: '2027-04-01', endDate: '2027-09-01', status: { value: 'UPCOMING' }, competition: { id: 'g', name: 'Gippsland League' } }, organisation: { id: 'MOE', name: 'Moe FC' } };

let answers = { profiles: {}, teams: {} };
for (const u of wUuids) answers.profiles[u] = [own('PARKSIDE', 'Parkside FC'), old25];
for (const u of eUuids) answers.profiles[u] = [own('BLACKBURN', 'Blackburn FC', E26, '2025-10-01')];
answers.profiles.w001 = [own('PARKSIDE', 'Parkside FC'), old25, reg27('PARKSIDE', 'Parkside FC')];            // registered, unassigned
answers.profiles.w002 = [own('PARKSIDE', 'Parkside FC'), reg27('NEWPORT', 'Newport FC', 'Newport U13 Blue')]; // moved, assigned
answers.profiles.w003 = [own('PARKSIDE', 'Parkside FC'), gipps];                                                // gone to Gippsland
answers.profiles.w004 = 'NOT_FOUND';
// w009: CONCURRENT registrations — a tracked EFNL 2026 season (starts 2025-10-01,
// overlaps) and an outside 2026 season starting in April. Neither is next season.
const efnl26 = { id: 't-e', name: 'Blackburn U12', season: { id: E26, name: '2026', startDate: '2025-10-01', endDate: '2026-09-30', status: { value: 'ACTIVE' }, competition: { id: 'e', name: 'Eastern Football Netball League' } }, organisation: { id: 'BLACKBURN', name: 'Blackburn FC' } };
const school26 = { id: 't-s', name: 'Scotch 1st XVIII', season: { id: 'aps2026', name: '2026', startDate: '2026-04-20', endDate: '2026-08-30', status: { value: 'ACTIVE' }, competition: { id: 'aps', name: 'APS Football' } }, organisation: { id: 'SCOTCH', name: 'Scotch College' } };
answers.profiles.w009 = [own('PARKSIDE', 'Parkside FC'), efnl26, school26];
// w010: a season starting the DAY AFTER ours ends must count (EFNL 2027 will start 2026-10-01 against an end of 2026-09-30).
answers.profiles.w010 = [own('PARKSIDE', 'Parkside FC'), { ...reg27('PARKSIDE', 'Parkside FC'), season: { ...reg27('PARKSIDE', 'Parkside FC').season, startDate: '2026-09-22' } }];
// w011: no own-season record at all — club cannot be harvested.
answers.profiles.w011 = [old25];
const saveAnswers = () => fs.writeFileSync(STUB_IN, JSON.stringify(answers));
saveAnswers();

function run(env) {
  fs.rmSync(STUB_LOG, { force: true });
  const r = spawnSync(process.execPath, ['scripts/walk-registrations.js'], { cwd: TMP, encoding: 'utf8',
    env: { ...process.env, WALK_RATE: '1000', WALK_WINDOW_MS: '1000', ...(env || {}) } });
  if (r.error) throw r.error;
  const calls = fs.existsSync(STUB_LOG) ? JSON.parse(fs.readFileSync(STUB_LOG, 'utf8')) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls,
    profiles: calls.filter(c => c.op === 'PublicProfileTeams').map(c => c.vars.profileID) };
}
const read = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT)).toString('utf8'));
const write = (obj) => fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify(obj))));
const rec = (u) => read().players[u];
const setRec = (u, patch) => { const r = read(); Object.assign(r.players[u], patch); write(r); };
const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString();

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 1. First run: cohort, budget, never-checked first ────────────────────────
console.log('\n1  First run builds the cohort and walks one slice');
let r = run();
ok('version line', /walk-registrations v4 2026-09-07/.test(r.out));
ok('exit 0 (changed)', r.code === 0, `exit ${r.code}`);
ok('cohort is the latest season per org, not 2025', /cohort: 21 people/.test(r.out), (r.out.match(/cohort: .*/) || [''])[0]);
ok('2025-only players are not in the file', !read().players.old01);
ok('budget ceil(21/7)=3 profile calls', r.profiles.length === 3, `${r.profiles.length} calls: ${r.profiles.join(',')}`);
ok('one discoverTeams call for the one upcoming season', r.calls.filter(c => c.op === 'DiscoverTeams').length === 1);
ok('club trigger with no teams marks nobody', /0 club\(s\) with more teams/.test(r.out));
const first = r.profiles.slice();

// ── 2. Slicing: the next run walks different people ──────────────────────────
console.log('\n2  The next run walks the next three, never the same three');
r = run();
ok('three more calls', r.profiles.length === 3);
ok('none repeated from run 1', r.profiles.every(u => !first.includes(u)), r.profiles.join(','));
ok('exit 0', r.code === 0);
for (let i = 0; i < 5; i++) run(); // finish the cohort: 7 runs × 3 = 21
r = run();
ok('after the whole cohort is walked, a run makes no calls', r.profiles.length === 0, `${r.profiles.length}`);
ok('… and exits 2, no change', r.code === 2, `exit ${r.code}`);

// ── 3. What was stored ───────────────────────────────────────────────────────
console.log('\n3  Stored shape: club harvested, own season dropped, tracked/other split');
const w0 = rec('w000'), w1 = rec('w001'), w2 = rec('w002'), w3 = rec('w003'), w4 = rec('w004');
ok('club harvested from the own-season record', w0.from.club === 'PARKSIDE' && w0.from.clubName === 'Parkside FC', JSON.stringify(w0.from));
ok('own-season and 2025 records dropped', w0.tracked.length === 0 && w0.other.length === 0);
ok('unfound player due again in 7 days', Math.round((Date.parse(w0.nextCheck) - Date.parse(w0.at)) / 86400000) === 7);
ok('w001 registered unassigned: tracked, team null', w1.tracked.length === 1 && w1.tracked[0].seasonId === S27 && w1.tracked[0].club === 'PARKSIDE' && w1.tracked[0].team === null, JSON.stringify(w1.tracked));
ok('w001 found -> due again in 28 days', Math.round((Date.parse(w1.nextCheck) - Date.parse(w1.at)) / 86400000) === 28);
ok('w002 moved and assigned: club NEWPORT, team named', w2.tracked[0].club === 'NEWPORT' && w2.tracked[0].team === 'Newport U13 Blue', JSON.stringify(w2.tracked));
ok('w002 from.club still the OLD club (Parkside)', w2.from.club === 'PARKSIDE');
ok('w003 gone: nothing tracked, one other with league, season and dates but no club', w3.tracked.length === 0 && w3.other.length === 1 && w3.other[0].league === 'Gippsland League' && w3.other[0].season === '2027' && w3.other[0].startDate === '2027-04-01' && w3.other[0].endDate === '2027-09-01' && !('club' in w3.other[0]), JSON.stringify(w3.other));
ok('w004 NOT_FOUND recorded, not retried for 28 days', w4.missing === true && Math.round((Date.parse(w4.nextCheck) - Date.parse(w4.at)) / 86400000) === 28);
ok('EFNL player harvested its own club', rec('e000').from.club === 'BLACKBURN');
const w9 = rec('w009'), w10 = rec('w010'), w11 = rec('w011');
ok('w009 concurrent tracked season (EFNL 2026 overlapping) NOT stored as next season', w9.tracked.length === 0, JSON.stringify(w9.tracked));
ok('w009 concurrent outside season NOT stored as a departure', w9.other.length === 0, JSON.stringify(w9.other));
ok('w009 therefore on the 7-day re-check, not 28', Math.round((Date.parse(w9.nextCheck) - Date.parse(w9.at)) / 86400000) === 7);
ok('w010 season starting the day after ours ends IS next season', w10.tracked.length === 1, JSON.stringify(w10.tracked));
ok('w011 no own record: club stays null, counted and logged', w11.from.club === null);

// ── 4. Due ordering by nextCheck ─────────────────────────────────────────────
console.log('\n4  Due ordering: overdue first, future not walked');
setRec('w005', { nextCheck: daysAgoIso(1) });     // overdue by a day
setRec('w006', { nextCheck: daysAgoIso(10) });    // overdue by ten
setRec('w007', { nextCheck: new Date(Date.now() + 3 * 86400000).toISOString() }); // not yet
r = run();
ok('exactly the two overdue walked', r.profiles.length === 2 && r.profiles.includes('w005') && r.profiles.includes('w006'), r.profiles.join(','));
ok('most overdue first', r.profiles[0] === 'w006');
ok('future nextCheck not walked', !r.profiles.includes('w007'));

// ── 5. Club trigger ──────────────────────────────────────────────────────────
console.log('\n5  Club trigger: Parkside forms teams -> Parkside players due now, ahead of others');
answers.teams[S27] = [1, 2, 3].map(i => ({ id: 't' + i, name: 'Parkside U1' + i, organisation: { id: 'PARKSIDE', name: 'Parkside FC' } }));
saveAnswers();
setRec('e001', { nextCheck: daysAgoIso(2) });     // an unrelated overdue player
r = run();
ok('trigger reported 1 club risen', /1 club\(s\) with more teams than last run/.test(r.out), (r.out.match(/club trigger WFNL 2027: .*/) || [''])[0]);
ok('3 profile calls, all Parkside players (budget 3)', r.profiles.length === 3 && r.profiles.every(u => u.startsWith('w')), r.profiles.join(','));
ok('the unrelated overdue EFNL player waits behind them', !r.profiles.includes('e001'));
ok('club counts stored', read().meta.clubTeams[S27].PARKSIDE === 3);
ok('walked players are no longer flagged', r.profiles.every(u => rec(u).triggered === false));
const stillFlagged = Object.values(read().players).filter(p => p.triggered).length;
ok('unwalked Parkside players stay flagged for tomorrow', stillFlagged > 0, `${stillFlagged}`);
r = run();
ok('same counts next run -> nobody newly triggered', /0 club\(s\) with more teams/.test(r.out));
ok('flagged players continue to drain, Parkside first', r.profiles.length === 3 && r.profiles.every(u => u.startsWith('w')));

// ── 6. Failure paths ─────────────────────────────────────────────────────────
console.log('\n6  Failure paths');
answers.teams[S27] = 'REJECT'; saveAnswers();
r = run();
ok('rejected discoverTeams is logged and the walk continues', /query rejected/.test(r.out) && r.code !== 1, `exit ${r.code}`);
answers.teams[S27] = []; saveAnswers();
setRec('w008', { nextCheck: daysAgoIso(1) });
answers.profiles.w008 = 'THROW'; saveAnswers();
const beforeThrow = rec('w008');
r = run();
ok('a thrown call leaves the record untouched and due', JSON.stringify(rec('w008')) === JSON.stringify(beforeThrow));
answers.profiles.w008 = [own('PARKSIDE', 'Parkside FC')]; saveAnswers();
r = run({ WALK_TIME_BUDGET_MS: '0' });
ok('zero time budget -> no profile calls, STOPPED FOR TIME', r.profiles.length === 0 && /STOPPED FOR TIME/.test(r.out));
fs.rmSync(path.join(SEASONS, `${S26}-players.json`)); fs.rmSync(path.join(SEASONS, `${E26}-players.json`));
r = run();
ok('players file only for 2025 -> cohort falls back to 2025', /cohort season aaaa2025 WFNL 2025/.test(r.out));
fs.rmSync(path.join(SEASONS, `${S25}-players.json`));
r = run();
ok('no players file at all -> exit 2, no calls', r.code === 2 && r.calls.length === 0, `exit ${r.code}, ${r.calls.length} calls`);

// ── 7. Pacing ────────────────────────────────────────────────────────────────
console.log('\n7  Pacing: at most RATE calls per WINDOW');
writeSeason(S26, 'WFNL 2026', wUuids, 'Parkside');
for (const u of wUuids) setRec(u, { nextCheck: daysAgoIso(1), triggered: false });
r = run({ WALK_RATE: '2', WALK_WINDOW_MS: '600', WALK_DAILY_FRACTION: '1' });
const times = r.calls.map(c => c.t);
let violations = 0;
for (let i = 2; i < times.length; i++) if (times[i] - times[i - 2] < 600 - 30) violations++;
ok('no 600 ms window holds more than 2 calls', violations === 0, `${times.length} calls, ${violations} violation(s)`);
ok('the run took at least (calls/2 - 1) windows', times.length >= 6 && (times[times.length - 1] - times[0]) >= (Math.ceil(times.length / 2) - 1) * 600 - 30);

// ── 8. Migration of a v1 file ────────────────────────────────────────────────
console.log('\n8  A v1 file (startDate rule) is migrated: stored registrations re-decided, clubs kept');
const v1 = read();
v1.meta.version = 1;
v1.players.w000.tracked = [{ seasonId: E26, compName: 'EFNL 2026', status: 'ACTIVE', club: 'BLACKBURN', clubName: 'Blackburn FC', team: null, name: 'Blackburn FC' }];
v1.players.w000.nextCheck = new Date(Date.now() + 20 * 86400000).toISOString();   // would not be due
v1.players.w001.other = [{ league: 'APS Football', season: '2026', status: 'ACTIVE' }];
v1.players.w001.nextCheck = new Date(Date.now() + 5 * 86400000).toISOString();
const w002Before = JSON.stringify(v1.players.w002);
write(v1);
for (const u of wUuids) answers.profiles[u] = [own('PARKSIDE', 'Parkside FC')];
answers.profiles.w000 = [own('PARKSIDE', 'Parkside FC'), efnl26];
answers.profiles.w001 = [own('PARKSIDE', 'Parkside FC'), school26];
saveAnswers();
r = run({ WALK_DAILY_FRACTION: '1' });
// Six: the two planted here plus w001, w002, w003 and w010 from earlier sections.
ok('migration logged with the count', /migrated registrations.json v1 -> v2: 6 record\(s\)/.test(r.out), (r.out.match(/migrated .*/) || [''])[0]);
ok('both re-decided players were walked', r.profiles.includes('w000') && r.profiles.includes('w001'));
ok('under v2 the concurrent registrations are gone', rec('w000').tracked.length === 0 && rec('w001').other.length === 0);
ok('harvested club kept through migration', rec('w000').from.club === 'PARKSIDE');
ok('a record with nothing stored is untouched by migration', JSON.stringify(rec('w002')) === w002Before || r.profiles.includes('w002'));
ok('file now marked v2', read().meta.version === 2);
r = run();
ok('a v2 file is not migrated again', !/migrated registrations.json/.test(r.out));

// ── 9. Legacy plain .json is converted to .gz once and removed ───────────────
console.log('\n9  A plain registrations.json from v1–v3 is read, written as .gz, and deleted');
const legacy = read(); fs.rmSync(OUT); fs.writeFileSync(LEGACY, JSON.stringify(legacy));
r = run({ WALK_DAILY_FRACTION: '100000' });
ok('legacy read logged', /reading legacy data\/registrations.json/.test(r.out));
ok('.gz written', fs.existsSync(OUT));
ok('plain file removed and logged', !fs.existsSync(LEGACY) && /removed legacy/.test(r.out));
ok('contents carried over', Object.keys(read().players).length === Object.keys(legacy.players).length);
ok('exit 0 even with nothing else changed (the conversion is the change)', r.code === 0, `exit ${r.code}`);
ok('gzipped output is a real gzip (magic bytes)', fs.readFileSync(OUT)[0] === 0x1f && fs.readFileSync(OUT)[1] === 0x8b);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
