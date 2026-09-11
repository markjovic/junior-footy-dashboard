// scripts/verify-careers.js
//
// Runs the REAL scripts/fetch-career-stats.js as a child process in a temporary
// tree, with only scripts/lib/playhq.js stubbed. The stub reads its answers from
// a JSON file the test writes and logs every call, so a section can say exactly
// who was fetched.
//
// Covers the SILENT failures only:
//   * the same game counted twice because a regrade puts it under two grades
//   * a single-game record pointing at a game we do not hold when a held one exists
//   * a shard that did nothing writing NO summary, which the aggregator reads as
//     a crash and carries forward for ever
//   * a WAF block reported as a clean finish, so the chain never retries the shard
//   * `held` false for a season that is in the manifest
//   * the league taken from the club-name bracket instead of season.competition
//   * a fresh player re-fetched, or a stale one skipped
//   * a write landing outside players/<shard>/, which git silently drops under
//     the workflow's sparse checkout
//
// Run: node scripts/verify-careers.js   Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-careers v6 2026-09-11 held-needs-compname';
console.log(`=== ${VERSION} ===`);

const REAL = path.join(__dirname, 'fetch-career-stats.js');
if (!fs.existsSync(REAL)) {
  console.error(`FATAL: ${REAL} not found. Run from the repository root.`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'careers-verify-'));
const SHARD = '00';
const DIR = path.join(TMP, 'players', SHARD);
const STUB_IN = path.join(TMP, 'stub-answers.json');
const STUB_LOG = path.join(TMP, 'stub-calls.json');
fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.copyFileSync(REAL, path.join(TMP, 'scripts', 'fetch-career-stats.js'));

fs.writeFileSync(path.join(TMP, 'scripts', 'lib', 'playhq.js'), `
'use strict';
const fs = require('fs'), path = require('path');
const IN = path.join(__dirname, '..', '..', 'stub-answers.json');
const LOG = path.join(__dirname, '..', '..', 'stub-calls.json');
const counters = { ok:0, graphqlError:0, blocked:0, auth403:0, transient:0, retries:0, sessionRefreshes:0 };
const calls = [];
let n = 0;
const BLOCK_AT = Number(process.env.STUB_BLOCK_AT || 0);
async function gqlPost(query, vars, op) {
  n++;
  calls.push({ op, id: vars.profileID });
  fs.writeFileSync(LOG, JSON.stringify(calls));
  if (BLOCK_AT && n >= BLOCK_AT) counters.blocked++;
  const a = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const r = a.profiles[vars.profileID];
  if (r === undefined) { counters.ok++; return { data: { publicProfileStatistics: { careerStatistics: { totalStatistics: [] }, seasonStatistics: [] } } }; }
  if (r === 'NOT_FOUND') { counters.graphqlError++; return { errors: [{ message: '5 NOT_FOUND: failed to find profile' }] }; }
  if (r === 'PRIVATE') { counters.auth403++; throw new Error('403 not accessible: publicProfileStatistics'); }
  if (r === 'NULLDATA') { counters.ok++; return { data: { publicProfileStatistics: null } }; }
  if (r === 'SERVERERR') { counters.graphqlError++; return { errors: [{ message: "Cannot read properties of undefined (reading '0')" }] }; }
  counters.ok++;
  return { data: { publicProfileStatistics: r } };
}
module.exports = { gqlPost,
  sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5))),
  refreshSession: async () => { counters.sessionRefreshes++; return process.env.STUB_NO_SESSION !== 'true'; },
  summary: () => ({ ...counters }),
  logSummary: () => {} };
`);

// ── Fixture ──────────────────────────────────────────────────────────────────
const HELD = '2dcbf383';       // in the manifest
const OUT = 'mpjfl2023';       // not in the manifest
// ⚠️ THE MANIFEST CARRIES SEASONS WE DO NOT STORE. discover-seasons records every
// organisation, tracked and watched, so a watched league's season has a seasonId
// and NO compName. Marking it held made it bright and clickable on the career
// table — a row for a league never fetched. OUT is exactly that shape here.
fs.writeFileSync(path.join(TMP, 'data', 'core.json'), JSON.stringify({
  manifest: [{ seasonId: HELD, compName: 'EFNL 2026' },
             { seasonId: 'other', compName: 'WFNL 2026' },
             { seasonId: OUT, org: 'watched-org' }],
}));

