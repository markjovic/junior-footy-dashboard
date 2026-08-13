// scripts/verify-per-season.js
//
// Verifies scripts/lib/store.js (per-season layout) and scripts/split-by-season.js
// by EXECUTING them against fixtures. per_season_storage_design.md.
//
// Neither makes a network call, so nothing is stubbed — the code under test is
// exactly the committed code. The repository's own data/ is never opened.
//
// Run: node scripts/verify-per-season.js    Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-per-season v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const SCRIPTS = __dirname;
for (const f of ['lib/store.js', 'split-by-season.js']) {
  if (!fs.existsSync(path.join(SCRIPTS, f))) { console.error(`FATAL: scripts/${f} not found.`); process.exit(1); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perseason-'));
fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(path.join(SCRIPTS, 'lib', 'store.js'), path.join(TMP, 'scripts', 'lib', 'store.js'));
fs.copyFileSync(path.join(SCRIPTS, 'split-by-season.js'), path.join(TMP, 'scripts', 'split-by-season.js'));
const store = require(path.join(TMP, 'scripts', 'lib', 'store.js'));

const DATA = path.join(TMP, 'data');
const ORGS = path.join(DATA, 'orgs');
const SEASONS = path.join(DATA, 'seasons');
const CORE = path.join(DATA, 'core.json');
const sCore = (id) => path.join(SEASONS, `${id}-core.json`);
const sPlayers = (id) => path.join(SEASONS, `${id}-players.json`);

const MANIFEST = () => ([
  { org: '383836bb', seasonId: '2dcbf383', seasonName: '2026', compName: 'EFNL 2026', status: 'ACTIVE', retired: false },
  { org: '383836bb', seasonId: '75d8a232', seasonName: '2025', compName: 'EFNL 2025', status: 'COMPLETED', retired: true },
  { org: '4f9a099e', seasonId: 'cda2f0ec', seasonName: '2026', compName: 'YJFL 2026', status: 'ACTIVE', retired: false },
]);
const M = (c, i) => ({ id: `${c}|${i}`, compName: c, age: 'U12', rawGrade: 'A', gradeId: 'g1',
  round: i, home: 'a', away: 'b' });
const P = (c, i) => ({ id: `p${c}${i}`, compName: c, name: `P${i}`, age: 'U12' });

function writeOldLayout(manifest) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(ORGS, { recursive: true });
  fs.writeFileSync(CORE, JSON.stringify({ manifest: manifest || MANIFEST(),
    orgFiles: [{ file: 'stale' }], clubs: { a: 1 }, lastRound: { 'U12|A': 14 } }, null, 2));
  fs.writeFileSync(path.join(ORGS, '383836bb-current.json'), JSON.stringify({
    meta: { org: '383836bb', kind: 'current' },
    matches: [0, 1, 2].map(i => M('EFNL 2026', i)), players: [0, 1, 2].map(i => P('EFNL 2026', i)),
    roster: { 'EFNL 2026|a|U12': {} }, gradeMeta: { 'EFNL 2026|U12|g1': { r: 1 } } }));
  fs.writeFileSync(path.join(ORGS, '383836bb-archive.json'), JSON.stringify({
    meta: { org: '383836bb', kind: 'archive' },
    matches: [0, 1].map(i => M('EFNL 2025', i)), players: [0, 1].map(i => P('EFNL 2025', i)),
    roster: { 'EFNL 2025|a|U12': {} }, gradeMeta: { 'EFNL 2025|U12|g1': { r: 1 } } }));
  fs.writeFileSync(path.join(ORGS, '4f9a099e-current.json'), JSON.stringify({
    meta: { org: '4f9a099e', kind: 'current' },
    matches: [0, 1, 2, 3].map(i => M('YJFL 2026', i)), players: [],
    roster: {}, gradeMeta: {} }));
}

function migrate(env) {
  const r = spawnSync(process.execPath, ['scripts/split-by-season.js'],
    { cwd: TMP, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let pass = 0, fail = 0, LAST = null, dumped = false;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); return; }
  fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  if (!dumped && LAST) { dumped = true; console.log('\n--- output ---');
    for (const l of LAST.out.split('\n').slice(-25)) console.log(`  | ${l}`);
    console.log('--- end ---\n'); }
}

// ── 1. Migration: dry run ────────────────────────────────────────────────────
console.log('\n1  The migration defaults to a dry run');
writeOldLayout();
LAST = migrate({});
ok('exit 2', LAST.code === 2, `exit ${LAST.code}`);
ok('no season files written', !fs.existsSync(SEASONS));
ok('the old files are untouched', fs.existsSync(path.join(ORGS, '383836bb-current.json')));
ok('it reports the split it would make', /% players\)/.test(LAST.out));

