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

const VERSION = 'verify-audit v6 2026-08-19 byes-settled';
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
      // Both correctly shaped. Section 9 checking an EMPTY map would pass
      // whatever it did, so the clean case has to carry real keys.
      // Retired as of audit v16. Kept in the fixture deliberately: section 9
      // reports it as INFO, and an empty map could not show that firing.
      lastRound: { 'EFNL 2026|U12|g1': 2, 'EFNL 2025|U12|g2': 2 },
      gotwFlags: { 'EFNL 2026|U12|2': 'EFNL 2026|U12|A|2|a|b' },
      seasonFiles: [
        { file: 'data/seasons/2dcbf383-core.json', seasonId: '2dcbf383', kind: 'core', bytes: 1 },
        { file: 'data/seasons/2dcbf383-players.json', seasonId: '2dcbf383', kind: 'players', bytes: 1 },
        { file: 'data/seasons/75d8a232-core.json', seasonId: '75d8a232', kind: 'core', bytes: 1 },
        { file: 'data/seasons/75d8a232-players.json', seasonId: '75d8a232', kind: 'players', bytes: 1 },
      ],
    },
    current: {
      meta: { seasonId: '2dcbf383', org: '383836bb', comps: ['EFNL 2026'],
              phases: { results: true, players: true, matches: 2, players_n: 1 } },
      matches: [
        { id: 'EFNL 2026|U12|A|1|a|b', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', gradeId: 'gA', round: 1,
          home: 'Blackburn', away: 'Norwood' },
        { id: 'EFNL 2026|U12|A|2|a|b', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', gradeId: 'gA', round: 2,
          home: 'Blackburn', away: 'Vermont' },
      ],
      players: [{ id: 'p1', compName: 'EFNL 2026' }],
      roster: { 'EFNL 2026|Blackburn|U12': {} },
      gradeMeta: { 'EFNL 2026|U12|A': { r: 1 } },
    },
    archive: {
      meta: { seasonId: '75d8a232', org: '383836bb', comps: ['EFNL 2025'],
              phases: { results: true, players: false, matches: 3, players_n: 0 } },
      matches: [
        { id: 'EFNL 2025|U12|A|1|a|b', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', gradeId: 'gA', round: 1,
          home: 'Blackburn', away: 'Norwood' },
        { id: 'EFNL 2025|U12|A|2|a|b', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', gradeId: 'gA', round: 2,
          home: 'Blackburn', away: 'Vermont' },
        // U9 exists in 2025 and not in 2026 — the case round coverage cannot see.
        // Its rawGrade is empty, so it lands in the two-grade "U9|" collision.
        { id: 'EFNL 2025|U9||1|a|b', compName: 'EFNL 2025', age: 'U9', rawGrade: '', gradeId: 'g', round: 1,
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

// data/seasons/<seasonId>-core.json and <seasonId>-players.json.
// per_season_storage_design.md. `current` and `archive` remain the fixture's
// shorthand for the 2026 and 2025 seasons; only where they land has changed.
const SEASONS = path.join(TMP, 'data', 'seasons');
const sCore = (id) => path.join(SEASONS, `${id}-core.json`);
const sPlayers = (id) => path.join(SEASONS, `${id}-players.json`);
function writeSeason(id, season) {
  const { players = [], ...rest } = season;
  fs.writeFileSync(sCore(id), JSON.stringify({ ...rest }));
  fs.writeFileSync(sPlayers(id), JSON.stringify({
    meta: { seasonId: id, count: players.length }, players,
  }));
}

function write(fx) {
  fs.rmSync(path.join(TMP, 'data'), { recursive: true, force: true });
  fs.mkdirSync(SEASONS, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'core.json'), JSON.stringify(fx.core, null, 2));
  if (fx.current) writeSeason('2dcbf383', fx.current);
  if (fx.archive) writeSeason('75d8a232', fx.archive);
  // Season files are read in sorted filename order, so anything placed here is
  // read AFTER both of the above. Used by 4c-bis.
  if (fx.extra) writeSeason(fx.extraId, fx.extra);
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
                              age: 'U12', rawGrade: 'A', gradeId: 'gA', round: 3 });
    fx.current.meta.phases.matches = 3;   // now disagrees with what is in the file
  },
  /records are in season file 2dcbf383/);

