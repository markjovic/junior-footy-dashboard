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
  const head = html.slice(0, html.indexOf('</head>'));
  const body = html.slice(html.indexOf('<body'));
  const hdr = body.slice(body.indexOf('<header'), body.indexOf('</header>'));

  ok('the header is still overflow:hidden — the reason this matters',
    /\.hdr\{[^}]*overflow:hidden/.test(head));
  ok('a mobile view-switch row exists OUTSIDE the header',
    /id="mob-view-tabs"/.test(body) && !/id="mob-view-tabs"/.test(hdr));
  ok('it carries both destinations',
    /id="mvt-dash"/.test(body) && /id="mvt-finals"/.test(body));
  ok('the header switch is hidden below 768px',
    /#view-switch\{display:none!important\}/.test(head));
  ok('and the mobile row is shown there',
    /\.mob-view-tabs\{display:flex!important\}/.test(head));

  // It must NOT be inside #dash. #mob-tabs is, which is why it could not be
  // reused: that row is hidden whenever the finals view is showing, so the way
  // back would disappear along with it.
  const dashStart = body.indexOf('id="dash"');
  const finalsStart = body.indexOf('id="finals-view"');
  const mvtAt = body.indexOf('id="mob-view-tabs"');
  ok('the row sits ABOVE both views, not inside either',
    mvtAt > 0 && mvtAt < dashStart && mvtAt < finalsStart,
    `row at ${mvtAt}, dash at ${dashStart}, finals at ${finalsStart}`);

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

  // A reader must be able to tell "still arriving" from "there are none".
  ok('Scorers says loading rather than empty while players are in flight',
    /Loading scorers…/.test(body) && /S\.playersPending/.test(body));
  ok('so does player search', /Loading players…/.test(body));

  // Could that have failed? The old empty state must still exist for the real case.
  ok('and still says "no scorer data" when there genuinely is none',
    /No scorer data loaded/.test(body));
}

// ── 7. The season selector ──────────────────────────────────────────────────
// season_selection_design.md §2.1: year is the OUTER scope, and the competition
// list must come from the manifest rather than from loaded records — a past year
// has nothing in S.matches until it is fetched, and an empty competition list
// would leave nothing to click to trigger the fetch.
console.log('\n7  Year is the outer scope, and its lists come from the manifest');
{
  const body = html.slice(html.indexOf('<body'));
  ok('a season selector exists in the sidebar', /id="year-sel"/.test(body));
  ok('it sits ABOVE the competition filter',
    body.indexOf('id="year-sel"') < body.indexOf('id="comp-filters"'));
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
// over matchGrade(). There were three copies of that computation and they
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
    run('matchGrade(S.matches[0])') === 'gA', run('matchGrade(S.matches[0])'));
  ok('one ladder, not two',
    run('gradesForAge("U12")').length === 1, JSON.stringify(run('gradesForAge("U12")')));
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

  const body = html.slice(html.indexOf('<body'));
  ok('the search result renders the season', /yearTag/.test(body));
  ok('and results are ordered newest season first',
    /seasonYearOf\(a\.compName\)/.test(body) && /by\.localeCompare\(ay\)/.test(body));
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
  const body = html.slice(html.indexOf('<body'));
  ok('the search box sits BELOW the season selector',
    body.indexOf('id="year-sel"') < body.indexOf('id="player-search-input"'),
    'position implies scope');

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

console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
