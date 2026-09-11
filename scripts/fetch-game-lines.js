#!/usr/bin/env node
// scripts/fetch-game-lines.js
//
// Per-game player lines — the box score. per_game_stats_design.md.
//
// One `discoverGame` call per game on api.playhq.com, the same operation
// enrich-games.js already runs for quarter scores, with the player selection the
// game-centre page's own `gameView` request uses. Captured 2026-09-11; every
// field below came off that request rather than from a guess.
//
// ⚠️ FIRST RUNS ARE DRY. Without --apply it walks, measures and reports, and
// writes nothing. The figures it prints are the ones the design is still missing:
// coverage per league per season, the statistic vocabulary, whether
// periodStatistics is populated, roster sizes, lines with no uuid, and records
// with no gameId. Read them before committing to a shape.
//
// STORAGE. data/seasons/<seasonId>-lines.json.gz, written whole by this script
// and nothing else. NOT through store.save: this script never loads or writes a
// season core or players file, so it cannot revert another writer's work. It
// still takes `playhq-data-write`, because enrich-games.yml commits with
// `git add -A data/` and would otherwise stage this file mid-write.
//
// ⚠️ DICTIONARY-ENCODED, FULL UUIDS. `players` is an array of [uuid, name]; each
// line is [playerIndex, goals, behinds, votes]. MEASURED 2026-09-11 by building
// the file and gzipping it: 281 B/game against 923 for a full uuid on every line
// and 488 for a 13-character truncation with a name. The dictionary is both the
// smallest and the only one that keeps whole uuids — truncation would create the
// mixed-form condition behind the sibling project's split-identity case, where a
// roster held both a 13-char and a 36-char id for one person.
// A fill-in or anonymous player has a name and NO uuid: their table entry is
// [null, name].
//
// ⚠️ A DEFINITIVE NEGATIVE IS STAMPED. A grade with `hideScores`, or a game with
// no player block: both ANSWERS. Stored as `{ n: <reason>, at: <date> }` against
// the game id. Left unstamped they are due again on every run for ever and a pass
// never completes — which is what private profiles did to the career sweep.
//
// ⚠️ BUT NOT EVERY NEGATIVE IS PERMANENT. `hideScores` is a grade setting and
// never changes for a played game, so it is stamped for good. "No player block"
// is a scorer who has not entered the side yet — filling it in on the Monday after
// the game is the NORMAL case, so it expires after FGL_NO_DAYS for a season that
// is still live and never for a retired one. That is the rule enrich-games.js
// arrived at for `qNo`, and it is here for the same reason: a permanent stamp on a
// temporary absence loses the data for good.
//
// ⚠️ GZIP DOES NOT DELTA-COMPRESS. A rewritten .gz adds its whole size to git
// history every time, so the file is written only when its CONTENT changed,
// ignoring the run stamp. Without that guard a timestamp alone produces a commit
// on every run — measured on build-career-tops.js.
//
// Exit codes: 0 = finished. 75 = stopped on the time budget, more to do (the
// workflow re-dispatches on this). 2 = nothing to do. 1 = fatal.
//
// Env: FGL_APPLY, FGL_COMP, FGL_YEAR, FGL_BUDGET_MIN (300), FGL_CONC (6),
//      FGL_CHECKPOINT (200), FGL_PUSH_MIN (20), FGL_DELAY_MS (120),
//      FGL_MAX_GAMES (0 = no cap), FGL_NO_DAYS (1), FGL_COMMIT,
//      FGL_RATE (100) / FGL_WINDOW_MS (80000) — the token bucket.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');
const { gqlPost, sleep, logSummary, summary } = require('./lib/playhq');

const VERSION = 'fetch-game-lines v4 2026-09-11 token-bucket';
// Stamped on every game this extraction writes. Bump when the EXTRACTION changes
// in a way that makes an older record worth fetching again.
const LV = 1;