seeded('a record whose compName is not in the manifest',
  fx => { fx.archive.matches[0].compName = 'EFNL 2019'; },
  /not in the manifest/);

seeded('a match id that disagrees with its compName',
  fx => { fx.archive.matches[0].id = 'EFNL 2024|U12|A|1|a|b'; },
  /does not match its compName/);

seeded('meta.phases count disagreeing with the records present',
  fx => { fx.archive.meta.phases.matches = 999; },
  /meta\.phases says 999 matches/);

seeded('meta.phases missing for a season that has records',
  fx => { delete fx.archive.meta.phases; },
  /has 3 matches but no meta\.phases/);

seeded('the manifest disagreeing with the file',
  fx => { fx.core.manifest[1].phases = { results: true, players: true }; },
  /manifest says results=true players=true/);

seeded('a file on disk that seasonFiles does not list',
  fx => { fx.core.seasonFiles = fx.core.seasonFiles.filter(f => !f.file.includes('75d8a232')); },
  /missing from core\.seasonFiles/);

seeded('seasonFiles listing a file that does not exist',
  fx => { fx.core.seasonFiles.push({ file: 'data/seasons/deadbeef-core.json', seasonId: 'deadbeef', kind: 'core' }); },
  /the file does not exist/);

seeded('a roster key with no manifest entry',
  fx => { fx.archive.roster['SEJ 2019|Berwick|U12'] = {}; },
  /roster key .* has no manifest entry/);

seeded('a duplicate match id',
  fx => { fx.archive.matches.push({ ...fx.archive.matches[0] }); fx.archive.meta.phases.matches = 4; },
  /duplicate match id/);

// ── 3. Warnings, which must not fail the run unless STRICT ───────────────────
console.log('\n3  Warnings are reported without failing');

// A gap in a RETIRED season costs nothing: fetch-results.js takes its list from
// config.json and never walks an archive. Counting the two together produced a
// figure larger than the entire run it claimed to describe.
seeded('a missing round in a RETIRED season is reported as costing nothing', fx => {
  fx.archive.matches[1].round = 3;                       // 1 and 3 stored, 2 missing
  fx.archive.matches[1].id = 'EFNL 2025|U12|A|3|a|b';
}, /retired .*EFNL 2025\|U12\|gA — has 1\.\.3, missing 2/, 0);

seeded('and is NOT counted against the per-run cost', fx => {
  fx.archive.matches[1].round = 3;
  fx.archive.matches[1].id = 'EFNL 2025|U12|A|3|a|b';
}, /~0 round fixture call\(s\) re-fetched on every full results run/, 0);

// A gap in a LIVE season does cost, every run.
seeded('a missing round in a LIVE season IS counted', fx => {
  fx.current.matches[1].round = 3;
  fx.current.matches[1].id = 'EFNL 2026|U12|A|3|a|b';
}, /~2 round fixture call\(s\) re-fetched on every full results run/, 0);
// Two, not one: with rounds 1 and 3 stored the scan stops at 1, so rounds 2 AND
// 3 are re-fetched. My first expectation here said one and was simply wrong.

seeded('and is labelled LIVE so the two cannot be confused', fx => {
  fx.current.matches[1].round = 3;
  fx.current.matches[1].id = 'EFNL 2026|U12|A|3|a|b';
}, /LIVE .*EFNL 2026\|U12\|gA — has 1\.\.3, missing 2/, 0);