const st = (o) => Object.entries(o).map(([value, count]) => ({ count, details: { value } }));
const line = (id, goals) => ({
  game: { id, round: { name: 'Round 1', number: 1, isFinalsRound: false, abbreviatedName: 'R1' },
          date: '2026-05-02', home: { id: 'h', name: 'A' }, away: { id: 'a', name: 'B' } },
  statistics: st({ APPEARANCE: 1, GOAL_COUNT: goals }),
});

// ⚠️ THE FIXTURE MUST DISTINGUISH THE DEFECT.
// p1's held season is a REGRADE: one team, two grade entries, and game `g-dup`
// appears under BOTH. Correct behaviour counts 2 lines; a missing dedup counts 3.
// Its OUTSIDE season carries a HIGHER-scoring game (11) than any held game (9),
// so goalsHeld and goalsAny must differ — a fixture where the best game is held
// could not tell a broken split from a working one.
// The club name carries a bracket that is NOT the competition, so a league read
// from the bracket gives a different answer from one read from competition.name.
const p1 = {
  careerStatistics: { totalStatistics: st({ APPEARANCE: 187, GOAL_COUNT: 9, BEST_PLAYER: 32 }) },
  seasonStatistics: [
    { name: '2026', statistics: [{
      season: { id: HELD, name: '2026', startDate: '2025-10-01', endDate: '2026-09-30',
                status: { value: 'ACTIVE' }, competition: { id: 'k1', name: 'Eastern Football Netball League' } },
      club: { id: 'c2', name: 'Vermont (EFNL)' },
      totalStatistics: st({ APPEARANCE: 13, GOAL_COUNT: 9, BEST_PLAYER: 2 }),
      teamStatistics: [{ team: { id: 't2', name: 'Vermont U12' }, gradeStatistics: [
        { grade: { id: 'gB', name: 'U12 - B' }, totalStatistics: st({ APPEARANCE: 13 }),
          gameStatistics: [line('g-dup', 4), line('g-two', 9)] },
        { grade: { id: 'gR', name: 'U12 - BRES' }, totalStatistics: st({ APPEARANCE: 13 }),
          gameStatistics: [line('g-dup', 4)] },
      ] }],
    }] },
    { name: '2023', statistics: [{
      season: { id: OUT, name: '2023', startDate: '2022-10-01', endDate: '2023-09-30',
                status: { value: 'COMPLETED' }, competition: { id: 'k2', name: 'Mornington Peninsula JFL' } },
      club: { id: 'c3', name: 'Balnarring' },
      totalStatistics: st({ APPEARANCE: 5, GOAL_COUNT: 12 }),
      teamStatistics: [{ team: { id: 't3', name: 'Balnarring U15' }, gradeStatistics: [
        { grade: { id: 'g3', name: '15D 2023' }, totalStatistics: st({ APPEARANCE: 5 }),
          gameStatistics: [line('g-out', 11)] },
      ] }],
    }] },
  ],
};

let answers = { profiles: {} };
const uuids = [];
const mk = (u, extra, answer) => {
  uuids.push(u);
  fs.writeFileSync(path.join(DIR, `${u}.json`),
    JSON.stringify(Object.assign({ uuid: u, name: 'Player ' + u, statsChecked: null }, extra || {})));
  if (answer !== undefined) answers.profiles[u] = answer;
};
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

mk('00a-rich', null, p1);
mk('00b-priv', null, 'PRIVATE');
mk('00c-gone', null, 'NOT_FOUND');
mk('00d-fresh', { statsChecked: iso(5) }, p1);          // not due
mk('00e-stale', { statsChecked: iso(400) }, p1);        // due, stale
mk('00f-flag', { statsChecked: iso(1), refetch: true }, p1); // due, flagged
// A 200 carrying `publicProfileStatistics: null` and NO errors array. Measured
// live on shard 00, 2026-09-10 — two of 274 players. v1 counted it as an error,
// printed nothing, and never stamped it, so the player was due for ever and the
// shard's `remaining` never reached zero.
mk('00g-null', null, 'NULLDATA');
// A 200 carrying a GraphQL errors array whose MESSAGE IS A JAVASCRIPT TypeError
// from PlayHQ's own resolver. Measured 2026-09-10: 11 of 70,933 players, the
// same message on every retry across three chained runs. It is a verdict, not a
// transient fault, and leaving it unstamped kept 11 shards in the chain for ever.
mk('00h-crash', null, 'SERVERERR');
const saveAnswers = () => fs.writeFileSync(STUB_IN, JSON.stringify(answers));
saveAnswers();