const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply') || process.env.FGL_APPLY === 'true';
const COMP = (process.env.FGL_COMP || '').trim();
const YEAR = (process.env.FGL_YEAR || '').trim();
const BUDGET_MIN = Math.max(5, Number(process.env.FGL_BUDGET_MIN || 300));
const CONC = Math.max(1, Math.min(12, Number(process.env.FGL_CONC || 6)));
const CHECKPOINT = Math.max(25, Number(process.env.FGL_CHECKPOINT || 200));
const PUSH_MIN = Math.max(0, Number(process.env.FGL_PUSH_MIN || 20));
const DELAY = Math.max(0, Number(process.env.FGL_DELAY_MS || 120));
const MAX_GAMES = Math.max(0, Number(process.env.FGL_MAX_GAMES || 0));
const COMMIT = APPLY && process.env.FGL_COMMIT !== 'false';
const RECOVER_MIN = 2, CEIL_RECOVER_MIN = 8;
// ⚠️ A TOKEN BUCKET, NOT JUST CONCURRENCY. v3 had adaptive concurrency and a
// 120 ms delay between batches and nothing capping the RATE: measured on the
// first real run, 156 calls in 0.6 min = 260 req/min, against a documented
// ~120-130 for this operation. It blocked sixteen times in a row, each costing
// 80 s, and stepping concurrency down does not fix it — the limit is a RATE over
// about a minute and six workers simply reach it faster.
//
// 100 per 80 s is 75/min, 40% under the lowest reading, and is the shape
// walk-registrations.js has sustained 5,715 calls a night on without one block.
// Concurrency now only hides latency; the bucket sets the pace.
const RATE = Math.max(1, Number(process.env.FGL_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.FGL_WINDOW_MS || 80000));
// How long "no player block" stands for a LIVE season before it is worth asking
// again. Retired seasons are never re-asked — nobody enters a 2022 team sheet.
const NO_DAYS = Math.max(0, Number(process.env.FGL_NO_DAYS || 1));
const PERMANENT = new Set(['hideScores']);

// At most RATE calls in any rolling WINDOW_MS, across every worker.
const callTimes = [];
async function pace() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] >= WINDOW_MS) callTimes.shift();
  if (callTimes.length >= RATE) {
    await sleep(WINDOW_MS - (now - callTimes[0]) + 5);
    return pace();
  }
  callTimes.push(Date.now());
}

const started = Date.now();
const overBudget = () => (Date.now() - started) / 60000 >= BUDGET_MIN;
const mins = () => ((Date.now() - started) / 60000).toFixed(1);
const log = (...a) => console.log(...a);

// ── Documents ────────────────────────────────────────────────────────────────
// EVERY field is from the captured gameView request. The union has five members
// and only three carry a profile; the other two are a name and nothing else.
const PLAYER_UNION = `player {
      ... on DiscoverParticipant { id profile { id firstName lastName } }
      ... on DiscoverParticipantFillInPlayer { id profile { id firstName lastName } }
      ... on DiscoverGamePermitFillInPlayer { id profile { id firstName lastName } }
      ... on DiscoverRegularFillInPlayer { id name }
      ... on DiscoverAnonymousParticipant { id name }
    }`;

const TEAM_FRAGMENT = `fragment T on DiscoverGameTeamStatistics {
  players {
    playerNumber
    ${PLAYER_UNION}
    statistics { count type { value } }
    periodStatistics { period { value } statistics { count type { value } } }
  }
  statistics { count type { value } }
  bestPlayers {
    ranking
    participant {
      ... on DiscoverParticipant { id profile { id firstName lastName } }
      ... on DiscoverAnonymousParticipant { name }
    }
  }
}`;

const GRADE_BLOCK = `round { grade { id name hideScores hasPeriodScores bestPlayers { max } } }`;

const Q_GAME = `query gameView($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id
    status { value }
    ${GRADE_BLOCK}
    statistics { home { ...T } away { ...T } }
    result {
      home { statistics { count type { value } } }
      away { statistics { count type { value } } }
    }
  }
}
${TEAM_FRAGMENT}`;

// ⚠️ THE CONFIG VARIANT IS SEPARATE AND IS SENT ONCE PER GRADE. It is the only
// document carrying `$gameStatisticsFilter: GameStatisticsFilter!`, whose enum
// values are unknown beyond the `"TOTAL"` the page sends. Keeping it out of the
// per-game document means a bad enum costs one call per grade rather than every
// game in the run, and the plain document keeps working if it is rejected.
const Q_GAME_CONFIG = `query gameView($gameId: ID!, $gameStatisticsFilter: GameStatisticsFilter!) {
  discoverGame(gameID: $gameId) {
    id
    round { grade {
      id
      gameStatisticsConfiguration {
        gameStatistics(filter: $gameStatisticsFilter) {
          type value pointValue applicableTo required max
        }
      }
    } }
  }
}`;

