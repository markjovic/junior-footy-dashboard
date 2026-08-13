// scripts/verify-rebuild-grade-meta.js
//
// Verifies scripts/rebuild-grade-meta.js by EXECUTING it as a child process
// against a fixture. It makes no network calls of its own, so nothing is
// stubbed — the code under test is exactly the committed code, and the
// repository's own data/ is never opened.
//
// The point of the script is that archived seasons carry pre-2026-08-12
// gradeMeta: keyed on rawGrade, no label, no gradeId. An archived ladder would
// group correctly but show a hex id where a grade name belongs.
//
// Run: node scripts/verify-rebuild-grade-meta.js   Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-rebuild-grade-meta v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const SCRIPTS = __dirname;
for (const f of ['rebuild-grade-meta.js', 'lib/store.js', 'lib/results-engine.js']) {
  if (!fs.existsSync(path.join(SCRIPTS, f))) {
    console.error(`FATAL: scripts/${f} not found.`);
    process.exit(1);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-verify-'));
// ── Per-season fixture helpers ──────────────────────────────────────────────
// The storage layout moved from data/orgs/<org>-<kind>.json to
// data/seasons/<seasonId>-core.json plus <seasonId>-players.json on 2026-08-12.
// per_season_storage_design.md.
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
const ARC = sCore('75d8a232');
const CUR = sCore('2dcbf383');
const YJFL = sCore('cda2f0ec');

fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(path.join(SCRIPTS, 'rebuild-grade-meta.js'), path.join(TMP, 'scripts', 'rebuild-grade-meta.js'));
for (const f of ['store.js', 'results-engine.js']) {
  fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(TMP, 'scripts', 'lib', f));
}
// results-engine requires ./playhq at load. It is never called here.
fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'),
  "module.exports={gqlPost:async()=>({}),refreshSession:async()=>{},sleep:async()=>{},logSummary:()=>{}};\n");

const GRADES = [
  // Two grades that collapse to one rawGrade — the case a label must separate.
  { id: 'e1', name: 'U8 - Eastern', ageName: 'U8', genderName: 'Mixed', seasonID: '75d8a232', compName: 'EFNL 2025' },
  { id: 'e2', name: 'U8 - West', ageName: 'U8', genderName: 'Mixed', seasonID: '75d8a232', compName: 'EFNL 2025' },
  { id: 'e3', name: 'U12 - A', ageName: 'U12', genderName: 'Mixed', seasonID: '2dcbf383', compName: 'EFNL 2026' },
  { id: 'y1', name: 'U14 - A', ageName: 'U14', genderName: 'Mixed', seasonID: 'cda2f0ec', compName: 'YJFL 2026' },
];

function write(opts) {
  opts = opts || {};
  fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
  fs.mkdirSync(SEASONS, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'grades.json'), JSON.stringify(opts.grades || GRADES));
  fs.writeFileSync(CORE, JSON.stringify({
    manifest: [
      { org: '383836bb', seasonId: '2dcbf383', seasonName: '2026', compName: 'EFNL 2026',
        status: 'ACTIVE', retired: false },
      { org: '383836bb', seasonId: '75d8a232', seasonName: '2025', compName: 'EFNL 2025',
        status: 'COMPLETED', retired: true },
      { org: '4f9a099e', seasonId: 'cda2f0ec', seasonName: '2026', compName: 'YJFL 2026',
        status: 'ACTIVE', retired: false },
    ],
    clubs: {},
  }, null, 2));
  // The ARCHIVED season carries pre-2026-08-12 gradeMeta: rawGrade keys, no
  // label, no grade id.
  writeSeason('75d8a232', '383836bb', ['EFNL 2025'], {
    matches: [{ id: 'EFNL 2025|U8|e1|1|a|b', compName: 'EFNL 2025', age: 'U8',
                rawGrade: '', gradeId: 'e1', round: 1, home: 'a', away: 'b' }],
    gradeMeta: opts.archiveMeta !== undefined ? opts.archiveMeta : { 'EFNL 2025|U8|': { r: 1, lvl: 'junior', g: 'M' } },
  });
  writeSeason('2dcbf383', '383836bb', ['EFNL 2026'], {
    matches: [{ id: 'EFNL 2026|U12|e3|1|a|b', compName: 'EFNL 2026', age: 'U12',
                rawGrade: 'A', gradeId: 'e3', round: 1, home: 'a', away: 'b' }],
    gradeMeta: { 'EFNL 2026|U12|A': { r: 1, lvl: 'junior', g: 'M' } },
  });
  writeSeason('cda2f0ec', '4f9a099e', ['YJFL 2026'], {
    gradeMeta: { 'YJFL 2026|U14|A': { r: 1, lvl: 'junior', g: 'M' } },
  });
}

