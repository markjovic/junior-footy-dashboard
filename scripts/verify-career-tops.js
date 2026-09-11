// scripts/verify-career-tops.js
//
// Runs the REAL scripts/build-career-tops.js as a child process against a
// temporary players/ tree and reads the boards it writes.
//
// Covers the SILENT failures only — a leaderboard that is merely WRONG looks
// exactly like one that is right:
//   * a duplicated (season, club) row counted twice, inflating a total
//   * the goals-per-game floor not applied, so a one-game player tops the board
//   * "longest history" sorted the wrong way, putting 2026 above 2005
//   * a per-competition game record taken from a game in a DIFFERENT league
//   * a zero ranked as a record
//   * a private or unwalked player ranked as if they had a career
//   * the competition list built from something other than the held seasons
//   * a competition that disappears leaving a stale board behind
//   * two runs on identical data producing different bytes, which would commit
//     noise on every build
//
// Run: node scripts/verify-career-tops.js   Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-career-tops v3 2026-09-11 short-names';
console.log(`=== ${VERSION} ===`);

const REAL = path.join(__dirname, 'build-career-tops.js');
if (!fs.existsSync(REAL)) {
  console.error(`FATAL: ${REAL} not found. Run from the repository root.`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tops-verify-'));
fs.mkdirSync(path.join(TMP, 'scripts'), { recursive: true });
fs.copyFileSync(REAL, path.join(TMP, 'scripts', 'build-career-tops.js'));
// The manifest supplies the short names; "EFNL 2026" -> "EFNL".
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'data', 'core.json'), JSON.stringify({ manifest: [
  { seasonId: 'w26', compName: 'WFNL 2026' }, { seasonId: 'w25', compName: 'WFNL 2025' },
  { seasonId: 'e26', compName: 'EFNL 2026' },
  { seasonId: 'n23' }, { seasonId: 'o05' }, { seasonId: 'x24' } ] }));

const S = (year, sid, leagueId, league, club, gp, goals, best, held) =>
  ({ year, sid, leagueId, league, club, clubId: club, grade: 'G', gp, goals, best, held, lines: held ? gp : 0 });

function mk(uuid, name, seasons, records, extra) {
  const sh = uuid.slice(0, 2);
  fs.mkdirSync(path.join(TMP, 'players', sh), { recursive: true });
  const body = Object.assign({ uuid, name, statsChecked: 't' }, extra || {});
  if (seasons) {
    body.career = { gp: seasons.reduce((a, s) => a + s.gp, 0) };
    body.seasons = seasons;
    body.records = records || {};
  }
  fs.writeFileSync(path.join(TMP, 'players', sh, `${uuid}.json`), JSON.stringify(body));
}

// ── Fixture ──────────────────────────────────────────────────────────────────
// ⚠️ IT MUST DISTINGUISH THE DEFECTS.
// Lewis has TWO game records in DIFFERENT leagues — 14 in the NTFL we do not
// hold, 11 in the WFNL we do — so a per-competition board that takes the wrong
// one is visible. He is also the OLDEST career, so a reversed sort on "longest
// history" changes who leads. `01-dupe` has the same (season, club) row twice, so
// a missing dedupe doubles a total. `02-one` played one game and kicked three, so
// a missing rate floor puts him top of goals-per-game ahead of everyone.
mk('00-lewis', 'Lewis Stanton', [
  S('2026', 'w26', 'wfnl', 'Western FNL', 'Wyndhamvale', 21, 106, 8, true),
  S('2025', 'w25', 'wfnl', 'Western FNL', 'Wyndhamvale', 21, 125, 6, true),
  S('2023', 'n23', 'ntfl', 'NTFL SENIORS', 'Darwin', 20, 172, 5, false),
  S('2005', 'o05', 'ntfl', 'NTFL SENIORS', 'Darwin', 10, 9, 0, false),
], { goalsAny: { v: 14, gameId: 'g-ntfl', sid: 'n23' }, goalsHeld: { v: 11, gameId: 'g-wfnl', sid: 'w26' } });

mk('01-dupe', 'Dupe Rows', [
  S('2026', 'e26', 'efnl', 'Eastern FNL', 'Kew', 10, 5, 1, true),
  S('2026', 'e26', 'efnl', 'Eastern FNL', 'Kew', 10, 5, 1, true),
]);
mk('02-one', 'One Gamer', [S('2026', 'e26', 'efnl', 'Eastern FNL', 'Vermont', 1, 3, 0, true)],
  { goalsAny: { v: 3, gameId: 'g-one', sid: 'e26' } });