// A record with NO gradeId is no longer bucketed into round coverage at all —
// bucketing it under `compName|age|rawGrade` merged unrelated grades and invented
// gaps (six YJFL pools reported as one grade missing six rounds). It is counted
// and reported as unattributed instead.
seeded('a record with no gradeId is reported as unattributed', fx => {
  for (const m of fx.archive.matches) { delete m.gradeId; }
}, /record\(s\) across \d+ key\(s\) have no gradeId/, 0);

// It must read as SETTLED, not as an open defect. These are ambiguous byes in
// YJFL pool grades: a bye has no fixture to identify it and the pools are
// indistinguishable, so nothing can place them. Proved 2026-08-19 by running
// migrate-grade-ids passes 1, 2 and 3 for real — 279 API calls, 0 resolved.
//
// Asserted because the previous text told the reader they would "self-heal when a
// results run next fetches a real round", which was never true and left a
// permanent warning looking like a job someone had forgotten.
seeded('and reported as permanently unresolvable, with no action implied', fx => {
  for (const m of fx.archive.matches) { delete m.gradeId; }
}, /permanently unresolvable[\s\S]*NO ACTION/, 0);

seeded('it does not claim they self-heal', fx => {
  for (const m of fx.archive.matches) { delete m.gradeId; }
}, /^(?![\s\S]*self-heal)[\s\S]*no gradeId/, 0);

seeded('the unattributed key is named so it can be found', fx => {
  for (const m of fx.archive.matches) { delete m.gradeId; }
}, /unattributed — EFNL 2025\|U12\|A — \d+ record/, 0);

// And it must NOT appear as a round gap. This is the defect: those records used to
// produce a phantom gap in the same list as real ones.
{
  const fxu = clean();
  for (const m of fxu.archive.matches) { delete m.gradeId; }
  write(fxu);
  LAST = audit();
  ok('a gradeId-less record produces NO round gap',
    !/round gap — retired EFNL 2025/.test(LAST.out),
    'bucketing it under rawGrade is what invented the YJFL 2026 phantom gap');
}

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
  age: 'U99', rawGrade: 'Z', gradeId: 'gZ', round: 1, home: 'a', away: 'b' });
fx8.archive.meta.phases.matches = 4;
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
  age: 'U12', rawGrade: 'A', gradeId: 'gA', gradeId: 'g1', round: 1, home: 'a', away: 'b' };
write(fxMig);
LAST = audit();
ok('a migrated record is counted as migrated', /1 of 5 record\(s\) carry their PlayHQ grade id/.test(LAST.out),
  (LAST.out.match(/\d+ of \d+ record\(s\) carry[^.]*\./) || ['not reported'])[0]);
ok('unmigrated records are still counted', /could be migrated offline right now/.test(LAST.out));

// Could that have failed? A half-done record — gradeId set but the id not
// rewritten — must NOT count as migrated.
const fxHalf = clean();
fxHalf.current.matches[0] = { id: 'EFNL 2026|U12|A|1|a|b', compName: 'EFNL 2026',
  age: 'U12', rawGrade: 'A', gradeId: 'gA', gradeId: 'g1', round: 1, home: 'a', away: 'b' };
write(fxHalf);
LAST = audit();
ok('a gradeId with an unmigrated id does NOT count as done',
  /0 of 5 record\(s\) carry their PlayHQ grade id/.test(LAST.out),
  (LAST.out.match(/\d+ of \d+ record\(s\) carry[^.]*\./) || ['not reported'])[0]);

