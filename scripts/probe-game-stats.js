#!/usr/bin/env node
// scripts/probe-game-stats.js
//
// READ-ONLY. Writes no file, commits nothing, touches no season file.
//
// Answers the ONE question per_game_stats_design.md (P1) still has: does PlayHQ
// expose a GAME's player statistics in one call, or is the per-PLAYER route the
// only way to a box score?
//
// The per-player route is settled and is NOT re-probed: publicProfileStatistics
// returns every game line a person has, it is what the panel already uses, and
// career_stats_design.md measured its shape on 954 lines. What it cannot do is
// return the OTHER side of a game, so a box score built from it has a hole
// wherever a profile is private or unwalked.
//
// ⚠️ ROUTE 2's INTROSPECTION HALF IS DEAD. per_game_stats_design.md §3 planned a
// __type probe on the Query type. Introspection is disabled, in PlayHQ's own
// words, measured 2026-09-10. Guessing field names is the only route left, and a
// guess costs a rejection — which is the expensive part of a probe.
//
// HOW A TYPE IS EXPLORED WITH INTROSPECTION OFF
// PlayHQ returns "Did you mean" suggestions. `careerStatistics { statistics }`
// answered *Did you mean "clubStatistics" or "totalStatistics"?*, which is how
// careerStatistics was found. So a WRONG field name deliberately close to the
// wanted one hands back a slice of the real field list for free. Trials 1-3 each
// aim that at a DIFFERENT type — Query, DiscoverGame, and the grade-stats filter
// input — so one dispatch explores all three routes rather than three names on
// one of them.
//
// ⚠️ A REJECTION THAT NAMES A TYPE IS EVIDENCE THE FIELD EXISTS. `Cannot query
// field "x" on type "T"` means the server resolved the parent and rejected only
// the selection set. That is the mirror of result.periods — a field that is
// accepted and always empty. Both traps are called out in the output.
//
// ⚠️ NEVER COMBINE TRIAL FIELDS. GraphQL validates the whole document before
// executing any of it, so one unknown field returns an error and NO data —
// measured 2026-08-16, when adding `game { result { home { score } } }` took the
// player panel to "No season stats found" for every player in every season.
// Every trial here is a separate document on its own call.
//
// ⚠️ REJECTED-FIELD TRIALS ARE SPACED AND CAPPED. A probe firing five rejections
// back to back was followed by a run whose session handshake was refused nine
// times over twelve minutes. 20 s between trials, stop after 3 rejections. The
// remaining trials are printed with the exact trial_start to resume from, so the
// full list is covered over two or three dispatches instead of one poisoned one.
//
// TARGETS ARE CHOSEN BY THE SCRIPT, NOT SUPPLIED. It reads data/core.json's
// manifest for a non-retired season, takes a grade from data/grades.json, and
// walks discoverGrade -> discoverFixtureByRound to find a real COMPLETED game.
// Both ids are then PROVEN by two known-good calls before a single trial runs:
// a trial against a dud id is not a measurement. lib/store.js is deliberately
// not used — store.load would parse ~52,000 match records to obtain two ids.
//
// Env: PROBE_GRADE_ID, PROBE_GAME_ID, PROBE_ROUND_ID (override targeting),
//      PROBE_TRIAL_START (0), PROBE_TRIAL_MAX_REJECT (3),
//      PROBE_TRIAL_GAP_MS (20000), PROBE_RATE (100), PROBE_WINDOW_MS (80000),
//      PROBE_MAX_GRADES (3), PROBE_MAX_ROUNDS (3).
//
// Exit codes: 0 = the probe ran, whatever it found. 1 = it could not start —
// no session, no manifest, no grade, no completed game, or a baseline call that
// failed — or it threw. A run that cannot prove its targets exits 1 rather than
// printing trials nobody can trust.

'use strict';

const fs = require('fs');
const path = require('path');
const playhq = require('./lib/playhq');
const { gqlPost, sleep, refreshSession } = playhq;