function run(env) {
  const r = spawnSync(process.execPath, ['scripts/rebuild-grade-meta.js'], {
    cwd: TMP, encoding: 'utf8', env: { ...process.env, REBUILD_ORG: '383836bb', ...env },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let pass = 0, fail = 0, LAST = null, dumped = false;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); return; }
  fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  if (!dumped && LAST) {
    dumped = true;
    console.log('\n--- script output ---');
    for (const l of LAST.out.split('\n').slice(-30)) console.log(`  | ${l}`);
    console.log('--- end ---\n');
  }
}

// ── 1. Dry run ───────────────────────────────────────────────────────────────
console.log('\n1  Dry run is the default and writes nothing');
write();
const before = fs.readFileSync(ARC, 'utf8');
LAST = run({});
ok('exit 2', LAST.code === 2, `exit ${LAST.code}`);
ok('archive byte-identical', fs.readFileSync(ARC, 'utf8') === before);
ok('reports what it would do', /DRY RUN — not written/.test(LAST.out));

// ── 2. The rebuild ───────────────────────────────────────────────────────────
console.log('\n2  Archived gradeMeta gains ids and labels');
LAST = run({ REBUILD_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
const meta = read(ARC).gradeMeta;
ok('the two collapsed grades get separate id keys',
  !!meta['EFNL 2025|U8|e1'] && !!meta['EFNL 2025|U8|e2'], Object.keys(meta).join(', '));
ok('each carries a distinct label',
  meta['EFNL 2025|U8|e1'].label !== meta['EFNL 2025|U8|e2'].label,
  `${meta['EFNL 2025|U8|e1'].label} vs ${meta['EFNL 2025|U8|e2'].label}`);
ok('a label is present where there was none',
  !!meta['EFNL 2025|U8|e1'].label, JSON.stringify(meta['EFNL 2025|U8|e1'].label));
ok('the old rawGrade key still exists for the changeover', !!meta['EFNL 2025|U8|']);
ok('no match record was touched', read(ARC).matches.length === 1);

// ── 3. Scope ─────────────────────────────────────────────────────────────────
console.log('\n3  A scoped run cannot reach another organisation');
ok('YJFL gradeMeta unchanged',
  JSON.stringify(read(YJFL).gradeMeta) === '{"YJFL 2026|U14|A":{"r":1,"lvl":"junior","g":"M"}}',
  JSON.stringify(read(YJFL).gradeMeta));

// ── 4. Idempotency ───────────────────────────────────────────────────────────
console.log('\n4  Re-running changes nothing');
LAST = run({ REBUILD_DRY_RUN: 'false' });
ok('exit 2, unchanged', LAST.code === 2, `exit ${LAST.code}`);
ok('reports it', /unchanged/.test(LAST.out));

// ── 5. A season absent from grades.json keeps what it has ────────────────────
// Regenerating from an incomplete source would silently delete a season's
// metadata, and an absent season is indistinguishable from an empty one here.
console.log('\n5  A season with no grades in grades.json is left alone');
write({ grades: GRADES.filter(g => g.compName !== 'EFNL 2025'),
        archiveMeta: { 'EFNL 2025|U8|': { r: 7, lvl: 'junior', g: 'M' } } });
LAST = run({ REBUILD_DRY_RUN: 'false' });
ok('the untouched season keeps its entry',
  read(ARC).gradeMeta['EFNL 2025|U8|'] && read(ARC).gradeMeta['EFNL 2025|U8|'].r === 7,
  JSON.stringify(read(ARC).gradeMeta['EFNL 2025|U8|']));
ok('and says so', /existing gradeMeta is kept/.test(LAST.out));

// ── 6. Failure paths ─────────────────────────────────────────────────────────
console.log('\n6  Guards refuse rather than guess');
write();
LAST = run({ REBUILD_ORG: 'nope' });
ok('refuses a malformed code', LAST.code === 1 && /8-character/.test(LAST.out));
fs.rmSync(path.join(TMP, 'data', 'grades.json'));
LAST = run({ REBUILD_ORG: '383836bb', REBUILD_DRY_RUN: 'false' });
ok('refuses when grades.json is missing', LAST.code === 1 && /grades\.json not found/.test(LAST.out));

// ── 7. all ───────────────────────────────────────────────────────────────────
console.log('\n7  REBUILD_ORG=all covers every organisation');
write();
LAST = run({ REBUILD_ORG: 'all', REBUILD_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('EFNL rebuilt', !!read(ARC).gradeMeta['EFNL 2025|U8|e1']);
ok('YJFL rebuilt too — not just the first organisation',
  !!read(YJFL).gradeMeta['YJFL 2026|U14|y1'], Object.keys(read(YJFL).gradeMeta).join(', '));

// ── 8. Could these have failed? ──────────────────────────────────────────────
console.log('\n8  The fixture is real');
write();
ok('the archive starts with NO id-keyed entry',
  !Object.values(read(ARC).gradeMeta).some(v => v && v.gradeId),
  JSON.stringify(read(ARC).gradeMeta));
ok('and no label at all',
  !Object.values(read(ARC).gradeMeta).some(v => v && v.label));
ok('grades.json genuinely has two colliding grades',
  GRADES.filter(g => g.compName === 'EFNL 2025').length === 2);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