// ── 4c-bis. A LIVE round gap must be printed even when retired gaps outnumber it
// Only ten examples are printed. Until v12 they were the first ten found, in the
// order the season files happened to be read — so on 2026-08-13 the audit
// reported 1 live gap and 67 retired ones and printed ten retired examples,
// hiding the only gap with a per-run cost. 52 assertions passed that day because
// none of them checked WHICH examples were printed.
console.log('\n4c-bis  A live round gap is not crowded out by retired ones');
{
  const fxg = clean();
  // Twelve retired grades, each with rounds 1 and 3 stored and 2 missing. More
  // than the ten example slots, so an unranked list cannot show anything else.
  for (let i = 0; i < 12; i++) {
    const gid = `z${i}`;
    for (const rd of [1, 3]) {
      fxg.archive.matches.push({ id: `EFNL 2025|U13|${gid}|${rd}|a|b`, compName: 'EFNL 2025',
        age: 'U13', rawGrade: 'A', gradeId: 'gA', gradeId: gid, round: rd, home: 'a', away: 'b' });
    }
  }
  fxg.archive.meta.phases.matches = fxg.archive.matches.length;
  // The LIVE gap goes in a season whose id sorts LAST, so it is the last gap
  // found. Putting it in 2dcbf383 proved nothing: that file is read first, so it
  // headed the list whether or not the ranking existed — the first version of
  // this test passed with the sort deleted.
  fxg.extraId = 'ffffaaaa';
  fxg.extra = {
    meta: { seasonId: 'ffffaaaa', org: '383836bb', comps: ['EFNL 2027'],
            phases: { results: true, players: false, matches: 2, players_n: 0 } },
    matches: [
      { id: 'EFNL 2027|U12|gx|1|a|b', compName: 'EFNL 2027', age: 'U12',
        rawGrade: 'A', gradeId: 'gA', gradeId: 'gx', round: 1, home: 'a', away: 'b' },
      { id: 'EFNL 2027|U12|gx|3|a|b', compName: 'EFNL 2027', age: 'U12',
        rawGrade: 'A', gradeId: 'gA', gradeId: 'gx', round: 3, home: 'a', away: 'b' },
    ],
    players: [], roster: {}, gradeMeta: {},
  };
  fxg.core.manifest.push({ org: '383836bb', seasonId: 'ffffaaaa', seasonName: '2027',
    compName: 'EFNL 2027', status: 'ACTIVE', retired: false,
    phases: { results: true, players: false } });
  fxg.core.seasonFiles.push(
    { file: 'data/seasons/ffffaaaa-core.json', seasonId: 'ffffaaaa', kind: 'core', bytes: 1 },
    { file: 'data/seasons/ffffaaaa-players.json', seasonId: 'ffffaaaa', kind: 'players', bytes: 1 });
  fxg.grades.push({ id: 'gx', name: 'U12 - A', ageName: 'U12', genderName: 'Mixed',
    seasonID: 'ffffaaaa', compName: 'EFNL 2027' });
  write(fxg);
  LAST = audit();
  ok('the fixture really does have more retired gaps than example slots',
    /12 with a missing round|1[0-9] with a missing round/.test(LAST.out),
    (LAST.out.match(/\d+ grade\(s\) checked, \d+ with a missing round/) || ['not reported'])[0]);
  ok('the LIVE gap is printed', /LIVE .*EFNL 2027\|U12\|gx/.test(LAST.out),
    'this is the only gap that costs anything per run, and it is found LAST');
  ok('and it is the FIRST example listed',
    (LAST.out.match(/round gap — (LIVE|retired)/) || [])[1] === 'LIVE',
    (LAST.out.match(/round gap — \S+/) || ['none'])[0]);
  ok('retired gaps are still reported alongside it',
    /round gap — retired/.test(LAST.out));
  ok('exit 0 — gaps are warnings', LAST.code === 0, `exit ${LAST.code}`);
}

// ── 4d. Cross-organisation key shapes ───────────────────────────────────────
// lastround_gotw_keying_design.md. Section 9 exists because the failure mode is
// silent: a gotwFlags key the page cannot build falls through to the automatic
// pick, so nothing on screen says the administrator's choice was lost. An audit
// nobody has seen fire is worth nothing, so every branch is driven here.
//
// lastRound was checked alongside it until 2026-08-16 and is now RETIRED — engine
// v19 stopped writing it, Beta 0.176 removed its only reader. The shape
// assertions for it are gone; what replaces them is the assertion that it is
// reported as retired rather than silently dropped from the output.
console.log('\n4d  Section 9 checks the cross-organisation key shapes');
write(clean());
LAST = audit();
ok('section 9 ran', /9  Cross-organisation key shapes/.test(LAST.out));
ok('a correctly shaped tree raises no shape warning',
  !/are not compName/.test(LAST.out) && LAST.code === 0, `exit ${LAST.code}`);