const VERSION = 'probe-game-stats v2 2026-09-11 three-live-candidates';

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');

const RATE = Math.max(1, Number(process.env.PROBE_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.PROBE_WINDOW_MS || 80000));
const TRIAL_GAP_MS = Math.max(0, Number(process.env.PROBE_TRIAL_GAP_MS || 20000));
const TRIAL_MAX_REJECT = Math.max(1, Number(process.env.PROBE_TRIAL_MAX_REJECT || 3));
const TRIAL_START = Math.max(0, Number(process.env.PROBE_TRIAL_START || 0));
const MAX_GRADES = Math.max(1, Number(process.env.PROBE_MAX_GRADES || 3));
const MAX_ROUNDS = Math.max(1, Number(process.env.PROBE_MAX_ROUNDS || 3));
const BASE_LIMIT = 5;

const log = (...a) => console.log(...a);
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// ── Known-good documents, copied verbatim from the scripts that run them ─────
// Nothing here is a guess. enrich-games.js issues Q_GAME and Q_ROUND on every
// backfill run; fetch-stats.js issues Q_GRADE_STATS on every results weekend.
// They are the BASELINE: they prove the session, the grade id and the game id
// before any trial is allowed to run.

const PERIOD_BLOCK = 'periods { period { value } statistics { count type { value } } }';

const Q_GAME = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    round { grade { hasPeriodScores periods { value } } }
    statistics { home { ${PERIOD_BLOCK} } away { ${PERIOD_BLOCK} } }
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

const Q_GRADE_STATS = `query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      profile { id firstName lastName }
      team { name }
      statistics { count details { value } }
    }
  }
}`;