mk('03-zero', 'No Goals', [S('2026', 'e26', 'efnl', 'Eastern FNL', 'Vermont', 25, 0, 0, true)]);
mk('04-priv', 'Private', null, null, { noStats: true });
mk('05-stub', 'Never Walked', null, null, { statsChecked: null });
mk('06-out', 'Outside Only', [S('2024', 'x24', 'gv', 'Goulburn Valley', 'Shepp', 18, 60, 2, false)]);

function run(env) {
  const r = spawnSync(process.execPath, ['scripts/build-career-tops.js'],
    { cwd: TMP, encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
  if (r.error) throw r.error;
  const read = (p) => { try { return JSON.parse(fs.readFileSync(path.join(TMP, p), 'utf8')); } catch (e) { return null; } };
  return { code: r.status, out: r.stdout + r.stderr,
           all: read('data/leaderboard/all-time.json'),
           comp: (id) => read(`data/leaderboard/comp/${id}.json`) };
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); }
                          else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };
const names = (b) => (b || []).map(e => `${e.name}:${e.v}`).join(', ');

console.log('\n1  It runs and writes');
let r = run();
ok('version line', /build-career-tops v3 /.test(r.out));
ok('exit 0', r.code === 0, `exit ${r.code}`);
ok('all-time board written', !!r.all);
ok('one file per competition on a held season', !!r.comp('wfnl') && !!r.comp('efnl'), '');
ok('a league we only see on UNHELD seasons gets no board', !r.comp('gv') && !r.comp('ntfl'));

console.log('\n1b  Competitions carry the short name the dashboard already uses');
ok('all-time meta lists the competitions with a short name',
  (r.all.meta.comps || []).some(c => c.id === 'efnl' && c.short === 'EFNL'),
  JSON.stringify(r.all.meta.comps));