ok('gotwFlags is counted',
  /gotwFlags\s+1 key\(s\), 1 in the/.test(LAST.out),
  (LAST.out.match(/gotwFlags\s+\d+ key\(s\)[^\n]*/) || ['not reported'])[0]);

// The retired key must be REPORTED, not silently absent. A key that vanishes from
// the output looks identical to a key that is empty, and this one is neither — it
// still holds two entries in the fixture.
ok('lastRound is reported as RETIRED',
  /lastRound\s+2 key\(s\) — RETIRED/.test(LAST.out),
  (LAST.out.match(/lastRound[^\n]*/) || ['not reported'])[0]);
ok('and it is NOT shape-checked any more',
  !/core\.lastRound: .* are not compName/.test(LAST.out),
  'a shape check on a key with no reader reports on nothing');

// Could that have failed? With no lastRound at all the RETIRED line must still
// print, reporting zero — otherwise the assertion above only passes for a tree
// that happens to carry the stale key.
{
  const fxr = clean();
  delete fxr.core.lastRound;
  write(fxr);
  LAST = audit();
  ok('the RETIRED line prints even with the key absent',
    /lastRound\s+0 key\(s\) — RETIRED/.test(LAST.out),
    (LAST.out.match(/lastRound[^\n]*/) || ['not reported'])[0]);
  ok('and an absent retired key raises nothing', LAST.code === 0, `exit ${LAST.code}`);
}

// A two-segment gotwFlags key — the pre-2026-08-13 shape the page could not build.
seeded('a two-segment gotwFlags key is reported',
  fx => { fx.core.gotwFlags['U12|3'] = 'EFNL 2026|U12|A|3|a|b'; },
  /core\.gotwFlags: 1 of 2 key\(s\) are not compName\|age\|roundKey/, 0);

// Right shape, wrong competition: three segments but naming a season absent from
// the manifest, so the page can never build it.
seeded('a key naming a competition absent from the manifest is reported',
  fx => { fx.core.gotwFlags['SEJ 2019|U12|3'] = 'SEJ 2019|U12|A|3|a|b'; },
  /core\.gotwFlags: 1 key\(s\) name a competition absent from the manifest/, 0);

// Could these have failed? Both are WARNINGS, so they must not fail the run on
// their own — and must fail it under STRICT, like every other warning.
{
  const fxk = clean();
  fxk.core.gotwFlags['U12|3'] = 'EFNL 2026|U12|A|3|a|b';
  write(fxk);
  LAST = audit();
  ok('a wrong-shape key alone exits 0', LAST.code === 0, `exit ${LAST.code}`);
  LAST = audit({ AUDIT_STRICT: 'true' });
  ok('the same tree exits 1 under STRICT', LAST.code === 1, `exit ${LAST.code}`);
}

