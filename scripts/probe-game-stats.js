#!/usr/bin/env node
// scripts/probe-game-stats.js
//
// READ-ONLY. Writes no file, commits nothing, touches no season file.
//
// v3 (2026-09-11) — THE ROUTE IS FOUND AND THE QUESTION HAS CHANGED.
//
// v1 and v2 guessed field names on api.playhq.com. They were looking on the
// wrong host. Captured from the game-centre page's own network tab on
// 2026-09-11, the box score comes from the SPECTATOR endpoint, from the
// operation lib/playhq.js already sends there:
//
//   spectator.playhq.com   query game($id: ID!)
//     game(id).statistics.home.players[] { id profileID name playerNumber
//                                          statistics { type { value } count }
//                                          periodStatistics[] }
//
// One call per game, no session cookie on the afl tenant, every player on BOTH
// sides, profileID joining straight to our own player uuids, and per-PERIOD
// statistics per player underneath it.
//
// ⚠️ THIS IS THE QUARTER-SCORES LESSON REPEATING. Four probes once guessed field
// names for something the PlayHQ page was rendering the whole time, and the
// question was settled in one step by reading the page's own request. It
// happened again here: v1 and v2 spent five rejected trials on api.playhq.com
// while the data sat on a host this repo has called since August.
//
// WHAT IS STILL UNKNOWN, AND IS THE WHOLE POINT OF THIS RUN
//
// COVERAGE. The spectator endpoint only knows ELECTRONICALLY SCORED games:
// anything else answers "game could not be found or was not electronically
// scored", which is an ANSWER and not a failure. MEASURED 2026-08-20 on live
// games: 44 of 46 were not e-scored. If that holds for finished junior games
// then a box score exists for almost nothing and P1 is not worth building. If it
// does not hold, P1 is one call per game.
//
// ⚠️ 44 OF 46 WAS MEASURED ON IN-PROGRESS GAMES IN ONE LEAGUE ON ONE DAY, and
// the game captured on 2026-09-11 is a FINAL senior game that answered in full.
// Neither figure describes the cohort. This run samples across every tracked
// competition and every age group it can reach, and reports coverage broken down
// by both — a senior-only route would be useless to a junior dashboard, and a
// per-league adoption pattern is exactly what the profile route's per-game lines
// already showed.
//
// SECOND: what a player line carries. The page shows a PP column beside G. PP is
// almost certainly player points — a registration rating, constant across a
// player's games, not something that happened in the match — and it is NOT a
// named field in the captured query, so it must arrive as a statistics type
// value. Three values are documented to exist (APPEARANCE, GOAL_COUNT,
// BEST_PLAYER, measured across 954 profile game lines). This counts every
// distinct value the spectator route returns rather than assuming those three.
//
// TWO CAPPED TRIALS ON THE MAIN API, and no more:
//   M1  does `game(id:)` exist on api.playhq.com too? If it does, the choice of
//       host is ours; if not, this feature lives on an endpoint whose rate
//       limits have never been measured, and that is a design constraint.
//   M2  ⚠️ `result.<side>.periods` is recorded in the reference as "a real field
//       that is always empty", and three probes read that emptiness as PlayHQ
//       not exposing quarter data. The captured document calls it as
//       `periods(scope: $scope)`. AN ARGUMENT WE NEVER PASSED explains an empty
//       field far better than the field being decorative. One call settles it.
//
// Trials are spaced and capped for the reason they always are: a burst of
// rejections on one run is what refused the next run its session.
//
// Env: PROBE_GRADES_PER_COMP (4), PROBE_GAMES_PER_GRADE (3),
//      PROBE_TRIAL_MAX_REJECT (3), PROBE_TRIAL_GAP_MS (20000),
//      PROBE_RATE (100), PROBE_WINDOW_MS (80000), PROBE_MAX_ROUNDS (3),
//      PROBE_SKIP_TRIALS (false).
//
// Exit codes: 0 = the probe ran, whatever it found. 1 = it could not start — no
// session, no manifest, no grades, no sampled game — or the spectator document
// was rejected wholesale, which would otherwise report 0% coverage for a reason
// that has nothing to do with coverage.

'use strict';

const fs = require('fs');
const path = require('path');
const playhq = require('./lib/playhq');
const { gqlPost, specPost, sleep, refreshSession } = playhq;

const VERSION = 'probe-game-stats v3 2026-09-11 spectator-box-score-coverage';

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');