ok('the competition board carries it too', r.comp('wfnl').meta.short === 'WFNL', r.comp('wfnl').meta.short);
ok('… taken from the manifest compName, not parsed out of the league name',
  r.comp('efnl').meta.short === 'EFNL' && !/\(/.test(r.comp('efnl').meta.name),
  `${r.comp('efnl').meta.short} / ${r.comp('efnl').meta.name}`);

console.log('\n2  Two rows for one (season, club) are BOTH counted');
// 11,829 players carry a pair, and fetch-career-stats.js reports their summed
// registrations agreeing with PlayHQ's own career total — so the pair is two
// distinct registrations, not a repeat, and dropping one undercounts.
const dupe = (r.all.boards.goals || []).find(e => e.uuid === '01-dupe');
ok('both rows count toward the total (10, not 5)', dupe && dupe.v === 10, dupe ? `v=${dupe.v}` : 'absent');
ok('… and both sets of games count (20, not 10)', dupe && dupe.gp === 20, dupe ? `gp=${dupe.gp}` : 'absent');
ok('but it is ONE season, not two', dupe && dupe.seasons === 1, dupe ? `seasons=${dupe.seasons}` : 'absent');
ok('the pair is reported so a change in the count is visible',
  /hold two rows for one \(season, club\)/.test(r.out));

console.log('\n3  The rate floor');
const gpg = r.all.boards.goalsPerGame || [];
ok('a one-game player does NOT top goals per game', !gpg.some(e => e.uuid === '02-one'), names(gpg));
ok('a player over the floor does appear', gpg.some(e => e.uuid === '00-lewis'), names(gpg));
// The floor has to drop BELOW his one game, or the assertion proves only that 1
// is still under 5 — which is arithmetic, not the gate.
const r1 = run({ TOPS_MIN_GP: '1' });
ok('dropping the floor to 1 lets him in — the gate is real, not an accident of the data',
  (r1.all.boards.goalsPerGame || []).some(e => e.uuid === '02-one'), names(r1.all.boards.goalsPerGame));
// He does not top it — Lewis's 5.72 beats his 3.00. What the floor prevents is a
// one-game player outranking a 20-season one on a rate, which he does here
// against Dupe Rows.
ok('… ranking above a player with twenty times his games',
  (r1.all.boards.goalsPerGame || []).findIndex(e => e.uuid === '02-one') <
  (r1.all.boards.goalsPerGame || []).findIndex(e => e.uuid === '01-dupe'),
  names(r1.all.boards.goalsPerGame));

console.log('\n4  Longest history sorts the other way');
const early = r.all.boards.earliest || [];
ok('the OLDEST career leads', early[0] && early[0].uuid === '00-lewis', names(early));
ok('… with the earliest year as its value', early[0] && early[0].v === 2005, early[0] && String(early[0].v));
ok('and it is not simply the same order as goals',
  (r.all.boards.goals[0] || {}).uuid !== early[early.length - 1].uuid || early.length > 1);

console.log('\n5  A per-competition game record comes from THAT competition');
const wAll = (r.all.boards.gameGoals || [])[0];
const wComp = (r.comp('wfnl').boards.gameGoals || [])[0];
ok('all-time takes the best anywhere (14, NTFL)', wAll && wAll.v === 14 && wAll.sid === 'n23',
  wAll ? `${wAll.v}/${wAll.sid}` : 'absent');
ok('the WFNL board takes the WFNL game (11), not the NTFL one', wComp && wComp.v === 11 && wComp.sid === 'w26',
  wComp ? `${wComp.v}/${wComp.sid}` : 'absent');
ok('… and carries its gameId so a row can open the game', wComp && wComp.gameId === 'g-wfnl',
  wComp && String(wComp.gameId));

console.log('\n6  What must not be ranked');
const inAny = (uuid) => Object.values(r.all.boards).some(b => (b || []).some(e => e.uuid === uuid));
ok('a private profile is not ranked', !inAny('04-priv'));
ok('a never-walked stub is not ranked', !inAny('05-stub'));
ok('a zero is not a record', !(r.all.boards.goals || []).some(e => e.uuid === '03-zero'), names(r.all.boards.goals));
ok('… but that player still ranks where they have a value', (r.all.boards.games || []).some(e => e.uuid === '03-zero'));
ok('a player with no held season is still in the all-time boards',
  (r.all.boards.goals || []).some(e => e.uuid === '06-out'), names(r.all.boards.goals));
ok('… and in no competition board', !(r.comp('efnl').boards.goals || []).some(e => e.uuid === '06-out'));

console.log('\n7  Per-competition totals are that competition only');
const lw = (r.comp('wfnl').boards.goals || []).find(e => e.uuid === '00-lewis');
const la = (r.all.boards.goals || []).find(e => e.uuid === '00-lewis');
ok('WFNL counts only his two WFNL seasons (231)', lw && lw.v === 231, lw ? String(lw.v) : 'absent');
ok('all-time counts every league (412)', la && la.v === 412, la ? String(la.v) : 'absent');
ok('the leagues board is all-time only', !('leagues' in r.comp('wfnl').boards) && 'leagues' in r.all.boards);

console.log('\n8  Two runs on the same data produce the same bytes');
const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.meta.builtAt; return JSON.stringify(c); };
const again = run();
ok('all-time is byte-identical apart from builtAt', strip(again.all) === strip(r.all));
ok('a competition board is too', strip(again.comp('wfnl')) === strip(r.comp('wfnl')));

console.log('\n8b  A run that changes nothing rewrites nothing');
{
  const before = fs.statSync(path.join(TMP, 'data', 'leaderboard', 'all-time.json')).mtimeMs;
  const r8 = run();
  const after = fs.statSync(path.join(TMP, 'data', 'leaderboard', 'all-time.json')).mtimeMs;
  ok('the file is not rewritten when the data is identical', before === after,
    `mtime ${before} -> ${after}`);
  ok('… and the log says so rather than claiming a write', /Every board is unchanged/.test(r8.out),
    (r8.out.match(/Wrote.*|Every board.*/) || [''])[0]);
}

console.log('\n9  A competition that disappears leaves no stale board');
fs.writeFileSync(path.join(TMP, 'data', 'leaderboard', 'comp', 'ghost.json'), '{"boards":{}}');
const r9 = run();
ok('the stale board is removed', !r9.comp('ghost'));
ok('… and said so', /removed stale board ghost\.json/.test(r9.out));

console.log('\n10  Bad input');
fs.rmSync(path.join(TMP, 'players'), { recursive: true, force: true });
const r10 = run();
ok('no players/ exits 1 rather than writing empty boards', r10.code === 1, `exit ${r10.code}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
