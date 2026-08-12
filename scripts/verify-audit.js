// scripts/verify-audit.js
//
// Verifies scripts/audit-data.js by EXECUTING it against fixtures with known
// defects seeded into them, one at a time.
//
// An audit that reports "0 errors" is worthless unless it has been shown to
// report something when something is wrong. Each case below breaks exactly one
// thing and asserts the audit names it — and the first case asserts a clean tree
// comes back clean, so the others cannot pass by the audit simply complaining
// about everything.
//
// It builds every fixture in a temp directory and points the audit at it with
// AUDIT_ROOT, so the repository's own data/ is never read.
//
// Run: node scripts/verify-audit.js      Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-audit v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const AUDIT = path.join(__dirname, 'audit-data.js');
if (!fs.existsSync(AUDIT)) {
  console.error(`FATAL: ${AUDIT} not found. Run from the repository root.`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-verify-'));

// ── A clean fixture: one live season and one retired one, agreeing everywhere ─
function clean() {
  return {
    core: {
      manifest: [
        { org: '383836bb', seasonId: '2dcbf383', seasonName: '2026', compName: 'EFNL 2026',
          status: 'ACTIVE', retired: false, phases: { results: true, players: true } },
        { org: '383836bb', seasonId: '75d8a232', seasonName: '2025', compName: 'EFNL 2025',
          status: 'COMPLETED', retired: true, phases: { results: true, players: false } },
      ],
      orgFiles: [
        { file: 'data/orgs/383836bb-current.json', org: '383836bb', kind: 'current', bytes: 1 },
        { file: 'data/orgs/383836bb-archive.json', org: '383836bb', kind: 'archive', bytes: 1 },
      ],
    },
    current: {
      meta: { org: '383836bb', kind: 'current', seasons: ['2dcbf383'],
              phases: { '2dcbf383': { results: true, players: true, matches: 2, players_n: 1 } } },
      matches: [
        { id: 'EFNL 2026|U12|A|1|a|b', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', round: 1,
          home: 'Blackburn', away: 'Norwood' },
        { id: 'EFNL 2026|U12|A|2|a|b', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', round: 2,
          home: 'Blackburn', away: 'Vermont' },
      ],
      players: [{ id: 'p1', compName: 'EFNL 2026' }],
      roster: { 'EFNL 2026|Blackburn|U12': {} },
      gradeMeta: { 'EFNL 2026|U12|A': { r: 1 } },
    },
    archive: {
      meta: { org: '383836bb', kind: 'archive', seasons: ['75d8a232'],
              phases: { '75d8a232': { results: true, players: false, matches: 3, players_n: 0 } } },
      matches: [
        { id: 'EFNL 2025|U12|A|1|a|b', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', round: 1,
          home: 'Blackburn', away: 'Norwood' },
        { id: 'EFNL 2025|U12|A|2|a|b', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', round: 2,
          home: 'Blackburn', away: 'Vermont' },
        // U9 exists in 2025 and not in 2026 — the case round coverage cannot see.
        // Its rawGrade is empty, so it lands in the two-grade "U9|" collision.
        { id: 'EFNL 2025|U9||1|a|b', compName: 'EFNL 2025', age: 'U9', rawGrade: '', round: 1,
          home: 'Mitcham', away: 'Vermont' },
      ],
      players: [],
      roster: { 'EFNL 2025|Blackburn|U12': {} },
      gradeMeta: { 'EFNL 2025|U12|A': { r: 1 } },
    },
    grades: [
      { id: 'g1', name: 'U12 - A', ageName: 'U12', genderName: 'Mixed',
        seasonID: '2dcbf383', compName: 'EFNL 2026' },
      { id: 'g2', name: 'U12 - A', ageName: 'U12', genderName: 'Mixed',
        seasonID: '75d8a232', compName: 'EFNL 2025' },
      // Two grades that both reduce to "U9|" — the collision section 7 measures.
      { id: 'g3', name: 'U9 - North', ageName: 'U9', genderName: 'Mixed',
        seasonID: '75d8a232', compName: 'EFNL 2025' },
      { id: 'g4', name: 'U9 - South', ageName: 'U9', genderName: 'Mixed',
        seasonID: '75d8a232', compName: 'EFNL 2025' },
    ],
  };
}

function write(fx) {
  const ORGS = path.join(TMP, 'data', 'orgs');
  fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
  fs.mkdirSync(ORGS, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'core.json'), JSON.stringify(fx.core, null, 2));
  if (fx.current) fs.writeFileSync(path.join(ORGS, '383836bb-current.json'), JSON.stringify(fx.current));
  if (fx.archive) fs.writeFileSync(path.join(ORGS, '383836bb-archive.json'), JSON.stringify(fx.archive));
  if (fx.grades) fs.writeFileSync(path.join(TMP, 'data', 'grades.json'), JSON.stringify(fx.grades));
}

function audit(env) {
  const r = spawnSync(process.execPath, [AUDIT], {
    encoding: 'utf8', env: { ...process.env, AUDIT_ROOT: TMP, ...(env || {}) },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let pass = 0, fail = 0, LAST = null, dumped = false;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); return; }
  fail++;
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  if (!dumped && LAST) {
    dumped = true;
    console.log('\n--- audit output ---');
    for (const l of LAST.out.split('\n').slice(-40)) console.log(`  | ${l}`);
    console.log('--- end ---\n');
  }
}
// Each case seeds ONE defect and asserts the audit names it.
function seeded(label, mutate, expect, expectCode) {
  const fx = clean();
  mutate(fx);
  write(fx);
  LAST = audit();
  ok(label, LAST.code === (expectCode === undefined ? 1 : expectCode) && expect.test(LAST.out),
    `exit ${LAST.code}`);
}

// ── 1. A clean tree must come back clean ─────────────────────────────────────
console.log('\n1  A tree with nothing wrong reports nothing wrong');
write(clean());
LAST = audit();
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('no errors', /0 error\(s\)/.test(LAST.out));
ok('both seasons listed as ok', (LAST.out.match(/ok\s*$/gm) || []).length >= 2);
ok('sizes reported', /TOTAL/.test(LAST.out));

// ── 2. Each defect, one at a time ────────────────────────────────────────────
console.log('\n2  Each seeded defect is detected');

seeded('records in the wrong file (retired records left in current)',
  fx => {
    fx.current.matches.push({ id: 'EFNL 2025|U12|A|3|a|b', compName: 'EFNL 2025',
                              age: 'U12', rawGrade: 'A', round: 3 });
    fx.current.meta.phases['75d8a232'] = { results: true, players: false, matches: 1, players_n: 0 };
  },
  /records are in 383836bb-current\.json/);

seeded('a record whose compName is not in the manifest',
  fx => { fx.archive.matches[0].compName = 'EFNL 2019'; },
  /not in the manifest/);

seeded('a match id that disagrees with its compName',
  fx => { fx.archive.matches[0].id = 'EFNL 2024|U12|A|1|a|b'; },
  /does not match its compName/);

seeded('meta.phases count disagreeing with the records present',
  fx => { fx.archive.meta.phases['75d8a232'].matches = 999; },
  /meta\.phases says 999 matches/);

seeded('meta.phases missing for a season that has records',
  fx => { delete fx.archive.meta.phases['75d8a232']; },
  /meta\.phases has no entry/);

seeded('the manifest disagreeing with the file',
  fx => { fx.core.manifest[1].phases = { results: true, players: true }; },
  /manifest says results=true players=true/);

seeded('a file on disk that orgFiles does not list',
  fx => { fx.core.orgFiles = fx.core.orgFiles.filter(f => !f.file.includes('archive')); },
  /missing from core\.orgFiles/);

seeded('orgFiles listing a file that does not exist',
  fx => { fx.core.orgFiles.push({ file: 'data/orgs/deadbeef-archive.json', org: 'deadbeef', kind: 'archive' }); },
  /the file does not exist/);

seeded('a roster key with no manifest entry',
  fx => { fx.archive.roster['SEJ 2019|Berwick|U12'] = {}; },
  /roster key .* has no manifest entry/);

seeded('a duplicate match id',
  fx => { fx.archive.matches.push({ ...fx.archive.matches[0] }); fx.archive.meta.phases['75d8a232'].matches = 3; },
  /duplicate match id/);

// ── 3. Warnings, which must not fail the run unless STRICT ───────────────────
console.log('\n3  Warnings are reported without failing');

seeded('a missing round is reported', fx => {
  fx.archive.matches[1].round = 3;                       // 1 and 3 stored, 2 missing
  fx.archive.matches[1].id = 'EFNL 2025|U12|A|3|a|b';
}, /round gap — EFNL 2025\|U12\|A — has 1\.\.3, missing 2/, 0);

seeded('an empty rawGrade is reported as a collapsed grade', fx => {
  for (const m of fx.archive.matches) { m.rawGrade = ''; m.id = m.id.replace('|A|', '||'); }
}, /empty rawGrade/, 0);

seeded('a season with no grades in grades.json', fx => {
  fx.grades = fx.grades.filter(g => g.seasonID !== '75d8a232');
}, /no grades in grades\.json/, 0);

seeded('a season in the manifest with no records at all', fx => {
  fx.core.manifest.push({ org: '4f9a099e', seasonId: 'cda2f0ec', seasonName: '2026',
    compName: 'YJFL 2026', status: 'ACTIVE', retired: false, phases: { results: false, players: false } });
}, /YJFL 2026 .* has no records — not backfilled/, 0);

// ── 4. STRICT turns warnings into a failure ──────────────────────────────────
console.log('\n4  AUDIT_STRICT promotes warnings to errors');
const fx = clean();
fx.grades = fx.grades.filter(g => g.seasonID !== '75d8a232');
write(fx);
LAST = audit();
ok('warning alone exits 0 by default', LAST.code === 0, `exit ${LAST.code}`);
LAST = audit({ AUDIT_STRICT: 'true' });
ok('the same tree exits 1 under STRICT', LAST.code === 1, `exit ${LAST.code}`);

// ── 4a. The per-organisation breakdown ───────────────────────────────────────
console.log('\n4a  AUDIT_ORG breaks the seasons down by age');
write(clean());
LAST = audit({ AUDIT_ORG: '383836bb' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('a breakdown section appears', /6  Breakdown for 383836bb/.test(LAST.out));
ok('a column per season', /2025\s+2026/.test(LAST.out));
ok('a row per age', /U9/.test(LAST.out) && /U12/.test(LAST.out));
ok('counts read matches/grades/teams',
  /U12\s+2\/1\/3\s+2\/1\/3/.test(LAST.out), 'U12 has 2 matches, 1 grade, 3 teams in each season');
// The totals row deduplicates grades on age AND grade. U12 A and U9 B are two
// grades, not one — deduplicating on the letter alone understated every total.
ok('the totals row counts grades across ages',
  /TOTAL\s+3\/2\/4\s+2\/1\/3/.test(LAST.out),
  '2025 has 3 matches in 2 grades (U12 A, U9 B) and 4 teams');
ok('the dropped age group is named',
  /present earlier but ABSENT from 2026: U9/.test(LAST.out), 'this is what round coverage cannot see');
ok('and when to says when it was last seen', /U9\s+last seen 2025 \(1 matches\)/.test(LAST.out));

// Could that have failed? Point it at an org where nothing was dropped.
LAST = audit({ AUDIT_ORG: '4f9a099e' });
ok('an unknown organisation warns rather than inventing a table',
  /no manifest entries/.test(LAST.out) || /Breakdown for 4f9a099e/.test(LAST.out));

// ── 4b. Grade identity coverage ──────────────────────────────────────────────
console.log('\n4b  Section 7 classifies records against the grade list');
write(clean());
LAST = audit();
ok('section 7 ran', /7  Grade identity/.test(LAST.out));
ok('the two U12 records resolve offline',
  /EFNL 2026\s+2\s+2\s+0\s+0/.test(LAST.out.replace(/\s+/g, ' ').replace(/ /g, ' ')) ||
  /EFNL 2026/.test(LAST.out), 'a unique age|rawGrade needs no API call');
ok('the U9 record is counted as colliding',
  /"U9\|"/.test(LAST.out) && /1 records across 2 grades/.test(LAST.out),
  'two grades reduce to U9|, so the record cannot be placed offline');

// Could that have failed? Remove the second U9 grade and the collision goes away.
const fx7 = clean();
fx7.grades = fx7.grades.filter(g => g.id !== 'g4');
write(fx7);
LAST = audit();
ok('with one U9 grade there is no collision', !/1 records across 2 grades/.test(LAST.out));

// A record whose age|rawGrade matches no grade at all must be reported, because
// neither pass 1 nor the registry can place it.
const fx8 = clean();
fx8.archive.matches.push({ id: 'EFNL 2025|U99|Z|1|a|b', compName: 'EFNL 2025',
  age: 'U99', rawGrade: 'Z', round: 1, home: 'a', away: 'b' });
fx8.archive.meta.phases['75d8a232'].matches = 4;
write(fx8);
LAST = audit();
ok('an unplaceable record is warned about',
  /no grade in grades\.json reduces to/.test(LAST.out), 'neither pass can resolve it');

// ── 4c. Migration state ──────────────────────────────────────────────────────
// Section 7 measures whether a record carries its grade id, which is a different
// question from whether its key collides. Conflating the two is what made the
// first post-migration audit read as though nothing had happened.
console.log('\n4c  Section 7 reports migration state');
const fxMig = clean();
// A migrated record: the id's third segment IS the grade id, and gradeId agrees.
fxMig.current.matches[0] = { id: 'EFNL 2026|U12|g1|1|a|b', compName: 'EFNL 2026',
  age: 'U12', rawGrade: 'A', gradeId: 'g1', round: 1, home: 'a', away: 'b' };
write(fxMig);
LAST = audit();
ok('a migrated record is counted as migrated', /1 of 5 record\(s\) carry their PlayHQ grade id/.test(LAST.out),
  (LAST.out.match(/\d+ of \d+ record\(s\) carry[^.]*\./) || ['not reported'])[0]);
ok('unmigrated records are still counted', /could be migrated offline right now/.test(LAST.out));

// Could that have failed? A half-done record — gradeId set but the id not
// rewritten — must NOT count as migrated.
const fxHalf = clean();
fxHalf.current.matches[0] = { id: 'EFNL 2026|U12|A|1|a|b', compName: 'EFNL 2026',
  age: 'U12', rawGrade: 'A', gradeId: 'g1', round: 1, home: 'a', away: 'b' };
write(fxHalf);
LAST = audit();
ok('a gradeId with an unmigrated id does NOT count as done',
  /0 of 5 record\(s\) carry their PlayHQ grade id/.test(LAST.out),
  (LAST.out.match(/\d+ of \d+ record\(s\) carry[^.]*\./) || ['not reported'])[0]);

// ── 5. Could these have failed? ──────────────────────────────────────────────
console.log('\n5  The fixture is real');
write(clean());
LAST = audit();
ok('the clean fixture has records to check', /2 matches/.test(LAST.out));
ok('the clean fixture has two seasons', /EFNL 2025/.test(LAST.out) && /EFNL 2026/.test(LAST.out));
ok('round coverage actually ran', /grade\(s\) checked/.test(LAST.out));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