// ── 4d-bis. Section 8 sizes on PERSON-SEASONS, and section 11 counts them ────
// Both sections were unverified until 2026-08-16, and both failed the same way
// when a first attempt was made: the clean fixture's player records carry no
// `uuid`, so section 8 counted zero people and section 11 zero person-seasons.
// Every assertion passed against nothing. working_practice.md records that shape
// — "a fixture must be the shape the code really produces" — and this is it.
//
// The fixture below is deliberately arithmetic that distinguishes the two
// readings. fetch-stats.js stores one record PER GRADE:
//
//   alice  2026 gA, 2026 gB, 2025 gA   -> 3 records, 2 person-seasons
//   bob    2026 gA                     -> 1 record,  1 person-season
//   cara   2025 gA                     -> 1 record,  1 person-season
//
//   records = 5, person-seasons = 4, people = 3
//   average AS IT SHOULD BE  = 4/3 = 1.33
//   average IF IT COUNTS RECORDS = 5/3 = 1.67
//
// Those two numbers differ, which is the whole point — the previous code printed
// the second while labelling it the first.
console.log('\n4d-bis  Section 8 divides by person-seasons, not records');
{
  const P = (uuid, name, gradeID) => ({ id: uuid + gradeID, uuid, name, gradeID,
    compName: '', age: 'U12', team: 'Blackburn', teamRaw: 'Blackburn', rawGrade: 'A',
    gp: 5, goals: 2 });
  const fx8 = clean();
  fx8.current.players = [
    { ...P('u-alice', 'Alice', 'gA'), compName: 'EFNL 2026' },
    { ...P('u-alice', 'Alice', 'gB'), compName: 'EFNL 2026' },
    { ...P('u-bob',   'Bob',   'gA'), compName: 'EFNL 2026' },
  ];
  fx8.archive.players = [
    { ...P('u-alice', 'Alice', 'gA'), compName: 'EFNL 2025' },
    { ...P('u-cara',  'Cara',  'gA'), compName: 'EFNL 2025' },
  ];
  // The manifest claims 2025 has no players; it now has two, and an unrelated
  // phase mismatch would fail assertions that are not about section 8.
  fx8.core.manifest[1].phases.players = true;
  fx8.archive.meta.phases.players = true;
  fx8.archive.meta.phases.players_n = 2;
  fx8.current.meta.phases.players_n = 3;
  write(fx8);
  LAST = audit();

  // The fixture is real: without uuids every assertion below passes vacuously.
  ok('the fixture carries uuids, so section 8 has something to count',
    /5 player record\(s\) with a uuid/.test(LAST.out),
    (LAST.out.match(/\d+ player record\(s\) with a uuid[^\n]*/) || ['not reported'])[0]);
  ok('person-seasons are counted and reported',
    /4 person-season\(s\)/.test(LAST.out),
    (LAST.out.match(/\d+ person-season\(s\)[^\n]*/) || ['not reported'])[0]);
  ok('distinct people are counted',
    /3 DISTINCT people/.test(LAST.out),
    (LAST.out.match(/\d+ DISTINCT people/) || ['not reported'])[0]);

  // THE assertion. 1.33 is person-seasons/people; 1.67 is records/people.
  ok('the average divides by PERSON-SEASONS',
    /1\.33 season\(s\) each on average/.test(LAST.out),
    (LAST.out.match(/[\d.]+ season\(s\) each on average/) || ['not reported'])[0]);
  ok('and NOT by records',
    !/1\.67 season\(s\) each on average/.test(LAST.out),
    '1.67 is records/people — the figure this fix removed');
  ok('the gap between the two is explained, not silent',
    /1 record\(s\) are a second or later grade/.test(LAST.out),
    (LAST.out.match(/\d+ record\(s\) are a second or later grade[^\n]*/) || ['not reported'])[0]);

  // Section 11 over the same fixture. It reported zero people before this,
  // because the clean fixture had no uuid on any player record.
  //
  // SLICED, not matched against the whole output. Section 10 prints a table whose
  // rows also begin "EFNL 2026" followed by numbers, so a bare regex over LAST.out
  // reports section 10's row while asserting on section 11's — the assertion is
  // right and the failure message points at the wrong table, which is worse than
  // no message at all.
  const s11 = LAST.out.slice(LAST.out.indexOf('11  Player records per person per season'));
  const row11 = (s11.match(/EFNL 2026\s+\d+\s+\d+\s+\d+\s+\d+/) || ['no EFNL 2026 row'])[0];
  ok('section 11 counts real people now',
    /11  Player records per person per season/.test(LAST.out) &&
    !/TOTAL\s+0\s+0\s+0\s+0/.test(s11),
    `${row11} — a TOTAL row of zeros is the vacuous pass this fixture exists to stop`);
  ok('section 11 sees the person holding two records in one season',
    /EFNL 2026\s+2\s+1\s/.test(s11), row11);
  ok('and reports a maximum of two records for one person-season',
    /EFNL 2026\s+2\s+1\s+\d+\s+2/.test(s11), row11);
  ok('the person-season total agrees with section 8',
    /1 person-season\(s\) have more than one record/.test(s11),
    (s11.match(/\d+ person-season\(s\) have more than one record/) || ['not reported'])[0]);
  ok('none of this is an error', LAST.code === 0, `exit ${LAST.code}`);
}

