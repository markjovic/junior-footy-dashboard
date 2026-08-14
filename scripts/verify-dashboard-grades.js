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
// WHAT BELONGS HERE, AND WHAT DOES NOT
// Only things that fail QUIETLY. A wrong ladder, a scorer silently filtered out,
// a page that hangs because render() threw — none of those announce themselves,
// and the first two look like correct output.
//
// Layout does NOT belong here. Whether a row reads well, whether a control is in
// the right place, whether a column is redundant — all visible on screen in a
// second, and a regex over index.html cannot judge any of it. It only repeats
// the code back, which passes whatever the code says and has to be rewritten
// every time the design changes. Around twenty such assertions were removed on
// 2026-08-12 after they had to be rewritten three times in an hour to permit
// changes that were themselves the fix.
//
// Run: node scripts/verify-dashboard-grades.js    Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VERSION = 'verify-dashboard-grades v5 2026-08-13 counted-flag';
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
// classList has to actually work, and getElementById has to return the SAME
// object for the same id — otherwise a class set through one call is invisible
// to the next and any assertion about highlighting passes or fails at random.
const el = () => {
  const classes = new Set();
  return {
    style: {}, dataset: {}, addEventListener: noop, appendChild: noop, setAttribute: noop,
    innerHTML: '', textContent: '', value: '', children: [], querySelectorAll: () => [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                           else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
  };
};
const elCache = new Map();
const elById = (id) => { if (!elCache.has(id)) elCache.set(id, el()); return elCache.get(id); };
const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  document: {
    getElementById: elById, querySelector: () => el(), querySelectorAll: () => [],
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
for (const fn of ['gLabel', 'rebuildGradeLabels', 'gradeLabelOf', 'matchListGrade', 'matchLadderGrade',
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

ok('matchListGrade returns the grade id, not the rawGrade',
  run('matchListGrade(S.matches[0])') === 'aaa11111', run('matchListGrade(S.matches[0])'));
ok('two matches in different grades do NOT share a grouping key',
  run('matchListGrade(S.matches[0]) !== matchListGrade(S.matches[1])'),
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
  run('matchLadderGrade(S.matches[0])') === 'gA', run('matchLadderGrade(S.matches[0])'));
ok('so does the later A match', run('matchLadderGrade(S.matches[1])') === 'gA');
// This asserted gradesForAge().length === 1 until 2026-08-13. That was the TAB
// count, and from Beta 0.166 a listed-only result gets its own tab deliberately:
// the round-1 gB match is LISTED under gB, so gB has a tab showing it with no
// ladder rows. The guarantee was never about tabs — it is that the team counts on
// ONE ladder. Asserted directly now, so the check cannot be satisfied by a tab
// count that means something else.
ok('the team is NOT split across two ladders',
  run(`[...new Set(S.matches
        .filter(m => m.home === 'Norwood' || m.away === 'Norwood')
        .map(m => matchLadderGrade(m))
        .filter(Boolean))].length`) === 1,
  run(`JSON.stringify([...new Set(S.matches
        .filter(m => m.home === 'Norwood' || m.away === 'Norwood')
        .map(m => matchLadderGrade(m)))])`));
ok('and both of its matches count towards A',
  run('matchLadderGrade(S.matches[0])') === 'gA' &&
  run('matchLadderGrade(S.matches[1])') === 'gA');
ok('the old B grade still gets a TAB, for the result listed there',
  run('gradesForAge("U12")').indexOf('gB') >= 0,
  JSON.stringify(run('gradesForAge("U12")')));

// ── 4. Could this have failed? ───────────────────────────────────────────────
console.log('\n4  Without ids the old behaviour returns — the test can fail');
run(`S.matches = __m.map(x => { const c = {...x}; delete c.gradeId; return c; });
     S.roster = Object.fromEntries(Object.entries(__r).map(([k,v]) => [k, { grade: v.grade, age: v.age }]));`);
const merged = run('gradesForAge("U8")');
ok('pre-migration records still collapse to one ladder',
  merged.length === 1, `${merged.length}: ${JSON.stringify(merged)}`);
ok('which is exactly the defect this change fixes', merged[0] === '');

// ── 4a. Scorers survive a team the roster cannot resolve ────────────────────
// activGrades() returns grade IDS. currentGrade() returns an id only when the
// team is found in the roster; otherwise it falls back to rawGrade, which
// matches nothing in a set of ids — so those players silently vanished from the
// scorers list. fetch-stats.js stores gradeID on every player record.
console.log('\n4a  A scorer whose team is not in the roster still appears');
run(`S.gradeMeta = {
  'EFNL 2026|U12|gA': { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'gA' },
}; rebuildGradeLabels();`);
sandbox.__p = [
  // In the roster: resolves the old way.
  { team: 'Norwood', teamRaw: 'Norwood Purple', age: 'U12', rawGrade: 'A',
    compName: 'EFNL 2026', gradeID: 'gA', goals: 5, gp: 3 },
  // NOT in the roster — the name does not match. Without gradeID this player
  // resolves to 'A', which is not an id, and disappears.
  { team: 'Vermont', teamRaw: 'Vermont Blue Under 12s', age: 'U12', rawGrade: 'A',
    compName: 'EFNL 2026', gradeID: 'gA', goals: 9, gp: 3 },
];
run(`S.players = __p.map(x => ({...x}));
     S.roster = { 'EFNL 2026|Norwood Purple|U12': { grade: 'A', gradeId: 'gA', age: 'U12' } };
     S.selComp = 'EFNL 2026'; S.selGrades = new Set(['gA']);`);
ok('the rostered player resolves to a grade id',
  run('playerGrade(S.players[0])') === 'gA', run('playerGrade(S.players[0])'));
ok('the unrostered player falls back to its stored gradeID',
  run('playerGrade(S.players[1])') === 'gA', run('playerGrade(S.players[1])'));
ok('BOTH appear in the scorers list',
  run('getTopScorers("U12").length') === 2, `${run('getTopScorers("U12").length')} of 2`);

// Could that have failed? Remove the stored gradeID and the unrostered player
// goes back to being dropped.
run(`S.players = __p.map(x => { const c = {...x}; if (c.team === 'Vermont') delete c.gradeID; return c; });`);
ok('without gradeID the unrostered player is dropped again',
  run('getTopScorers("U12").length') === 1, `${run('getTopScorers("U12").length')} of 2`);

// ── 5. The view switch survives a narrow viewport ───────────────────────────
// A headless harness cannot see a clipped element, so this asserts the STRUCTURE
// that makes clipping impossible rather than the appearance. .hdr is a flex row
// with overflow:hidden, so anything inside it that does not fit disappears with
// no trace — which is exactly how the FINALS button vanished in portrait.
console.log('\n5  The view switch is reachable on a narrow viewport');
{
  // The layout itself is not asserted here. Whether a row reads well is visible
  // on screen in a second, and a regex over this file cannot tell — it only
  // repeats the code back. What IS worth holding is that the two controls never
  // disagree, because that is state, and state fails quietly.
  // Two controls, one piece of state. Both are set from S.view rather than from
  // whichever was clicked, so they cannot disagree.
  ok('both controls are synced from S.view', has('syncViewTabs'));
  run('S.view = "finals"; syncViewTabs();');
  ok('selecting finals highlights BOTH controls',
    run(`document.getElementById('vsw-finals').classList.contains('on')`) === true &&
    run(`document.getElementById('mvt-finals').classList.contains('on')`) === true);
  run('S.view = "dash"; syncViewTabs();');
  ok('and switching back clears both',
    run(`document.getElementById('vsw-finals').classList.contains('on')`) === false &&
    run(`document.getElementById('mvt-finals').classList.contains('on')`) === false);
}

// ── 6. The loader asks for season core files, not players ───────────────────
// per_season_storage_design.md §2.1: 78% of the stored bytes are player records
// and nothing reads them until Scorers or a player panel is opened. Fetching
// them up front cost every visitor 18.87 MB before a ladder could render.
console.log('\n6  The page loads core files only');
{
  const body = html.slice(html.indexOf('<body'));
  ok('it asks for data/seasons/<id>-core.json', /data\/seasons\/\$\{m\.seasonId\}-core\.json/.test(body));
  ok('it no longer asks for data/orgs', !/data\/orgs\//.test(body),
    'the previous layout');
  ok('player files are fetched by a separate function',
    /data\/seasons\/\$\{id\}-players\.json/.test(body) && has('loadPlayers'));
  ok('and NOT by the initial load',
    !/-players\.json/.test(body.slice(body.indexOf('async function loadStoredData'),
                                      body.indexOf('function loadPlayers'))),
    'loadStoredData must not name a players file');
  ok('the seasons it loaded are remembered, so players match them',
    /S\.loadedSeasons/.test(body));
}

// ── 7. The season selector ──────────────────────────────────────────────────
// season_selection_design.md §2.1: year is the OUTER scope, and the competition
// list must come from the manifest rather than from loaded records — a past year
// has nothing in S.matches until it is fetched, and an empty competition list
// would leave nothing to click to trigger the fetch.
console.log('\n7  Year is the outer scope, and its lists come from the manifest');
{
  // Where the controls sit is visible on screen. What is NOT visible is whether
  // the lists behind them can be built at all for a year with nothing loaded.
  for (const fn of ['getYears', 'getComps', 'seasonsForYear', 'selectYear', 'loadSeasons']) {
    ok(`${fn}() defined`, has(fn));
  }

  // YJFL ran 2022-2026, SER only 2025-2026. Choosing 2022 must offer YJFL alone.
  run(`S.manifest = [
    { org: 'a', seasonId: 's1', seasonName: '2026', compName: 'YJFL 2026' },
    { org: 'a', seasonId: 's2', seasonName: '2022', compName: 'YJFL 2022' },
    { org: 'b', seasonId: 's3', seasonName: '2026', compName: 'SER 2026' },
  ];
  S.seasonFiles = new Set(); S.loadedSeasons = []; S.matches = []; S.selYear = null;`);
  const years = run('getYears()');
  ok('years are newest first', JSON.stringify(years) === '["2026","2022"]', JSON.stringify(years));

  run('S.selYear = "2026";');
  const c26 = run('getComps()');
  ok('2026 offers both competitions', c26.length === 2, JSON.stringify(c26));
  run('S.selYear = "2022";');
  const c22 = run('getComps()');
  ok('2022 offers only the competition that ran then',
    JSON.stringify(c22) === '["YJFL 2022"]', JSON.stringify(c22));

  // The whole point: this works with NOTHING loaded.
  ok('and it did so with no matches in memory', run('S.matches.length') === 0);

  // A season with no file must not be offered — asking for it is a 404.
  run(`S.seasonFiles = new Set(['data/seasons/s1-core.json']); S.selYear = null;`);
  ok('a season with no file on disk is not offered',
    JSON.stringify(run('getYears()')) === '["2026"]', JSON.stringify(run('getYears()')));
}

// ── 8. The sidebar is built in BOTH views ───────────────────────────────────
// render() returns early for the finals view. renderAgeTabs() — which builds the
// Season dropdown and the Competition chips — sat below that return, so a reload
// straight into finals never built the sidebar and both came up empty. On a
// normal load it worked only because the dashboard had rendered first.
console.log('\n8  Reloading into the finals view still builds the sidebar');
{
  const body = html.slice(html.indexOf('<body'));
  const renderAt = body.indexOf('function render()');
  const chunk = body.slice(renderAt, renderAt + 2000);
  const tabsAt = chunk.indexOf('renderAgeTabs()');
  const finalsAt = chunk.indexOf('if (finals) {');
  ok('renderAgeTabs runs BEFORE the finals early return',
    tabsAt > 0 && finalsAt > 0 && tabsAt < finalsAt,
    `renderAgeTabs at ${tabsAt}, finals branch at ${finalsAt}`);

  // And behaviourally: render() in the finals view must populate the dropdown.
  run(`S.manifest = [
    { org: 'a', seasonId: 's1', seasonName: '2026', compName: 'YJFL 2026' },
    { org: 'a', seasonId: 's2', seasonName: '2022', compName: 'YJFL 2022' },
  ];
  S.seasonFiles = new Set(); S.loadedSeasons = ['s1']; S.selYear = null;
  S.matches = [{ id: 'm', compName: 'YJFL 2026', age: 'U12', rawGrade: 'A',
                 gradeId: 'g1', round: 1, home: 'a', away: 'b' }];
  S.view = 'finals';
  document.getElementById('year-sel').innerHTML = '';
  render();`);
  const opts = run(`document.getElementById('year-sel').innerHTML`);
  ok('the Season dropdown is populated in the finals view',
    /2026/.test(opts) && /2022/.test(opts), JSON.stringify(opts).slice(0, 80));

  // Could that have failed? Reset as a fresh page would be — the element caches
  // its last markup in dataset.last and skips rebuilding identical lists, so
  // clearing innerHTML alone would not prove anything.
  run(`S.view = 'dash';
    const el = document.getElementById('year-sel');
    el.innerHTML = ''; el.dataset.last = '';
    render();`);
  ok('and in the dashboard view', /2026/.test(run(`document.getElementById('year-sel').innerHTML`)),
    'the same single call site serves both');
}

// ── 9. A past season obeys the one-ladder rule too ──────────────────────────
// _valid and _grade are cached on every record at load, and a cached value wins
// over matchLadderGrade(). There were three copies of that computation and they
// drifted: loadSeasons() kept `_grade = m.gradeId`, the behaviour reverted in
// Beta 0.135, so a promoted team appeared on BOTH ladders in a past season and
// on one in a live season. One definition now, called from all three.
console.log('\n9  A promoted team stays on one ladder in ANY season');
{
  const body = html.slice(html.indexOf('<body'));
  ok('there is exactly one definition of the computation',
    (body.match(/_valid = \(hg === ag/g) || []).length === 1,
    `${(body.match(/_valid = \(hg === ag/g) || []).length} copies`);
  ok('and every loader calls it',
    (body.match(/precomputeMatches\(/g) || []).length >= 4,
    `${(body.match(/precomputeMatches\(/g) || []).length} references`);
  // The comment explaining the drift mentions the pattern, so match a STATEMENT
  // — an assignment ending in a semicolon — rather than any occurrence of it.
  ok('no loader sets _grade to the match\'s own gradeId',
    !/m\._grade = m\.gradeId;/.test(body), 'that is the reverted option B');

  // Behaviourally: a team promoted from B to A counts on A for both matches,
  // whichever loader put the records in memory.
  run(`S.gradeMeta = {
    'EFNL 2025|U12|gA': { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'gA' },
    'EFNL 2025|U12|gB': { r: 2, lvl: 'junior', g: 'M', label: 'B', gradeId: 'gB' },
  }; rebuildGradeLabels();
  S.roster = { 'EFNL 2025|Norwood|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
               'EFNL 2025|Vermont|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
               'EFNL 2025|Blackburn|U12': { grade: 'A', gradeId: 'gA', age: 'U12' } };
  S.matches = [
    { id: 'p1', compName: 'EFNL 2025', age: 'U12', rawGrade: 'B', gradeId: 'gB',
      round: 1, home: 'Norwood', away: 'Vermont', hScore: 1, aScore: 0 },
    { id: 'p2', compName: 'EFNL 2025', age: 'U12', rawGrade: 'A', gradeId: 'gA',
      round: 5, home: 'Norwood', away: 'Blackburn', hScore: 1, aScore: 0 },
  ];
  precomputeMatches(S.matches);
  S.selComp = 'EFNL 2025'; S.selYear = '2025';`);
  ok('the earlier B match counts towards A',
    run('matchLadderGrade(S.matches[0])') === 'gA', run('matchLadderGrade(S.matches[0])'));
  // Was gradesForAge().length === 1 — a TAB count. Same correction as the
  // assertion above: from Beta 0.166 a listed-only result gets its own tab, so
  // the ladder guarantee has to be asserted against the ladder.
  ok('one ladder, not two',
    run(`[...new Set(S.matches
          .filter(m => m.home === 'Norwood' || m.away === 'Norwood')
          .map(m => matchLadderGrade(m))
          .filter(Boolean))].length`) === 1,
    run(`JSON.stringify([...new Set(S.matches
          .filter(m => m.home === 'Norwood' || m.away === 'Norwood')
          .map(m => matchLadderGrade(m)))])`));
  ok('and this holds on the CACHED path, after precomputeMatches',
    run('S.matches[0]._ladder') === 'gA', String(run('S.matches[0]._ladder')));
}

// ── 10. Search results name their season ────────────────────────────────────
// Search spans every loaded season, so one player returns one row per season
// they played in — and the rest of the line is often identical between them.
// Before the year selector only one season was ever loaded, so it never showed.
console.log('\n10  A search result says which season it is');
{
  ok('seasonYearOf() defined', has('seasonYearOf'));
  ok('it reads the year off a compName', run(`seasonYearOf('EFNL 2025')`) === '2025',
    run(`seasonYearOf('EFNL 2025')`));
  ok('a competition with a year in its NAME does not confuse it',
    run(`seasonYearOf('AFL Barwon FNL 2024')`) === '2024',
    run(`seasonYearOf('AFL Barwon FNL 2024')`));
  ok('and something with no year yields nothing, not a wrong year',
    run(`seasonYearOf('')`) === '' && run(`seasonYearOf('EFNL')`) === '');
}

// ── 11. Partial names, in any order ─────────────────────────────────────────
// A single substring match only worked when the query was typed in name order,
// so "jovic to" found nothing. Every token must appear somewhere in the name.
console.log('\n11  Search matches name parts in any order');
{
  run(`S.players = [
    { uuid: 'u1', name: 'Toby Jovic', team: 'Norwood', teamRaw: 'Norwood Purple',
      age: 'U12', rawGrade: 'B', compName: 'EFNL 2026', goals: 5 },
    { uuid: 'u2', name: 'Toby James', team: 'Canterbury', teamRaw: 'Canterbury Mixed',
      age: 'U13', rawGrade: 'A', compName: 'EFNL 2026', goals: 0 },
  ];
  S.roster = {}; S.gradeMeta = {}; rebuildGradeLabels();
  // Search is scoped to the SELECTED season — accumulating scope by browsing was
  // unpredictable, so the fixture has to say which season it is looking at.
  S.selYear = '2026';`);

  const found = (q) => {
    run(`onPlayerSearch(${JSON.stringify(q)});`);
    return run(`document.getElementById('player-search-results').innerHTML`);
  };
  ok('"toby jo" finds Toby Jovic', /Toby Jovic/.test(found('toby jo')));
  ok('"jovic to" finds him too — reversed order', /Toby Jovic/.test(found('jovic to')));
  ok('"to jov" finds him — both parts partial', /Toby Jovic/.test(found('to jov')));
  ok('"jovic" alone still works', /Toby Jovic/.test(found('jovic')));
  ok('"toby" finds BOTH', (() => { const h2 = found('toby');
    return /Toby Jovic/.test(h2) && /Toby James/.test(h2); })());
  ok('a name that matches nothing says so rather than vanishing',
    /No match in/.test(found('zzzzz')));

  // The scope matters: a name absent from 2026 is indistinguishable from a name
  // that does not exist, unless the search says what it looked at.
  ok('the results say which season was searched', /searching 2026 only/.test(found('toby')));
}

// ── 12. Search scope is the selected season, and looks like it ──────────────
// It used to cover whatever happened to be in memory, so the same query returned
// more results the longer you had been on the page, with nothing to explain why.
// And it sat ABOVE the season control, which implied it was global.
console.log('\n12  Search is scoped to the selected season');
{
  run(`S.players = [
    { uuid: 'a', name: 'Toby Jovic', team: 'Norwood', teamRaw: 'Norwood Purple',
      age: 'U12', rawGrade: 'B', compName: 'EFNL 2026', goals: 5 },
    { uuid: 'b', name: 'Toby Jovic', team: 'Norwood', teamRaw: 'Norwood',
      age: 'U11', rawGrade: 'B', compName: 'EFNL 2025', goals: 5 },
  ];
  S.roster = {}; S.gradeMeta = {}; rebuildGradeLabels(); S.selYear = '2026';`);
  const find = (q) => { run(`onPlayerSearch(${JSON.stringify(q)});`);
    return run(`document.getElementById('player-search-results').innerHTML`); };

  const h26 = find('jovic');
  ok('only the selected season is returned',
    (h26.match(/Toby Jovic/g) || []).length === 1,
    `${(h26.match(/Toby Jovic/g) || []).length} row(s)`);
  ok('and it is the 2026 one', /Norwood Purple/.test(h26) && /U12/.test(h26));

  run(`S.selYear = '2025';`);
  const h25 = find('jovic');
  ok('changing season changes the result, not adds to it',
    (h25.match(/Toby Jovic/g) || []).length === 1 && /U11/.test(h25),
    `${(h25.match(/Toby Jovic/g) || []).length} row(s)`);
  ok('the note names the season being searched', /searching 2025 only/.test(h25));
}

// ── 15. The by-club view actually renders ───────────────────────────────────
// Every earlier finals test asserted on the SOURCE or rendered with an empty
// pool, so teamRow() and the club header had never once executed. A sort entry
// missing its `flat` therefore reached the browser: tierSummary() threw inside
// render(), init() never finished, and the page sat on the loading overlay.
console.log('\n15  A club card renders without throwing');
{
  run(`S.gradeMeta = { 'EFNL 2026|U12|g1': { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'g1' } };
  rebuildGradeLabels();
  S.clubs = { c1: { name: 'Norwood', type: 'CLUB' } };
  S.teamClub = { 'EFNL 2026|Norwood|U12': 'c1', 'EFNL 2026|Vermont|U12': 'c1' };
  S.roster = { 'EFNL 2026|Norwood|U12': { grade: 'A', gradeId: 'g1', age: 'U12' },
               'EFNL 2026|Vermont|U12': { grade: 'A', gradeId: 'g1', age: 'U12' } };
  const M = (ab, r, h, a, hs, as) => ({ id: 'm'+ab, compName: 'EFNL 2026', age: 'U12',
    rawGrade: 'A', gradeId: 'g1', round: r, home: h, away: a, hScore: hs, aScore: as,
    isFinals: true, finalsAbbrev: ab, status: { value: 'FINAL' }, date: '2026-09-01' });
  S.matches = [M('SF',1,'Norwood','Vermont',50,40), M('GF',3,'Norwood','Kew',60,50)];
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp = 'EFNL 2026'; S.selYear = '2026'; S.view = 'finals'; S.finalsMode = 'club';
  // Set explicitly rather than inherited from an earlier section — a test that
  // depends on leftover state passes or fails for reasons it does not state.
  S.finalsGender = 'all'; S.finalsLevel = 'all'; S.showAllAges = true; S.selClub = null;
  // render() calls renderAgeTabs() first, which resets S.selComp from the
  // MANIFEST for the selected year. Without a manifest naming this competition
  // it picks a different one and the pool comes back empty.
  S.manifest = [{ org: 'a', seasonId: 's1', seasonName: '2026', compName: 'EFNL 2026' }];
  S.seasonFiles = new Set(); S.loadedSeasons = ['s1'];`);

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw', !threw, threw || 'clean');
  const out = threw ? '' : run(`document.getElementById('finals-body').innerHTML`);
  ok('a club card was produced', out.length > 500, `${out.length} chars`);
  ok('the opponent is on screen', /Kew/.test(out) && /Vermont/.test(out));
  ok('the grand final win is marked', /★/.test(out));
  // No shared header any more, so each cell carries its own round name.
  ok('each result names its round on the cell', /GF<\/span>/.test(out) && /SF<\/span>/.test(out));

  // EVERY sort must render, not just the default — that is what was missed.
  for (const s of ['teams', 'remaining', 'gf', 'premiers', 'name']) {
    let e2 = null;
    try { run(`S.finalsSort = ${JSON.stringify(s)}; S.finalsWeighted = true; render();`); }
    catch (e) { e2 = e.message; }
    ok(`sort "${s}" renders weighted`, !e2, e2 || 'clean');
  }
  run(`S.finalsSort = 'premiers'; S.finalsWeighted = true;`);
}

// ── 16. The GOTW key carries the competition ─────────────────────────────────
// lastround_gotw_keying_design.md. This belongs in a suite because it fails
// SILENTLY: a key the picker writes and a reader cannot build shows the automatic
// closest-margin pick, which looks entirely normal. Nothing on screen says the
// administrator's choice was ignored.
console.log('\n16  The Game of the Week key carries the competition');
ok('gotwKeyFor exists — one definition for five call sites', has('gotwKeyFor'));
if (has('gotwKeyFor')) {
  const k = (c, a, r) => run(`gotwKeyFor(${JSON.stringify(c)}, ${JSON.stringify(a)}, ${JSON.stringify(r)})`);

  ok('a home-and-away key has three segments',
    k('EFNL 2026', 'U12', '3') === 'EFNL 2026|U12|3', k('EFNL 2026', 'U12', '3'));

  // THE DEFECT ITSELF. Before Beta 0.165 both of these were "U12|3", so setting
  // one pick silently deleted the other.
  ok('two competitions in the same age and round get DIFFERENT keys',
    k('EFNL 2026', 'U12', '3') !== k('SEJ 2026', 'U12', '3'),
    `${k('EFNL 2026', 'U12', '3')} vs ${k('SEJ 2026', 'U12', '3')}`);

  // compName carries the season, so two seasons of one competition separate too.
  ok('two seasons of one competition get DIFFERENT keys',
    k('EFNL 2026', 'U12', '3') !== k('EFNL 2025', 'U12', '3'),
    `${k('EFNL 2026', 'U12', '3')} vs ${k('EFNL 2025', 'U12', '3')}`);

  // A finals round key is "F:GF". Splitting on the pipe must not disturb it.
  ok('a finals round key survives intact',
    k('EFNL 2026', 'U12', 'F:GF') === 'EFNL 2026|U12|F:GF', k('EFNL 2026', 'U12', 'F:GF'));
  ok('and still has exactly three segments',
    k('EFNL 2026', 'U12', 'F:GF').split('|').length === 3);

  // Could that have failed? A key must not silently lose the competition when the
  // caller has none — it must still be three segments so a split does not shift.
  ok('a missing competition still yields three segments',
    k(null, 'U12', '3').split('|').length === 3, k(null, 'U12', '3'));
}

// End to end: a flag stored under the NEW key must actually be honoured by
// getGOTWMatch, and one stored under the OLD key must not be. Reading the key
// builder alone would not catch a reader that still assembles its own.
if (has('getGOTWMatch') && has('gotwKeyFor')) {
  run(`S.gradeMeta = {
    'EFNL 2026|U12|gA': { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'gA' },
  }; rebuildGradeLabels();`);
  sandbox.__g16 = [
    { id: 'EFNL 2026|U12|gA|3|Norwood|Vermont', compName: 'EFNL 2026', age: 'U12',
      rawGrade: 'A', gradeId: 'gA', round: 3, home: 'Norwood', away: 'Vermont',
      hScore: 50, aScore: 10 },
    { id: 'EFNL 2026|U12|gA|3|Blackburn|Mitcham', compName: 'EFNL 2026', age: 'U12',
      rawGrade: 'A', gradeId: 'gA', round: 3, home: 'Blackburn', away: 'Mitcham',
      hScore: 40, aScore: 39 },
  ];
  run(`S.matches = __g16.map(x => ({...x}));
       S.roster = { 'EFNL 2026|Norwood|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
                    'EFNL 2026|Vermont|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
                    'EFNL 2026|Blackburn|U12': { grade: 'A', gradeId: 'gA', age: 'U12' },
                    'EFNL 2026|Mitcham|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' } };
       S.selComp = 'EFNL 2026'; S.selRound = ''; S.gotwFlags = {};
       precomputeMatches(S.matches);`);

  // With no flag the automatic pick wins: Blackburn v Mitcham is the closer game.
  ok('with no flag, the closest margin is chosen',
    run('(getGOTWMatch("U12")||{}).match && getGOTWMatch("U12").match.home') === 'Blackburn',
    run('String((getGOTWMatch("U12")||{}).match && getGOTWMatch("U12").match.home)'));

  // A flag under the OLD two-segment key must be ignored — that is the shape the
  // page wrote before Beta 0.165 and it must no longer be honoured.
  run(`S.gotwFlags = { 'U12|3': 'EFNL 2026|U12|gA|3|Norwood|Vermont' };`);
  ok('a flag under the OLD age|roundKey is NOT honoured',
    run('getGOTWMatch("U12").match.home') === 'Blackburn',
    run('getGOTWMatch("U12").match.home'));

  // The same flag under the new key must override the automatic pick.
  run(`S.gotwFlags = { 'EFNL 2026|U12|3': 'EFNL 2026|U12|gA|3|Norwood|Vermont' };`);
  ok('a flag under the NEW compName|age|roundKey IS honoured',
    run('getGOTWMatch("U12").match.home') === 'Norwood',
    run('getGOTWMatch("U12").match.home'));

  // And a flag belonging to another competition must not leak across.
  run(`S.gotwFlags = { 'SEJ 2026|U12|3': 'EFNL 2026|U12|gA|3|Norwood|Vermont' };`);
  ok("another competition's flag does not leak in",
    run('getGOTWMatch("U12").match.home') === 'Blackburn',
    run('getGOTWMatch("U12").match.home'));
}

// ── 17. Grade attribution: listing versus ladder ────────────────────────────
// grade_attribution_split_design.md §2 and §5. Two questions with two answers:
// WHERE a result is listed (m.gradeId, ground truth from PlayHQ) and WHAT it
// counts towards (the teams' current grade, only when they agree).
//
// This belongs in a suite because every failure is silent. A result attributed to
// the wrong ladder shows a plausible number; a result dropped shows nothing at
// all. audit-data.js v13 measured 3,967 records — 7.6% of everything stored, in
// all eighteen seasons — currently discarded this way.
console.log('\n17  Grade attribution: listing versus ladder');
// ASSERTED, not guarded. `if (has(...))` would SKIP this whole section when the
// functions are absent, and a skipped section reads as a pass — which is how a
// suite reports green on code that does not exist.
ok('matchListGrade exists — the LISTING grade', has('matchListGrade'));
ok('matchLadderGrade exists — the LADDER grade', has('matchLadderGrade'));
ok('matchGrade is GONE — one ambiguous name is what conflated the two meanings',
  !has('matchGrade'), 'rename it rather than leaving both');
if (has('precomputeMatches') && has('matchLadderGrade') && has('matchListGrade')) {
  const G = (comp, gid, rd, h, a) => ({
    id: `${comp}|U12|${gid}|${rd}|${h}|${a}`, compName: comp, age: 'U12',
    rawGrade: 'A', gradeId: gid, round: rd, home: h, away: a,
    hScore: 30, aScore: 20,
  });

  // gGRADING is named grading; gA and gB are ordinary divisions.
  run(`S.gradeMeta = {
    'EFNL 2026|U12|gGRADING': { r: 1, lvl: 'junior', g: 'M', label: 'Grading', gradeId: 'gGRADING', name: 'U12 Mixed Grading' },
    'EFNL 2026|U12|gA':       { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'gA', name: 'U12 Mixed A' },
    'EFNL 2026|U12|gB':       { r: 2, lvl: 'junior', g: 'M', label: 'B', gradeId: 'gB', name: 'U12 Mixed B' },
  }; rebuildGradeLabels();`);

  sandbox.__g17 = [
    // 1. Neither moved: both end in gA, played in gA.
    G('EFNL 2026', 'gA', 5, 'Alpha', 'Bravo'),
    // 2. BOTH moved to the SAME grade: played in gGRADING, both ended in gA.
    //    This is the case the current code loses.
    G('EFNL 2026', 'gGRADING', 1, 'Alpha', 'Bravo'),
    // 3. ONE moved: played in gGRADING, Alpha ended gA, Charlie ended gB.
    G('EFNL 2026', 'gGRADING', 2, 'Alpha', 'Charlie'),
    // 4. Ordinary grade, one moved: played in gA, Charlie ended gB.
    G('EFNL 2026', 'gA', 6, 'Alpha', 'Charlie'),
  ];
  run(`S.matches = __g17.map(x => ({...x}));
       S.roster = {
         'EFNL 2026|Alpha|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
         'EFNL 2026|Bravo|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
         'EFNL 2026|Charlie|U12': { grade: 'B', gradeId: 'gB', age: 'U12' },
       };
       S.selComp = 'EFNL 2026'; S.selYear = '2026';
       precomputeMatches(S.matches);`);
  const M = (i) => `S.matches[${i}]`;

  // LISTING is always m.gradeId — ground truth, never the roster.
  ok('a grading game is LISTED under the grading grade',
    run(`matchListGrade(${M(1)})`) === 'gGRADING', run(`matchListGrade(${M(1)})`));
  ok('an ordinary game is LISTED under its own grade',
    run(`matchListGrade(${M(0)})`) === 'gA', run(`matchListGrade(${M(0)})`));
  ok('a one-team-moved game is still LISTED, not lost',
    run(`matchListGrade(${M(3)})`) === 'gA', run(`matchListGrade(${M(3)})`));

  // LADDER: a grading grade counts towards ITSELF (§2.1).
  ok('a grading game counts towards the GRADING ladder',
    run(`matchLadderGrade(${M(1)})`) === 'gGRADING', run(`matchLadderGrade(${M(1)})`));
  ok('even when both teams ended in the same division',
    run(`matchLadderGrade(${M(1)})`) !== 'gA');

  // LADDER: an ordinary grade counts towards the TEAMS' grade (§2.2).
  ok('neither moved — counts towards their grade',
    run(`matchLadderGrade(${M(0)})`) === 'gA', run(`matchLadderGrade(${M(0)})`));
  ok('one moved — counts towards NO ladder',
    !run(`matchLadderGrade(${M(3)})`), String(run(`matchLadderGrade(${M(3)})`)));
  ok('but it is still listed', !!run(`matchListGrade(${M(3)})`));

  // A grading game where one team moved still counts on the grading ladder —
  // the grading competition is its own series and everyone was in it.
  ok('a grading game with one mover still counts on the grading ladder',
    run(`matchLadderGrade(${M(2)})`) === 'gGRADING', run(`matchLadderGrade(${M(2)})`));

  // ONE TEAM, ONE DIVISION LADDER. The Beta 0.135 regression check.
  ok('Charlie appears on exactly ONE division ladder',
    run(`[...new Set(S.matches
          .filter(m => { const g = matchLadderGrade(m);
                         return g && g !== 'gGRADING' &&
                                (m.home === 'Charlie' || m.away === 'Charlie'); })
          .map(m => matchLadderGrade(m)))].length`) <= 1,
    'more than one means the reverted Beta 0.135 behaviour is back');

  // Could these have failed? A grade NOT named grading must take the fallback,
  // which is what SEJ 2026 a5a8276d does deliberately.
  run(`S.gradeMeta['EFNL 2026|U12|gGRADING'].name = 'U12 Mixed Zone 1'; rebuildGradeLabels();
       precomputeMatches(S.matches);`);
  ok('renaming the grade away from "grading" changes it to the fallback',
    run(`matchLadderGrade(${M(2)})`) !== 'gGRADING',
    'a name-based test that ignores the name is not a test');
  ok('and both-moved-to-the-same-grade then counts on THEIR grade',
    run(`matchLadderGrade(${M(1)})`) === 'gA', run(`matchLadderGrade(${M(1)})`));
}

// ── 18. Scorers: one row per person per season ──────────────────────────────
// grade_attribution_split_design.md §4. fetch-stats.js stores player records PER
// GRADE: audit v14 §11 measured 18,540 person-seasons holding more than one, up
// to four, and only 1,383 of those involve a grading grade. So the page must
// aggregate — group by uuid, sum gp and goals, and show the grade of the latest
// round. Without it the same child is listed twice with half their goals each.
console.log('\n18  Scorers show one row per person per season');
ok('aggregatePlayers exists', has('aggregatePlayers'));
if (has('aggregatePlayers')) {
  sandbox.__p18 = [
    { uuid: 'u1', name: 'Toby Jovic', team: 'Alpha', teamRaw: 'Alpha', age: 'U12',
      rawGrade: 'A', gradeID: 'gGRADING', compName: 'EFNL 2026', gp: 2, goals: 5 },
    { uuid: 'u1', name: 'Toby Jovic', team: 'Alpha', teamRaw: 'Alpha', age: 'U12',
      rawGrade: 'A', gradeID: 'gA', compName: 'EFNL 2026', gp: 9, goals: 12 },
    { uuid: 'u2', name: 'Sam Reid', team: 'Bravo', teamRaw: 'Bravo', age: 'U12',
      rawGrade: 'A', gradeID: 'gA', compName: 'EFNL 2026', gp: 7, goals: 3 },
  ];
  const agg = run(`JSON.stringify(aggregatePlayers(__p18))`);
  const rows = JSON.parse(agg);
  ok('two records for one person collapse to ONE row',
    rows.filter(r => r.uuid === 'u1').length === 1, agg);
  ok('gp is SUMMED across grades',
    (rows.find(r => r.uuid === 'u1') || {}).gp === 11,
    String((rows.find(r => r.uuid === 'u1') || {}).gp));
  ok('goals are SUMMED across grades',
    (rows.find(r => r.uuid === 'u1') || {}).goals === 17,
    String((rows.find(r => r.uuid === 'u1') || {}).goals));
  ok('a person with one record is unaffected',
    (rows.find(r => r.uuid === 'u2') || {}).goals === 3);
  ok('the row count is people, not records', rows.length === 2, String(rows.length));

  // Could that have failed? Two people who share a name must NOT collapse.
  sandbox.__p18b = [
    { uuid: 'x1', name: 'Sam Reid', team: 'Alpha', teamRaw: 'Alpha', age: 'U12',
      rawGrade: 'A', gradeID: 'gA', compName: 'EFNL 2026', gp: 1, goals: 1 },
    { uuid: 'x2', name: 'Sam Reid', team: 'Bravo', teamRaw: 'Bravo', age: 'U12',
      rawGrade: 'A', gradeID: 'gA', compName: 'EFNL 2026', gp: 1, goals: 1 },
  ];
  ok('two different people sharing a name stay separate',
    JSON.parse(run(`JSON.stringify(aggregatePlayers(__p18b))`)).length === 2,
    'aggregating on name instead of uuid would merge them');
}

// ── 19. A grading ladder owns every game in its rounds ──────────────────────
// grade_attribution_split_design.md §2.1. computeLadder required matchIsValid on
// EVERY row, so a grading ladder kept only the games between teams later placed
// in the same division. SER 2026 U13 showed teams on P=1 or 2 after four grading
// games. A pure grading competition owns all of them.
console.log('\n19  A grading ladder counts every game in its rounds');
if (has('computeLadder') && has('isGradingGrade')) {
  const g19 = (gid, rd, h, a, hs, as_) => ({
    id: `EFNL 2026|U12|${gid}|${rd}|${h}|${a}`, compName: 'EFNL 2026', age: 'U12',
    rawGrade: 'A', gradeId: gid, round: rd, home: h, away: a, hScore: hs, aScore: as_,
  });
  run(`S.gradeMeta = {
    'EFNL 2026|U12|gGRD': { r: 0, lvl: 'junior', g: 'M', label: 'Grading', gradeId: 'gGRD', name: 'U12 Mixed Grading', grading: true },
    'EFNL 2026|U12|gA':   { r: 1, lvl: 'junior', g: 'M', label: 'A', gradeId: 'gA', name: 'U12 Mixed A' },
    'EFNL 2026|U12|gB':   { r: 2, lvl: 'junior', g: 'M', label: 'B', gradeId: 'gB', name: 'U12 Mixed B' },
  }; rebuildGradeLabels();`);
  // Alpha plays three grading games: one against a future A team, two against
  // future B teams. All three must count on the grading ladder.
  sandbox.__g19 = [
    g19('gGRD', 1, 'Alpha', 'Bravo',   50, 10),
    g19('gGRD', 2, 'Alpha', 'Charlie', 40, 20),
    g19('gGRD', 3, 'Alpha', 'Delta',   30, 25),
    // An ORDINARY-grade game where one team moved. matchIsValid is false, so it
    // must NOT count on the gA ladder. Without this row, exempting EVERY grade
    // from the validity check passed the whole suite — the grading rows never
    // reach the gA ladder regardless, so they could not detect it.
    g19('gA', 5, 'Alpha', 'Charlie', 60, 10),
  ];
  run(`S.matches = __g19.map(x => ({...x}));
       S.roster = {
         'EFNL 2026|Alpha|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
         'EFNL 2026|Bravo|U12':   { grade: 'A', gradeId: 'gA', age: 'U12' },
         'EFNL 2026|Charlie|U12': { grade: 'B', gradeId: 'gB', age: 'U12' },
         'EFNL 2026|Delta|U12':   { grade: 'B', gradeId: 'gB', age: 'U12' },
       };
       S.selComp = 'EFNL 2026'; S.selYear = '2026'; S.selRound = '';
       precomputeMatches(S.matches);`);

  ok('the grading grade is recognised from its gradeMeta flag',
    run(`isGradingGrade('gGRD')`) === true);

  // A ladder row is keyed `name`, and P is w+d+l — there is no `p` field. My
  // first version of this test invented both and failed for its own reasons.
  const rows = JSON.parse(run(`JSON.stringify(computeLadder('U12','gGRD',''))`));
  const played = (r) => (r.w || 0) + (r.d || 0) + (r.l || 0);
  const alpha = rows.find(r => r.name === 'Alpha') || {};
  ok('Alpha played 3 grading games, not 1',
    played(alpha) === 3,
    `P=${played(alpha)} — 1 means matchIsValid is still filtering the ladder`);
  ok('every grading team appears', rows.length === 4, String(rows.length));
  ok('including the ones placed in a different division',
    !!rows.find(r => r.name === 'Charlie') && !!rows.find(r => r.name === 'Delta'));

  // Could that have failed? An ORDINARY grade must still require both sides to
  // agree — this is the rule the grading case is an exception TO.
  const aRows = JSON.parse(run(`JSON.stringify(computeLadder('U12','gA',''))`));
  ok('an ordinary ladder does NOT gain the cross-division grading games',
    !aRows.find(r => r.name === 'Charlie'),
    'the exception must be scoped to grading grades only');
  // An ordinary game where one team moved must not reach the A ladder. It is
  // matchLadderGrade returning NULL that excludes it — not a separate validity
  // test, which was redundant and has been removed. Asserted here so the removal
  // is covered rather than assumed.
  ok('an ordinary game with one mover reaches no ladder at all',
    run(`matchLadderGrade(S.matches[3])`) === null,
    String(run(`matchLadderGrade(S.matches[3])`)));
  ok('so it is absent from the A ladder',
    !aRows.find(r => r.name === 'Alpha'),
    JSON.stringify(aRows.map(r => r.name)));
}

// ── 20. "not counted" must agree with the ladder ────────────────────────────
// The results list badged a row "not counted" from matchIsValid(), while the
// ladder counted it via matchLadderGrade(). For a grading game between teams
// later placed in different divisions those disagree, so the same game appeared
// on the ladder AND was labelled uncounted beside it.
console.log('\n20  The counted flag agrees with the ladder');
ok('matchCounts exists', has('matchCounts'));
if (has('matchCounts') && has('matchLadderGrade')) {
  const g20 = (gid, rd, h, a) => ({
    id: `EFNL 2026|U12|${gid}|${rd}|${h}|${a}`, compName: 'EFNL 2026', age: 'U12',
    rawGrade: 'A', gradeId: gid, round: rd, home: h, away: a, hScore: 30, aScore: 20,
  });
  run(`S.gradeMeta = {
    'EFNL 2026|U12|gGRD': { r: 0, lvl:'junior', g:'M', label:'Grading', gradeId:'gGRD', name:'U12 Mixed Grading', grading:true },
    'EFNL 2026|U12|gA':   { r: 1, lvl:'junior', g:'M', label:'A', gradeId:'gA', name:'U12 Mixed A' },
    'EFNL 2026|U12|gB':   { r: 2, lvl:'junior', g:'M', label:'B', gradeId:'gB', name:'U12 Mixed B' },
  }; rebuildGradeLabels();`);
  sandbox.__g20 = [
    g20('gGRD', 1, 'Alpha', 'Charlie'),   // grading, teams end in DIFFERENT divisions
    g20('gGRD', 2, 'Alpha', 'Bravo'),     // grading, teams end together
    g20('gA',   5, 'Alpha', 'Charlie'),   // ordinary, one team moved
  ];
  run(`S.matches = __g20.map(x => ({...x}));
       S.roster = {
         'EFNL 2026|Alpha|U12':   { grade:'A', gradeId:'gA', age:'U12' },
         'EFNL 2026|Bravo|U12':   { grade:'A', gradeId:'gA', age:'U12' },
         'EFNL 2026|Charlie|U12': { grade:'B', gradeId:'gB', age:'U12' },
       };
       S.selComp = 'EFNL 2026'; precomputeMatches(S.matches);`);

  // THE DEFECT. This is the row that read "not counted" while the grading ladder
  // counted it.
  ok('a grading game across two future divisions COUNTS',
    run('matchCounts(S.matches[0])') === true,
    'this is the row that was badged "not counted" on SER 2026 U13');
  ok('and matchIsValid still says otherwise — the two are different questions',
    run('matchIsValid(S.matches[0])') === false);
  ok('a grading game between future division-mates counts too',
    run('matchCounts(S.matches[1])') === true);
  ok('an ordinary game with one mover does NOT count',
    run('matchCounts(S.matches[2])') === false,
    'the badge must still appear where it is correct');

  // Could that have failed? matchCounts must agree with matchLadderGrade on
  // every record — that agreement IS the fix.
  ok('matchCounts agrees with matchLadderGrade on every record',
    run(`S.matches.every(m => matchCounts(m) === (matchLadderGrade(m) != null))`),
    'a second definition of "counts" is what caused this');
}

console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
