// scripts/verify-dashboard-grades.js
//
// Verifies that index.html groups ladders by grade IDENTITY and displays grade
// LABELS. grade_identity_migration.md build-order step 6.
//
// It extracts the real inline <script> from index.html and evaluates it in a
// sandbox with a minimal DOM, so the functions under test are the committed
// ones rather than a copy. Nothing is written and index.html is never modified.
//
// What it is checking for: before this change, four EFNL U8 grades collapsed
// onto one empty rawGrade and shared a single ladder. Grouping is now on the
// PlayHQ grade id, and every visible string goes through gLabel().
//
// Run: node scripts/verify-dashboard-grades.js    Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VERSION = 'verify-dashboard-grades v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const HTML = path.join(__dirname, '..', 'index.html');
if (!fs.existsSync(HTML)) { console.error('FATAL: index.html not found.'); process.exit(1); }
const html = fs.readFileSync(HTML, 'utf8');

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.error('FATAL: no inline script found in index.html.'); process.exit(1); }

// A DOM stub that answers everything with something harmless. The script only
// touches the DOM from event handlers and render functions, none of which run
// here — but top-level lookups must not throw.
const noop = () => {};
const el = () => ({
  style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  dataset: {}, addEventListener: noop, appendChild: noop, setAttribute: noop,
  innerHTML: '', textContent: '', value: '', children: [], querySelectorAll: () => [],
});
const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  document: {
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), addEventListener: noop, body: el(), documentElement: el(),
  },
  window: {}, navigator: { userAgent: 'node' }, location: { protocol: 'https:', search: '' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: () => Promise.reject(new Error('no network in the harness')),
  setTimeout: noop, setInterval: noop, clearTimeout: noop, clearInterval: noop,
  requestAnimationFrame: noop, indexedDB: undefined, matchMedia: () => ({ matches: false, addEventListener: noop }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let ctx;
try {
  ctx = vm.createContext(sandbox);
  for (const b of blocks) vm.runInContext(b, ctx, { timeout: 10000 });
} catch (e) {
  console.error(`FATAL: index.html's script threw while loading: ${e.message}`);
  console.error('That is a real defect, not a harness problem — the page would not start.');
  process.exit(1);
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
// `let S` inside the page script is NOT a property of the sandbox global — only
// function declarations are — so everything touching state runs in-context.
const run = (code) => vm.runInContext(code, ctx, { timeout: 10000 });
const has = (n) => run(`typeof ${n}`) === 'function';

// ── 1. The functions exist ───────────────────────────────────────────────────
console.log('\n1  The grade identity layer is present');
for (const fn of ['gLabel', 'rebuildGradeLabels', 'gradeLabelOf', 'matchGrade',
                  'currentGrade', 'gradesForAge', 'gradeSortPos']) {
  ok(`${fn}() defined`, has(fn));
}
if (fail) { console.log('\nstopping — the rest cannot be meaningful'); process.exit(1); }

// ── 2. Labels ────────────────────────────────────────────────────────────────
// The four EFNL U8 grades: one empty rawGrade, distinct ids and labels.
console.log('\n2  gLabel turns an id into something readable');
sandbox.__fx = {
  gradeMeta: {
    'EFNL 2026|U8|aaa11111': { r: 1, lvl: 'junior', g: 'M', label: 'Eastern', gradeId: 'aaa11111' },
    'EFNL 2026|U8|bbb22222': { r: 2, lvl: 'junior', g: 'M', label: 'West', gradeId: 'bbb22222' },
    'EFNL 2026|U8|': { r: 1, lvl: 'junior', g: 'M' },
  },
};
run('Object.assign(S, __fx); rebuildGradeLabels();');
ok('an id resolves to its label', run("gLabel('aaa11111')") === 'Eastern', run("gLabel('aaa11111')"));
ok('two collapsed grades get DIFFERENT labels',
  run("gLabel('aaa11111')") !== run("gLabel('bbb22222')"),
  `${run("gLabel('aaa11111')")} vs ${run("gLabel('bbb22222')")}`);
ok('a pre-migration key passes through unchanged', run("gLabel('A')") === 'A');
ok('an unknown id falls back to itself rather than blank',
  run("gLabel('zzz99999')") === 'zzz99999', run("gLabel('zzz99999')"));
ok('an empty key stays empty', run("gLabel('')") === '');

// ── 3. Grouping ──────────────────────────────────────────────────────────────
console.log('\n3  Ladders group by identity, so collapsed grades separate');
sandbox.__m = [
  { id: 'm1', compName: 'EFNL 2026', age: 'U8', rawGrade: '', gradeId: 'aaa11111',
    round: 1, home: 'Bayswater', away: 'Boronia', hScore: 1, aScore: 0 },
  { id: 'm2', compName: 'EFNL 2026', age: 'U8', rawGrade: '', gradeId: 'bbb22222',
    round: 1, home: 'Vermont', away: 'Mitcham', hScore: 1, aScore: 0 },
];
sandbox.__r = {
  'EFNL 2026|Bayswater|U8': { grade: '', gradeId: 'aaa11111', age: 'U8' },
  'EFNL 2026|Boronia|U8':   { grade: '', gradeId: 'aaa11111', age: 'U8' },
  'EFNL 2026|Vermont|U8':   { grade: '', gradeId: 'bbb22222', age: 'U8' },
  'EFNL 2026|Mitcham|U8':   { grade: '', gradeId: 'bbb22222', age: 'U8' },
};
run('S.matches = __m.map(x => ({...x})); S.roster = __r; S.selComp = "";');

ok('matchGrade returns the grade id, not the rawGrade',
  run('matchGrade(S.matches[0])') === 'aaa11111', run('matchGrade(S.matches[0])'));
ok('two matches in different grades do NOT share a grouping key',
  run('matchGrade(S.matches[0]) !== matchGrade(S.matches[1])'),
  'they have the same empty rawGrade');

const grades = run('gradesForAge("U8")');
ok('gradesForAge returns TWO grades, not one',
  grades.length === 2, `${grades.length}: ${JSON.stringify(grades)}`);
ok('ordered by rank, not by id',
  run(`gradeSortPos("EFNL 2026","U8",${JSON.stringify(grades[0])}) <= gradeSortPos("EFNL 2026","U8",${JSON.stringify(grades[1])})`),
  `${run(`gLabel(${JSON.stringify(grades[0])})`)} then ${run(`gLabel(${JSON.stringify(grades[1])})`)}`);
ok('both labelled distinctly for display',
  new Set(grades.map(g => run(`gLabel(${JSON.stringify(g)})`))).size === 2,
  grades.map(g => run(`gLabel(${JSON.stringify(g)})`)).join(', '));

// ── 3a. A promoted team stays on ONE ladder ─────────────────────────────────
// team_registry_design.md §3.4: a team appears on exactly one ladder. Earlier
// results still show; they do not count on the grade the team has left.
// Returning the match's own gradeId here was tried on 2026-08-12 and reverted,
// because it split a promoted team across two ladders.
console.log('\n3a  A promoted team counts on one ladder only');
run(`S.gradeMeta = {
  'EFNL 2026|U12|gA': { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'gA' },
  'EFNL 2026|U12|gB': { r: 2, lvl: 'junior', g: 'M', label: 'B', gradeId: 'gB' },
}; rebuildGradeLabels();`);
sandbox.__m3 = [
  // Norwood played B in round 1, then was promoted to A from round 5.
  { id: 'p1', compName: 'EFNL 2026', age: 'U12', rawGrade: 'B', gradeId: 'gB',
    round: 1, home: 'Norwood', away: 'Vermont', hScore: 1, aScore: 0 },
  { id: 'p2', compName: 'EFNL 2026', age: 'U12', rawGrade: 'A', gradeId: 'gA',
    round: 5, home: 'Norwood', away: 'Blackburn', hScore: 1, aScore: 0 },
];
run(`S.matches = __m3.map(x => ({...x}));
     S.roster = { 'EFNL 2026|Norwood|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
                  'EFNL 2026|Vermont|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
                  'EFNL 2026|Blackburn|U12': { grade: 'A', gradeId: 'gA', age: 'U12' } };
     S.selComp = '';`);
ok('the earlier B match counts towards A, the current grade',
  run('matchGrade(S.matches[0])') === 'gA', run('matchGrade(S.matches[0])'));
ok('so does the later A match', run('matchGrade(S.matches[1])') === 'gA');
ok('the team is NOT split across two ladders',
  run('gradesForAge("U12")').length === 1, JSON.stringify(run('gradesForAge("U12")')));

// ── 4. Could this have failed? ───────────────────────────────────────────────
console.log('\n4  Without ids the old behaviour returns — the test can fail');
run(`S.matches = __m.map(x => { const c = {...x}; delete c.gradeId; return c; });
     S.roster = Object.fromEntries(Object.entries(__r).map(([k,v]) => [k, { grade: v.grade, age: v.age }]));`);
const merged = run('gradesForAge("U8")');
ok('pre-migration records still collapse to one ladder',
  merged.length === 1, `${merged.length}: ${JSON.stringify(merged)}`);
ok('which is exactly the defect this change fixes', merged[0] === '');

console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