const RATE = Math.max(1, Number(process.env.PROBE_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.PROBE_WINDOW_MS || 80000));
const TRIAL_GAP_MS = Math.max(0, Number(process.env.PROBE_TRIAL_GAP_MS || 20000));
const TRIAL_MAX_REJECT = Math.max(1, Number(process.env.PROBE_TRIAL_MAX_REJECT || 3));
const GRADES_PER_COMP = Math.max(1, Number(process.env.PROBE_GRADES_PER_COMP || 4));
const GAMES_PER_GRADE = Math.max(1, Number(process.env.PROBE_GAMES_PER_GRADE || 3));
const MAX_ROUNDS = Math.max(1, Number(process.env.PROBE_MAX_ROUNDS || 3));
const SKIP_TRIALS = String(process.env.PROBE_SKIP_TRIALS || 'false') === 'true';

const log = (...a) => console.log(...a);
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// ── Documents ────────────────────────────────────────────────────────────────
// Q_ROUND is copied verbatim from enrich-games.js. Q_GRADE_ROUNDS is a minimal
// reconstruction of lib/results-engine.js's Q_GRADE_ROUNDS — every field in it
// is one enrich-games.js reads off a live response, so the names are proven by
// use, and it ran clean on 2026-09-11.

const Q_GRADE_ROUNDS = `query discoverGrade($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    rounds { id number isFinalsRound abbreviatedName }
  }
}`;