function run(args, env) {
  fs.rmSync(STUB_LOG, { force: true });
  const r = spawnSync(process.execPath,
    ['scripts/fetch-career-stats.js', `--shard=${SHARD}`, ...(args || [])],
    { cwd: TMP, encoding: 'utf8', env: { ...process.env, CAREER_BATCH_GAP_MS: '0', ...(env || {}) } });
  if (r.error) throw r.error;
  const calls = fs.existsSync(STUB_LOG) ? JSON.parse(fs.readFileSync(STUB_LOG, 'utf8')) : [];
  const sPath = path.join(TMP, `career-summary-${SHARD}.json`);
  return {
    code: r.status, out: r.stdout + r.stderr,
    fetched: calls.map(c => c.id),
    summary: fs.existsSync(sPath) ? JSON.parse(fs.readFileSync(sPath, 'utf8')) : null,
  };
}
const player = (u) => JSON.parse(fs.readFileSync(path.join(DIR, `${u}.json`), 'utf8'));
const reset = () => { for (const u of uuids) {
  const f = path.join(DIR, `${u}.json`);
  const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ uuid: cur.uuid, name: cur.name, statsChecked: null }));
} };

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 1. Due selection ─────────────────────────────────────────────────────────
console.log('\n1  Which players a run picks up');
let r = run([], { CAREER_BATCH: '10' });
ok('version line', /fetch-career-stats v6 /.test(r.out));
ok('exit 0', r.code === 0, `exit ${r.code}`);
ok('never-checked, stale and flagged are fetched', ['00a-rich', '00b-priv', '00c-gone', '00e-stale', '00f-flag']
  .every(u => r.fetched.includes(u)), r.fetched.join(','));
ok('a player checked 5 days ago is NOT fetched', !r.fetched.includes('00d-fresh'), r.fetched.join(','));
ok('never-checked sort ahead of stale', r.fetched.indexOf('00a-rich') < r.fetched.indexOf('00e-stale'));

// ── 2. The stored shape ──────────────────────────────────────────────────────
console.log('\n2  What is stored');
const p = player('00a-rich');
const held = p.seasons.find(s => s.sid === HELD);
const out = p.seasons.find(s => s.sid === OUT);
ok('career comes from careerStatistics, not a sum', p.career.gp === 187 && p.career.goals === 9 && p.career.best === 32,
  JSON.stringify(p.career));
ok('career.from is the earliest season year', p.career.from === '2023', String(p.career.from));
ok('held flag true for a manifest season', held && held.held === true);
ok('held flag false for a season we do not hold', out && out.held === false);
ok('a manifest entry with a seasonId but NO compName does NOT count as held',
  out && out.sid === OUT && out.held === false, out && `${out.sid} held=${out.held}`);
ok('league from season.competition, NOT the club bracket', held && held.league === 'Eastern Football Netball League',
  held && `${held.league} (club is ${held.club})`);
ok('outside league is captured too', out && out.league === 'Mornington Peninsula JFL', out && String(out.league));
ok('grade stored for a season we do not hold', out && out.grade === '15D 2023', out && String(out.grade));
ok('both grades kept when a season has more than one', held && Array.isArray(held.grades) && held.grades.length === 2,
  held && JSON.stringify(held.grades));
ok('statsChecked stamped', typeof p.statsChecked === 'string' && p.statsChecked.length > 10);

// ── 3. The dedup, and the record split ───────────────────────────────────────
console.log('\n3  Deduplication by game id, and the two records');
ok('regraded season counts g-dup ONCE (2 lines, not 3)', held && held.lines === 2, held && `lines=${held.lines}`);
ok('outside season counts its one line', out && out.lines === 1, out && `lines=${out.lines}`);
ok('goalsHeld points at the best game in a season we hold', p.records.goalsHeld
  && p.records.goalsHeld.v === 9 && p.records.goalsHeld.gameId === 'g-two' && p.records.goalsHeld.sid === HELD,
  JSON.stringify(p.records.goalsHeld));
