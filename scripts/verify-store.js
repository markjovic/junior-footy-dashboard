// scripts/verify-store.js
//
// Verifies scripts/lib/store.js by EXECUTING it, not by reading it.
//
// It copies the real store.js into a temporary tree and runs it there, so the
// repository's own data/ directory is never opened, let alone written. The file
// under test is the committed one, byte for byte — a reimplementation would
// prove nothing about what actually runs.
//
// Covers the success path and the failure paths. A guard that has never fired is
// a guard that has never been tested, so every guard here is deliberately
// tripped: records with no manifest entry, a roster key with no manifest entry,
// and a scope that cannot reach a bucket.
//
// Run: node scripts/verify-store.js      Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = 'verify-store v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const REPO_STORE = path.join(__dirname, 'lib', 'store.js');
if (!fs.existsSync(REPO_STORE)) {
  console.error(`FATAL: ${REPO_STORE} not found. Run from the repository root.`);
  process.exit(1);
}

// ── Fixture ──────────────────────────────────────────────────────────────────
// Two organisations. EFNL has a live 2026 season and a retired 2025 season whose
// archive does not exist yet — the exact state Phase A starts from. YJFL exists
// only to prove a scoped save cannot touch it.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'store-verify-'));
const ORGS = path.join(TMP, 'data', 'orgs');
const CORE = path.join(TMP, 'data', 'core.json');
const EFNL_CUR = path.join(ORGS, '383836bb-current.json');
const EFNL_ARC = path.join(ORGS, '383836bb-archive.json');
const YJFL_CUR = path.join(ORGS, '4f9a099e-current.json');

fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(REPO_STORE, path.join(TMP, 'scripts', 'lib', 'store.js'));
const store = require(path.join(TMP, 'scripts', 'lib', 'store.js'));

const FULL_MANIFEST = [
  { org: '383836bb', seasonId: '2dcbf383', seasonName: '2026', compName: 'EFNL 2026',
    status: 'ACTIVE', retired: false, phases: { results: false, players: false } },
  { org: '383836bb', seasonId: '75d8a232', seasonName: '2025', compName: 'EFNL 2025',
    status: 'COMPLETED', retired: true, phases: { results: false, players: false } },
  { org: '4f9a099e', seasonId: 'cda2f0ec', seasonName: '2026', compName: 'YJFL 2026',
    status: 'ACTIVE', retired: false, phases: { results: true, players: true } },
];