// ⚠️ INFERRED, NOT READ FROM A QUERY DOCUMENT. enrich-games.js reads
// rr.data.discoverGrade.rounds and then round.id, round.number,
// round.isFinalsRound and round.abbreviatedName off every element, on a walk
// that runs against live PlayHQ, so those five names are proven by consumption.
// The document itself lives in lib/results-engine.js as Q_GRADE_ROUNDS and has
// not been read here, so this is a minimal reconstruction of it and nothing
// more is selected. If it is rejected the run exits 1 and says so rather than
// treating it as an answer about the routes.
const Q_GRADE_ROUNDS = `query discoverGrade($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    rounds { id number isFinalsRound abbreviatedName }
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

let calls = 0;

// ⚠️ THE OPERATION NAME MUST MATCH THE DOCUMENT. A name matching no operation is
// rejected before execution, and that rejection reads exactly like the field
// being unavailable — a negative result manufactured by the test. Derived from
// the query text so the two cannot drift.
function opName(query) {
  return (/^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query || '') || [])[1] || null;
}

// One call. Returns { ok, json, errors } and never throws: a trial that throws
// would stop the run before the trials that follow it.
async function ask(query, vars) {
  await pace();
  calls++;
  let json;
  try {
    json = await gqlPost(query, vars, opName(query));
  } catch (e) {
    return { ok: false, threw: true, errors: [String((e && e.message) || e)], json: null };
  }
  const errs = (json && json.errors) || [];
  if (errs.length) {
    return { ok: false, threw: false, errors: errs.map(e => String((e && e.message) || e)), json };
  }
  return { ok: true, threw: false, errors: [], json };
}

const statOf = (stats, type) => {
  const s = (stats || []).find(x => x && x.type && x.type.value === type);
  return s && s.count !== null && s.count !== undefined ? s.count : null;
};

// ── Targeting ────────────────────────────────────────────────────────────────

// Non-retired seasons, newest first. The year comes from compName — a season's
// startDate PRECEDES the year in its name, so a start date must never be read
// as one. An active season is preferred over a completed one only because a
// completed season's last rounds are the likeliest to hold finished games; both
// are walked if the first yields nothing.
function pickSeasons(manifest) {
  const rank = (m) => (m.state === 'active' ? 0 : m.state === 'complete' ? 1 : 2);
  const yearOf = (c) => Number((String(c || '').match(/\b(\d{4})\b/) || [])[1] || 0);
  return manifest
    .filter(m => m && m.seasonId && !m.retired)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || yearOf(b.compName) - yearOf(a.compName) ||
      String(a.compName || '').localeCompare(String(b.compName || '')));
}

// Spread the grade candidates across the list rather than taking the first few.
// The first grades in a season file are the youngest age groups, which are the
// likeliest to carry no player statistics at all — picking three of them and
// concluding "no completed games" would be an answer produced by the selection.
function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * list.length / n)]);
  return out;
}

async function findTarget(seasons, grades) {
  for (const season of seasons) {
    const mine = grades.filter(g => g && g.id && g.seasonID === season.seasonId);
    if (!mine.length) continue;
    const candidates = spread(mine.slice().sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''))), MAX_GRADES);
    log(`\n  season ${season.compName} (${season.seasonId}, state ${season.state || '?'}) — ` +
      `${mine.length} grade(s) in grades.json, trying ${candidates.length}`);

    for (const grade of candidates) {
      const r = await ask(Q_GRADE_ROUNDS, { gradeID: grade.id });
      if (!r.ok) {
        log(`    ${grade.name}: discoverGrade REJECTED — ${r.errors[0]}`);
        return { fatal: `discoverGrade was rejected: ${r.errors[0]}` };
      }
      const rounds = (r.json && r.json.data && r.json.data.discoverGrade &&
        r.json.data.discoverGrade.rounds) || [];
      if (!rounds.length) { log(`    ${grade.name}: no rounds`); continue; }

      // Newest rounds first: a finished game is likeliest at the end of a season.
      const tryRounds = rounds.slice().reverse().slice(0, MAX_ROUNDS);
      for (const round of tryRounds) {
        if (!round || !round.id) continue;
        const rr = await ask(Q_ROUND, { roundID: round.id });
        if (!rr.ok) {
          log(`    ${grade.name} round ${round.number}: discoverFixtureByRound failed — ${rr.errors[0]}`);
          continue;
        }
        const games = (rr.json && rr.json.data && rr.json.data.discoverFixtureByRound &&
          rr.json.data.discoverFixtureByRound.games) || [];
        // ⚠️ discoverFixtureByRound returns an EMPTY result block for any game
        // not marked FINAL, so a game with two scores is a COMPLETED game. That
        // is what a box score would exist for; an unplayed fixture would answer
        // "no statistics" for a reason that has nothing to do with the route.
        const done = games.find(g => g && g.id &&
          statOf(g.result && g.result.home && g.result.home.statistics, 'TOTAL_SCORE') !== null &&
          statOf(g.result && g.result.away && g.result.away.statistics, 'TOTAL_SCORE') !== null);
        log(`    ${grade.name} round ${round.number}${round.isFinalsRound ? ' (finals)' : ''}: ` +
          `${games.length} game(s), ${done ? 'one COMPLETED — taking it' : 'none completed'}`);
        if (done) {
          return {
            season, grade, round,
            gameId: done.id,
            gameLabel: `${(done.home && done.home.name) || '?'} v ${(done.away && done.away.name) || '?'}`,
            gamesInRound: games.length,
          };
        }
      }
    }
  }
  return null;
}

// ── Trials ───────────────────────────────────────────────────────────────────
// Ranked by what they can teach, not by route. The first three each aim a
// deliberately wrong name at a DIFFERENT type, so one capped dispatch explores
// Query, DiscoverGame and GradePlayerStatisticsFilter rather than three names
// on one of them. Everything after them is a second or third guess on a type
// the first three have already described.

// ⚠️ FIVE CANDIDATES WERE DELETED WITHOUT A CALL. Run 1's two suggestion lists
// rule them out on their own, and re-probing them would spend the rejection
// budget on questions already answered:
//
//   Apollo Server's suggestion list is graphql-js's `suggestionList`, which
//   offers every name within a Damerau-Levenshtein distance of
//   floor(input.length * 0.4) + 1 and caps the list at FIVE. Run 1 got ONE
//   suggestion each time, so neither list was truncated and each is exhaustive
//   within its threshold.
//
//   "gamePlayerStatistics" on Query, threshold 9, suggested only
//   "gradePlayerStatistics" (d=2). So "gameStatistics" (d=6),
//   "publicGameStatistics" (d=9), "gamePlayerStats" (d=5) and "gamePlayers"
//   (d=9) DO NOT EXIST on Query. Route 2 is dead by arithmetic.
//
//   "playerStatistics" on DiscoverGame, threshold 7, suggested only
//   "statistics" (d=6). So "gameStatistics" (d=4), "teamStatistics" (d=5),
//   "playerStats" (d=5) and "profileStatistics" (d=6) do not exist there
//   either. "players", "lineup" and "roster" are all beyond 7 and survive.
//
//   "gameID" on GradePlayerStatisticsFilter, threshold 3, suggested NOTHING.
//   So "gameId", "game" and "gameIDs" are not filter fields. "roundID" (d=5)
//   and "round" survive.
//
// ⚠️ I AM INFERRING, from PlayHQ naming Apollo Server in its own introspection
// error, that it uses graphql-js's standard threshold. If they have tuned it or
// truncate the list, these exclusions are wrong and the names come back. The
// arithmetic is in the message that delivered this file, so it can be checked.
//
// That leaves exactly three live candidates, which is exactly the rejection cap.
function trials(t, baselineTotal) {
  const filterBase = { sort: [{ column: 'GOAL_COUNT', direction: 'DESC' }], pagination: { page: 1, limit: 5 } };
  // ⚠️ ACCEPTED IS NOT POPULATED, and for a FILTER, accepted is not APPLIED. Each
  // trial says for itself what a real answer would look like, because a generic
  // "is the payload empty" test cannot tell a null field from a null row inside a
  // populated one. `populated` false is reported as loudly as a rejection.
  const objCheck = (pick) => (data) => {
    const v = pick(data);
    if (v === undefined) return { populated: false, note: 'the field is absent from the response entirely — accepted, but nothing came back' };
    if (v === null) return { populated: false, note: 'the field is NULL. That is the result.periods trap: a field can be accepted, take no arguments and always be empty' };
    return { populated: true, note: `type ${v.__typename || '(no __typename returned)'}` };
  };
  const filterCheck = (data) => {
    const g = data && data.gradePlayerStatistics;
    if (!g || !g.meta) return { populated: false, note: 'accepted but returned no gradePlayerStatistics block' };
    const n = g.meta.totalRecords;
    if (baselineTotal !== null && n === baselineTotal) {
      return { populated: false, note: `totalRecords is ${n}, IDENTICAL to the unfiltered baseline — ` +
        'the key was accepted and appears to have been IGNORED. An accepted input field that changes nothing is not a route' };
    }
    return { populated: true, note: `totalRecords ${n} against an unfiltered baseline of ${baselineTotal} — the filter CHANGED the result set` };
  };
  return [
    {
      id: 'H1  DiscoverGame.statistics.home.players',
      route: '3 — one level below the quarters',
      why: 'The biggest prize left: discoverGame is already fetched for quarters, so ' +
           'players hanging off statistics.home cost NOTHING extra per weekend. Run 1 ' +
           'described DiscoverGame itself but nothing has ever described the SIDE type ' +
           'under statistics, so a rejection here is a field list we do not have.',
      query: `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) { id statistics { home { players { __typename } } } }
}`,
      vars: { gameID: t.gameId },
      check: objCheck(d => d && d.discoverGame && d.discoverGame.statistics &&
        d.discoverGame.statistics.home && d.discoverGame.statistics.home.players),
    },
    {
      id: 'H2  GradePlayerStatisticsFilter.roundID',
      route: '1 — one call per grade-round',
      why: 'The only survivor of run 1\'s filter trial: "roundID" is distance 5 from ' +
           '"gameID" and that rejection suggested nothing within 3, so it was never ' +
           'ruled out. If it works, a weekend is ~249 calls and needs no new operation. ' +
           'The round id below is real — it came from the fixture walk.',
      query: Q_GRADE_STATS,
      vars: { gradeID: t.grade.id, filter: Object.assign({ roundID: t.round.id }, filterBase) },
      check: filterCheck,
      needsRound: true,
    },
    {
      id: 'H3  DiscoverGame.lineup',
      route: '3 — the team sheet rather than the statistics',
      why: 'Last guess, and a different word family from "playerStatistics" — distance ' +
           '14, so run 1 could not have ruled it out. A lineup gives who played even ' +
           'without goals, which is most of a box score.',
      query: `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) { id lineup { __typename } }
}`,
      vars: { gameID: t.gameId },
      check: objCheck(d => d && d.discoverGame && d.discoverGame.lineup),
    },
  ];
}

// PlayHQ's suggestions are the point of a rejection, so they are pulled out
// rather than left inside a message that also carries the field name.
function suggestion(msg) {
  const m = /Did you mean\s+(.+?)\??$/i.exec(String(msg).trim());
  return m ? m[1] : null;
}
// ⚠️ A REJECTION NAMING A TYPE IS EVIDENCE THE PARENT FIELD EXISTS.
function namedType(msg) {
  const m = /on type "([^"]+)"/.exec(String(msg));
  return m ? m[1] : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== ${VERSION} ===`);
  log(`pace: ${RATE} calls / ${WINDOW_MS / 1000}s; trials spaced ${TRIAL_GAP_MS / 1000}s, ` +
    `stopping after ${TRIAL_MAX_REJECT} rejection(s)${TRIAL_START ? `, starting at trial index ${TRIAL_START}` : ''}`);
  log('READ-ONLY: this run writes no file and commits nothing.\n');

  // ⚠️ ACQUIRE THE SESSION BEFORE ANYTHING ELSE. Without one every call fails
  // and the trials report rejections that are really a missing handshake —
  // a negative result manufactured by the test.
  const gotSession = await refreshSession();
  if (!gotSession) {
    console.error('FATAL: no PlayHQ session. Every call would fail and every trial would');
    console.error('report a rejection that is really a missing handshake.');
    console.error('If the log above shows CloudFront blocks on TenantConfig/ProfileSearch,');
    console.error('the WAF is refusing it — wait and re-dispatch. Nothing was written.');
    process.exit(1);
  }
  if (playhq.summary().blocked) {
    log(`⚠️ session acquired, but ${playhq.summary().blocked} block(s) on the way — the window`);
    log('   is tight. Consider re-dispatching later rather than spending trials now.');
  }

  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')).manifest || [];
  } catch (e) {
    console.error(`FATAL: could not read data/core.json (${e.message}).`);
    console.error('It is where the non-retired seasons are listed and there is no other');
    console.error('source for them. Nothing was written.');
    process.exit(1);
  }
  let grades = [];
  try {
    grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));
    if (!Array.isArray(grades)) throw new Error('grades.json is not an array');
  } catch (e) {
    console.error(`FATAL: could not read data/grades.json (${e.message}).`);
    console.error('It is where the grade ids come from. Pass PROBE_GRADE_ID and');
    console.error('PROBE_GAME_ID to skip targeting. Nothing was written.');
    process.exit(1);
  }
  const seasons = pickSeasons(manifest);
  log(`manifest: ${manifest.length} entr(ies), ${seasons.length} non-retired season(s); ` +
    `grades.json: ${grades.length} grade(s)`);

  // ── Targets ────────────────────────────────────────────────────────────────
  let target = null;
  const envGrade = (process.env.PROBE_GRADE_ID || '').trim();
  const envGame = (process.env.PROBE_GAME_ID || '').trim();
  const envRound = (process.env.PROBE_ROUND_ID || '').trim();
  if (envGrade && envGame) {
    const g = grades.find(x => x && x.id === envGrade) || { id: envGrade, name: '(supplied)' };
    target = { season: { compName: '(supplied)', seasonId: g.seasonID || null }, grade: g,
      round: { id: envRound || null, number: null }, gameId: envGame,
      gameLabel: '(supplied)', gamesInRound: null };
    log(`\ntargets SUPPLIED: grade ${envGrade}, game ${envGame}${envRound ? `, round ${envRound}` : ''}`);
    if (!envRound) log('  ⚠️ no round id supplied — the roundID filter trial will be skipped.');
  } else {
    log('\n── targeting: finding one real COMPLETED game and its grade ──');
    const found = await findTarget(seasons, grades);
    if (found && found.fatal) {
      console.error(`\nFATAL: ${found.fatal}`);
      console.error('That is a fault in this probe\'s reconstruction of the rounds query,');
      console.error('not an answer about the per-game routes. No trial was run.');
      process.exit(1);
    }
    target = found;
  }
  if (!target) {
    console.error('\nFATAL: no completed game found in any candidate grade.');
    console.error(`Tried up to ${MAX_GRADES} grade(s) per season and ${MAX_ROUNDS} round(s) each.`);
    console.error('Raise PROBE_MAX_GRADES / PROBE_MAX_ROUNDS, or pass PROBE_GRADE_ID and');
    console.error('PROBE_GAME_ID directly. No trial was run, because a trial against an id');
    console.error('that may not exist is not a measurement. Nothing was written.');
    process.exit(1);
  }
  log(`\nTARGETS`);
  log(`  competition ${target.season.compName}`);
  log(`  grade       ${target.grade.id}  ${target.grade.name || ''}`);
  log(`  round       ${target.round.id || '(none)'}${target.round.number != null ? `  number ${target.round.number}` : ''}`);
  log(`  game        ${target.gameId}  ${target.gameLabel}`);

  // ── Baseline: prove both ids with calls that are already known to work ──────
  log('\n═══ BASELINE — the two known-good calls, before any guess ═══');
  const bGame = await ask(Q_GAME, { gameID: target.gameId });
  const dg = bGame.ok && bGame.json.data ? bGame.json.data.discoverGame : null;
  if (!bGame.ok || !dg) {
    console.error(`FATAL: discoverGame did not answer for ${target.gameId} — ` +
      (bGame.ok ? 'accepted but returned null' : bGame.errors[0]));
    console.error('The game id is unusable, so every trial below would be measuring the id');
    console.error('rather than the route. Nothing was written.');
    process.exit(1);
  }
  const hp = (dg.statistics && dg.statistics.home && dg.statistics.home.periods) || [];
  log(`  discoverGame: ACCEPTED — id ${dg.id}, ` +
    `hasPeriodScores ${dg.round && dg.round.grade ? dg.round.grade.hasPeriodScores : '?'}, ` +
    `${hp.length} home period row(s)`);

  const bGrade = await ask(Q_GRADE_STATS, {
    gradeID: target.grade.id,
    filter: { sort: [{ column: 'GOAL_COUNT', direction: 'DESC' }], pagination: { page: 1, limit: BASE_LIMIT } },
  });
  const gps = bGrade.ok && bGrade.json.data ? bGrade.json.data.gradePlayerStatistics : null;
  if (!bGrade.ok || !gps) {
    console.error(`FATAL: gradePlayerStatistics did not answer for ${target.grade.id} — ` +
      (bGrade.ok ? 'accepted but returned null' : bGrade.errors[0]));
    console.error('Route 1\'s filter trials would be measuring the grade id rather than the');
    console.error('filter. Nothing was written.');
    process.exit(1);
  }
  const first = (gps.results || [])[0];
  // ⚠️ totalPages IS COMPUTED ON THE LIMIT THIS CALL SENT, not on 50. v1 printed
  // "83 page(s) at 50" for 411 records, which is arithmetic nobody can reproduce
  // and exactly the kind of figure that gets quoted back as a measurement.
  log(`  gradePlayerStatistics: ACCEPTED — ${gps.meta.totalRecords} player record(s) in this grade, ` +
    `${gps.meta.totalPages} page(s) at the limit ${BASE_LIMIT} this call sent`);
  log(`    first row: ${first ? JSON.stringify({ team: first.team && first.team.name,
    stats: (first.statistics || []).map(s => `${s.details && s.details.value}=${s.count}`) }) : '(none)'}`);
  log('  ⚠️ These are SEASON totals for the grade. They are the thing a box score is not.');

  // ── Trials ─────────────────────────────────────────────────────────────────
  const TL = trials(target, gps.meta ? gps.meta.totalRecords : null);
  log(`\n═══ TRIALS — ${TL.length} candidate(s), one per call, never combined ═══`);
  log('⚠️ __type introspection is NOT tried: measured disabled 2026-09-10, in PlayHQ\'s');
  log('   own words. per_game_stats_design.md §3 route 2\'s introspection half is dead.');

  const results = [];
  let rejections = 0;
  let stoppedAt = -1;
  let ran = 0;

  for (let i = 0; i < TL.length; i++) {
    const t = TL[i];
    if (i < TRIAL_START) { results.push({ i, t, verdict: 'SKIPPED (before trial_start)' }); continue; }
    if (t.needsRound && !target.round.id) {
      log(`\n[${i}] ${t.id}: NOT RUN — no round id available.`);
      results.push({ i, t, verdict: 'NOT RUN — no round id' });
      continue;
    }
    if (rejections >= TRIAL_MAX_REJECT) {
      if (stoppedAt < 0) stoppedAt = i;
      results.push({ i, t, verdict: 'NOT RUN — rejection cap reached' });
      continue;
    }
    if (ran++) { log(`\n  [spacing ${TRIAL_GAP_MS / 1000}s before the next trial]`); await sleep(TRIAL_GAP_MS); }

    const r = await ask(t.query, t.vars);
    log(`\n[${i}] ${t.id}`);
    log(`  route: ${t.route}`);
    log(`  why:   ${t.why}`);
    log(`  sent:  ${flat(t.query)}`);
    log(`  vars:  ${flat(JSON.stringify(t.vars))}`);

    if (r.ok) {
      const data = (r.json && r.json.data) || {};
      const payload = JSON.stringify(data);
      // ⚠️ ACCEPTED IS NOT POPULATED. result.<side>.periods is accepted, takes no
      // arguments and is always empty; three probes read that as "PlayHQ does not
      // expose this". Each trial carries its own test of what a real answer looks
      // like, so an accepted-but-null field is never reported as a working route.
      const v = t.check ? t.check(data) : { populated: true, note: '(no check defined)' };
      log(`  ACCEPTED${v.populated ? '' : ' — BUT NOT POPULATED'}`);
      log(`  ${v.populated ? 'evidence' : 'why that is not a route'}: ${v.note}`);
      log(`  payload: ${payload.slice(0, 1200)}`);
      if (!v.populated) {
        log('  ⚠️ Accepted is NOT the same as populated. Three probes misread');
        log('     result.<side>.periods — a real field that is always empty — as');
        log('     "PlayHQ does not expose this". This is not yet a route.');
      }
      results.push({ i, t, verdict: v.populated ? 'ACCEPTED and populated' : 'ACCEPTED but empty', payload });
    } else {
      rejections++;
      for (const m of r.errors) log(`  REJECTED — ${m}`);
      const sug = r.errors.map(suggestion).filter(Boolean);
      const typ = r.errors.map(namedType).filter(Boolean);
      if (sug.length) {
        log(`  ⭐ SUGGESTION: ${sug.join(' | ')}`);
        log('     That is PlayHQ describing its own type. With introspection off this is');
        log('     the only field list available, and it is the whole point of the trial.');
      }
      if (typ.length) {
        log(`  ⚠️ THE ERROR NAMES A TYPE (${typ.join(', ')}) — the PARENT field resolved and`);
        log('     only the selection set was rejected. That is how careerStatistics was found.');
      }
      results.push({ i, t, verdict: 'REJECTED', errors: r.errors, sug, typ });
    }
  }

  // ── What to do next ────────────────────────────────────────────────────────
  log('\n═══ VERDICT ═══');
  for (const r of results) log(`  [${r.i}] ${String(r.verdict).padEnd(34)} ${r.t.id}`);
  const accepted = results.filter(r => r.verdict === 'ACCEPTED and populated');
  const hollow = results.filter(r => r.verdict === 'ACCEPTED but empty');
  log(`\n  accepted: ${accepted.length}; rejected: ${rejections}; ` +
    `not run: ${results.filter(r => /NOT RUN|SKIPPED/.test(r.verdict)).length}`);
  if (hollow.length && !accepted.length) {
    log('  ⚠️ Something was ACCEPTED AND EMPTY. That is the hardest result to read and');
    log('     it is not a negative: the field exists. It needs a second dispatch against');
    log('     a DIFFERENT game before anyone concludes the route is useless.');
  }
  if (accepted.length) {
    log('  A GAME-SIDE ROUTE EXISTS. The next dispatch probes its selection set the same');
    log('  way — one field group per call — rather than guessing a whole shape at once.');
  } else if (stoppedAt >= 0) {
    log(`  No route yet, and the run stopped at the ${TRIAL_MAX_REJECT}-rejection cap.`);
    log(`  ⚠️ RE-DISPATCH WITH trial_start = ${stoppedAt} to continue, tomorrow rather than now:`);
    log('     a burst of rejections on one run is what refuses the NEXT run its session.');
  } else {
    log('  Every candidate was tried and none exists. The per-PLAYER route is the only');
    log('  one, and the design decision is whether a box score with holes in it is worth');
    log('  a nine-hour walk. The suggestions above are the evidence for that, not a guess.');
  }

  // ── Local cost, no calls ───────────────────────────────────────────────────
  // From grades.json and one measured round. ⚠️ ONE ROUND IS A SAMPLE. It gives
  // an order of magnitude for §4's estimates and nothing more, and it says so.
  log('\n── cost, for per_game_stats_design.md §4 (computed locally, no calls) ──');
  const liveIds = new Set(seasons.map(s => s.seasonId));
  const liveGrades = grades.filter(g => g && liveIds.has(g.seasonID));
  const byComp = new Map();
  for (const g of liveGrades) byComp.set(g.compName, (byComp.get(g.compName) || 0) + 1);
  log(`  grades in non-retired seasons: ${liveGrades.length} across ${byComp.size} competition(s)`);
  for (const [c, n] of [...byComp].sort((a, b) => b[1] - a[1])) log(`    ${String(c).padEnd(20)} ${n}`);
  if (target.gamesInRound) {
    log(`  one grade-round returned ${target.gamesInRound} game(s) (${target.grade.name})`);
    log(`  -> a full round across those grades is ~${liveGrades.length} grade-round call(s)`);
    log(`     and ~${liveGrades.length * target.gamesInRound} game(s) if every grade plays`);
    log('  ⚠️ ONE ROUND OF ONE GRADE IS A SAMPLE, not a population. This is an order of');
    log('     magnitude for §4, and byes, splits and finals all move it.');
  }

  log(`\n── summary ──`);
  log(`calls ${calls}`);
  playhq.logSummary('probe-game-stats');
  log('Read-only: nothing was written. Exit 0.');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