ok('goalsAny points at the best game anywhere, which is the outside one', p.records.goalsAny
  && p.records.goalsAny.v === 11 && p.records.goalsAny.gameId === 'g-out' && p.records.goalsAny.sid === OUT,
  JSON.stringify(p.records.goalsAny));
ok('the two records DIFFER, so a fixture could tell them apart',
  p.records.goalsHeld.gameId !== p.records.goalsAny.gameId);

// ── 4. The drift check (career total vs summed registrations) ────────────────
console.log('\n4  The career-total check reports rather than silently reconciling');
ok('drift stored when the sum disagrees', p.drift === (13 + 5) - 187, `drift=${p.drift}`);
ok('drift counted in the summary', r.summary && r.summary.drifted >= 1, JSON.stringify(r.summary && r.summary.drifted));
ok('drift reported in the log', /disagreed for \d+ of \d+/.test(r.out), (r.out.match(/career total vs.*/) || [''])[0]);

// ── 5. Not-found and private are answers, not errors ─────────────────────────
console.log('\n5  A private profile and a missing one do not fail the shard');
ok('both counted as notFound', r.summary && r.summary.notFound === 2, JSON.stringify(r.summary && r.summary.notFound));
ok('a null publicProfileStatistics is counted separately, not as an error',
  r.summary && r.summary.noStats === 1 && r.summary.errors === 0,
  JSON.stringify(r.summary && { noStats: r.summary.noStats, errors: r.summary.errors }));
ok('… and the uuid is PRINTED, not just counted', /00g-null/.test(r.out),
  (r.out.match(/null data.*/) || [''])[0]);
// A count on its own asks to be taken on trust. Every negative kind prints a
// profile URL for its first few, so a claim that PlayHQ has nothing for a player
// can be checked in a browser.
ok('a checkable profile link is printed for a null-data player',
  r.out.includes(`https://www.playhq.com/public/profile/00g-null/statistics?tenant=afl`));
ok('… and for a PlayHQ resolver crash',
  r.out.includes(`https://www.playhq.com/public/profile/00h-crash/statistics?tenant=afl`));
ok('… and for a 403 private profile',
  r.out.includes(`https://www.playhq.com/public/profile/00b-priv/statistics?tenant=afl`));
ok('… and for a NOT_FOUND profile',
  r.out.includes(`https://www.playhq.com/public/profile/00c-gone/statistics?tenant=afl`));
// The aggregator can only report what the summary carries. Without the uuids a
// 256-shard sweep gives counts and no way to check any of them.
ok('the summary carries sample uuids per negative kind',
  r.summary && r.summary.samples && r.summary.samples.serverError
  && r.summary.samples.serverError.includes('00h-crash')
  && r.summary.samples.noStats.includes('00g-null'),
  JSON.stringify(r.summary && r.summary.samples));
ok('… capped, so a bad shard cannot fill the summary',
  r.summary && Object.values(r.summary.samples || {}).every(a => a.length <= 5));
ok('each kind is labelled with what the answer MEANT',
  /private profile, or no statistics/.test(r.out) && /JavaScript TypeError/.test(r.out),
  (r.out.match(/serverError.*/) || [''])[0]);
ok('a PlayHQ resolver crash is counted as a server error, not a transport one',
  r.summary && r.summary.serverErrors === 1 && r.summary.errors === 0,
  JSON.stringify(r.summary && { serverErrors: r.summary.serverErrors, errors: r.summary.errors }));
ok('… and its message is kept in the player file, not just the log',
  /Cannot read properties/.test(String(player('00h-crash').serverError || '')),
  JSON.stringify(player('00h-crash')));
ok('a private profile is NOT written', !fs.readFileSync(path.join(DIR, '00b-priv.json'), 'utf8').includes('career'));

// ── 5b. Every definitive negative is stamped, or the shard never finishes ────
console.log('\n5b Negatives are stamped so remaining can reach zero');
for (const u of ['00b-priv', '00c-gone', '00g-null', '00h-crash']) {
  const rec = player(u);
  ok(`${u} stamped with statsChecked`, typeof rec.statsChecked === 'string' && rec.statsChecked.length > 10,
    JSON.stringify(rec));
}
ok('each carries a marker saying WHICH negative it was',
  player('00b-priv').private === true && player('00c-gone').missing === true
  && player('00g-null').noStats === true && !!player('00h-crash').serverError,
  [player('00b-priv'), player('00c-gone'), player('00g-null')].map(x => JSON.stringify(x)).join(' '));
{
  const r2 = run([], { CAREER_BATCH: '10' });
  ok('a second run re-fetches NONE of them', r2.fetched.length === 0, r2.fetched.join(','));
  ok('… so remaining reaches zero and the chain lets the shard go',
    r2.summary && r2.summary.remaining === 0, JSON.stringify(r2.summary && r2.summary.remaining));
}

