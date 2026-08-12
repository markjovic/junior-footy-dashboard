// scripts/verify-migrate-grade-ids.js
//
// Verifies scripts/migrate-grade-ids.js by EXECUTING it as a child process with
// only scripts/lib/playhq.js stubbed. Everything else is the committed code, and
// the repository's own data/ is never opened.
//
// A migration that cannot prove it lost nothing is not a migration
// (grade_identity_migration.md §5), so this covers the success path, the
// integrity guards, and the failure paths — including the one that matters most,
// two records merging into one id.
//
// Run: node scripts/verify-migrate-grade-ids.js    Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-migrate-grade-ids v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const SCRIPTS = __dirname;
for (const f of ['migrate-grade-ids.js', 'lib/store.js', 'lib/results-engine.js']) {
  if (!fs.existsSync(path.join(SCRIPTS, f))) {
    console.error(`FATAL: scripts/${f} not found.`);
    process.exit(1);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-verify-'));
const ORGS = path.join(TMP, 'data', 'orgs');
const CORE = path.join(TMP, 'data', 'core.json');
const ARC = path.join(ORGS, '383836bb-archive.json');
const YJFL = path.join(ORGS, '4f9a099e-current.json');

fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(path.join(SCRIPTS, 'migrate-grade-ids.js'), path.join(TMP, 'scripts', 'migrate-grade-ids.js'));
for (const f of ['store.js', 'results-engine.js']) {
  fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(TMP, 'scripts', 'lib', f));
}

// ── The stub. Only the network. ──────────────────────────────────────────────
// Two teams in "U8 - North" and two in "U8 - South", plus one ungraded team, so
// pass 2 has something to resolve and something it cannot.
fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'), `
'use strict';
const TEAMS = [
  { id: 't1', name: 'Bayswater U8 Gold',  grade: { id: 'gN', name: 'U8 - North' } },
  { id: 't2', name: 'Boronia U8 Brown',   grade: { id: 'gN', name: 'U8 - North' } },
  { id: 't3', name: 'Vermont U8 Blue',    grade: { id: 'gS', name: 'U8 - South' } },
  { id: 't4', name: 'Mitcham U8 Red',     grade: { id: 'gS', name: 'U8 - South' } },
  { id: 't5', name: 'Nowhere U8 Grey',    grade: null },
  { id: 't6', name: 'Nobody U8 Black',    grade: null },
];
// Round 3 of grade gS holds the match pass 2 could not place, because both its
// teams are ungraded in the registry. Pass 3 reads the grade from the fixture.
const ROUNDS = {
  gN: [{ id: 'rN3', number: '3', isFinalsRound: false },
       { id: 'rN4', number: '4', isFinalsRound: false },
       { id: 'rN5', number: '5', isFinalsRound: false }],
  gS: [{ id: 'rS3', number: '3', isFinalsRound: false },
       { id: 'rS4', number: '4', isFinalsRound: false },
       { id: 'rS5', number: '5', isFinalsRound: false }],
};
const FIXTURES = {
  rN3: [],
  rS3: [{ home: { name: 'Nobody U8 Black' }, away: { name: 'Nowhere U8 Grey' } }],
  // Round 4: gN played, gS did not — so a bye in round 4 is gS's.
  rN4: [{ home: { name: 'Bayswater U8 Gold' }, away: { name: 'Boronia U8 Brown' } }],
  rS4: [],
  // Round 5: neither played. A bye here cannot be attributed to either.
  rN5: [], rS5: [],
};
module.exports = {
  gqlPost: async (query, vars) => {
    if (process.env.STUB_FAIL === 'true') throw new Error('stub: forced registry failure');
    if (/gradeRounds/.test(query)) return { data: { discoverGrade: { rounds: ROUNDS[vars.gradeID] || [] } } };
    if (/discoverFixtureByRound/.test(query)) {
      return { data: { discoverFixtureByRound: { games: FIXTURES[vars.roundID] || [] } } };
    }
    return { data: { discoverTeams: TEAMS } };
  },
  refreshSession: async () => {}, sleep: async () => {}, logSummary: () => {},
};
`);

const GRADES = [
  // Two grades that both reduce to "U8|" — the collision pass 2 must settle.
  { id: 'gN', name: 'U8 - North', ageName: 'U8', genderName: 'Mixed', seasonID: '75d8a232', compName: 'EFNL 2025' },
  { id: 'gS', name: 'U8 - South', ageName: 'U8', genderName: 'Mixed', seasonID: '75d8a232', compName: 'EFNL 2025' },
  // A unique key, resolvable by pass 1 alone.
  { id: 'gP', name: 'Premier Senior Men', ageName: 'Senior', genderName: 'Men', seasonID: '75d8a232', compName: 'EFNL 2025' },
  { id: 'gY', name: 'U14 - A', ageName: 'U14', genderName: 'Mixed', seasonID: 'cda2f0ec', compName: 'YJFL 2026' },
];

const M = (comp, age, raw, round, h, a, extra) => Object.assign({
  id: `${comp}|${age}|${raw}|${round}|${h}|${a}`,
  compName: comp, age, rawGrade: raw, round, home: h, away: a,
}, extra || {});

function base() {
  return {
    manifest: [
      { org: '383836bb', seasonId: '75d8a232', seasonName: '2025', compName: 'EFNL 2025',
        status: 'COMPLETED', retired: true, phases: { results: true, players: false } },
      { org: '4f9a099e', seasonId: 'cda2f0ec', seasonName: '2026', compName: 'YJFL 2026',
        status: 'ACTIVE', retired: false, phases: { results: true, players: false } },
    ],
    // The value is a match id. It must follow the record it points at.
    gotwFlags: { 'U8|1': 'EFNL 2025|U8||1|Bayswater Gold|Boronia Brown' },
    lastRound: { 'U8|': 3 },
    archive: [
      M('EFNL 2025', 'U8', '', 1, 'Bayswater Gold', 'Boronia Brown'),   // pass 2 -> gN
      M('EFNL 2025', 'U8', '', 2, 'Mitcham Red', 'Vermont Blue'),       // pass 2 -> gS
      M('EFNL 2025', 'U8', '', 3, 'Nobody Black', 'Nowhere Grey'),      // pass 3 -> gS
      // A bye sentinel. No fixture can match it; only elimination can place it.
      M('EFNL 2025', 'U8', '', 4, '__bye__', '__bye__', { isBye: true }),
      // A bye in a round where NEITHER candidate played — must stay unresolved.
      M('EFNL 2025', 'U8', '', 5, '__bye__', '__bye__', { isBye: true }),
      M('EFNL 2025', 'Senior Men', 'Premier', 1, 'Balwyn Seniors', 'Norwood Seniors'), // pass 1
    ],
  };
}

function write(fx) {
  fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
  fs.mkdirSync(ORGS, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'grades.json'), JSON.stringify(fx.grades || GRADES));
  fs.writeFileSync(CORE, JSON.stringify({
    manifest: fx.manifest, gotwFlags: fx.gotwFlags, lastRound: fx.lastRound,
    orgFiles: [], clubs: {},
  }, null, 2));
  fs.writeFileSync(ARC, JSON.stringify({
    meta: { org: '383836bb', kind: 'archive', seasons: ['75d8a232'] },
    matches: fx.archive, players: [], roster: { 'EFNL 2025|Bayswater|U8': {} },
    gradeMeta: { 'EFNL 2025|U8|': { r: 1 } },
  }));
  fs.writeFileSync(YJFL, JSON.stringify({
    meta: { org: '4f9a099e', kind: 'current', seasons: ['cda2f0ec'] },
    matches: [M('YJFL 2026', 'U14', 'A', 1, 'Ivanhoe', 'Kew')],
    players: [], roster: {}, gradeMeta: {},
  }));
}

function run(env) {
  const r = spawnSync(process.execPath, ['scripts/migrate-grade-ids.js'], {
    cwd: TMP, encoding: 'utf8',
    env: { ...process.env, MIGRATE_ORG: '383836bb', ...env },
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
    console.log('\n--- migration output ---');
    for (const l of LAST.out.split('\n').slice(-45)) console.log(`  | ${l}`);
    console.log('--- end ---\n');
  }
}

// ── 1. Dry run is the default and writes nothing ─────────────────────────────
console.log('\n1  Dry run is the default');
write(base());
const beforeArc = fs.readFileSync(ARC, 'utf8');
LAST = run({});
ok('exit 2', LAST.code === 2, `exit ${LAST.code}`);
ok('says DRY RUN', /DRY RUN/.test(LAST.out));
ok('archive byte-identical', fs.readFileSync(ARC, 'utf8') === beforeArc);
ok('reports the plan', /records to rewrite\s*:\s*3/.test(LAST.out),
  '1 by pass 1, 2 by pass 2');
ok('reports what it cannot do without pass 3', /left on the old id\s*:\s*3/.test(LAST.out),
  '1 game plus 2 bye sentinels, none placeable without a fixture');

// ── 2. The real run ──────────────────────────────────────────────────────────
console.log('\n2  Applying the migration');
LAST = run({ MIGRATE_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
const arc = read(ARC);
const byHome = (h) => arc.matches.find(m => m.home === h || m.away === h);
ok('pass 1 record rewritten',
  (byHome('Balwyn Seniors') || {}).id === 'EFNL 2025|Senior Men|gP|1|Balwyn Seniors|Norwood Seniors',
  (byHome('Balwyn Seniors') || {}).id);
ok('pass 2 resolved a U8 North match',
  (byHome('Bayswater Gold') || {}).id === 'EFNL 2025|U8|gN|1|Bayswater Gold|Boronia Brown',
  (byHome('Bayswater Gold') || {}).id);
ok('pass 2 resolved a U8 South match to a DIFFERENT grade',
  (byHome('Vermont Blue') || {}).id === 'EFNL 2025|U8|gS|2|Mitcham Red|Vermont Blue',
  (byHome('Vermont Blue') || {}).id);
ok('gradeId set on the record', (byHome('Bayswater Gold') || {}).gradeId === 'gN');
ok('rawGrade KEPT for display', (byHome('Bayswater Gold') || {}).rawGrade === '');
ok('the unresolvable record keeps its old id',
  (byHome('Nobody Black') || {}).id === 'EFNL 2025|U8||3|Nobody Black|Nowhere Grey',
  (byHome('Nobody Black') || {}).id);
ok('no record lost', arc.matches.length === 6, `${arc.matches.length} records`);

const core2 = read(CORE);
ok('gotwFlags VALUE remapped',
  core2.gotwFlags['U8|1'] === 'EFNL 2025|U8|gN|1|Bayswater Gold|Boronia Brown',
  core2.gotwFlags['U8|1']);
ok('gotwFlags KEY untouched', 'U8|1' in core2.gotwFlags);
ok('lastRound untouched', core2.lastRound['U8|'] === 3);
ok('gradeMeta untouched', !!read(ARC).gradeMeta['EFNL 2025|U8|']);
ok('the other organisation is untouched', read(YJFL).matches[0].id === 'YJFL 2026|U14|A|1|Ivanhoe|Kew');

// ── 3. Idempotency ───────────────────────────────────────────────────────────
console.log('\n3  Re-running changes nothing');
LAST = run({ MIGRATE_DRY_RUN: 'false' });
ok('exit 2, nothing to do', LAST.code === 2, `exit ${LAST.code}`);
ok('already-migrated records counted', /already migrated\s*:\s*3/.test(LAST.out));
ok('still 6 records', read(ARC).matches.length === 6);

// ── 4. Failure paths ─────────────────────────────────────────────────────────
console.log('\n4  Guards must refuse rather than produce something wrong');

// Two records that would collapse onto one id. This is the one that must never
// pass: a migration that merges records has destroyed data.
// Two records, same teams and round, differing only in rawGrade, where both
// rawGrades resolve to the SAME grade id — so both rewrite to one id.
// The first attempt at this fixture produced an unplaceable record instead and
// the test passed for the wrong reason.
const fxDup = base();
fxDup.grades = GRADES.concat([
  // "U8 - A" reduces to U8|A and carries the same id as "U8 - North".
  { id: 'gN', name: 'U8 - A', ageName: 'U8', genderName: 'Mixed',
    seasonID: '75d8a232', compName: 'EFNL 2025' },
]);
// key "U8|A" -> gN by pass 1; the existing record 1 is key "U8|" -> gN by pass 2.
fxDup.archive.push(M('EFNL 2025', 'U8', 'A', 1, 'Bayswater Gold', 'Boronia Brown'));
write(fxDup);
LAST = run({ MIGRATE_DRY_RUN: 'false' });
ok('refuses to merge two records into one id',
  LAST.code === 1 && /would both become/.test(LAST.out), `exit ${LAST.code}`);

write(base());
LAST = run({ MIGRATE_ORG: 'deadbeef' });
ok('refuses an unknown organisation', LAST.code === 1 && /no manifest entries/.test(LAST.out));
LAST = run({ MIGRATE_ORG: 'nope' });
ok('refuses a malformed code', LAST.code === 1 && /8-character/.test(LAST.out));

const beforeFail = fs.readFileSync(ARC, 'utf8');
LAST = run({ MIGRATE_DRY_RUN: 'false', STUB_FAIL: 'true' });
ok('a registry failure aborts', LAST.code === 1 && /registry fetch failed/.test(LAST.out));
ok('and writes nothing', fs.readFileSync(ARC, 'utf8') === beforeFail,
  'the fetch happens before any write');

// ── 5. Pass 2 can be skipped ─────────────────────────────────────────────────
console.log('\n5  MIGRATE_SKIP_PASS2 resolves offline only');
write(base());
LAST = run({ MIGRATE_DRY_RUN: 'false', MIGRATE_SKIP_PASS2: 'true' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('only the pass 1 record was rewritten',
  read(ARC).matches.filter(m => String(m.id).split('|')[2] && m.gradeId).length === 1);
ok('the U8 records were left alone',
  read(ARC).matches.filter(m => m.id.startsWith('EFNL 2025|U8||')).length === 5,
  '2 games plus 1 pass-3 game plus 2 byes');

// ── 5a. MIGRATE_ORG=all ──────────────────────────────────────────────────────
console.log('\n5a  MIGRATE_ORG=all does every organisation in one run');
write(base());
LAST = run({ MIGRATE_ORG: 'all' });
ok('dry run exits 2', LAST.code === 2, `exit ${LAST.code}`);
ok('both organisations reported', /2 organisation\(s\)/.test(LAST.out) &&
  /organisation 383836bb/.test(LAST.out) && /organisation 4f9a099e/.test(LAST.out));
ok('nothing written', read(YJFL).matches[0].id === 'YJFL 2026|U14|A|1|Ivanhoe|Kew');

LAST = run({ MIGRATE_ORG: 'all', MIGRATE_DRY_RUN: 'false' });
ok('real run exits 0', LAST.code === 0, `exit ${LAST.code}`);
ok('EFNL migrated', read(ARC).matches.some(m => m.id === 'EFNL 2025|U8|gN|1|Bayswater Gold|Boronia Brown'));
ok('YJFL migrated too — not just the first organisation',
  read(YJFL).matches[0].id === 'YJFL 2026|U14|gY|1|Ivanhoe|Kew',
  read(YJFL).matches[0].id);
ok('each organisation reported its own totals', /written: 383836bb, 4f9a099e/.test(LAST.out));

// Could that have failed? A second all-run must find nothing to do.
LAST = run({ MIGRATE_ORG: 'all', MIGRATE_DRY_RUN: 'false' });
ok('a second all-run exits 2', LAST.code === 2, `exit ${LAST.code}`);

// ── 5b. Pass 3 ───────────────────────────────────────────────────────────────
console.log('\n5b  Pass 3 reads the grade from the fixture');
write(base());
LAST = run({ MIGRATE_PASS3: 'true' });
ok('a dry run reports the call count and makes none',
  /worst case \d+ API call\(s\)/.test(LAST.out) && /DRY RUN — no calls made/.test(LAST.out));
ok('and is still targeted, not a season crawl', /grade\(s\) to list/.test(LAST.out));

LAST = run({ MIGRATE_PASS3: 'true', MIGRATE_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('the record pass 2 could not place is now resolved',
  /resolved by fixture : 1/.test(LAST.out),
  (LAST.out.match(/resolved by fixture : \d+/) || ['not reported'])[0]);
ok('only the deliberately ambiguous bye is left',
  /still unresolved    : 1/.test(LAST.out),
  'the round-5 bye, where neither candidate grade played');
const arc3 = read(ARC);
ok('it went to the grade the FIXTURE said, not a guess',
  arc3.matches.some(m => m.id === 'EFNL 2025|U8|gS|3|Nobody Black|Nowhere Grey'),
  (arc3.matches.find(m => m.home === 'Nobody Black') || {}).id);
ok('five of six migrated, the ambiguous bye excepted',
  arc3.matches.filter(m => m.gradeId).length === 5,
  arc3.matches.filter(m => !m.gradeId).length + ' without a gradeId');

// Could that have failed? Without pass 3 the same record stays behind.
write(base());
LAST = run({ MIGRATE_DRY_RUN: 'false' });
ok('without pass 3 the record is left alone',
  read(ARC).matches.some(m => m.id === 'EFNL 2025|U8||3|Nobody Black|Nowhere Grey'));
ok('and the run says how to resolve it', /set MIGRATE_PASS3=true/.test(LAST.out));

// ── 5c. Bye sentinels ────────────────────────────────────────────────────────
console.log('\n5c  Bye sentinels are placed by elimination, or left alone');
write(base());
LAST = run({ MIGRATE_PASS3: 'true', MIGRATE_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('the unambiguous bye was resolved', /resolved as a bye   : 1/.test(LAST.out),
  (LAST.out.match(/resolved as a bye   : \d+/) || ['not reported'])[0]);
const arcB = read(ARC);
ok('it went to the grade that did NOT play that round',
  arcB.matches.some(m => m.id === 'EFNL 2025|U8|gS|4|__bye__|__bye__'),
  (arcB.matches.find(m => m.round === 4) || {}).id);
ok('the ambiguous bye was left alone — not guessed',
  arcB.matches.some(m => m.id === 'EFNL 2025|U8||5|__bye__|__bye__'),
  (arcB.matches.find(m => m.round === 5) || {}).id);
ok('and the reason is reported', /1 ambiguous bye/.test(LAST.out),
  (LAST.out.match(/\(\d+ ambiguous bye[^)]*\)/) || ['not reported'])[0]);

// ── 6. Could these have failed? ──────────────────────────────────────────────
console.log('\n6  The fixture is real');
write(base());
ok('fixture has a genuine collision', GRADES.filter(g => g.name.startsWith('U8 -')).length === 2);
ok('fixture has records in it', read(ARC).matches.length === 6);
ok('fixture gotwFlags points at a real record',
  read(ARC).matches.some(m => m.id === read(CORE).gotwFlags['U8|1']));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