// ── Helpers ──────────────────────────────────────────────────────────────────
const statMap = (stats) => {
  const m = new Map();
  for (const s of stats || []) {
    const k = s && s.type && s.type.value;
    if (k) m.set(String(k), Number(s.count));
  }
  return m;
};
// ⚠️ NAMES ARE DISCOVERED, NOT ASSERTED. The spectator route calls a goal
// 6_POINT_SCORE while GOAL_COUNT is zero on every row; the profile route is the
// other way round. Summing an assumed name reported "goals 0-0" for games that
// had goals, twice. The first key actually PRESENT wins, and the run reports
// which it used.
const GOAL_KEYS = ['6_POINT_SCORE', 'TOTAL_GOALS', 'GOALS', 'GOAL_COUNT'];
const BEHIND_KEYS = ['1_POINT_SCORE', 'TOTAL_BEHINDS', 'BEHINDS'];
const pick = (m, keys) => { for (const k of keys) if (m.has(k)) return { key: k, v: m.get(k) }; return { key: null, v: null }; };

const yearOf = (c) => (String(c || '').match(/\b(\d{4})\b/) || [])[1] || '';
const linesPath = (sid) => path.join(store.SEASONS_DIR, `${sid}-lines.json.gz`);

function loadLines(sid) {
  const p = linesPath(sid);
  if (!fs.existsSync(p)) return { meta: { version: LV, seasonId: sid }, players: [], games: {} };
  try {
    const r = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    r.meta = r.meta || { version: LV, seasonId: sid };
    r.players = Array.isArray(r.players) ? r.players : [];
    r.games = r.games || {};
    return r;
  } catch (e) {
    throw new Error(`could not read ${path.relative(ROOT, p)}: ${e.message}`);
  }
}