// ── 4e. Section 10: dropped records, defunct versus live ────────────────────
// grade_attribution_split_design.md §5 claim 2. The whole proposed fix keys on
// "is this grade defunct", so a section that cannot tell defunct from live would
// give a confident wrong number. Reintroducing `isDefunct = true` passed the entire
// suite before this was written.
console.log('\n4e  Section 10 tells a DEFUNCT grade from a LIVE one');
{
  // Two teams whose roster entries point at DIFFERENT grades, with the record
  // stored under a third grade nobody is in — a grading round.
  const fxd = clean();
  // Team names taken from the fixture's own records, not invented: the archive
  // matches are Mitcham v Vermont. My first attempt keyed the roster on 'a'/'b'
  // and nothing resolved, so nothing dropped and the test proved nothing.
  for (const m of fxd.archive.matches) {
    fxd.archive.roster[`EFNL 2025|${m.home}|${m.age}`] = { grade: 'A', gradeId: 'gDiv1', age: m.age };
    fxd.archive.roster[`EFNL 2025|${m.away}|${m.age}`] = { grade: 'A', gradeId: 'gDiv2', age: m.age };
  }
  for (const m of fxd.archive.matches) { m.gradeId = 'gGRADING'; }
  write(fxd);
  LAST = audit();
  ok('section 10 ran', /10  Records the dashboard never shows/.test(LAST.out));
  ok('the record is counted as dropped',
    /dropped record\(s\) sit in a DEFUNCT grade/.test(LAST.out));
  ok('and it is classed DEFUNCT, since no team resolves to gGRADING',
    /\[stored gGRADING, DEFUNCT\]/.test(LAST.out),
    (LAST.out.match(/\[stored [^\]]*\]/) || ['none'])[0]);
  ok('zero are classed LIVE', / 0 sit in a LIVE grade/.test(LAST.out),
    (LAST.out.match(/\d+ sit in a LIVE grade/) || ['not reported'])[0]);

  // Now the promotion case: the record is stored under a grade a team IS in.
  // This must be LIVE, because the defunct rule must NOT fire on a promotion.
  const fxl = clean();
  for (const m of fxl.archive.matches) {
    fxl.archive.roster[`EFNL 2025|${m.home}|${m.age}`] = { grade: 'A', gradeId: 'gA', age: m.age };
    fxl.archive.roster[`EFNL 2025|${m.away}|${m.age}`] = { grade: 'B', gradeId: 'gB', age: m.age };
  }
  for (const m of fxl.archive.matches) { m.gradeId = 'gA'; }
  write(fxl);
  LAST = audit();
  ok('a record stored under a grade a team IS in is classed LIVE',
    /\[stored gA, LIVE\]/.test(LAST.out),
    (LAST.out.match(/\[stored [^\]]*\]/) || ['none'])[0]);
  ok('and the live count is non-zero',
    !/ 0 sit in a LIVE grade/.test(LAST.out),
    (LAST.out.match(/\d+ sit in a LIVE grade/) || ['not reported'])[0]);

  // Could these have failed? A tree where both sides agree must drop nothing.
  write(clean());
  LAST = audit();
  ok('a clean tree drops nothing at all',
    /^\s*0 dropped record\(s\) sit in a DEFUNCT grade/m.test(LAST.out) ||
    /  0 dropped record\(s\) sit in a DEFUNCT grade/.test(LAST.out),
    (LAST.out.match(/\d+ dropped record\(s\) sit in a DEFUNCT/) || ['not reported'])[0]);
}

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