// ── 6. The summary contract with the aggregator ──────────────────────────────
console.log('\n6  The summary — silence must not look like success');
reset();
r = run([], { CAREER_BATCH: '2', STUB_BLOCK_AT: '3' });
ok('a block is recorded, not swallowed', r.summary && r.summary.blocked === true, JSON.stringify(r.summary));
ok('blocked_at_call is recorded', r.summary && typeof r.summary.blocked_at_call === 'number' && r.summary.blocked_at_call > 0,
  String(r.summary && r.summary.blocked_at_call));
ok('batches_completed is recorded', r.summary && r.summary.batches_completed >= 1);
ok('remaining is non-zero after a block, so the chain retries', r.summary && r.summary.remaining > 0,
  String(r.summary && r.summary.remaining));
ok('the run still exits 0 — a block is not a failure', r.code === 0, `exit ${r.code}`);
ok('it stopped rather than working through every batch', r.fetched.length < uuids.length,
  `${r.fetched.length} fetched of ${uuids.length}`);

fs.rmSync(path.join(TMP, `career-summary-${SHARD}.json`), { force: true });
r = run([], { CAREER_BATCH: '10' });   // everything already fresh from the block run? force nothing
ok('a shard with nothing due STILL writes a summary', r.summary !== null);
ok('… reporting remaining 0 rather than staying silent', r.summary && r.summary.remaining === 0,
  JSON.stringify(r.summary && r.summary.remaining));

fs.rmSync(path.join(TMP, `career-summary-${SHARD}.json`), { force: true });
r = run(['--force'], { STUB_NO_SESSION: 'true' });
ok('no session: summary written and shard marked blocked for retry',
  r.summary && r.summary.blocked === true && r.summary.remaining > 0, JSON.stringify(r.summary));
ok('no session: no profile calls made', r.fetched.length === 0, `${r.fetched.length}`);

fs.rmSync(path.join(TMP, `career-summary-ff.json`), { force: true });
const rf = spawnSync(process.execPath, ['scripts/fetch-career-stats.js', '--shard=ff'],
  { cwd: TMP, encoding: 'utf8', env: process.env });
ok('a shard directory that does not exist writes a summary and exits 0',
  rf.status === 0 && fs.existsSync(path.join(TMP, 'career-summary-ff.json')), `exit ${rf.status}`);

// ── 7. Blast radius ──────────────────────────────────────────────────────────
console.log('\n7  Writes stay inside players/<shard>/ — anything else is dropped by git');
reset();
const before = new Set();
const walk = (d) => { for (const n of fs.readdirSync(d)) {
  const f = path.join(d, n);
  if (fs.statSync(f).isDirectory()) walk(f); else before.add(path.relative(TMP, f));
} };
walk(TMP);
r = run(['--force'], { CAREER_BATCH: '10' });
const after = new Set(); walk(TMP);
const added = [...after].filter(f => !before.has(f));
ok('the only new file is this shard\'s summary', added.length === 0
  || added.every(f => f === `career-summary-${SHARD}.json`), added.join(','));
const strayDir = fs.readdirSync(path.join(TMP, 'players')).filter(d => d !== SHARD);
ok('no other shard directory was created', strayDir.length === 0, strayDir.join(','));

// ── 8. Bad input ─────────────────────────────────────────────────────────────
console.log('\n8  Bad input fails loudly');
const rb = spawnSync(process.execPath, ['scripts/fetch-career-stats.js', '--shard=zz'],
  { cwd: TMP, encoding: 'utf8', env: process.env });
ok('a shard name that is not two hex digits exits 1', rb.status === 1, `exit ${rb.status}`);
const rn = spawnSync(process.execPath, ['scripts/fetch-career-stats.js'],
  { cwd: TMP, encoding: 'utf8', env: process.env });
ok('a missing --shard exits 1', rn.status === 1, `exit ${rn.status}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