// Content comparison ignoring the run stamp — see the gzip note in the header.
const canon = (f) => JSON.stringify({ players: f.players, games: f.games });

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}`);
  log(`Scope: ${COMP || 'all competitions'}${YEAR ? `, ${YEAR}` : ', every season'}`);
  log(`Budget ${BUDGET_MIN} min, concurrency ${CONC}, checkpoint ${CHECKPOINT}`);
  log(`Pace: ${RATE} calls / ${WINDOW_MS / 1000}s = ${(RATE / (WINDOW_MS / 60000)).toFixed(0)} req/min\n`);

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = core.manifest || [];
  const seasonOf = new Map();               // compName -> manifest entry
  for (const m of manifest) if (m.compName) seasonOf.set(m.compName, m);

  const scope = COMP ? [COMP] : null;
  const data = store.load(scope, { players: false });

  const eligible = (data.matches || []).filter(m =>
    !m.isBye && !m.isPartial && !m.scheduled && !m.live &&
    m.hScore !== null && m.hScore !== undefined &&
    (!YEAR || yearOf(m.compName) === YEAR));

  // ⚠️ "THE JOIN IS EXACT" IS LOAD-BEARING AND IS CHECKED, NOT ASSUMED. gameId is
  // stamped by engine v16 and backfilled for older records by enrich-games.js, so
  // some may have none. A game with no id cannot be asked about at all.
  const noId = eligible.filter(m => !m.gameId);
  const withId = eligible.filter(m => m.gameId);
  const byComp = new Map();
  for (const m of eligible) {
    const k = m.compName || '(none)';
    if (!byComp.has(k)) byComp.set(k, { total: 0, noId: 0 });
    const e = byComp.get(k); e.total++; if (!m.gameId) e.noId++;
  }
  log('gameId coverage of completed records, per competition:');
  for (const [c, e] of [...byComp].sort()) {
    log(`  ${String(c).padEnd(14)} ${String(e.total).padStart(6)} record(s), ${String(e.noId).padStart(5)} with NO gameId` +
      `  ${e.total ? ((e.total - e.noId) / e.total * 100).toFixed(1) : '—'}% joinable`);
  }
  if (!withId.length) { log('\nNo completed record carries a gameId — nothing to walk.'); process.exit(2); }

  // Group by season, then by grade: one grade's games share a config call.
  const bySeason = new Map();
  for (const m of withId) {
    const e = seasonOf.get(m.compName);
    if (!e || !e.seasonId) continue;
    if (!bySeason.has(e.seasonId)) bySeason.set(e.seasonId, { entry: e, games: [] });
    bySeason.get(e.seasonId).games.push(m);
  }

  // Already done, from each season's own lines file. The markers live THERE and
  // not on the match records, so this script never opens a season core file and
  // cannot revert another writer.
  const retired = new Set(manifest.filter(m => m.retired).map(m => m.seasonId));
  const today = new Date().toISOString().slice(0, 10);
  // Dates this script wrote itself. Parsed by parts — never new Date(string).
  const ageDays = (d) => {
    const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!x) return Infinity;
    return (Date.now() - Date.UTC(+x[1], +x[2] - 1, +x[3])) / 86400000;
  };
  const negativeStands = (g, sid) => {
    if (!g || !g.n) return false;
    if (PERMANENT.has(g.n)) return true;        // a grade setting, settled for good
    if (retired.has(sid)) return true;          // nobody edits a retired season
    return ageDays(g.at) < NO_DAYS;             // a scorer may still fill it in
  };

  const files = new Map();
  let todo = [];
  const perSeason = [];
  let negStanding = 0, negStale = 0;
  for (const [sid, s] of bySeason) {
    const f = APPLY || fs.existsSync(linesPath(sid)) ? loadLines(sid) : { meta: { version: LV, seasonId: sid }, players: [], games: {} };
    files.set(sid, { file: f, before: canon(f), entry: s.entry, index: new Map(f.players.map((p, i) => [String(p[0]), i])) });
    const mine = [];
    for (const m of s.games) {
      const g = f.games[m.gameId];
      if (g && g.v === LV && !g.n) continue;         // stored by this extraction
      if (negativeStands(g, sid)) { negStanding++; continue; }
      if (g && g.n) negStale++;                      // expired — ask again
      mine.push({ m, sid });
    }
    perSeason.push(mine);
  }
  // ⚠️ INTERLEAVE THE SEASONS. v2 pushed them season by season, so a run capped
  // at 200 games spent all 200 on the FIRST season and reported one row in a
  // table headed "per league per season". A cap must sample the population it
  // claims to describe, not the front of it. Full runs are unaffected — the same
  // games in a different order.
  for (let i = 0; perSeason.some(a => i < a.length); i++) {
    for (const a of perSeason) if (i < a.length) todo.push(a[i]);
  }
  if (MAX_GAMES) todo = todo.slice(0, MAX_GAMES);
  log(`\n${withId.length} joinable record(s); ${todo.length} to fetch.`);
  if (negStanding) log(`  ${negStanding} carry a standing negative (hideScores, or no player block within ${NO_DAYS} day(s)) — not re-asked.`);
  if (negStale) log(`  ${negStale} had "no player block" recorded ${NO_DAYS}+ day(s) ago in a live season — asked again.`);
  if (!todo.length) { log('Nothing to do.'); process.exit(2); }

  // ── Counters ───────────────────────────────────────────────────────────────
  let calls = 0, done = 0, stamped = 0, hidden = 0, noBlock = 0, failed = 0;
  let pending = 0, committed = 0, pushFailures = 0, lastPush = Date.now(), stopped = false;
  const statKeys = new Map(), periodKeys = new Map(), gradeSeen = new Map();
  const covByComp = new Map();      // compName -> {games, withLines, sides, exact, partial, empty, hidden}
  let rosterTotal = 0, rosterGames = 0, noUuid = 0, lineTotal = 0;
let votesOffered = 0, votesStored = 0;
  let periodPopulated = 0, periodEmpty = 0, periodNoRows = 0, cumulativeHint = 0, perQuarterHint = 0;
  let configTried = 0, configOk = 0;
  const configSamples = [];
  const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const cov = (c) => {
    if (!covByComp.has(c)) covByComp.set(c, { games: 0, withLines: 0, sides: 0, exact: 0, partial: 0, empty: 0, hidden: 0 });
    return covByComp.get(c);
  };

  const gitCommit = (label) => {
    if (!COMMIT) return;
    try {
      execFileSync('git', ['add', '-A', 'data/'], { stdio: 'pipe' });
      const staged = execFileSync('git', ['diff', '--staged', '--name-only'], { encoding: 'utf8' }).trim();
      if (!staged) return;
      execFileSync('git', ['commit', '-m', `Game lines: ${label}`], { stdio: 'pipe' });
      // ⚠️ NAME THE BRANCH. A bare pull --rebase fails on a detached HEAD, which
      // is what actions/checkout leaves without a `ref:`.
      const branch = process.env.GITHUB_REF_NAME || 'main';
      execFileSync('git', ['pull', '--rebase', 'origin', branch], { stdio: 'pipe' });
      execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'pipe' });
      pushFailures = 0;
      log(`    …pushed (${label})`);
    } catch (e) {
      pushFailures++;
      const msg = (e.stderr || e.stdout || e.message || '').toString().split('\n')[0];
      console.error(`    ⚠️ push failed (${label}): ${msg.slice(0, 140)}`);
      // A push failing every time is not transient, and "it is on disk" is false
      // comfort — the disk goes away with the runner.
      if (pushFailures >= 3) throw new Error('push is not working; stopping rather than discarding hours of work');
    }
  };

  // Writes every season file whose content changed. ⚠️ Content, not timestamp:
  // a .gz rewritten for a stamp alone is pure git history.
  const flush = globalThis.__fglFlush = (label) => {
    pending = 0;
    if (!APPLY) return 0;
    let n = 0;
    for (const [sid, s] of files) {
      const now = canon(s.file);
      if (now === s.before) continue;
      s.file.meta = { ...s.file.meta, version: LV, seasonId: sid, builtAt: new Date().toISOString(),
        games: Object.keys(s.file.games).length, people: s.file.players.length };
      const out = JSON.stringify(s.file);
      const gz = zlib.gzipSync(Buffer.from(out, 'utf8'), { level: 9 });
      fs.mkdirSync(store.SEASONS_DIR, { recursive: true });
      fs.writeFileSync(linesPath(sid), gz);
      s.before = now;
      n++;
      log(`    wrote ${path.relative(ROOT, linesPath(sid))} (${(gz.length / 1024).toFixed(0)} KB gz, ${(out.length / 1024).toFixed(0)} KB plain)`);
    }
    if (!n) return 0;
    committed += n;
    const due = label === 'final' || label === 'after a fatal error' || PUSH_MIN === 0 ||
      (Date.now() - lastPush) / 60000 >= PUSH_MIN;
    if (due) { lastPush = Date.now(); gitCommit(label); }
    return n;
  };

  // Add a person to the season's dictionary and return the index. Keyed on the
  // uuid; an id-less player is keyed on a name so repeated fill-ins share a row.
  const indexOf = (s, uuid, name) => {
    const key = uuid ? String(uuid) : `~${name || ''}`;
    if (s.index.has(key)) return s.index.get(key);
    const i = s.file.players.length;
    s.file.players.push([uuid || null, name || null]);
    s.index.set(key, i);
    return i;
  };

  // ── One game ───────────────────────────────────────────────────────────────
  const handle = async ({ m, sid }) => {
    const s = files.get(sid);
    const c = cov(m.compName);
    let json;
    try { await pace(); json = await gqlPost(Q_GAME, { gameId: m.gameId }, 'gameView'); calls++; }
    catch (e) { failed++; return; }                     // transport: left due, retried next run
    if (json.errors && json.errors.length) {
      // ⚠️ A REJECTED DOCUMENT IS NOT A GAME WITHOUT DATA. It is reported and the
      // game is left due, because stamping it would make a probe defect permanent.
      failed++;
      if (failed <= 3) console.error(`    ⚠️ ${m.gameId}: ${String(json.errors[0].message).slice(0, 200)}`);
      return;
    }
    const g = json.data && json.data.discoverGame;
    c.games++;
    if (!g) { s.file.games[m.gameId] = { n: 'nogame', at: today, v: LV }; stamped++; noBlock++; return; }

    const grade = (g.round && g.round.grade) || {};
    if (grade.id && !gradeSeen.has(grade.id)) {
      gradeSeen.set(grade.id, { name: grade.name, hideScores: grade.hideScores === true,
        bestMax: grade.bestPlayers ? grade.bestPlayers.max : null, comp: m.compName });
    }
    // A grade that hides scores is an ANSWER. Publishing a box score for it would
    // be worse than any gap.
    if (grade.hideScores === true) {
      s.file.games[m.gameId] = { n: 'hideScores', at: today, v: LV }; stamped++; hidden++; c.hidden++; return;
    }

    const sides = { h: (g.statistics || {}).home, a: (g.statistics || {}).away };
    const res = { h: ((g.result || {}).home || {}), a: ((g.result || {}).away || {}) };
    const out = { v: LV };
    let any = false;

    for (const key of ['h', 'a']) {
      const block = sides[key] || {};
      const players = block.players || [];
      if (!players.length) continue;
      rosterTotal += players.length; any = true;

      // best-player votes, joined back onto the line by profile id
      const votes = new Map();
      votesOffered += (block.bestPlayers || []).length;
      for (const b of (block.bestPlayers || [])) {
        const pid = b && b.participant && b.participant.profile && b.participant.profile.id;
        if (pid) votes.set(String(pid), Number(b.ranking) || 1);
      }

      const rows = [];
      for (const p of players) {
        const who = p.player || {};
        const uuid = (who.profile && who.profile.id) || null;
        const name = who.profile
          ? `${who.profile.firstName || ''} ${who.profile.lastName || ''}`.trim()
          : (who.name || null);
        if (!uuid) noUuid++;
        const sm = statMap(p.statistics);
        for (const k of sm.keys()) bump(statKeys, k);
        const gl = pick(sm, GOAL_KEYS), bh = pick(sm, BEHIND_KEYS);
        const vote = uuid ? (votes.get(String(uuid)) || 0) : 0;
        if (vote) votesStored++;
        rows.push([indexOf(s, uuid, name), gl.v || 0, bh.v || 0, vote]);
        lineTotal++;

        if (!(p.periodStatistics || []).length) periodNoRows++;
        for (const ps of (p.periodStatistics || [])) {
          const pm = statMap(ps.statistics);
          if (pm.size) { periodPopulated++; for (const k of pm.keys()) bump(periodKeys, k); }
          else periodEmpty++;
        }
        // Cumulative or per-quarter? A per-quarter series can fall; a cumulative
        // one never does. Stored hQ/aQ are per-quarter while the site shows
        // cumulative, so this is the first thing to check before trusting it.
        const series = (p.periodStatistics || []).map(ps => pick(statMap(ps.statistics), GOAL_KEYS).v).filter(v => v !== null);
        if (series.length > 1) {
          if (series.some((v, i) => i && v < series[i - 1])) perQuarterHint++;
          else if (series.some((v, i) => i && v > series[i - 1])) cumulativeHint++;
        }
      }
      out[key] = rows;

      // Attribution against the team's own totals from the SAME response.
      const tm = statMap(res[key].statistics);
      const tg = pick(tm, GOAL_KEYS);
      const pg = rows.reduce((n, r) => n + r[1], 0);
      c.sides++;
      if (tg.key === null) { /* no reference to compare against */ }
      else if (pg === 0 && tg.v > 0) c.empty++;
      else if (pg === tg.v) c.exact++;
      else c.partial++;
    }

    if (!any) { s.file.games[m.gameId] = { n: 'noplayers', at: today, v: LV }; stamped++; noBlock++; return; }
    rosterGames++;
    c.withLines++;
    s.file.games[m.gameId] = out;
    done++;
    pending++;
  };

  // One config call per grade, on the first game of that grade.
  const gradeConfigDone = new Set();
  const fetchConfig = async ({ m }) => {
    const gid = m.gradeId;
    if (!gid || gradeConfigDone.has(gid) || configTried >= 8) return;
    gradeConfigDone.add(gid); configTried++;
    let json;
    try { await pace(); json = await gqlPost(Q_GAME_CONFIG, { gameId: m.gameId, gameStatisticsFilter: { classification: 'TOTAL' } }, 'gameView'); calls++; }
    catch (e) { return; }
    if (json.errors && json.errors.length) {
      if (configSamples.length < 2) configSamples.push(`REJECTED — ${String(json.errors[0].message).slice(0, 200)}`);
      return;
    }
    const cfg = (((json.data || {}).discoverGame || {}).round || {}).grade;
    const list = ((cfg || {}).gameStatisticsConfiguration || {}).gameStatistics || [];
    configOk++;
    if (configSamples.length < 2) {
      configSamples.push(`${m.compName} ${m.age || ''}: ` + list.map(x => `${x.value}(${x.pointValue})`).join(' '));
    }
  };

  // ── Walk, with the adaptive concurrency enrich-games measured ──────────────
  // A block costs 80 s whatever the concurrency, because every in-flight request
  // waits the window out in parallel — so back off by one, not by halving, and let
  // the ceiling recover.
  let conc = CONC, ceiling = CONC, lastBlockAt = 0, lastCeilingLift = Date.now();
  for (let i = 0; i < todo.length; i += conc) {
    if (overBudget()) { stopped = true; break; }
    const batch = todo.slice(i, i + conc);
    await fetchConfig(batch[0]);
    const before = summary().blocked;
    await Promise.all(batch.map(handle));
    const blockedNow = summary().blocked - before;
    if (blockedNow > 0) {
      const was = conc;
      if (conc > 1) conc--;
      ceiling = Math.max(2, Math.min(ceiling, was));
      lastBlockAt = Date.now(); lastCeilingLift = Date.now();
      if (conc !== was) log(`    ↓ concurrency ${was} → ${conc} (rate limited, ceiling ${ceiling})`);
    } else {
      const clear = (Date.now() - lastBlockAt) / 60000;
      if (conc < ceiling && clear >= RECOVER_MIN) { conc++; lastBlockAt = Date.now(); log(`    ↑ concurrency → ${conc}`); }
      else if (conc >= ceiling && ceiling < CONC && (Date.now() - lastCeilingLift) / 60000 >= CEIL_RECOVER_MIN) {
        ceiling++; lastCeilingLift = Date.now(); log(`    ⇧ ceiling → ${ceiling}`);
      }
    }
    if (pending >= CHECKPOINT) flush(`${i + batch.length}/${todo.length}`);
    if (i % (conc * 25) === 0) log(`  ${i + batch.length}/${todo.length} — ${done} with lines, ${stamped} stamped, ${mins()} min`);
    if (DELAY) await sleep(DELAY);
  }
  flush('final');

  // ── Report ─────────────────────────────────────────────────────────────────
  log('\n═══ WHAT THIS RUN MEASURED ═══');
  log(`calls ${calls}; games with lines ${done}; stamped negatives ${stamped} ` +
    `(${hidden} hideScores, ${noBlock} no player block); failures left due ${failed}`);

  log('\ncoverage — PER LEAGUE PER SEASON (⚠️ per-game lines have a per-LEAGUE adoption');
  log('date, so a single average blends two different worlds):');
  for (const [c, e] of [...covByComp].sort()) {
    log(`  ${String(c).padEnd(14)} ${String(e.withLines).padStart(5)} of ${String(e.games).padStart(5)} game(s) have lines` +
      `  ${e.games ? (e.withLines / e.games * 100).toFixed(0) + '%' : '—'}` +
      `   sides: ${e.exact} exact, ${e.partial} partial, ${e.empty} empty; ${e.hidden} hideScores`);
  }

  log('\nstatistic keys actually present on a player line:');
  for (const [k, n] of [...statKeys].sort((a, b) => b[1] - a[1])) log(`  ${k.padEnd(22)} ${n}`);
  log(`  goal key used: ${GOAL_KEYS.find(k => statKeys.has(k)) || '(none found)'}` +
    `; behind key used: ${BEHIND_KEYS.find(k => statKeys.has(k)) || '(none found)'}`);

  log(`\nperiodStatistics: ${periodPopulated} populated row(s), ${periodEmpty} empty, ` +
    `${periodNoRows} player(s) with NO period rows at all`);
  if (!periodPopulated && !periodEmpty && periodNoRows) {
    log('  ⚠️ The array is EMPTY on every player — not a skeleton carrying nothing, but');
    log('     no rows at all. There are no per-quarter player figures on this route.');
    log('     That is a different answer from the spectator route, which returns four');
    log('     QUARTERS rows with empty statistics, and both mean the same thing here.');
  } else if (periodPopulated) {
    log('  keys: ' + [...periodKeys.keys()].join(', '));
    log(`  shape: ${perQuarterHint} player series FELL between periods (per-quarter), ` +
      `${cumulativeHint} only rose (cumulative or single-scorer)`);
    log('  ⚠️ A rising series alone proves nothing — a player who kicks one a quarter');
    log('     rises either way. A FALLING series is the only proof of per-quarter.');
  } else {
    log('  ⚠️ Structure present, nothing in it — the same empty QUARTERS skeleton the');
    log('     spectator route returns. Accepted is not populated.');
  }

  log(`\nrosters: ${rosterGames} game(s), ${rosterTotal} player row(s)` +
    (rosterGames ? `, mean ${(rosterTotal / rosterGames).toFixed(1)} per game` : ''));
  log(`best-player votes: ${votesOffered} offered, ${votesStored} joined onto a line` +
    (votesOffered && votesStored < votesOffered
      ? `  ⚠️ ${votesOffered - votesStored} did not join — an anonymous best player has a name and no profile id`
      : ''));
  log(`lines with NO uuid (fill-in or anonymous): ${noUuid} of ${lineTotal}` +
    (lineTotal ? ` (${(noUuid / lineTotal * 100).toFixed(1)}%)` : ''));
  log(`records with no gameId: ${noId.length} of ${eligible.length}`);

  log(`\ngrade settings seen (${gradeSeen.size} grade(s)):`);
  const hs = [...gradeSeen.values()].filter(x => x.hideScores).length;
  const nb = [...gradeSeen.values()].filter(x => !x.bestMax).length;
  log(`  ${hs} with hideScores — a configured silence, not missing data`);
  log(`  ${nb} with bestPlayers.max of 0 or null — explains an absent vote column`);

  log(`\ngameStatisticsConfiguration: ${configOk} of ${configTried} grade call(s) answered`);
  for (const l of configSamples) log('  ' + l);
  const cfgNames = new Set(configSamples.join(' ').match(/[A-Z_]{4,}/g) || []);
  const lineNames = new Set(statKeys.keys());
  const onlyCfg = [...cfgNames].filter(x => !lineNames.has(x));
  if (configOk && onlyCfg.length) {
    log(`  ⚠️ THE CONFIG NAMES ARE NOT THE LINE NAMES. Present in the configuration and`);
    log(`     never on a player line: ${onlyCfg.join(', ')}. So the configuration describes`);
    log('     the grade\'s scoring events, not the keys a stored line uses. Read the line.');
  }
  if (!configOk && configTried) {
    log('  ⚠️ classification "TOTAL" may not be the right enum here. It is what the');
    log('     page sends. Probe the enum separately — a wrong VALUE returns a readable');
    log('     error naming the valid ones, unlike a wrong FIELD.');
  }

  const rate = calls / Math.max(0.01, (Date.now() - started) / 60000);
  log(`\nelapsed ${mins()} min; ACHIEVED ${rate.toFixed(0)} req/min over ${calls} call(s); ` +
    `concurrency ended at ${conc} (ceiling ${ceiling}); blocks ${summary().blocked}`);
  if (summary().blocked) {
    log('  ⚠️ Blocks cost 80 s each and lib/playhq.js absorbs them, so they never throw.');
    log('     If the achieved rate is near the cap, lower FGL_RATE — stepping concurrency');
    log('     down does not help, because the limit is a RATE and not a concurrency.');
  }
  if (!APPLY) log('\nDRY RUN — nothing was written. Re-dispatch with apply=true to store.');
  if (typeof logSummary === 'function') logSummary('fetch-game-lines');

  if (stopped) {
    log(`\n⏸  Stopped on the ${BUDGET_MIN} min budget. Everything so far is committed;`);
    log('   the workflow starts a fresh run.');
    return 75;
  }
  log('\n✅ Complete for this scope.');
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error('Fatal:', e && e.stack ? e.stack : e);
    try { if (typeof globalThis.__fglFlush === 'function') globalThis.__fglFlush('after a fatal error'); }
    catch (e2) { console.error('Salvage failed:', e2.message); }
    process.exit(1);
  });