const Q_ROUND = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      result {
        home { statistics { count type { value } } }
        away { statistics { count type { value } } }
      }
    }
  }
}`;

// ⚠️ EVERY FIELD BELOW IS COPIED FROM THE CAPTURED DOCUMENT. Nothing here is a
// guess, which is the only reason it is safe to ask for this much at once: one
// unknown field would fail the whole document and report as zero coverage. It is
// a strict SUBSET of what the page asks for — the cricket fragments, the clock,
// statisticsV2 and the per-player side/status/displayOrder are left out because
// nothing here needs them.
const Q_SPEC_BOX = `query game($id: ID!, $scope: PeriodScore) {
  game(id: $id) {
    id
    status
    statistics {
      home {
        players {
          id profileID name playerNumber
          statistics { type { value } count }
          periodStatistics {
            period { value }
            statistics { type { value } count }
          }
        }
      }
      away {
        players {
          id profileID name playerNumber
          statistics { type { value } count }
          periodStatistics {
            period { value }
            statistics { type { value } count }
          }
        }
      }
    }
    result {
      home { statistics { type { value } count } periods(scope: $scope) { period { value } statistics { type { value } count } } }
      away { statistics { type { value } count } periods(scope: $scope) { period { value } statistics { type { value } count } } }
    }
  }
}`;

// ── Token bucket — the shape walk-registrations.js has never tripped ─────────
const callTimes = [];
async function pace() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] >= WINDOW_MS) callTimes.shift();
  if (callTimes.length >= RATE) {
    const wait = WINDOW_MS - (now - callTimes[0]) + 5;
    await sleep(wait);
    return pace();
  }
  callTimes.push(Date.now());
}

let apiCalls = 0, specCalls = 0;

// ⚠️ THE OPERATION NAME MUST MATCH THE DOCUMENT, or the rejection reads exactly
// like the field being unavailable. Derived from the text so the two cannot drift.
const opName = (q) => (/^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(q || '') || [])[1] || null;

async function ask(query, vars) {
  await pace();
  apiCalls++;
  try {
    const json = await gqlPost(query, vars, opName(query));
    const errs = (json && json.errors) || [];
    return errs.length
      ? { ok: false, errors: errs.map(e => String((e && e.message) || e)), json }
      : { ok: true, errors: [], json };
  } catch (e) {
    return { ok: false, threw: true, errors: [String((e && e.message) || e)], json: null };
  }
}

// ⚠️ "NOT ELECTRONICALLY SCORED" IS AN ANSWER, NOT AN ERROR, and telling it apart
// from a VALIDATION error is the whole integrity of this run: one says the game
// has no box score, the other says the probe is broken and every coverage figure
// under it is meaningless.
const NOT_SCORED = /not electronically scored|could not be found/i;

async function askSpec(gameId) {
  await pace();
  specCalls++;
  try {
    const json = await specPost(Q_SPEC_BOX, { id: gameId, scope: 'BY_PERIOD' }, 'game');
    const errs = ((json && json.errors) || []).map(e => String((e && e.message) || e));
    if (errs.length) {
      const benign = errs.every(m => NOT_SCORED.test(m));
      return { notScored: benign, invalid: !benign, errors: errs, game: null };
    }
    return { game: (json && json.data && json.data.game) || null, errors: [] };
  } catch (e) {
    return { threw: true, errors: [String((e && e.message) || e)], game: null };
  }
}

const statOf = (stats, type) => {
  const s = (stats || []).find(x => x && x.type && x.type.value === type);
  return s && s.count !== null && s.count !== undefined ? s.count : null;
};

// ── Sampling ─────────────────────────────────────────────────────────────────

// Newest non-retired season per COMPETITION. The year comes from compName — a
// season's startDate precedes the year in its name, so a start date is never
// read as one.
function newestPerComp(manifest) {
  const yearOf = (c) => Number((String(c || '').match(/\b(\d{4})\b/) || [])[1] || 0);
  const best = new Map();
  for (const m of manifest) {
    if (!m || !m.seasonId || m.retired) continue;
    const key = String(m.compName || '').replace(/\s*\d{4}\s*$/, '') || String(m.compName);
    const prev = best.get(key);
    if (!prev || yearOf(m.compName) > yearOf(prev.compName)) best.set(key, m);
  }
  return [...best.values()].sort((a, b) => String(a.compName).localeCompare(String(b.compName)));
}

// ⚠️ SPREAD THE SAMPLE ACROSS THE GRADE LIST, never take the first N. The first
// grades in a season are one age group, and a coverage figure drawn from one age
// group would be an answer produced by the selection — which is exactly the shape
// of the per-league adoption pattern the profile route already showed.
function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * list.length / n)]);
  return out;
}

async function sampleGames(seasons, grades) {
  const sample = [];
  for (const season of seasons) {
    const mine = grades.filter(g => g && g.id && g.seasonID === season.seasonId);
    if (!mine.length) { log(`  ${season.compName}: no grades in grades.json — skipped`); continue; }
    const picked = spread(mine.slice().sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''))), GRADES_PER_COMP);
    log(`  ${season.compName} (${season.seasonId}): ${mine.length} grade(s), sampling ${picked.length}`);

    for (const grade of picked) {
      const r = await ask(Q_GRADE_ROUNDS, { gradeID: grade.id });
      if (!r.ok) { log(`    ${grade.name}: discoverGrade failed — ${r.errors[0]}`); continue; }
      const rounds = ((r.json.data || {}).discoverGrade || {}).rounds || [];
      let taken = 0;
      for (const round of rounds.slice().reverse().slice(0, MAX_ROUNDS)) {
        if (taken >= GAMES_PER_GRADE || !round || !round.id) break;
        const rr = await ask(Q_ROUND, { roundID: round.id });
        if (!rr.ok) continue;
        const games = ((rr.json.data || {}).discoverFixtureByRound || {}).games || [];
        for (const g of games) {
          if (taken >= GAMES_PER_GRADE) break;
          const hs = statOf(g.result && g.result.home && g.result.home.statistics, 'TOTAL_SCORE');
          const as = statOf(g.result && g.result.away && g.result.away.statistics, 'TOTAL_SCORE');
          // discoverFixtureByRound serves an EMPTY result block for any game not
          // marked FINAL, so two scores means a completed game. An unplayed
          // fixture would answer "no box score" for a reason that has nothing to
          // do with whether the route works.
          if (!g.id || hs === null || as === null) continue;
          sample.push({
            gameId: g.id, comp: season.compName, seasonId: season.seasonId,
            grade: grade.name, age: grade.ageName || '(no ageName)',
            round: round.number, finals: !!round.isFinalsRound,
            home: (g.home && g.home.name) || '?', away: (g.away && g.away.name) || '?',
            hScore: hs, aScore: as,
          });
          taken++;
        }
      }
      log(`    ${String(grade.name).slice(0, 40).padEnd(40)} ${taken} completed game(s) sampled`);
    }
  }
  return sample;
}

// ── Main-API trials, capped ──────────────────────────────────────────────────
function trials(sampleGame) {
  return [
    {
      id: 'M1  api.playhq.com  Query.game(id:)',
      why: 'The box score is served by the SPECTATOR host. If the same operation also ' +
           'exists on the main API then the choice of host is ours; if it does not, this ' +
           'feature lives entirely on an endpoint whose rate limits have never been ' +
           'measured, which is a design constraint rather than a detail.',
      query: `query game($id: ID!) { game(id: $id) { id status } }`,
      vars: { id: sampleGame.gameId },
      check: (d) => (d && d.game)
        ? { populated: true, note: `status ${d.game.status}` }
        : { populated: false, note: 'accepted but game came back null' },
    },
    {
      id: 'M2  discoverGame  result.periods(scope: BY_PERIOD)',
      why: 'THE REFERENCE MAY BE WRONG ABOUT THIS ONE. result.<side>.periods is recorded ' +
           'as "a real field that is always empty", and three probes read that emptiness ' +
           'as PlayHQ not exposing quarter data. The captured document calls it as ' +
           'periods(scope: $scope). An argument we never passed explains an empty field ' +
           'far better than the field being decorative.',
      query: `query DiscoverGame($gameID: ID!, $scope: PeriodScore) {
  discoverGame(gameID: $gameID) {
    id
    result {
      home { periods(scope: $scope) { period { value } statistics { type { value } count } } }
    }
  }
}`,
      vars: { gameID: sampleGame.gameId, scope: 'BY_PERIOD' },
      check: (d) => {
        const p = d && d.discoverGame && d.discoverGame.result &&
          d.discoverGame.result.home && d.discoverGame.result.home.periods;
        if (!Array.isArray(p)) return { populated: false, note: 'periods is not an array — accepted but absent' };
        if (!p.length) return { populated: false, note: 'periods is an EMPTY ARRAY even with the scope argument — the reference stands and the argument was not the explanation' };
        return { populated: true, note: `${p.length} period row(s) — THE REFERENCE IS WRONG: the field needed the scope argument` };
      },
    },
  ];
}

const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const tallyLine = (m, indent) => [...m.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${indent}${String(k).padEnd(30)} ${n}`).join('\n');

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== ${VERSION} ===`);
  log(`sample: ${GRADES_PER_COMP} grade(s) per competition, ${GAMES_PER_GRADE} game(s) per grade`);
  log(`pace: ${RATE} calls / ${WINDOW_MS / 1000}s across BOTH hosts`);
  log('READ-ONLY: this run writes no file and commits nothing.\n');

  const gotSession = await refreshSession();
  if (!gotSession) {
    console.error('FATAL: no PlayHQ session. The SAMPLE is drawn from the main API, so');
    console.error('without one there are no game ids to ask the spectator endpoint about.');
    console.error('Nothing was written.');
    process.exit(1);
  }

  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')).manifest || []; }
  catch (e) {
    console.error(`FATAL: could not read data/core.json (${e.message}). Nothing was written.`);
    process.exit(1);
  }
  let grades = [];
  try {
    grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));
    if (!Array.isArray(grades)) throw new Error('grades.json is not an array');
  } catch (e) {
    console.error(`FATAL: could not read data/grades.json (${e.message}). Nothing was written.`);
    process.exit(1);
  }

  const seasons = newestPerComp(manifest);
  log(`manifest: ${manifest.length} entr(ies) -> ${seasons.length} competition(s), newest non-retired season each`);

  log('\n── sampling completed games ──');
  const sample = await sampleGames(seasons, grades);
  if (!sample.length) {
    console.error('\nFATAL: no completed game could be sampled from any competition.');
    console.error('Coverage cannot be measured against an empty sample, and printing 0%');
    console.error('here would be a figure produced by the sampling. Nothing was written.');
    process.exit(1);
  }
  log(`\nsampled ${sample.length} completed game(s) across ` +
    `${new Set(sample.map(s => s.comp)).size} competition(s) and ` +
    `${new Set(sample.map(s => s.age)).size} age group(s)`);

  // ── The measurement ────────────────────────────────────────────────────────
  log('\n═══ SPECTATOR BOX-SCORE COVERAGE ═══');
  log('One call per game to spectator.playhq.com. "not electronically scored" is an');
  log('ANSWER, not a failure — it is the figure this whole run exists to establish.\n');

  const byComp = new Map(), byAge = new Map();
  const statValues = new Map(), periodValues = new Map();
  let scored = 0, notScored = 0, broken = 0, withPeriods = 0, resultPeriods = 0;
  let playersTotal = 0, plausibleN = 0, checkedN = 0;
  let firstPlayer = null, firstGame = null;

  for (const s of sample) {
    const r = await askSpec(s.gameId);

    // ⚠️ A VALIDATION ERROR IS NOT A COVERAGE FIGURE. If the document itself is
    // rejected, every game answers "no" for a reason that has nothing to do with
    // e-scoring, and the run stops rather than reporting 0%.
    if (r.invalid || r.threw) {
      broken++;
      log(`  ${s.gameId} ${s.comp} ${s.grade}: ⚠️ NOT A COVERAGE ANSWER — ${r.errors[0]}`);
      if (broken >= 3) {
        console.error('\nFATAL: three games answered with something that is not "not electronically');
        console.error('scored". That is the document being rejected, not the games lacking data.');
        console.error('Every coverage figure below would be measuring this probe, so the run stops.');
        playhq.logSummary('probe-game-stats');
        process.exit(1);
      }
      continue;
    }

    if (!byComp.has(s.comp)) byComp.set(s.comp, { yes: 0, no: 0 });
    if (!byAge.has(s.age)) byAge.set(s.age, { yes: 0, no: 0 });

    const g = r.game;
    const hp = (g && g.statistics && g.statistics.home && g.statistics.home.players) || [];
    const ap = (g && g.statistics && g.statistics.away && g.statistics.away.players) || [];

    if (!hp.length && !ap.length) {
      notScored++;
      byComp.get(s.comp).no++; byAge.get(s.age).no++;
      log(`  ${s.gameId} ${String(s.comp).padEnd(11)} ${String(s.age).padEnd(14)} ` +
        `${r.notScored ? 'not electronically scored' : 'answered, but NO players on either side'}`);
      continue;
    }

    scored++;
    byComp.get(s.comp).yes++; byAge.get(s.age).yes++;
    playersTotal += hp.length + ap.length;
    if (!firstGame) { firstGame = { s, g }; firstPlayer = hp[0] || ap[0]; }

    for (const p of hp.concat(ap)) {
      for (const st of (p.statistics || [])) bump(statValues, (st.type && st.type.value) || '(no type.value)');
      for (const ps of (p.periodStatistics || [])) bump(periodValues, (ps.period && ps.period.value) || '(no period.value)');
    }
    if (hp.concat(ap).some(p => (p.periodStatistics || []).length)) withPeriods++;
    if (((g.result && g.result.home && g.result.home.periods) || []).length) resultPeriods++;

    // ⚠️ CHECK AGAINST A NUMBER WE ALREADY HOLD. A players array that parses is
    // not a players array that is right. The fixture gives TOTAL_SCORE only, so
    // goals cannot be derived from it exactly — 6 goals and 1 behind and 5 goals
    // and 7 behinds both make 37 — but goals × 6 can never EXCEED the score, and
    // that is a real check rather than a restatement.
    const goalsOf = (arr) => arr.reduce((n, p) => n + (statOf(p.statistics, 'GOAL_COUNT') || 0), 0);
    const hg = goalsOf(hp), ag = goalsOf(ap);
    const plausible = hg * 6 <= s.hScore && ag * 6 <= s.aScore;
    checkedN++;
    if (plausible) plausibleN++;
    log(`  ${s.gameId} ${String(s.comp).padEnd(11)} ${String(s.age).padEnd(14)} ` +
      `${hp.length}+${ap.length} players, goals ${hg}-${ag} against score ${s.hScore}-${s.aScore}` +
      `${plausible ? '' : '  ⚠️ IMPOSSIBLE: goals x6 exceed the final score'}`);
  }

  // ── Answers ────────────────────────────────────────────────────────────────
  const answered = scored + notScored;
  log('\n═══ ANSWERS ═══');
  log(`\n1. coverage — the number P1 turns on`);
  log(`   games sampled and answered:        ${answered}`);
  log(`   WITH a box score:                  ${scored}  (${answered ? (scored / answered * 100).toFixed(0) + '%' : '—'})`);
  log(`   not electronically scored:         ${notScored}`);
  log(`   answers that were not coverage:    ${broken}`);
  log('   ⚠️ A SAMPLE, not a census. It is stratified across competitions and age groups');
  log('      precisely because coverage is the thing most likely to vary by both.');

  log(`\n   by competition:`);
  for (const [c, v] of byComp) {
    const t = v.yes + v.no;
    log(`     ${String(c).padEnd(14)} ${String(v.yes).padStart(3)} of ${String(t).padStart(3)}  ${t ? (v.yes / t * 100).toFixed(0) + '%' : '—'}`);
  }
  log(`\n   by age group:`);
  for (const [a, v] of [...byAge.entries()].sort()) {
    const t = v.yes + v.no;
    log(`     ${String(a).padEnd(14)} ${String(v.yes).padStart(3)} of ${String(t).padStart(3)}  ${t ? (v.yes / t * 100).toFixed(0) + '%' : '—'}`);
  }

  log(`\n2. what a player line carries`);
  log(`   players returned across ${scored} game(s): ${playersTotal}` +
    (scored ? ` (mean ${(playersTotal / scored).toFixed(1)} per game)` : ''));
  log('   distinct statistics type values:');
  log(tallyLine(statValues, '     ') || '     (none)');
  const KNOWN = new Set(['APPEARANCE', 'GOAL_COUNT', 'BEST_PLAYER']);
  const novel = [...statValues.keys()].filter(v => !KNOWN.has(v));
  log(`   NOT among APPEARANCE / GOAL_COUNT / BEST_PLAYER: ${novel.length ? novel.join(', ') : 'none'}`);
  log('   ⚠️ The page shows a PP column beside G. If a value above is player points it is a');
  log('      REGISTRATION rating, constant across that player\'s games — not a per-game');
  log('      statistic, and it must not be stored as one.');
  log(`   games where a player carried periodStatistics: ${withPeriods} of ${scored}` +
    ' — per-QUARTER goals per player, which nothing in this repo has ever had');
  log('   period values seen:');
  log(tallyLine(periodValues, '     ') || '     (none)');
  log(`   games where result.<side>.periods(scope) was non-empty: ${resultPeriods} of ${scored}`);
  log(`   goals never exceeding the final score: ${plausibleN} of ${checkedN}` +
    ' — a sanity check, not a reconciliation');

  if (firstPlayer) {
    log('\n── RAW: one player object ──');
    log(JSON.stringify(firstPlayer));
    log(`   from ${firstGame.s.comp} ${firstGame.s.grade}, game ${firstGame.s.gameId}, status ${firstGame.g.status}`);
    log(`   profileID present: ${firstPlayer.profileID
      ? 'YES — joins straight to our own player uuids'
      : 'NO — there would be no join to our own records'}`);
  }

  // ── Trials ─────────────────────────────────────────────────────────────────
  if (SKIP_TRIALS) {
    log('\n(trials skipped by PROBE_SKIP_TRIALS)');
  } else {
    const TL = trials(sample[0]);
    log(`\n═══ TRIALS — main API, ${TL.length} candidate(s), one per call, never combined ═══`);
    let rejections = 0, ran = 0;
    for (const t of TL) {
      if (rejections >= TRIAL_MAX_REJECT) { log(`\n${t.id}: NOT RUN — rejection cap reached.`); continue; }
      if (ran++) { log(`\n  [spacing ${TRIAL_GAP_MS / 1000}s before the next trial]`); await sleep(TRIAL_GAP_MS); }
      const r = await ask(t.query, t.vars);
      log(`\n${t.id}`);
      log(`  why:  ${t.why}`);
      log(`  sent: ${flat(t.query)}`);
      if (r.ok) {
        const v = t.check((r.json && r.json.data) || {});
        log(`  ACCEPTED${v.populated ? '' : ' — BUT NOT POPULATED'}`);
        log(`  ${v.populated ? 'evidence' : 'why that is not an answer'}: ${v.note}`);
        log(`  payload: ${JSON.stringify((r.json && r.json.data) || {}).slice(0, 900)}`);
        if (!v.populated) log('  ⚠️ Accepted is NOT the same as populated — that is the result.periods trap itself.');
      } else {
        rejections++;
        for (const m of r.errors) log(`  REJECTED — ${m}`);
        const sug = r.errors.map(m => (/Did you mean\s+(.+?)\??$/i.exec(String(m).trim()) || [])[1]).filter(Boolean);
        if (sug.length) log(`  ⭐ SUGGESTION: ${sug.join(' | ')}`);
      }
    }
  }

  // ── Cost ───────────────────────────────────────────────────────────────────
  log('\n── cost, for per_game_stats_design.md §4 ──');
  const liveIds = new Set(seasons.map(s => s.seasonId));
  log(`   grades in the sampled seasons: ${grades.filter(g => g && liveIds.has(g.seasonID)).length}`);
  log('   ONE CALL PER GAME on the spectator endpoint, which needs no session cookie.');
  log('   ⚠️ Its rate limits have never been measured on this account — 40 calls with zero');
  log(`      403s in August is all there is. This run made ${specCalls}, which is the second`);
  log('      data point and still not a budget.');

  log(`\n── summary ──`);
  log(`calls: ${apiCalls} on api.playhq.com, ${specCalls} on spectator.playhq.com`);
  playhq.logSummary('probe-game-stats');
  log('Read-only: nothing was written. Exit 0.');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