function reset(manifest) {
  fs.rmSync(ORGS, { recursive: true, force: true });
  fs.mkdirSync(ORGS, { recursive: true });
  fs.writeFileSync(CORE, JSON.stringify({
    manifest: manifest || FULL_MANIFEST,
    clubs: { Blackburn: 1 },
    teamLogos: { Blackburn: 'http://x/b.png' },
    lastRound: { 'U12|A': 14, 'U14|B': 16 },
    lastResultsFetch: '2026-08-10T00:00:00.000Z',
  }, null, 2));

  fs.writeFileSync(EFNL_CUR, JSON.stringify({
    meta: { org: '383836bb', kind: 'current', seasons: ['2dcbf383'] },
    matches: [
      { id: 'a', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', round: 14 },
      { id: 'b', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', round: 13 },
    ],
    players: [{ id: 'p1', compName: 'EFNL 2026' }],
    roster: { 'EFNL 2026|Blackburn|U12': { grade: 'A' } },
    gradeMeta: { 'EFNL 2026|U12|A': { r: 1 } },
  }));

  fs.writeFileSync(YJFL_CUR, JSON.stringify({
    meta: { org: '4f9a099e', kind: 'current', seasons: ['cda2f0ec'] },
    matches: [{ id: 'y', compName: 'YJFL 2026', age: 'U14', rawGrade: 'B', round: 16 }],
    players: [],
    roster: { 'YJFL 2026|Ivanhoe|U14': { grade: 'B' } },
    gradeMeta: { 'YJFL 2026|U14|B': { r: 2 } },
  }));
}

// Records a Phase A backfill of EFNL 2025 would add. No players — that is
// Phase B, and it is the whole reason the completeness signal exists.
const BACKFILL = [
  { id: 'c', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', round: 18 },
  { id: 'd', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', round: 17 },
  { id: 'e', compName: 'EFNL 2025', age: 'U14', rawGrade: 'B', round: 18 },
];

// ── Harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const sha = (p) => fs.existsSync(p)
  ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12)
  : '(absent)';
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ── 1. The success path ──────────────────────────────────────────────────────
console.log('\n1  A scoped save creates an -archive.json that does not exist');
reset();
const yjflBefore = sha(YJFL_CUR);
ok('archive absent to start with', !fs.existsSync(EFNL_ARC));

let d = store.load(['EFNL 2025']);
ok('load returned the live season only', d.matches.length === 2, `${d.matches.length} matches`);

d.matches.push(...BACKFILL);
d.roster['EFNL 2025|Blackburn|U12'] = { grade: 'A' };
d.gradeMeta['EFNL 2025|U12|A'] = { r: 1 };
const r1 = store.save(d, ['EFNL 2025']);
store.report(r1, 'verify');

ok('archive created', fs.existsSync(EFNL_ARC), sha(EFNL_ARC));
const arc = read(EFNL_ARC);
const cur = read(EFNL_CUR);
ok('archive holds only 2025 records',
  arc.matches.length === 3 && arc.matches.every((m) => m.compName === 'EFNL 2025'),
  `${arc.matches.length} matches`);
ok('current holds only 2026 records',
  cur.matches.length === 2 && cur.matches.every((m) => m.compName === 'EFNL 2026'),
  `${cur.matches.length} matches`);
ok('2025 roster key went to the archive', !!arc.roster['EFNL 2025|Blackburn|U12']);
ok('2026 roster key stayed in current', !!cur.roster['EFNL 2026|Blackburn|U12']);
ok('YJFL file byte-identical', sha(YJFL_CUR) === yjflBefore, `${yjflBefore} unchanged`);
ok('nothing skipped, nothing unplaced',
  r1.skipped === 0 && Object.keys(r1.unplaced).length === 0);
ok('rollover recorded once per season, not per record',
  r1.rolledOver.length === 1, `${r1.rolledOver.length} entries for 3 records`);

// ── 2. Per-season completeness in the file ───────────────────────────────────
console.log('\n2  meta.phases describes each season separately');
ok('archive phases keyed by season id',
  !!arc.meta.phases?.['75d8a232'], JSON.stringify(arc.meta.phases));
ok('2025 reports results and NO players',
  arc.meta.phases?.['75d8a232']?.results === true &&
  arc.meta.phases?.['75d8a232']?.players === false);
ok('the flags carry their counts',
  arc.meta.phases?.['75d8a232']?.matches === 3 &&
  arc.meta.phases?.['75d8a232']?.players_n === 0,
  `matches=${arc.meta.phases?.['75d8a232']?.matches}, players_n=${arc.meta.phases?.['75d8a232']?.players_n}`);
ok('2026 reports results AND players',
  cur.meta.phases?.['2dcbf383']?.results === true &&
  cur.meta.phases?.['2dcbf383']?.players === true);

// ── 3. The manifest copy ─────────────────────────────────────────────────────
console.log('\n3  The manifest mirrors the file, and leaves untouched seasons alone');
const core1 = read(CORE);
const mOf = (id) => core1.manifest.find((m) => m.seasonId === id);
ok('manifest 2025 matches the archive',
  JSON.stringify(mOf('75d8a232')?.phases) === JSON.stringify(arc.meta.phases?.['75d8a232']),
  JSON.stringify(mOf('75d8a232')?.phases));
ok('manifest 2026 matches current',
  JSON.stringify(mOf('2dcbf383')?.phases) === JSON.stringify(cur.meta.phases?.['2dcbf383']));
ok('YJFL manifest entry untouched by an EFNL-scoped save',
  mOf('cda2f0ec')?.phases?.results === true && mOf('cda2f0ec')?.phases?.players === true,
  JSON.stringify(mOf('cda2f0ec')?.phases));

// ── 4. Idempotency ───────────────────────────────────────────────────────────
console.log('\n4  Re-running the same backfill changes nothing but the timestamp');
const strip = (p) => { const o = read(p); delete o.meta.generatedAt; return JSON.stringify(o); };
const arcBefore = strip(EFNL_ARC);
let d2 = store.load(['EFNL 2025']);
ok('reload picks up both files', d2.matches.length === 5, `${d2.matches.length} matches`);
store.save(d2, ['EFNL 2025']);
ok('archive identical apart from generatedAt', strip(EFNL_ARC) === arcBefore);
ok('no duplicate records', read(EFNL_ARC).matches.length === 3);

// ── 5. Failure path: a competition missing from the manifest ─────────────────
console.log('\n5  Records with no manifest entry must THROW and write nothing');
reset(FULL_MANIFEST.filter((m) => m.compName !== 'EFNL 2025'));
const curBefore = sha(EFNL_CUR);
let threw = null;
try {
  const d3 = store.load(['EFNL 2026']);
  d3.matches.push(...BACKFILL);
  store.save(d3, ['EFNL 2026']);
} catch (e) { threw = e.message; }
ok('save threw', !!threw, threw ? threw.split('.')[0] : 'DID NOT THROW');
ok('archive was not created', !fs.existsSync(EFNL_ARC));
ok('current was NOT rewritten before throwing', sha(EFNL_CUR) === curBefore,
  'the check runs before the write loop');

// ── 6. Failure path: a roster key with no manifest entry ─────────────────────
// This is the gap the first version had: PREFIX_KEYS were not counted, so a
// stray roster key vanished with a warning while the save exited zero.
console.log('\n6  A stray roster key alone must THROW, with no match record to catch it');
reset();
threw = null;
try {
  const d4 = store.load(['EFNL 2026']);
  d4.roster['SEJ 2019|Berwick|U12'] = { grade: 'A' };
  store.save(d4, ['EFNL 2026']);
} catch (e) { threw = e.message; }
ok('save threw on a roster key alone', !!threw, threw ? threw.split('.')[0] : 'DID NOT THROW');

// ── 7. Could these tests have failed? ────────────────────────────────────────
// A verification that cannot fail proves nothing. Assert the fixture really is
// in the state the tests assume, rather than passing because nothing happened.
console.log('\n7  The fixture is real, not empty');
reset();
ok('fixture has records to lose', read(EFNL_CUR).matches.length === 2);
ok('fixture archive genuinely absent', !fs.existsSync(EFNL_ARC));
ok('the manifest has an entry the tests can remove',
  FULL_MANIFEST.some((m) => m.compName === 'EFNL 2025'));

// ── 8. An unscoped save still works ──────────────────────────────────────────
// All four live writers use a scope, but split-data.js and any recovery run do
// not. A change to the scoped path must not break the unscoped one.
console.log('\n8  An unscoped save still round-trips every organisation');
reset();
const d5 = store.load(null);
ok('unscoped load reads both organisations', d5.matches.length === 3, `${d5.matches.length} matches`);
store.save(d5, null);
ok('EFNL current intact', read(EFNL_CUR).matches.length === 2);
ok('YJFL current intact', read(YJFL_CUR).matches.length === 1);

// ── Done ─────────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