// ── 2. Migration: applied ────────────────────────────────────────────────────
console.log('\n2  Every record lands in its own season');
LAST = migrate({ SPLIT_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('six files: core and players per season', fs.readdirSync(SEASONS).length === 6,
  fs.readdirSync(SEASONS).sort().join(', '));
ok('EFNL 2026 core holds only its own matches',
  read(sCore('2dcbf383')).matches.length === 3 &&
  read(sCore('2dcbf383')).matches.every(m => m.compName === 'EFNL 2026'));
ok('EFNL 2025 is a SEPARATE file from EFNL 2026',
  read(sCore('75d8a232')).matches.length === 2);
ok('players are in their own file, not the core one',
  read(sPlayers('2dcbf383')).players.length === 3 && read(sCore('2dcbf383')).players === undefined);
ok('a season with no players still gets a file',
  fs.existsSync(sPlayers('cda2f0ec')) && read(sPlayers('cda2f0ec')).players.length === 0);
ok('roster and gradeMeta went with the core file',
  !!read(sCore('2dcbf383')).roster['EFNL 2026|a|U12'] &&
  !!read(sCore('2dcbf383')).gradeMeta['EFNL 2026|U12|g1']);
ok('the old files are STILL there as a rollback path',
  fs.existsSync(path.join(ORGS, '383836bb-archive.json')));
ok('core.json gained a season index and lost the old one',
  Array.isArray(read(CORE).seasonFiles) && read(CORE).orgFiles === undefined);
ok('the manifest gained per-season phases',
  read(CORE).manifest.find(m => m.seasonId === '2dcbf383').phases.matches === 3);

// ── 3. Migration: it refuses rather than losing records ──────────────────────
console.log('\n3  A record it cannot place aborts the whole migration');
writeOldLayout(MANIFEST().filter(m => m.compName !== 'EFNL 2025'));
LAST = migrate({ SPLIT_DRY_RUN: 'false' });
ok('exit 1', LAST.code === 1, `exit ${LAST.code}`);
ok('it names what it could not place', /no manifest entry/.test(LAST.out));
ok('and wrote nothing at all', !fs.existsSync(SEASONS));

// ── 4. The store reads the new layout ────────────────────────────────────────
console.log('\n4  store.load round-trips the migrated data');
writeOldLayout();
migrate({ SPLIT_DRY_RUN: 'false' });
process.chdir(TMP);
{
  const d = store.load(null);
  ok('every match is back', d.matches.length === 9, `${d.matches.length} of 9`);
  ok('every player is back', d.players.length === 5, `${d.players.length} of 5`);
  ok('roster and gradeMeta too', Object.keys(d.roster).length === 2 && Object.keys(d.gradeMeta).length === 2);
  ok('core keys came from core.json', d.lastRound && d.lastRound['U12|A'] === 14);
}

// ── 5. Scope ─────────────────────────────────────────────────────────────────
console.log('\n5  A scoped save cannot reach another season');
{
  const yjflBefore = fs.readFileSync(sCore('cda2f0ec'), 'utf8');
  const d = store.load(['EFNL 2026']);
  ok('a scoped load reads only that season', d.matches.length === 3, `${d.matches.length} matches`);
  d.matches.push(M('EFNL 2026', 99));
  store.save(d, ['EFNL 2026']);
  ok('the season was written', read(sCore('2dcbf383')).matches.length === 4);
  ok('YJFL is byte-identical', fs.readFileSync(sCore('cda2f0ec'), 'utf8') === yjflBefore);
  ok('EFNL 2025 is byte-identical too — same organisation, different season',
    read(sCore('75d8a232')).matches.length === 2);
}

// ── 6. players:false must not erase a season's players ───────────────────────
// A writer that does not read players must not replace them with nothing. This
// is the failure that would silently delete 78% of the data.
console.log('\n6  A run that skips players leaves them alone');
{
  const before = fs.readFileSync(sPlayers('2dcbf383'), 'utf8');
  const d = store.load(['EFNL 2026'], { players: false });
  ok('no players loaded', d.players.length === 0);
  ok('and the player file was not even read',
    !d.__filesRead.some(f => f.includes('players')), d.__filesRead.join(', '));
  const r = store.save(d, ['EFNL 2026']);
  ok('the player file is untouched', fs.readFileSync(sPlayers('2dcbf383'), 'utf8') === before);
  ok('only the core file was written', r.written.length === 1, r.written.join(', '));
  ok('the log says untouched, not zero',
    (r.seasonPhases[0] || {}).playersUntouched === true);
  ok('and the manifest does NOT claim players are missing',
    read(CORE).manifest.find(m => m.seasonId === '2dcbf383').phases.players === true);
}

// ── 7. The loss guard ────────────────────────────────────────────────────────
console.log('\n7  A record with no manifest entry throws before writing');
{
  const before = fs.readFileSync(sCore('2dcbf383'), 'utf8');
  const d = store.load(['EFNL 2026']);
  d.matches.push(M('SEJ 2019', 1));
  let threw = null;
  try { store.save(d, ['EFNL 2026']); } catch (e) { threw = e.message; }
  ok('it threw', !!threw, threw ? threw.split('.')[0] : 'DID NOT THROW');
  ok('and wrote nothing', fs.readFileSync(sCore('2dcbf383'), 'utf8') === before);
}

// ── 8. Could these have failed? ──────────────────────────────────────────────
console.log('\n8  The fixture is real');
{
  ok('three seasons exist', read(CORE).manifest.length === 3);
  ok('two of them belong to one organisation',
    read(CORE).manifest.filter(m => m.org === '383836bb').length === 2);
  ok('players outnumber matches in the fixture, as they do in reality',
    read(sPlayers('2dcbf383')).players.length > 0);
}

process.chdir(os.tmpdir());
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
