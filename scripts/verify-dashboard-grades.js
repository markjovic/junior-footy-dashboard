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

const VERSION = 'verify-dashboard-grades v17 2026-08-20 cross-season-search';
console.log(`=== ${VERSION} ===`);

const HTML = path.join(__dirname, '..', 'index.html');
if (!fs.existsSync(HTML)) { console.error('FATAL: index.html not found.'); process.exit(1); }
const html = fs.readFileSync(HTML, 'utf8');

// Parse the club summary table, resolving columns by HEADER NAME rather than by
// position.
//
// Beta 0.182 added a leading "#" column and FIFTEEN assertions failed at once,
// every one of them because an index moved by one. The assertions were right and
// their parsing was brittle: a test that has to be edited whenever a column is
// inserted will eventually be edited wrongly. Resolving by name costs nothing and
// the next column added or reordered breaks nothing.
function summaryTable(out) {
  // A cell holds TWO figures from Beta 0.186: the measure, and a gold top-grade
  // subset in a <span class="fv-sum-top">. Stripping tags naively glued them into
  // "2 (67%) 2 (67%)" and every assertion that matched a whole cell failed. They
  // are separated here so a test can assert on either without either one's text
  // leaking into the other's.
  const splitCell = (htmlCell) => {
    const m = htmlCell.match(/<span class="fv-sum-top"[^>]*>([\s\S]*?)<\/span>/);
    const top = m ? m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const main = htmlCell.replace(/<span class="fv-sum-top"[^>]*>[\s\S]*?<\/span>/, '')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { main, top };
  };
  const parsedOf = (block) => [...String(block).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(tr => [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(td => splitCell(td[1])));
  const cellsOf = (block) => parsedOf(block).map(r => r.map(c => c.main));
  const heads = [...String((out.match(/<thead>([\s\S]*?)<\/thead>/) || ['',''])[1])
    .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map(h => h[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  const col = {};
  heads.forEach((h, i) => { col[h.toLowerCase()] = i; });
  const bodyHtml = (out.match(/<tbody>([\s\S]*?)<\/tbody>/) || ['',''])[1];
  const footHtml = (out.match(/<tfoot>([\s\S]*?)<\/tfoot>/) || ['',''])[1];
  const rowsFull = parsedOf(bodyHtml);
  const footFull = parsedOf(footHtml)[0] || [];
  const rows = rowsFull.map(r => r.map(c => c.main));
  const foot = footFull.map(c => c.main);
  const idx = (name) => col[String(name).toLowerCase()];
  const get = (row, name) => (row || [])[idx(name)];
  const byClub = {}, topByClub = {};
  rowsFull.forEach((full, i) => {
    const name = rows[i][idx('club')];
    byClub[name] = rows[i];
    topByClub[name] = full.map(c => c.top);
  });
  // The gold top-grade figure, by club and column name.
  const getTop = (club, name) => (topByClub[club] || [])[idx(name)];
  const footTop = (name) => (footFull[idx(name)] || {}).top;
  return { heads, col, rows, foot, get, byClub, getTop, footTop };
}
const cellNum = (v) => { const m = String(v).match(/^(\d+)/); return m ? Number(m[1]) : 0; };

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
  // A CSS custom property store, so setProperty/getPropertyValue round-trip. The
  // sticky-offset code writes --sticky-top on documentElement and reads it back to
  // avoid redundant writes; with a bare {} for style it would write every frame
  // and, worse, the test could not observe what it wrote.
  const props = new Map();
  return {
    style: {
      setProperty: (k, v) => props.set(k, String(v)),
      getPropertyValue: (k) => props.get(k) || '',
      removeProperty: (k) => props.delete(k),
    },
    // Overridable per element by a test that needs to place it on screen. jsdom
    // and this harness both do zero layout, so any assertion about position has to
    // supply the geometry it is asserting on.
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    dataset: {}, addEventListener: noop, appendChild: noop, setAttribute: noop,
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
const listeners = {};
// Fire every handler registered for an event, so a test can drive the page the way
// a browser would rather than calling internals directly.
const fireEvent = (ev) => (listeners[ev] || []).forEach(fn => fn({ type: ev }));
const elCache = new Map();
const elById = (id) => { if (!elCache.has(id)) elCache.set(id, el()); return elCache.get(id); };
const sandbox = {
  console: { log: noop, warn: noop, error: noop },
  document: {
    getElementById: elById, querySelector: () => el(), querySelectorAll: () => [],
    createElement: () => el(), addEventListener: noop, body: el(), documentElement: el(),
  },
  // Listeners are RECORDED rather than dropped. index.html registers scroll and
  // resize handlers at the top level, and a noop stub both hid a load-time crash
  // (`window.addEventListener is not a function`) and made the handlers untestable.
  addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  removeEventListener: (ev, fn) => {
    listeners[ev] = (listeners[ev] || []).filter(f => f !== fn);
  },
  window: {}, navigator: { userAgent: 'node' }, location: { protocol: 'https:', search: '' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: () => Promise.reject(new Error('no network in the harness')),
  setTimeout: noop, setInterval: noop, clearTimeout: noop, clearInterval: noop,
  // Runs the callback SYNCHRONOUSLY and returns a truthy handle. A noop meant every
  // rAF-throttled function was queued and never executed, so the code under test
  // did nothing and the assertions measured the initial state.
  requestAnimationFrame: (fn) => { fn(0); return 1; },
  cancelAnimationFrame: noop, indexedDB: undefined, matchMedia: () => ({ matches: false, addEventListener: noop }),
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
  S.selYear = '2026';
  // The index state must be STATED. Left at '' the search kicks off a fetch, the
  // harness has no network, and every assertion below sees the "loading…" branch
  // rather than the token matching it is testing. 'failed' is the honest choice:
  // this section is about name matching, which must work with or without an index.
  S.playerIndex = null; S.playerIndexState = 'failed';`);

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
    /No match in|No player of that name/.test(found('zzzzz')));

  // The scope matters: a name absent from the loaded seasons is indistinguishable
  // from a name that does not exist, unless the search says what it looked at.
  // With no index loaded this is the fallback wording.
  ok('the results say what was searched',
    /index unavailable — searching .* only/.test(found('toby')),
    'name matching must work without the index, and must say the scope is narrowed');
}

// ── 12. Cross-season search: one row per PERSON ─────────────────────────────
// cross_season_search_design.md. Search used to cover only the selected season,
// so a player who left in 2024 was unfindable from a 2026 view. It now reads
// data/player-index.json — one row per person, seasons nested.
//
// THE FAILURE THIS GUARDS is the one the old scoping existed to prevent: a name
// returning more rows the more seasons you had browsed. The index solves it by
// grouping on uuid rather than by narrowing, and if that grouping ever broke the
// list would silently grow a row per season with nothing to explain it.
console.log('\n12  Cross-season search returns one row per person');
{
  // The index shape as build-player-index.js writes it: dictionary-encoded,
  // seasons newest-first, integers into the four tables.
  sandbox.__ix = {
    meta: { people: 3 },
    seasons: ['s2026', 's2025', 's2023', 's2024'],
    teams:   ['Norwood Purple', 'Norwood', 'Mitcham', 'Vermont'],
    ages:    ['U12', 'U11', 'U15'],
    grades:  ['B', 'A', 'D'],
    people: [
      // ONE person, THREE seasons — must be ONE row
      ['u-toby', 'Toby Jovic', [[0,0,0,0],[1,1,1,0],[2,1,1,1]]],   // 2026, 2025, 2023
      // A different person with the SAME name — must be a SEPARATE row, and
      // tellable apart by team. This is what carrying the team buys.
      ['u-toby2','Toby Jovic', [[0,3,0,1]]],                        // 2026 only
      // Only in a retired season — unfindable before the index existed
      // 2024 ONLY, and no other person has 2024 — that is what makes the
      // selected-season sort below able to fail.
      ['u-gone', 'Departed Jovic', [[3,2,2,2]]],
    ],
  };
  run(`S.manifest = [
    { seasonId:'s2026', compName:'EFNL 2026', seasonName:'2026' },
    { seasonId:'s2025', compName:'EFNL 2025', seasonName:'2025' },
    { seasonId:'s2023', compName:'EFNL 2023', seasonName:'2023' },
    { seasonId:'s2024', compName:'EFNL 2024', seasonName:'2024' },
  ];
  S.players = []; S.roster = {}; S.gradeMeta = {}; rebuildGradeLabels();
  S.selYear = '2026';
  S.playerIndex = __ix; S.playerIndexState = 'ready';`);

  const find = (q) => { run(`onPlayerSearch(${JSON.stringify(q)});`);
    return run(`document.getElementById('player-search-results').innerHTML`); };

  const h = find('jovic');
  // THREE people share this surname in the fixture — Toby (3 seasons), a second
  // Toby (1), and Departed (1). Five person-seasons, three rows. Before the
  // grouping this returned five.
  ok('five person-seasons collapse to three rows, one per person',
    (h.match(/class="player-result"/g) || []).length === 3,
    `${(h.match(/class="player-result"/g) || []).length} row(s) — one per PERSON, not per season`);
  ok('the row is named by the most recent season',
    /Norwood Purple/.test(h) && /U12/.test(h),
    'seasons are newest-first in the index; the top one names the row');
  ok('the other seasons appear as year chips', /2025/.test(h) && /2023/.test(h));
  ok('two people with one name are told apart by team',
    /Norwood Purple/.test(h) && /Vermont/.test(h),
    'this is what carrying team/age/grade in the index is for');

  // THE POINT OF THE FEATURE: someone whose only season is retired.
  const g = find('departed');
  ok('a player only in a retired season is findable', /Departed Jovic/.test(g));
  ok('and the row shows the season they played', /2024/.test(g));

  ok('the note says every season was searched',
    /searching all 4 seasons/.test(h), 'the reader must know the search was not narrowed');
  ok('an unmatched name is now unambiguous',
    /No player of that name/.test(find('zzzzz')),
    'with the whole index loaded, absent really does mean absent');

  // Selected season first — design §10.3.
  // A SHARED SURNAME, so one query returns all three and the order is the thing
  // under test. The first version queried "o" — under the two-character minimum,
  // so nothing rendered and the assertion compared -1 against -1.
  run(`S.selYear = '2024';`);
  const h24 = find('jovic');
  ok('a player in the selected season sorts above one who is not',
    h24.indexOf('Departed Jovic') < h24.indexOf('Toby Jovic'),
    `Departed played 2024 only; Toby played 2026/2025/2023 — with 2024 selected ` +
    `Departed must lead`);
  run(`S.selYear = '2026';`);
  const h26 = find('jovic');
  ok('and the order reverses when the selected season does',
    h26.indexOf('Toby Jovic') < h26.indexOf('Departed Jovic'),
    'if this matched the line above, the selected season is not being read at all');

  // ── The fallback ──────────────────────────────────────────────────────────
  // If the index cannot be fetched, search must degrade to the loaded seasons and
  // SAY so — reporting "no such player" for someone merely not in memory is the
  // failure the old scope note existed to prevent.
  run(`S.playerIndex = null; S.playerIndexState = 'failed';
  S.players = [
    { uuid:'u-toby', name:'Toby Jovic', team:'Norwood', teamRaw:'Norwood Purple',
      age:'U12', rawGrade:'B', compName:'EFNL 2026', goals:5 },
    { uuid:'u-toby', name:'Toby Jovic', team:'Norwood', teamRaw:'Norwood',
      age:'U11', rawGrade:'B', compName:'EFNL 2025', goals:5 },
  ];`);
  const f = find('jovic');
  ok('without the index, the loaded seasons still search',
    /Toby Jovic/.test(f));
  ok('and one person in two loaded seasons is STILL one row',
    (f.match(/class="player-result"/g) || []).length === 1,
    `${(f.match(/class="player-result"/g) || []).length} row(s) — the grouping is not the index's doing`);
  ok('and the note admits the index is unavailable',
    /index unavailable/.test(f),
    'silently narrowing is how "not loaded" gets read as "does not exist"');

  ok('openPlayerFromSearch exists to load a season the page has never fetched',
    has('openPlayerFromSearch'));
  ok('loadPlayerIndex exists', has('loadPlayerIndex'));
  run(`S.playerIndexState = ''; S.playerIndex = null;`);
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

// ── 21. The BY VENUE view, both nestings ────────────────────────────────────
// Beta 0.176 added the mode and 0.177 the grouping switch, and until this section
// neither had ever been executed by a test — exactly the gap section 15 was
// written to close for the club view, where a missing sort entry threw inside
// render() and left the page on its loading overlay.
//
// FOUR things here fail quietly and none of them look wrong on screen:
//
//   render() throwing in one nesting only. The page hangs, and it hangs only for
//   whoever had the other grouping saved in their filters.
//
//   The jump list naming a group that has no heading to scroll to. The dropdown
//   looks populated and simply does nothing when used.
//
//   The venue link vanishing in venue-first. Found by hand on 2026-08-16: the
//   outer heading was plain text and the inner heading had become a date, so
//   venueUrl had nowhere to render. A missing link is invisible — the ground name
//   is still there, just no longer clickable.
//
//   An undated match sorting FIRST. An empty string sorts before every real date,
//   so the naive ordering silently promotes "Date TBC" to the top of a schedule.
//
// Ordering and layout beyond that are visible in a second and are not tested.
console.log('\n21  The by-venue view renders in both nestings');
ok('renderFinalsByVenue exists', has('renderFinalsByVenue'));
ok('setVenueGroup exists', has('setVenueGroup'));
ok('syncFinalsJump exists', has('syncFinalsJump'));
if (has('renderFinalsByVenue') && has('setVenueGroup')) {
  run(`S.gradeMeta = {
    'EFNL 2026|Veterans|gM': { r: 1, lvl:'senior', g:'M', label:'Men',   gradeId:'gM', name:'Veterans Men' },
    'EFNL 2026|Veterans|gW': { r: 1, lvl:'senior', g:'F', label:'Women', gradeId:'gW', name:'Veterans Women' },
  }; rebuildGradeLabels();
  S.roster = {
    'EFNL 2026|Ringwood|Veterans': { grade:'Men', gradeId:'gM', age:'Veterans' },
    'EFNL 2026|Croydon|Veterans':  { grade:'Men', gradeId:'gM', age:'Veterans' },
    'EFNL 2026|Blackburn|Veterans':{ grade:'Women', gradeId:'gW', age:'Veterans' },
    'EFNL 2026|Gembrook|Veterans': { grade:'Women', gradeId:'gW', age:'Veterans' },
  };`);

  // Shapes taken from real stored records: a dated+timed result, a dated result
  // with an EMPTY time string, a scheduled provisional GF, and an UNDATED one.
  sandbox.__v21 = [
    { id:'v1', compName:'EFNL 2026', age:'Veterans', rawGrade:'Men', gradeId:'gM', round:1,
      isFinals:true, finalsAbbrev:'SF', home:'Ringwood', away:'Croydon',
      hScore:68, hG:10, hB:8, aScore:34, aG:5, aB:4,
      date:'2026-08-14', time:'', venue:'Quambee Reserve', vSuburb:'North Ringwood',
      venueUrl:'https://maps.google.com/?q=-37.78,145.24' },
    { id:'v2', compName:'EFNL 2026', age:'Veterans', rawGrade:'Women', gradeId:'gW', round:1,
      isFinals:true, finalsAbbrev:'SF', home:'Blackburn', away:'Gembrook',
      hScore:59, hG:8, hB:11, aScore:4, aG:0, aB:4,
      date:'2026-08-15', time:'12:30:00', venue:'Morton Park', vSuburb:'Blackburn' },
    { id:'v3', compName:'EFNL 2026', age:'Veterans', rawGrade:'Men', gradeId:'gM', round:2,
      isFinals:true, finalsAbbrev:'GF', home:'Winner Game 1', away:'Winner Game 2',
      scheduled:true, provisional:true, date:'2026-08-23', time:'14:00:00', venue:'Morton Park' },
    // No date and no venue: must land in Date TBC / Venue TBC, and LAST.
    { id:'v4', compName:'EFNL 2026', age:'Veterans', rawGrade:'Women', gradeId:'gW', round:2,
      isFinals:true, finalsAbbrev:'GF', home:'Winner Game 1', away:'Winner Game 2',
      scheduled:true, provisional:true, date:'', time:'', venue:'' },
    // "Yarra Park" sorts AFTER "Venue TBC" alphabetically, and that is the whole
    // reason it is here. Without a venue past V the TBC-last guard is unreachable:
    // every other ground in the fixture starts with M or Q, so Venue TBC lands
    // last by plain alphabetical order and the assertion passes whether the guard
    // exists or not. Verified by removing the guard — the suite stayed green until
    // this record was added.
    { id:'v5', compName:'EFNL 2026', age:'Veterans', rawGrade:'Men', gradeId:'gM', round:1,
      isFinals:true, finalsAbbrev:'SF', home:'Ringwood', away:'Croydon',
      hScore:40, hG:6, hB:4, aScore:30, aG:4, aB:6,
      date:'2026-08-16', time:'10:00:00', venue:'Yarra Park', vSuburb:'East Melbourne' },
  ];
  run(`S.matches   = __v21.filter(m => !m.scheduled).map(x => ({...x}));
       S.fixtures  = __v21.filter(m =>  m.scheduled).map(x => ({...x}));
       precomputeMatches(S.matches);
       S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='venue';
       S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
       S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
       S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  // The fixture is real: without a non-empty pool everything below passes on an
  // empty string.
  ok('the pool has all five finals records',
    run('finalsPool().length') === 5, String(run('finalsPool().length')));

  for (const g of ['date', 'venue']) {
    run(`S.venueGroup = ${JSON.stringify(g)};`);
    let threw = null;
    try { run('render();'); } catch (e) { threw = e.message; }
    ok(`render() does not throw grouped by ${g}`, !threw, threw || 'clean');
    if (threw) continue;

    const out = run(`document.getElementById('finals-body').innerHTML`);
    ok(`grouped by ${g}: something was drawn`, out.length > 400, `${out.length} chars`);

    // Every match must appear in BOTH nestings — a grouping is not a filter.
    ok(`grouped by ${g}: every match is still present`,
      /Ringwood/.test(out) && /Blackburn/.test(out) && /Winner Game 1/.test(out),
      'a grouping switch must not drop records');

    // THE JUMP LIST. Every entry must name a heading that exists, or the
    // dropdown silently scrolls nowhere.
    const keys = run(`fvGroupIndex.map(x => x.key)`);
    const ids  = run(`fvGroupIndex.map(x => fvGroupId(x.key))`);
    ok(`grouped by ${g}: the jump list is populated`, keys.length > 0, `${keys.length} group(s)`);
    ok(`grouped by ${g}: every jump target has a heading to scroll to`,
      ids.every(id => out.includes(`id="${id}"`)),
      `${JSON.stringify(ids)} — an id with no heading is a dropdown that does nothing`);

    // The undated match must be LAST, not first. An empty string sorts before
    // every real date, so this is the ordering that goes wrong by default.
    const tbcAt = out.indexOf(g === 'date' ? '>Date TBC<' : '>Venue TBC<');
    ok(`grouped by ${g}: the TBC group is present`, tbcAt !== -1,
      'the undated/unallocated match must still be shown');
    if (tbcAt !== -1) {
      // The comparison that can actually fail. For DATES, every real key starts
      // with a digit and "Date TBC" with a letter, so TBC lands last by plain
      // string order and the guard is belt and braces — this assertion protects
      // the observable ordering rather than the guard itself. For VENUES it is a
      // real test: "Yarra Park" sorts after "Venue TBC" alphabetically, so only
      // the guard puts TBC last.
      const realAt = out.indexOf(g === 'date' ? '>Friday 14 August<' : 'Yarra Park');
      ok(`grouped by ${g}: TBC sorts AFTER every real group`,
        realAt !== -1 && realAt < tbcAt,
        `last real group at ${realAt}, TBC at ${tbcAt}`);
    }

    // The maps link follows the venue to whichever level shows it. This is the
    // defect found by hand: in venue-first the link had nowhere to render.
    ok(`grouped by ${g}: the venue link survives`,
      out.includes('maps.google.com'),
      'Quambee Reserve carries a venueUrl — a missing link is invisible on screen');
  }

  // Could these have failed? A mode that is not 'venue' must clear the jump list,
  // or a stale one keeps offering groups that are no longer on the page.
  run(`S.finalsMode = 'age'; render();`);
  ok('leaving the venue mode clears the jump list',
    run('fvGroupIndex.length') === 0,
    `${run('fvGroupIndex.length')} — a stale list points at headings that are gone`);
  run(`S.finalsMode = 'venue'; S.venueGroup = 'date';`);
}

// ── 22. The club summary: denominators, percentages and the collapse ────────
// The summary is built from the SAME `entries` array as the cards and sorted by
// the SAME comparator. If either were derived separately the two could disagree,
// and a table that quietly contradicts the thing under it is worse than no table:
// both look plausible. That is the shape that let _grade and matchGrade drift.
//
// Beta 0.178 added three things that fail silently:
//
//   CLUBS WITH NO FINALISTS. They come from enteredPool(), not finalsPool(). If
//   they were dropped the table would show only successful clubs and every club
//   would look successful — and the percentages would have no denominator worth
//   having. A missing row looks exactly like a club that entered nothing.
//
//   THE DENOMINATOR ITSELF. Counting identity is comp|team|age with no grade. On
//   the card's own key — which carries rawGrade — a side that played grading and
//   was then placed in a division counts twice, so a club's finals total can
//   exceed the teams it entered and print a percentage over 100.
//
//   THE FILTER AGREEING ACROSS BOTH POOLS. finalsFilters() is shared. If the
//   gender or level filter applied to one pool and not the other, 6 of 40 and
//   6 of 12 would both render as perfectly ordinary numbers.
console.log('\n22  The club summary: denominators, percentages and the collapse');
ok('finalsFilters exists', has('finalsFilters'));
ok('enteredPool exists', has('enteredPool'));
ok('toggleClubSummary exists', has('toggleClubSummary'));
{
  // Two clubs reach finals and two do NOT. Norwood enters three teams and gets
  // two into the finals, so its percentage is 67% rather than the 100% every
  // club would show if only finalists were listed.
  const f22 = (isF, ab, r, h, a, hs, as) => ({ id:'s'+(ab||'')+r+h, compName:'EFNL 2026',
    age:'U12', rawGrade:'A', gradeId:'g1', round:r, home:h, away:a, hScore:hs, aScore:as,
    ...(isF ? { isFinals:true, finalsAbbrev:ab } : {}), date:'2026-09-01' });
  sandbox.__c22 = [
    f22(true,  'SF', 1, 'Norwood',   'Vermont', 50, 40),
    f22(true,  'GF', 3, 'Norwood',   'Kew',     60, 50),
    // Home and away only — these two clubs entered teams and reached no finals.
    f22(false, '',   1, 'Norwood B', 'Croydon', 30, 20),
    f22(false, '',   1, 'Ringwood',  'Croydon', 25, 15),
    // Norwood ALSO played in the grading grade. It is ONE team the club entered,
    // and counting on a key that carries the grade makes it two — which is what
    // pushes a percentage over 100 in production. Without this record the
    // denominator's identity cannot be tested at all: every team here would sit
    // in exactly one grade and both keys would agree.
    { ...f22(false, '', 1, 'Norwood', 'Vermont', 20, 18),
      id:'grading1', rawGrade:'Grading', gradeId:'gGRD' },
    // A DIFFERENT COMPETITION. finalsFilters() must exclude it from both pools:
    // if enteredPool() skipped the filters this club would appear as a fifth row
    // and inflate the totals, and nothing on screen would say why.
    { ...f22(false, '', 1, 'Ivanhoe', 'Kew East', 40, 30),
      id:'yjfl1', compName:'YJFL 2026' },
  ];
  run(`S.gradeMeta = {
    'EFNL 2026|U12|g1': { r:1, lvl:'junior', g:'M', label:'A', gradeId:'g1', name:'U12 Mixed A' },
    // buildGradeMeta writes the rawGrade key too, and gradeRankOf is called with
    // t.grade — a rawGrade. Without this the Top grade column and the weighted
    // tiers both read 0 and the assertions below would pass on nothing.
    'EFNL 2026|U12|A':  { r:1, lvl:'junior', g:'M' },
  };
  rebuildGradeLabels();
  S.clubs = { c1:{name:'Norwood',type:'CLUB'}, c2:{name:'Vermont',type:'CLUB'},
              c3:{name:'Croydon',type:'CLUB'}, c4:{name:'Ringwood',type:'CLUB'},
              c5:{name:'Ivanhoe',type:'CLUB'} };
  S.teamClub = { 'EFNL 2026|Norwood|U12':'c1', 'EFNL 2026|Kew|U12':'c1',
                 'EFNL 2026|Norwood B|U12':'c1', 'EFNL 2026|Vermont|U12':'c2',
                 'EFNL 2026|Croydon|U12':'c3', 'EFNL 2026|Ringwood|U12':'c4',
                 'YJFL 2026|Ivanhoe|U12':'c5', 'YJFL 2026|Kew East|U12':'c5' };
  S.roster = {};
  for (const t of ['Norwood','Kew','Norwood B','Vermont','Croydon','Ringwood'])
    S.roster['EFNL 2026|'+t+'|U12'] = { grade:'A', gradeId:'g1', age:'U12' };
  for (const t of ['Ivanhoe','Kew East'])
    S.roster['YJFL 2026|'+t+'|U12'] = { grade:'A', gradeId:'g1', age:'U12' };
  S.matches = __c22.map(x => ({...x}));
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='club';
  S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
  S.finalsSort='premiers'; S.finalsWeighted=false; S.clubSummaryOpen=true;
  S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
  S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  // The fixture is real: two clubs must have finals teams and two must not, or
  // the no-finalist row is untested and every assertion below is about one case.
  ok('the finals pool holds only the two finals records',
    run('finalsPool().length') === 2, String(run('finalsPool().length')));
  // Five of the six records are EFNL; the YJFL one must be filtered out of both
  // pools by finalsFilters(). If this reads 6 the competition filter is not being
  // applied to the denominator.
  ok('the entered pool holds the five in-scope records, not the YJFL one',
    run('enteredPool().length') === 5, String(run('enteredPool().length')));
  ok('and the two pools use the same filter',
    run(`enteredPool().every(finalsFilters) && finalsPool().every(finalsFilters)`),
    'a filter applied to one pool and not the other gives a wrong denominator');

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw with the summary table', !threw, threw || 'clean');
  const out = threw ? '' : run(`document.getElementById('finals-body').innerHTML`);

  ok('the summary table was drawn', /class="fv-sum"/.test(out));
  ok('and the club cards are still below it', /class="fv-club"/.test(out));
  ok('the summary comes BEFORE the cards',
    out.indexOf('class="fv-sum"') !== -1 &&
    out.indexOf('class="fv-sum"') < out.indexOf('class="fv-club"'),
    'a summary printed under the detail it summarises is not a summary');

  // ── Rows ── resolved by header name, so a new column cannot break this.
  const T = summaryTable(out);
  const cells = T.rows;
  const byName = T.byClub;
  ok('the table exposes the columns this section asserts on',
    ['club','entered','finals','remaining','gf','premierships']
      .every(h => T.col[h] !== undefined),
    JSON.stringify(T.heads));

  // THE assertion this whole change turns on.
  ok('a club that reached NO finals still has a row',
    !!byName['Croydon'] && !!byName['Ringwood'],
    `${JSON.stringify(Object.keys(byName))} — without these the percentages have no denominator`);
  ok('all four in-scope clubs are listed, and only those',
    cells.length === 4, `${cells.length} row(s): ${JSON.stringify(Object.keys(byName))}`);
  ok('the out-of-scope competition contributed no row',
    !byName['Ivanhoe'], 'YJFL is not the selected competition');
  // Every lookup below assumes these rows exist. A missing row must fail with a
  // readable message rather than throwing on a property of undefined — a suite
  // that crashes says less than one that fails.
  const row = (n) => byName[n] || [];
  const cell = (n, h) => T.get(row(n), h);

  // Columns: 0 Club, 1 Entered, 2 Finals, 3 Top grade, 4 Remaining, 5 GF, 6 Premierships
  const num = (v) => { const m = String(v).match(/^(\d+)/); return m ? Number(m[1]) : 0; };
  ok('Norwood entered three teams', num(cell('Norwood','entered')) === 3, cell('Norwood','entered'));
  ok('two of them reached the finals', num(cell('Norwood','finals')) === 2, cell('Norwood','finals'));
  ok('a no-finals club still shows the teams it entered',
    num(cell('Croydon','entered')) === 1, cell('Croydon','entered'));
  ok('and shows a dash rather than a zero in the finals column',
    /^–$/.test(cell('Croydon','finals')), `"${cell('Croydon','finals')}"`);

  // ── Percentages ──
  // 2 of 3 is 67%. If the denominator were the finals teams it would read 100%,
  // which is the number a table of finalists only would print for every club.
  ok('the percentage is against teams ENTERED, not teams in finals',
    /^2 \(67%\)$/.test(cell('Norwood','finals')),
    `"${cell('Norwood','finals')}" — 100% here means the denominator is wrong`);
  // Beta 0.186: the standalone Top grade column is GONE. The measure now rides
  // beside every other figure as a gold subset, and its percentage is a share of
  // teams ENTERED like everything else in the row.
  ok('there is no standalone Top grade column any more',
    T.col['top grade'] === undefined, JSON.stringify(T.heads));
  ok('the gold top-grade figure rides beside the Finals count',
    /^2 \(67%\)$/.test(T.getTop('Norwood','finals') || ''),
    `"${T.getTop('Norwood','finals')}" — both of Norwood's finalists are in grade A`);
  ok('and beside the Entered count, with its own share of teams entered',
    /^3 \(100%\)$/.test(T.getTop('Norwood','entered') || ''),
    `"${T.getTop('Norwood','entered')}" — all three of Norwood's teams are grade A`);
  ok('a club with no top-grade teams shows no gold figure at all',
    !T.getTop('Croydon','finals'),
    `"${T.getTop('Croydon','finals')}" — a second dash would double the table in dashes`);
  ok('a premiership is counted and shown as a share of teams entered',
    /^1 \(33%\)$/.test(cell('Norwood','premierships')), `"${cell('Norwood','premierships')}"`);
  ok('a zero cell carries no percentage',
    !/%/.test(cell('Croydon','premierships')), `"${cell('Croydon','premierships')}"`);

  // ── Totals ── every numeric column, found by name.
  for (const h of ['entered','finals','top grade','remaining','gf','premierships']) {
    const summed = cells.reduce((n, r) => n + num(T.get(r, h)), 0);
    ok(`the ${h} total equals the sum of its rows`,
      summed === num(T.get(T.foot, h)),
      `rows sum to ${summed}, footer says "${T.get(T.foot, h)}"`);
  }
  ok('six teams entered in total', num(T.get(T.foot,'entered')) === 6,
    String(T.get(T.foot,'entered')));

  // Could these have failed? The premierships column must distinguish the clubs —
  // a uniform column satisfies every totals check for free.
  const prem = cells.map(r => num(T.get(r,'premierships')));
  ok('the premierships column distinguishes the clubs',
    prem.includes(1) && prem.includes(0),
    `${JSON.stringify(prem)} — a uniform column passes the totals check for free`);
  // And the entered column must not simply equal the finals column, or the
  // percentages are all 100% and prove nothing.
  ok('entered and finals are genuinely different numbers',
    cells.some(r => num(T.get(r,'entered')) !== num(T.get(r,'finals'))),
    'if these always matched, every percentage would read 100%');

  // ── The collapse ──
  ok('the summary is expanded when S.clubSummaryOpen is true',
    /<div class="fv-sum-body" style="display:">/.test(out) || /fv-sum-body" style="display:"/.test(out),
    'open state comes from S, not from a <details> element');
  ok('and the caret points down when open', /▾/.test(out));
  run(`S.clubSummaryOpen = false; render();`);
  const closed = run(`document.getElementById('finals-body').innerHTML`);
  ok('closing hides the body', /fv-sum-body" style="display:none"/.test(closed),
    'the table must collapse, not disappear entirely');
  ok('the header survives the collapse so it can be reopened',
    /fv-sum-hdr/.test(closed) && /▸/.test(closed),
    'a collapsed section with no header cannot be expanded again');
  ok('the summary line is readable while collapsed',
    /teams entered/.test(closed),
    'the point of a collapsed header is that it still says something');
  // The toggle must actually flip the state — a handler that only re-renders
  // would leave the section stuck shut and look like a dead control.
  run('toggleClubSummary();');
  ok('toggleClubSummary flips the state', run('S.clubSummaryOpen') === true,
    String(run('S.clubSummaryOpen')));
  run(`S.clubSummaryOpen = false;`);
}

// ── 22a. REMOVED 2026-08-17 ─────────────────────────────────────────────────
// A dozen CSS regexes asserting that position:sticky was declared and that no
// ancestor carried an overflow. Deleted, and worth recording why rather than
// quietly dropping:
//
//   It passed while the headings did not stick at all, because it checked the two
//   boxes that had just been edited rather than the whole ancestor chain.
//   Getting it to work then took three attempts — an unanchored selector matched
//   inside `.fv-sum-body`, `String.match` returned only the first of two `body`
//   rules, and the regex literals were over-escaped.
//   Worst of all, in Beta 0.183 it DROVE A REGRESSION: the CSS was changed to
//   satisfy it, which removed the scrollport the page header was sticking to and
//   broke the header on the live site.
//
// It caught one thing that a single scroll would have shown. working_practice.md
// already said layout does not belong in a suite; this is the evidence for that
// rule, not an exception to it. Section 22b stays because it drives real
// behaviour through real events and caught a genuine scheduling bug.
// ── 22b. The sticky offset follows the page header ──────────────────────────
// .hdr is sticky at top:0, but ONLY until its containing block runs out: body is
// height:100%, and a sticky element cannot leave its containing block, so the page
// header releases after roughly one viewport and scrolls away. Anything pinned a
// constant 52px below it is then floating in mid-air with club rows passing above
// it — reported from the live page on 2026-08-17.
//
// syncStickyTop() keeps --sticky-top equal to the header's BOTTOM EDGE, clamped at
// zero. This is driven here the way a browser drives it: register the handlers by
// loading the page, place the header with a stubbed rect, then fire a real scroll
// event. Calling syncStickyTop() directly would skip the listener registration,
// which is the half most likely to be forgotten.
console.log('\n22b  The sticky offset follows the page header down');
ok('syncStickyTop exists', has('syncStickyTop'));
if (has('syncStickyTop')) {
  const hdr = { bottom: 52 };
  // document.querySelector('.hdr') returns a fresh stub each call, so the rect has
  // to be injected at the source.
  run(`document.querySelector = (sel) => ({
    getBoundingClientRect: () => ({ top: __hdrTop, bottom: __hdrBottom,
      left: 0, right: 0, width: 0, height: 52 }),
  });`);
  const place = (bottom) => {
    sandbox.__hdrTop = bottom - 52;
    sandbox.__hdrBottom = bottom;
  };
  const offset = () => run(`document.documentElement.style.getPropertyValue('--sticky-top')`);

  // The fixture is real: a scroll listener must have been registered at load, or
  // firing the event proves nothing.
  ok('a scroll listener was registered when the page loaded',
    (listeners.scroll || []).length > 0,
    `${(listeners.scroll || []).length} listener(s) — without one the offset never updates`);
  ok('and a resize listener too',
    (listeners.resize || []).length > 0,
    'a window resize moves the header without scrolling');

  place(52); fireEvent('scroll');
  ok('with the header fully visible the offset is its bottom edge',
    offset() === '52px', `"${offset()}"`);

  // Mid-release: the header is half off screen, so the headings must sit at 26,
  // not snap between 52 and 0. This is what distinguishes tracking the rect from
  // toggling a class at a threshold.
  place(26); fireEvent('scroll');
  ok('part-way through the release the offset follows continuously',
    offset() === '26px',
    `"${offset()}" — 52 or 0 here means it is switching at a threshold, not tracking`);

  place(0); fireEvent('scroll');
  ok('once the header reaches the top edge the offset is zero',
    offset() === '0px', `"${offset()}"`);

  // THE REPORTED BUG. The header is gone, its bottom is negative, and the headings
  // must be at the very top rather than 52px — or lower — down the page.
  place(-180); fireEvent('scroll');
  ok('with the header scrolled away the offset is clamped to zero',
    offset() === '0px',
    `"${offset()}" — a negative offset pulls the headings off screen, and 52px is ` +
    `the bug: floating with rows visible above`);

  // Could these have failed? The value must actually move, or a stuck '0px' would
  // satisfy the two assertions above on its own.
  place(52); fireEvent('scroll');
  ok('and it comes back when the header does',
    offset() === '52px',
    `"${offset()}" — a value that only ever decreases would pass everything above`);
}

// ── 23. Columns run GF first; ladder positions; the ALL TEAMS switch ────────
// Three changes in Beta 0.179, each of which fails quietly:
//
//   COLUMN ORDER REVERSED. Column 0 is now the grand final for every grade. The
//   depth sort reads the same index, so it had to invert with it — a sort that
//   silently reversed would put the teams knocked out FIRST at the top of every
//   card, which reads as a plausible ordering rather than an obvious fault.
//
//   LADDER POSITION. A wrong position looks exactly like a right one. It is
//   memoised per render, so the cache is also a place a stale figure could hide.
//
//   ALL TEAMS. The non-finalists are held on `extraTeams`, NOT merged into
//   `e.teams` — every existing figure is computed from `e.teams`, and folding
//   them in would restate all of them at once: a club with two of eleven teams in
//   the finals would begin reporting eleven.
console.log('\n23  GF-first columns, ladder positions, and the ALL TEAMS switch');
ok('ladderPosOf exists', has('ladderPosOf'));
ok('setShowAllTeams exists', has('setShowAllTeams'));
ok('ordinal exists', has('ordinal'));
{
  // Ordinals first — the teens are what a naive implementation gets wrong.
  ok('ordinal handles 1, 2, 3', run(`[ordinal(1),ordinal(2),ordinal(3)].join(',')`) === '1st,2nd,3rd');
  ok('ordinal handles the teens', run(`[ordinal(11),ordinal(12),ordinal(13)].join(',')`) === '11th,12th,13th',
    run(`[ordinal(11),ordinal(12),ordinal(13)].join(',')`));
  ok('ordinal handles 21 and 22', run(`[ordinal(21),ordinal(22)].join(',')`) === '21st,22nd');

  // A four-team grade with a full home-and-away season, then a finals series.
  // Alpha finishes top, Delta bottom — so a ladder position is checkable rather
  // than merely present.
  const ha = (r, h, a, hs, as) => ({ id:`h${r}${h}${a}`, compName:'EFNL 2026', age:'U12',
    rawGrade:'A', gradeId:'g1', round:r, home:h, away:a, hScore:hs, aScore:as, date:'2026-05-01' });
  // finalsName is what roundLabel() prints, and PlayHQ supplies it. Without it
  // every cell reads "GF" or "QF" — strings that appear all over the markup — and
  // the column-order assertions below could not locate anything.
  const FNAME = { QF:'Qualifying Final', PF:'Preliminary Final', GF:'Grand Final' };
  const finIn = (age, gid) => (ab, r, h, a, hs, as) => ({ id:`f${age}${ab}${h}`,
    compName:'EFNL 2026', age, rawGrade:'A', gradeId:gid, round:r, home:h, away:a,
    hScore:hs, aScore:as, isFinals:true, finalsAbbrev:ab, finalsName:FNAME[ab],
    date:'2026-09-01' });
  const g14 = finIn('U14','g14');
  const g16 = finIn('U16','g16');
  const fin = (ab, r, h, a, hs, as) => ({ id:`f${ab}${h}`, compName:'EFNL 2026', age:'U12',
    rawGrade:'A', gradeId:'g1', round:r, home:h, away:a, hScore:hs, aScore:as,
    isFinals:true, finalsAbbrev:ab, finalsName:FNAME[ab], date:'2026-09-01' });
  sandbox.__c23 = [
    // Alpha 3 wins, Bravo 2, Charlie 1, Delta 0.
    ha(1,'Alpha','Delta',100,10), ha(1,'Bravo','Charlie',80,40),
    ha(2,'Alpha','Charlie',90,20), ha(2,'Bravo','Delta',70,30),
    ha(3,'Alpha','Bravo',60,50),  ha(3,'Charlie','Delta',55,45),
    // Finals: a three-round series. Alpha wins the QF and goes straight to the
    // GF — a BYE in the middle column, which is the gap that must survive.
    fin('QF', 1, 'Alpha',  'Delta',  70, 40),
    fin('PF', 2, 'Bravo',  'Charlie',65, 55),
    fin('GF', 3, 'Alpha',  'Bravo',  80, 60),
    // Echo entered and reached no finals at all.
    ha(1,'Echo','Alpha',20,90), ha(2,'Echo','Bravo',25,85),

    // ── A SECOND AND THIRD GRADE, so DEPTH can be told from grade strength ──
    // Alpha FC has three teams in finals. Neither of the two below won a grand
    // final, so the premier band cannot decide their order — only depth can:
    //   Alpha C (U16) wins its QF and loses the PF -> column 1
    //   Alpha B (U14) loses its QF                 -> column 2
    // Column 0 is the grand final, so the SMALLER index is the deeper run and
    // Alpha C must sort above Alpha B. With the depth sort left uninverted after
    // the columns were reversed, that order flips — and a card listing the team
    // knocked out first at the top reads as perfectly plausible.
    g14('QF', 1, 'Golf',    'Alpha B', 60, 40),
    g14('PF', 2, 'Hotel',   'Golf',    70, 50),
    g14('GF', 3, 'Hotel',   'India',   80, 60),
    g16('QF', 1, 'Alpha C', 'Juliet',  75, 45),
    g16('PF', 2, 'Kilo',    'Alpha C', 65, 55),
    g16('GF', 3, 'Kilo',    'Mike',    90, 70),
    // And a fourth Alpha team that reached no finals, so the club has BOTH kinds
    // and the card header has two different numbers to report.
    { id:'ha18', compName:'EFNL 2026', age:'U18', rawGrade:'A', gradeId:'g18',
      round:1, home:'Alpha D', away:'Lima', hScore:30, aScore:20, date:'2026-05-01' },
  ];
  run(`S.gradeMeta = {
    'EFNL 2026|U12|g1':  { r:1, lvl:'junior', g:'M', label:'A', gradeId:'g1',  name:'U12 Mixed A' },
    'EFNL 2026|U12|A':   { r:1, lvl:'junior', g:'M' },
    'EFNL 2026|U14|g14': { r:1, lvl:'junior', g:'M', label:'A', gradeId:'g14', name:'U14 Mixed A' },
    'EFNL 2026|U14|A':   { r:1, lvl:'junior', g:'M' },
    'EFNL 2026|U16|g16': { r:1, lvl:'junior', g:'M', label:'A', gradeId:'g16', name:'U16 Mixed A' },
    'EFNL 2026|U16|A':   { r:1, lvl:'junior', g:'M' },
    'EFNL 2026|U18|g18': { r:1, lvl:'junior', g:'M', label:'A', gradeId:'g18', name:'U18 Mixed A' },
    'EFNL 2026|U18|A':   { r:1, lvl:'junior', g:'M' },
  };
  rebuildGradeLabels();
  S.clubs = { cA:{name:'Alpha FC',type:'CLUB'}, cB:{name:'Bravo FC',type:'CLUB'},
              cC:{name:'Charlie FC',type:'CLUB'}, cD:{name:'Delta FC',type:'CLUB'},
              cE:{name:'Echo FC',type:'CLUB'}, cX:{name:'Others FC',type:'CLUB'} };
  S.teamClub = { 'EFNL 2026|Alpha|U12':'cA','EFNL 2026|Bravo|U12':'cB',
                 'EFNL 2026|Charlie|U12':'cC','EFNL 2026|Delta|U12':'cD',
                 'EFNL 2026|Echo|U12':'cE',
                 'EFNL 2026|Alpha B|U14':'cA','EFNL 2026|Alpha C|U16':'cA',
                 'EFNL 2026|Alpha D|U18':'cA' };
  for (const [t,a] of [['Golf','U14'],['Hotel','U14'],['India','U14'],
                       ['Juliet','U16'],['Kilo','U16'],['Mike','U16'],['Lima','U18']])
    S.teamClub['EFNL 2026|'+t+'|'+a] = 'cX';
  S.roster = {};
  for (const t of ['Alpha','Bravo','Charlie','Delta','Echo'])
    S.roster['EFNL 2026|'+t+'|U12'] = { grade:'A', gradeId:'g1', age:'U12' };
  for (const [t,a,g] of [['Alpha B','U14','g14'],['Golf','U14','g14'],['Hotel','U14','g14'],
                         ['India','U14','g14'],['Alpha C','U16','g16'],['Juliet','U16','g16'],
                         ['Kilo','U16','g16'],['Mike','U16','g16'],
                         ['Alpha D','U18','g18'],['Lima','U18','g18']])
    S.roster['EFNL 2026|'+t+'|'+a] = { grade:'A', gradeId:g, age:a };
  S.matches = __c23.map(x => ({...x}));
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='club';
  S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
  S.finalsSort='premiers'; S.finalsWeighted=false; S.clubSummaryOpen=false;
  S.showAllTeams=false;
  S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
  S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  // ── Ladder positions ──
  run('resetLadderPos();');
  ok('the ladder puts Alpha first',   run(`ladderPosOf('U12','g1','Alpha')`) === 1,
    String(run(`ladderPosOf('U12','g1','Alpha')`)));
  // Echo plays two games and loses both, so the ladder has FIVE teams. Delta and
  // Echo both finish winless and are separated on percentage — Delta 85 for 225
  // against, Echo 45 for 175 — which is why the order is checked rather than
  // assumed.
  ok('Delta is fourth',  run(`ladderPosOf('U12','g1','Delta')`) === 4,
    String(run(`ladderPosOf('U12','g1','Delta')`)));
  ok('and Echo is last of the five', run(`ladderPosOf('U12','g1','Echo')`) === 5,
    String(run(`ladderPosOf('U12','g1','Echo')`)));
  ok('a team that never played returns 0, not a position',
    run(`ladderPosOf('U12','g1','Nobody')`) === 0);
  ok('an unknown grade returns 0 rather than throwing',
    run(`ladderPosOf('U12','gZZZ','Alpha')`) === 0);
  // Could that have failed? The positions must differ, or any constant passes.
  ok('positions are not all the same number',
    run(`new Set(['Alpha','Bravo','Charlie','Delta','Echo'].map(t => ladderPosOf('U12','g1',t))).size > 1`),
    'a ladder that returned one number for everyone would satisfy the checks above');

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw with positions and reversed columns', !threw, threw || 'clean');
  const out = threw ? '' : run(`document.getElementById('finals-body').innerHTML`);

  // SLICED past the summary table. The summary lists every club including the
  // ones with no finalists, and it sits in the DOM even when collapsed — so a
  // search over the whole body finds "Echo FC" there and proves nothing about the
  // cards. Same mistake as the section 10/11 table confusion.
  const cardsOnly = (h) => h.slice(h.indexOf('</table>') + 1 || 0);
  const cardOf = (h, club) => {
    const i = h.indexOf(club);
    if (i === -1) return '';
    const j = h.indexOf('class="fv-card"', i);
    return h.slice(i, j === -1 ? h.length : j);
  };

  // ── GF first, and the bye gap in the middle ──
  // Alpha's card: QF in the LAST column, GF in the FIRST, and the middle column
  // blank because it had a bye through the preliminary final.
  const alphaCard = (out.match(/<div class="fv-card">(?:(?!<div class="fv-card">)[\s\S])*?Alpha FC[\s\S]*?<\/div>\s*<\/div>/) || [''])[0]
    || out.slice(out.indexOf('Alpha FC'));
  const gfAt = alphaCard.indexOf('Grand Final');
  const qfAt = alphaCard.indexOf('Qualifying Final');
  ok('the grand final is rendered on Alpha\'s row', gfAt !== -1);
  ok('the qualifying final is too', qfAt !== -1);
  ok('the GRAND FINAL comes before the qualifying final in the markup',
    gfAt !== -1 && qfAt !== -1 && gfAt < qfAt,
    `GF at ${gfAt}, QF at ${qfAt} — column 0 must be the grand final`);
  ok('the bye between them is a gap, not a closed-up row',
    /color:var\(--b2\)">·<\/span>/.test(alphaCard),
    'a team that skipped a round keeps its blank column');

  // ── Depth sort inverted with the columns ──
  // Alpha won the GF, Echo played no finals. Alpha must be first in its card and
  // the premier must not be sorted below a team knocked out earlier.
  // DEPTH, tested between two teams that neither won nor lost a grand final, so
  // the premier band cannot be doing the work. Alpha C reached a preliminary
  // final; Alpha B lost its qualifying final.
  const alphaFC = cardOf(cardsOnly(out), 'Alpha FC');
  const u16At = alphaFC.indexOf('U16 A');
  const u14At = alphaFC.indexOf('U14 A');
  ok('both of the non-premier Alpha teams are on the card',
    u16At !== -1 && u14At !== -1, `U16 at ${u16At}, U14 at ${u14At}`);
  ok('the DEEPER run sorts above the shallower one',
    u16At !== -1 && u14At !== -1 && u16At < u14At,
    `U16 (reached a PF) at ${u16At}, U14 (lost its QF) at ${u14At} — ` +
    `column 0 is the grand final, so the deeper run is the SMALLER index`);
  ok('and the premier is still above both',
    alphaFC.indexOf('U12 A') !== -1 && alphaFC.indexOf('U12 A') < u16At,
    'premiers are lifted out before depth is compared');

  // The RENDERED position, not just the function. Alpha finished top of the U12
  // ladder, so its row must carry a 1st tag.
  ok('a ladder position is rendered on the row',
    /class="fv-pos fv-pos-1"[^>]*>1st</.test(alphaFC) || /fv-pos-1[^>]*>1st</.test(alphaFC),
    'the minor premier must be marked on its own row, not only computed');
  ok('and a position appears for more than one team',
    (cardsOnly(out).match(/class="fv-pos/g) || []).length > 3,
    'one tag could be a coincidence of a single row');

  // ── ALL TEAMS off ──
  ok('with the switch off, a club with no finalists has no CARD',
    !/Echo FC/.test(cardsOnly(out)),
    'Echo reached no finals and the switch is off');
  ok('and no "did not reach the finals" heading appears',
    !/did not reach the finals/.test(out));

  // ── ALL TEAMS on ──
  run(`S.showAllTeams = true; render();`);
  const all = run(`document.getElementById('finals-body').innerHTML`);
  ok('with the switch on, the no-finals club gets a CARD',
    /Echo FC/.test(cardsOnly(all)), 'this is the whole point of the switch');
  ok('and its team is listed by name', /Echo</.test(all) || />Echo/.test(all));
  ok('the non-finalists are introduced, not silently appended',
    /did not reach the finals/.test(all));
  ok('a finalist club still shows its finals rows', /Grand Final/.test(all));

  // THE assertion that protects every existing figure. Charlie reached a
  // preliminary final, so cC has one team in finals and none outside it; Delta
  // played the QF. Alpha's club has one finals team and must still say so.
  // THE assertion that catches extraTeams being merged into e.teams. Alpha FC has
  // THREE teams in finals and a fourth that reached none. If the non-finalists
  // were folded in, both numbers move together and the card would read 4 of 5.
  const alphaAll = cardOf(cardsOnly(all), 'Alpha FC');
  ok('the card header counts finals teams and entered teams separately',
    /3 of 4 teams in finals/.test(alphaAll),
    (alphaAll.match(/\d+ of \d+ teams? in finals/) || ['not reported'])[0] +
    ' — merging extraTeams into e.teams moves both numbers at once');
  // extraTeams must NOT be counted as finalists. Echo has a card and a row, and
  // the summary must still report it as reaching no finals — if extraTeams were
  // merged into e.teams this would read 1.
  // Read by COLUMN NAME, not by scraping the row text. The row now carries a gold
  // top-grade figure inside the Entered cell, so "Echo FC 1 –" became
  // "Echo FC 1 1 – …" and a text match on the raw row broke while the behaviour
  // was correct.
  const TE = summaryTable(all);
  ok('the summary still reports Echo as reaching no finals',
    /^–$/.test(TE.get(TE.byClub['Echo FC'], 'finals') || ''),
    `entered "${TE.get(TE.byClub['Echo FC'], 'entered')}", ` +
    `finals "${TE.get(TE.byClub['Echo FC'], 'finals')}"`);
  ok('while still showing the team it entered',
    /^1$/.test(TE.get(TE.byClub['Echo FC'], 'entered') || ''),
    `"${TE.get(TE.byClub['Echo FC'], 'entered')}"`);

  // Could that have failed? With the switch on, Echo has a row and NO finals
  // cells — if extraTeams were merged into e.teams it would be counted as a
  // finalist and the header would say so.
  run(`S.showAllTeams = false;`);
}

// ── 24. Sorting on VALUES or on SHARE ───────────────────────────────────────
// "Most GF appearances" and "the highest proportion of teams entered that reached
// a grand final" are different questions, and a big club wins the first almost by
// size alone. Beta 0.180 makes the basis pickable.
//
// This fails SILENTLY: a wrong order is still an order. Nothing on screen says
// which question was answered, so a basis that is ignored, or applied to one of
// the two lists and not the other, reads as a perfectly ordinary ranking.
//
// THE FIXTURE IS BUILT TO SEPARATE THE TWO. Alpha enters ten teams and gets three
// into grand finals; Beta enters two and gets both there.
//
//   on VALUES  Alpha (3) then Beta (2) then Cee (1)
//   on SHARE   Beta (100%) then Cee (100%) then Alpha (30%)
//
// Alpha moves from FIRST to LAST between the two, which is the only arrangement
// that cannot be satisfied by an implementation that quietly ignores the basis.
console.log('\n24  The club summary sorts on values or on share');
ok('setFinalsSortBasis exists', has('setFinalsSortBasis'));
if (has('setFinalsSortBasis')) {
  const gf = (age, gid, h, a, hs, as) => ({ id:'gf'+age+h, compName:'EFNL 2026', age,
    rawGrade:'A', gradeId:gid, round:3, home:h, away:a, hScore:hs, aScore:as,
    isFinals:true, finalsAbbrev:'GF', date:'2026-09-20' });
  const ha = (age, gid, h, a) => ({ id:'ha'+age+h+a, compName:'EFNL 2026', age,
    rawGrade:'A', gradeId:gid, round:1, home:h, away:a, hScore:30, aScore:20,
    date:'2026-05-01' });
  const pad = [];
  // Seven more Alpha teams, entered and nowhere near a final. Without these Alpha
  // would enter three and the two orderings would coincide.
  for (let i = 4; i <= 10; i++) pad.push(ha('U12', 'g12', 'A' + i, 'A' + (i === 10 ? 4 : i + 1)));
  sandbox.__c23 = [
    gf('U12', 'g12', 'A1', 'A2', 60, 50),
    gf('U13', 'g13', 'A3', 'B1', 40, 55),
    gf('U14', 'g14', 'B2', 'C1', 70, 30),
    ...pad,
  ];
  const teamsAll = ['A1','A2','A3','A4','A5','A6','A7','A8','A9','A10','B1','B2','C1'];
  run(`S.gradeMeta = {};
  for (const [age, gid] of [['U12','g12'],['U13','g13'],['U14','g14']]) {
    S.gradeMeta['EFNL 2026|'+age+'|'+gid] = { r:1, lvl:'junior', g:'M', label:'A', gradeId:gid };
    S.gradeMeta['EFNL 2026|'+age+'|A']    = { r:1, lvl:'junior', g:'M' };
  }
  rebuildGradeLabels();
  S.clubs = { cA:{name:'Alpha',type:'CLUB'}, cB:{name:'Beta',type:'CLUB'}, cC:{name:'Cee',type:'CLUB'} };
  S.teamClub = {}; S.roster = {};
  for (const t of ${JSON.stringify(teamsAll)}) {
    const club = t[0] === 'A' ? 'cA' : t[0] === 'B' ? 'cB' : 'cC';
    for (const [age, gid] of [['U12','g12'],['U13','g13'],['U14','g14']]) {
      S.teamClub['EFNL 2026|'+t+'|'+age] = club;
      S.roster['EFNL 2026|'+t+'|'+age] = { grade:'A', gradeId:gid, age };
    }
  }
  S.matches = __c23.map(x => ({...x}));
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='club';
  S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
  S.showAllTeams=false; S.finalsWeighted=false; S.clubSummaryOpen=true;
  S.finalsSort='gf'; S.finalsSortBasis='count';
  S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
  S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  const order = () => {
    const T = summaryTable(run(`document.getElementById('finals-body').innerHTML`));
    return T.rows.map(r => T.get(r, 'club')).filter(Boolean);
  };
  const table = () => summaryTable(run(`document.getElementById('finals-body').innerHTML`));

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw on the count basis', !threw, threw || 'clean');

  // The fixture is real: the two clubs must differ on BOTH count and share, or
  // neither ordering below proves anything.
  const T24 = table();
  const cv = (club, h) => T24.get(T24.byClub[club], h);
  ok('Alpha entered ten teams and reached three grand finals',
    /^10$/.test(cv('Alpha','entered') || '') && /^3 \(30%\)$/.test(cv('Alpha','gf') || ''),
    `entered "${cv('Alpha','entered')}", GF "${cv('Alpha','gf')}"`);
  ok('Beta entered two and reached two',
    /^2$/.test(cv('Beta','entered') || '') && /^2 \(100%\)$/.test(cv('Beta','gf') || ''),
    `entered "${cv('Beta','entered')}", GF "${cv('Beta','gf')}"`);
  ok('so a count and a share MUST disagree about first place',
    3 > 2 && (2/2) > (3/10),
    'if this were false the assertions below would pass on either basis');

  const byCount = order();
  ok('on VALUES the biggest count leads', byCount[0] === 'Alpha',
    JSON.stringify(byCount));

  run(`S.finalsSortBasis = 'pct'; render();`);
  const byPct = order();
  ok('on % the best share leads', byPct[0] === 'Beta', JSON.stringify(byPct));
  ok('and the big club drops to LAST', byPct[byPct.length - 1] === 'Alpha',
    `${JSON.stringify(byPct)} — Alpha first on both bases means the basis is ignored`);
  ok('the two orderings are genuinely different',
    byCount.join('|') !== byPct.join('|'),
    `${JSON.stringify(byCount)} vs ${JSON.stringify(byPct)}`);

  // The CARDS are sorted by the same comparator, so they must move too — a basis
  // that reorders the table and not the cards puts two contradictory rankings on
  // one screen.
  {
    const out = run(`document.getElementById('finals-body').innerHTML`);
    const cardNames = [...out.matchAll(/class="fv-club-name">([^<]+)</g)].map(m => m[1].trim());
    ok('the club CARDS follow the same basis as the table',
      cardNames[0] === byPct[0],
      `cards ${JSON.stringify(cardNames)} vs table ${JSON.stringify(byPct)}`);
  }

  // Choosing % turns weighted OFF, because both decide how to compare the same
  // measure and leaving both on would make one control silently inert.
  run(`S.finalsWeighted = true; S.finalsSortBasis = 'count'; setFinalsSortBasis('pct');`);
  ok('choosing % clears the weighted flag', run('S.finalsWeighted') === false,
    String(run('S.finalsWeighted')));
  ok('and the basis took', run('S.finalsSortBasis') === 'pct', String(run('S.finalsSortBasis')));

  // Could that have failed? An unknown basis must be rejected rather than stored,
  // or a bad saved filter puts the view into a state no control can leave.
  run(`setFinalsSortBasis('sideways');`);
  ok('an unknown basis is rejected', run('S.finalsSortBasis') === 'pct',
    String(run('S.finalsSortBasis')));

  run(`S.finalsSortBasis = 'count'; S.finalsSort = 'premiers';`);
}

// ── 25. The rank denominator, and grading-pool visitors ─────────────────────
// Two defects reported from the live page on 2026-08-17, both silent, and both
// passing the entire suite as it stood.
//
// (a) THE "4 of 8" TAG COUNTED EVERY GRADE TWICE. buildGradeMeta writes each
//     ranked grade under BOTH its PlayHQ grade id and its parsed rawGrade, so
//     gradeTierCount's `startsWith(prefix)` saw two entries per grade. U14 with
//     grades A to D reported eight. A rank out of a wrong total is still a
//     plausible-looking tag, which is why nothing caught it.
//
// (b) CLUBS FROM OTHER LEAGUES WERE COUNTED AS HAVING ENTERED. Grading pools run
//     jointly across leagues and then split out, so EFNL's own records contain
//     games played by YJFL and Outer East clubs' teams. Those records pass every
//     filter — the compName really is EFNL — and teamClub correctly resolves each
//     team to a club that is not an EFNL club. The summary listed dozens of them
//     and every percentage was over an inflated denominator.
//
// THE FIXTURE MIRRORS PRODUCTION'S DUAL KEYING. A fixture with only id keys would
// report the right number for the wrong reason and (a) could not be tested at all.
console.log('\n25  The rank denominator and grading-pool visitors');
{
  const AGES = { U14: ['g14a','g14b','g14c','g14d'] };
  const gm = {};
  ['A','B','C','D'].forEach((lbl, i) => {
    const id = AGES.U14[i];
    // Both keys, exactly as buildGradeMeta writes them: the id entry carries
    // gradeId/label/name, the rawGrade entry is the bare { r, lvl, g }.
    gm[`EFNL 2026|U14|${id}`] = { r: i + 1, lvl:'junior', g:'M', label: lbl,
                                  gradeId: id, name: `U14 Mixed ${lbl}` };
    gm[`EFNL 2026|U14|${lbl}`] = { r: i + 1, lvl:'junior', g:'M' };
  });
  // A grading grade: id key only, r:0, flagged. It must NOT add a rank slot.
  gm['EFNL 2026|U14|g14grd'] = { r: 0, lvl:'junior', g:'M', label:'Grading',
                                 gradeId:'g14grd', name:'U14 Mixed Grading', grading: true };

  const M = (gid, raw, r, h, a, extra) => ({ id:'m'+gid+r+h, compName:'EFNL 2026',
    age:'U14', rawGrade:raw, gradeId:gid, round:r, home:h, away:a,
    hScore:50, aScore:40, date:'2026-06-01', ...(extra || {}) });
  sandbox.__c25 = [
    // Inside and Other play the GRADING pool and then real football.
    M('g14grd','Grading',1,'Inside','Visitor'),
    M('g14grd','Grading',1,'Other','Visitor'),
    M('g14d','D',1,'Inside','Other'),
    // Inside reaches a grand final in grade D, so it gets a row with a rank tag.
    M('g14d','D',3,'Inside','Other',{ isFinals:true, finalsAbbrev:'GF' }),
  ];
  sandbox.__gm25 = gm;
  run(`S.gradeMeta = __gm25; rebuildGradeLabels();
  S.clubs = { cI:{name:'Inside JFC',type:'CLUB'}, cO:{name:'Other JFC',type:'CLUB'},
              cV:{name:'Visitor JFC (Yarra Junior Football League (YJFL))',type:'CLUB'} };
  S.teamClub = { 'EFNL 2026|Inside|U14':'cI', 'EFNL 2026|Other|U14':'cO',
                 'EFNL 2026|Visitor|U14':'cV' };
  S.roster = { 'EFNL 2026|Inside|U14':{grade:'D',gradeId:'g14d',age:'U14'},
               'EFNL 2026|Other|U14':{grade:'D',gradeId:'g14d',age:'U14'},
               'EFNL 2026|Visitor|U14':{grade:'Grading',gradeId:'g14grd',age:'U14'} };
  S.matches = __c25.map(x => ({...x}));
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='club';
  S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
  S.showAllTeams=false; S.finalsWeighted=false; S.clubSummaryOpen=true;
  S.finalsSort='premiers'; S.finalsSortBasis='count';
  S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
  S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  // The fixture is real: without the dual keys (a) is untestable, and without a
  // recognised grading grade (b) is.
  ok('the fixture is dual-keyed the way buildGradeMeta writes it',
    run(`Object.keys(S.gradeMeta).filter(k => k.startsWith('EFNL 2026|U14|')).length`) === 9,
    `${run(`Object.keys(S.gradeMeta).filter(k => k.startsWith('EFNL 2026|U14|')).length`)} keys — 4 grades x2, plus grading`);
  ok('the grading grade is recognised as one',
    run(`isGradingGrade('g14grd')`) === true,
    'without this every record counts as ranked and the visitor is never excluded');

  // ── (a) the denominator ──
  ok('gradeTierCount counts FOUR ranked grades, not eight',
    run(`gradeTierCount('EFNL 2026','U14')`) === 4,
    `${run(`gradeTierCount('EFNL 2026','U14')`)} — 8 is every grade counted twice, 5 includes the grading grade`);

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw', !threw, threw || 'clean');
  const out = threw ? '' : run(`document.getElementById('finals-body').innerHTML`);

  ok('a team in grade D is tagged 4/4 on its row',
    /Grade 4 of 4 in U14/.test(out),
    (out.match(/Grade \d+ of \d+ in U14/) || ['no rank tag'])[0]);
  ok('and no "of 8" tag appears anywhere',
    !/of 8 in U14/.test(out), 'the doubled denominator is back');

  // ── (b) grading-pool visitors ──
  ok('a club seen ONLY in the grading pool is not listed',
    !/Visitor JFC/.test(out),
    'a joint grading pool must not make another league\'s club look like an entrant');
  ok('a club that played grading AND real football IS listed',
    /Inside JFC/.test(out) && /Other JFC/.test(out),
    'the test is whether the team played outside the pool, not what its club is called');

  // Could that have failed? The visitor must actually be IN the pool, or the
  // exclusion is being credited for a team that was never there.
  ok('the visitor really is in the entered pool records',
    run(`enteredPool().some(m => m.home === 'Visitor' || m.away === 'Visitor')`),
    'if it were filtered earlier this assertion would pass for the wrong reason');
  ok('and it resolves to a club, so only the grading rule can exclude it',
    run(`!!clubIdOf('EFNL 2026','Visitor','U14')`),
    'an unresolved club is dropped by a different guard entirely');

  // The denominator of every percentage moves with it: two clubs entered, not
  // three. This is what the defect actually cost on screen.
  const T25 = summaryTable(out);
  ok('the summary counts two clubs, not three',
    /^2 clubs$/.test(T25.get(T25.foot, 'club') || ''),
    `"${T25.get(T25.foot, 'club')}"`);
  ok('and two teams entered, not three',
    /^2$/.test(T25.get(T25.foot, 'entered') || ''),
    `"${T25.get(T25.foot, 'entered')}" — the visitor inflated every percentage in the table`);
}

// ── 26. The rank column ─────────────────────────────────────────────────────
// Beta 0.182. A position number per row, so a change of sort shows WHERE a club
// ranks rather than only reordering the rows.
//
// Two silent failure modes, and the fixture is built to separate them:
//
//   RANKING ON cmpEntries INSTEAD OF THE MEASURE. cmpEntries always separates two
//   clubs — on premierships, then on name — so every rank would be distinct and
//   the column would be the row number. It would look completely correct.
//
//   TIES NOT SHARED. Two clubs level on the chosen measure showing 3 and 4 asserts
//   a difference that does not exist on the measure the reader picked, and what
//   actually separated them is invisible on screen.
//
// The fixture gives Beta and Cee the SAME number of premierships and the same
// everything else that the measure sees, so they must tie — and Alpha ahead of
// both, so the club after the tie must be 4 rather than 3.
console.log('\n26  The rank column');
{
  const f26 = (age, gid, ab, r, h, a, hs, as) => ({ id:'r'+age+ab+h, compName:'EFNL 2026',
    age, rawGrade:'A', gradeId:gid, round:r, home:h, away:a, hScore:hs, aScore:as,
    isFinals:true, finalsAbbrev:ab, date:'2026-09-20' });
  // Alpha wins two grand finals; Beta and Cee win one each; Dee wins none.
  sandbox.__c26 = [
    f26('U12','g12','GF',3,'A1','D1',60,20),
    f26('U13','g13','GF',3,'A2','D2',55,30),
    f26('U14','g14','GF',3,'B1','D3',50,40),
    f26('U15','g15','GF',3,'C1','D4',45,44),
  ];
  run(`S.gradeMeta = {};
  for (const [age,gid] of [['U12','g12'],['U13','g13'],['U14','g14'],['U15','g15']]) {
    S.gradeMeta['EFNL 2026|'+age+'|'+gid] = { r:1, lvl:'junior', g:'M', label:'A', gradeId:gid };
    S.gradeMeta['EFNL 2026|'+age+'|A']    = { r:1, lvl:'junior', g:'M' };
  }
  rebuildGradeLabels();
  S.clubs = { cA:{name:'Alpha',type:'CLUB'}, cB:{name:'Beta',type:'CLUB'},
              cC:{name:'Cee',type:'CLUB'},   cD:{name:'Dee',type:'CLUB'} };
  S.teamClub = {}; S.roster = {};
  for (const [t,club,age,gid] of [['A1','cA','U12','g12'],['A2','cA','U13','g13'],
      ['B1','cB','U14','g14'],['C1','cC','U15','g15'],
      ['D1','cD','U12','g12'],['D2','cD','U13','g13'],['D3','cD','U14','g14'],['D4','cD','U15','g15']]) {
    S.teamClub['EFNL 2026|'+t+'|'+age] = club;
    S.roster['EFNL 2026|'+t+'|'+age] = { grade:'A', gradeId:gid, age };
  }
  S.matches = __c26.map(x => ({...x}));
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='club';
  S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
  S.showAllTeams=false; S.finalsWeighted=false; S.clubSummaryOpen=true;
  S.finalsSort='premiers'; S.finalsSortBasis='count';
  S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
  S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw with the rank column', !threw, threw || 'clean');
  const T = summaryTable(run(`document.getElementById('finals-body').innerHTML`));

  ok('there is a rank column', T.col['#'] !== undefined, JSON.stringify(T.heads));
  const rank = (club) => T.get(T.byClub[club], '#');

  // The fixture is real: the premiership counts must be 2,1,1,0 or nothing below
  // distinguishes a shared rank from a distinct one.
  ok('Alpha has two premierships and Beta and Cee one each',
    cellNum(T.get(T.byClub['Alpha'],'premierships')) === 2 &&
    cellNum(T.get(T.byClub['Beta'],'premierships')) === 1 &&
    cellNum(T.get(T.byClub['Cee'],'premierships')) === 1,
    `${T.get(T.byClub['Alpha'],'premierships')} / ${T.get(T.byClub['Beta'],'premierships')} / ${T.get(T.byClub['Cee'],'premierships')}`);

  ok('the leader is ranked 1', rank('Alpha') === '1', String(rank('Alpha')));
  ok('two clubs level on the measure SHARE rank 2',
    rank('Beta') === '2' && rank('Cee') === '2',
    `Beta "${rank('Beta')}", Cee "${rank('Cee')}" — distinct numbers here means the rank ` +
    `is being taken from cmpEntries, which always separates two clubs`);
  ok('and the club after the tie is 4, not 3',
    rank('Dee') === '4',
    `"${rank('Dee')}" — 3 is dense ranking, which hides how many clubs are ahead`);

  // Could that have failed? The ranks must not simply be the row numbers.
  const ranks = T.rows.map(r => T.get(r, '#'));
  ok('the ranks are not just 1,2,3,4',
    ranks.join(',') !== '1,2,3,4',
    `${JSON.stringify(ranks)} — row numbers would satisfy every assertion above except the tie`);

  // The rank must FOLLOW the sort. Switching measure has to renumber, or the
  // column is decoration that happens to agree with the default sort.
  run(`S.finalsSort = 'teams'; render();`);
  const T2 = summaryTable(run(`document.getElementById('finals-body').innerHTML`));
  ok('Dee leads on teams in finals, so it is now ranked 1',
    T2.get(T2.byClub['Dee'], '#') === '1',
    `"${T2.get(T2.byClub['Dee'], '#')}" — Dee has four teams in finals to Alpha's two`);
  ok('and the previous leader is no longer 1',
    T2.get(T2.byClub['Alpha'], '#') !== '1',
    'a rank that does not move with the sort is decoration');

  // Alphabetical is an ordering, not a ranking: every pair ties on the measure, so
  // a number would read as "everyone is first".
  run(`S.finalsSort = 'name'; render();`);
  const T3 = summaryTable(run(`document.getElementById('finals-body').innerHTML`));
  ok('the alphabetical sort shows a dash rather than a rank',
    T3.rows.every(r => /^–$/.test(T3.get(r, '#') || '')),
    JSON.stringify(T3.rows.map(r => T3.get(r, '#'))));
  ok('and the rows are still in alphabetical order',
    T3.rows.map(r => T3.get(r,'club')).join('|') === 'Alpha|Beta|Cee|Dee',
    JSON.stringify(T3.rows.map(r => T3.get(r,'club'))));

  run(`S.finalsSort = 'premiers';`);
}

// ── 27. The gold top-grade figure on every measure ──────────────────────────
// Beta 0.186. The standalone Top grade column is gone; the measure now rides
// beside every other figure as a gold subset. Both numbers in a cell are a share
// of TEAMS ENTERED — one denominator for the whole table.
//
// What fails silently here:
//
//   THE GOLD DENOMINATOR DRIFTING. If the gold percentage were a share of
//   top-grade entered rather than of all teams entered, every gold figure would
//   still look like a plausible percentage and no two numbers on screen would
//   visibly disagree.
//
//   ENTERED-TOP TAKEN FROM e.teams. A club can enter a top-grade team that never
//   reaches the finals. Counting the gold Entered figure from the finals list
//   would undercount it, and the gold column would start from the wrong total.
//
// The fixture separates both: Alpha enters three top-grade teams, only two of
// which reach finals, and also enters a lower-grade team that does.
console.log('\n27  The gold top-grade figure');
{
  const g27 = (age, gid, raw, ab, r, h, a, hs, as) => ({ id:'g'+age+raw+h+r,
    compName:'EFNL 2026', age, rawGrade:raw, gradeId:gid, round:r, home:h, away:a,
    hScore:hs, aScore:as, date:'2026-09-01',
    ...(ab ? { isFinals:true, finalsAbbrev:ab } : {}) });
  sandbox.__c27 = [
    // Top-grade (A) teams: T1 wins the GF, T2 reaches finals, T3 enters only.
    g27('U12','g12a','A','GF',3,'T1','T2',60,40),
    g27('U12','g12a','A','',  1,'T3','T2',30,25),
    // A B-grade team that DOES reach a grand final. Gold must not count it.
    g27('U13','g13b','B','GF',3,'L1','L2',50,45),
    // THREE top-grade teams that reach no finals at all, at a club with no finals
    // record of any kind. This is what makes the topgrade sort testable: the club
    // leads that measure while sitting last on every other one, so a sort that
    // cannot see a no-finals club's entered teams drops it to the bottom. Without
    // these records `enteredTop` could be missing from the zero row and nothing
    // would notice.
    g27('U12','g12a','A','',  1,'N1','N2',30,20),
    g27('U12','g12a','A','',  2,'N3','N1',25,22),
  ];
  run(`S.gradeMeta = {
    'EFNL 2026|U12|g12a': { r:1, lvl:'junior', g:'M', label:'A', gradeId:'g12a' },
    'EFNL 2026|U12|A':    { r:1, lvl:'junior', g:'M' },
    'EFNL 2026|U13|g13b': { r:2, lvl:'junior', g:'M', label:'B', gradeId:'g13b' },
    'EFNL 2026|U13|B':    { r:2, lvl:'junior', g:'M' },
  };
  rebuildGradeLabels();
  S.clubs = { cA:{name:'Alpha',type:'CLUB'}, cZ:{name:'Zed',type:'CLUB'},
              cN:{name:'Nofinals',type:'CLUB'} };
  S.teamClub = { 'EFNL 2026|T1|U12':'cA', 'EFNL 2026|T3|U12':'cA', 'EFNL 2026|L1|U13':'cA',
                 'EFNL 2026|T2|U12':'cZ', 'EFNL 2026|L2|U13':'cZ',
                 'EFNL 2026|N1|U12':'cN', 'EFNL 2026|N2|U12':'cN', 'EFNL 2026|N3|U12':'cN' };
  S.roster = { 'EFNL 2026|T1|U12':{grade:'A',gradeId:'g12a',age:'U12'},
               'EFNL 2026|T2|U12':{grade:'A',gradeId:'g12a',age:'U12'},
               'EFNL 2026|T3|U12':{grade:'A',gradeId:'g12a',age:'U12'},
               'EFNL 2026|L1|U13':{grade:'B',gradeId:'g13b',age:'U13'},
               'EFNL 2026|L2|U13':{grade:'B',gradeId:'g13b',age:'U13'},
               'EFNL 2026|N1|U12':{grade:'A',gradeId:'g12a',age:'U12'},
               'EFNL 2026|N2|U12':{grade:'A',gradeId:'g12a',age:'U12'},
               'EFNL 2026|N3|U12':{grade:'A',gradeId:'g12a',age:'U12'} };
  S.matches = __c27.map(x => ({...x}));
  S.fixtures = []; precomputeMatches(S.matches);
  S.selComp='EFNL 2026'; S.selYear='2026'; S.view='finals'; S.finalsMode='club';
  S.finalsGender='all'; S.finalsLevel='all'; S.showAllAges=true; S.selClub=null;
  S.showAllTeams=false; S.finalsWeighted=false; S.clubSummaryOpen=true;
  S.finalsSort='premiers'; S.finalsSortBasis='count';
  S.manifest=[{org:'a',seasonId:'s1',seasonName:'2026',compName:'EFNL 2026'}];
  S.seasonFiles=new Set(); S.loadedSeasons=['s1'];`);

  let threw = null;
  try { run('render();'); } catch (e) { threw = e.message; }
  ok('render() does not throw with the gold figures', !threw, threw || 'clean');
  const T = summaryTable(run(`document.getElementById('finals-body').innerHTML`));

  // The fixture is real: Alpha must have a top-grade team that did NOT reach
  // finals, or entered-top and finals-top are the same number and the second
  // failure mode above is untestable.
  ok('Alpha entered three teams', /^3$/.test(T.get(T.byClub['Alpha'],'entered') || ''),
    `"${T.get(T.byClub['Alpha'],'entered')}"`);
  ok('the gold Entered percentage is a share of teams entered',
    /^2 \(67%\)$/.test(T.getTop('Alpha','entered') || ''),
    `"${T.getTop('Alpha','entered')}" — 2 of 3 entered is 67%`);

  // ── The topgrade SORT ──
  // It sorts on teams ENTERED in the top grade, not teams that reached finals
  // there, which is the one thing the other four measures cannot show: a club can
  // field several top-grade sides and win nothing.
  ok('there is a top-grade sort option', run(`!!FINALS_SORTS.topgrade`), 'missing');
  // Wrapped, because a measure reading the wrong field throws on a bare object and
  // a stack trace says less than a failed assertion.
  const flatOf = (obj) => {
    try { return run(`FINALS_SORTS.topgrade.flat(${JSON.stringify(obj)})`); }
    catch (e) { return `threw: ${e.message}`; }
  };
  ok('and it reads teams entered in the top grade, not finalists',
    flatOf({ enteredTop: 4, teams: [1,2], inGF: 9 }) === 4,
    `${flatOf({ enteredTop: 4, teams: [1,2], inGF: 9 })} — 2 means it is counting finalists`);
  ok('a club with the field absent scores zero rather than undefined',
    flatOf({}) === 0,
    `${flatOf({})} — undefined in a comparator sorts every club equal`);

  run(`setFinalsSort('topgrade'); render();`);
  const TS = summaryTable(run(`document.getElementById('finals-body').innerHTML`));
  ok('the sort was accepted', run(`S.finalsSort`) === 'topgrade', String(run(`S.finalsSort`)));
  // Nofinals entered three top-grade teams and reached no finals, so it must LEAD
  // this measure while sitting last on every other one. A sort that cannot read a
  // no-finals club's entered teams drops it to the bottom instead.
  ok('the club with the most top-grade teams leads, even with no finals record',
    TS.get(TS.rows[0], 'club') === 'Nofinals',
    `${JSON.stringify(TS.rows.map(r => TS.get(r,'club')))} — Nofinals has 3 grade-A teams`);
  ok('and the rank column renumbers on the new measure',
    TS.get(TS.byClub['Nofinals'], '#') === '1' && TS.get(TS.byClub['Alpha'], '#') === '2',
    `Nofinals "${TS.get(TS.byClub['Nofinals'], '#')}", Alpha "${TS.get(TS.byClub['Alpha'], '#')}"`);
  ok('the same club is NOT first on premierships, so the measure moved something',
    (() => { run(`setFinalsSort('premiers'); render();`);
      const TP = summaryTable(run(`document.getElementById('finals-body').innerHTML`));
      return TP.get(TP.rows[0], 'club') !== 'Nofinals'; })(),
    'if one club led every measure the sort could be ignored and still pass');
  run(`setFinalsSort('topgrade'); render();`);

  // Could that have failed? The premierships sort puts Alpha first too, so the
  // measure must be shown to move something. Sorting by remaining — where both
  // clubs are level at zero — must fall through to the tiebreaks and NOT crash.
  run(`setFinalsSort('remaining'); render();`);
  ok('a measure on which every club is level still renders',
    summaryTable(run(`document.getElementById('finals-body').innerHTML`)).rows.length === 3,
    'a comparator returning 0 for every pair must not throw or drop rows');
  run(`setFinalsSort('topgrade');`);
  ok('two of them are top grade, and one of those never reached finals',
    /^2 \(67%\)$/.test(T.getTop('Alpha','entered') || ''),
    `"${T.getTop('Alpha','entered')}" — T1 and T3 are grade A; T3 played no final`);

  ok('the Top grade column is gone', T.col['top grade'] === undefined,
    JSON.stringify(T.heads));

  // Alpha's finalists: T1 (A, won the GF) and L1 (B, made a GF). 2 of 3 entered.
  ok('the Finals figure counts both finalists',
    /^2 \(67%\)$/.test(T.get(T.byClub['Alpha'],'finals') || ''),
    `"${T.get(T.byClub['Alpha'],'finals')}"`);
  ok('and the gold figure counts only the top-grade one',
    /^1 \(33%\)$/.test(T.getTop('Alpha','finals') || ''),
    `"${T.getTop('Alpha','finals')}" — 2 here means a B-grade team is being counted as top`);

  // THE DENOMINATOR. 1 of 3 entered is 33%. If gold were a share of top-grade
  // entered it would read 50%, which looks just as reasonable on screen.
  ok('the gold percentage is a share of ALL teams entered, not of top-grade entered',
    /33%/.test(T.getTop('Alpha','finals') || '') && !/50%/.test(T.getTop('Alpha','finals') || ''),
    `"${T.getTop('Alpha','finals')}" — 50% means the gold column has its own denominator`);

  ok('the premiership is top grade and shown in gold',
    /^1 \(33%\)$/.test(T.getTop('Alpha','premierships') || ''),
    `"${T.getTop('Alpha','premierships')}"`);

  // Zed's finalists are T2 (A) and L2 (B), neither a premier — so its gold
  // premierships cell must be absent, not a zero.
  ok('a club with no top-grade premiership shows no gold figure there',
    !T.getTop('Zed','premierships'),
    `"${T.getTop('Zed','premierships')}"`);

  // Could these have failed? Gold and white must differ somewhere, or a cell that
  // simply repeated the white figure would satisfy everything above.
  ok('gold and white are different numbers somewhere in the table',
    T.rows.some(r => {
      const club = T.get(r, 'club');
      return (T.getTop(club,'finals') || '') !== (T.get(r,'finals') || '');
    }),
    'if gold always equalled white, it would be measuring nothing');
}

console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
