#!/usr/bin/env node
// scripts/probe-game-stats.js
//
// READ-ONLY. Writes no file, commits nothing. NO call to api.playhq.com and NO
// session: the spectator endpoint takes no cookie on the afl tenant. Twelve
// calls at the defaults.
//
// v5 (2026-09-11) — THE LAST UNKNOWN: IS THE ATTRIBUTION COMPLETE?
//
// WHAT v4 FOUND, and what it cost to find it. The per-player figures are in
// players[].statistics after all. They are NOT under the names the profile route
// uses:
//
//     6_POINT_SCORE   goals            1_POINT_SCORE   BEHINDS
//     TOTAL_GOALS     goals again      TOTAL_BEHINDS   behinds again
//     GOAL_COUNT      0 for every player in every game
//     APPEARANCE      0                BEST_PLAYER     0
//
// ⚠️ THE STATISTIC NAMES ARE PER-ROUTE, NOT PER-TENANT. The reference records
// that only APPEARANCE, GOAL_COUNT and BEST_PLAYER exist, measured across 954
// game lines. That is true OF THE PROFILE ROUTE. The spectator route uses a
// different vocabulary on the same tenant, and v3 and v4 both summed GOAL_COUNT
// against it and reported 0-0 for games that plainly had goals. Twice.
//
// ⚠️ BEHINDS EXIST. `per_game_stats_design.md` §5 lists behinds as optional and
// the career design concluded there is no behinds figure anywhere. On THIS route
// there is one, per player, per game. That is a genuine correction to
// docs/playhq_api_reference.md and not a detail of this probe.
//
// WHAT IS STILL UNKNOWN, AND IS ALL THIS RUN ASKS
//
// Whether the attribution is COMPLETE. Of twelve electronically scored games,
// only EIGHT carried any player figure at all, and the count of non-zero entries
// looked low against the final scores. A box score that names four of a team's
// ten goalkickers is worse than no box score, because nothing on the page tells
// a reader which six are missing.
//
// So: sum every player's 6_POINT_SCORE and 1_POINT_SCORE per side and compare
// them with the team's own totals from the SAME response. That is a real
// reconciliation rather than a restatement — the team figures come from
// result.<side>.statistics and statisticsV2, which are populated independently
// of the player rows, as game 7ce5b38c proves by having team totals and no
// player figures whatsoever.
//
// ⚠️ AND CHECK THE ARITHMETIC. 6 x goals + behinds must equal TOTAL_SCORE. If
// the team's own three figures do not agree with each other then the player rows
// are being compared against a number that is itself wrong.
//
// ALREADY SETTLED — not re-asked:
//   coverage: 12 of 58 sampled games e-scored; Senior 5/5, U18 2/2, and roughly
//     1 in 20 for U8-U16; SER 0 of 12 (measured 2026-09-11, v3)
//   `game(id:)` does not exist on api.playhq.com — rejected, no suggestion
//   `periods(scope:)` is spectator-only; the main API has no PeriodScore type
//     and GameTeamResult.periods takes no argument, so the reference's
//     "real field that is always empty" STANDS
//   players[].periodStatistics is a four-row QUARTERS skeleton whose statistics
//     array is EMPTY in all 12 games and all 528 players — accepted, structured,
//     and carrying nothing. There are no per-quarter player goals.
//
// Env: PROBE_GAME_IDS (csv; defaults to the twelve v3 found e-scored),
//      PROBE_RATE (100), PROBE_WINDOW_MS (80000), PROBE_MAX_GAMES (12).
//
// Exit codes: 0 = it ran. 1 = the document was rejected, or nothing answered.

'use strict';

const playhq = require('./lib/playhq');
const { specPost, sleep } = playhq;

const VERSION = 'probe-game-stats v5 2026-09-11 attribution-completeness';

const DEFAULT_IDS = [
  '2c9b42bc', '7ce5b38c', '44e86e26', '8e5f6184', '345110a0',  // EFNL Senior
  '5ec563b2', '30cdedc4',                                      // EFNL U15
  'ffe978ec',                                                  // SEJ U8
  '2815c7e4',                                                  // SEJ U10
  'f98dd0e7', 'f94cd17f',                                      // WFNL U18
  '56a03119',                                                  // YJFL U16
];

const RATE = Math.max(1, Number(process.env.PROBE_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.PROBE_WINDOW_MS || 80000));
const MAX_GAMES = Math.max(1, Number(process.env.PROBE_MAX_GAMES || 12));
const IDS = String(process.env.PROBE_GAME_IDS || '')
  .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log(...a);

// Trimmed to what a reconciliation needs. Every field was in the page's own
// request; periodStatistics is gone because v4 measured it empty in all 528
// player rows, and asking for it again would only reprint that.
const Q_BOX = `query game($id: ID!, $scope: PeriodScore) {
  game(id: $id) {
    id
    status
    statistics {
      home { statisticsV2 { type { type value } count } players { id profileID name playerNumber statistics { type { value } count } } }
      away { statisticsV2 { type { type value } count } players { id profileID name playerNumber statistics { type { value } count } } }
    }
    result {
      home { statistics { type { value } count } periods(scope: $scope) { period { value } statistics { type { value } count } } }
      away { statistics { type { value } count } periods(scope: $scope) { period { value } statistics { type { value } count } } }
    }
  }
}`;

const callTimes = [];
async function pace() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] >= WINDOW_MS) callTimes.shift();
  if (callTimes.length >= RATE) { await sleep(WINDOW_MS - (now - callTimes[0]) + 5); return pace(); }
  callTimes.push(Date.now());
}

const NOT_SCORED = /not electronically scored|could not be found/i;
const val = (stats, type) => {
  const s = (stats || []).find(x => x && x.type && x.type.value === type);
  return s && s.count !== null && s.count !== undefined ? Number(s.count) : null;
};
const sumOver = (players, type) =>
  (players || []).reduce((n, p) => n + (val(p.statistics, type) || 0), 0);

async function main() {
  const ids = (IDS.length ? IDS : DEFAULT_IDS).slice(0, MAX_GAMES);
  log(`=== ${VERSION} ===`);
  log(`${ids.length} game(s), spectator endpoint only — no session, no main-API call.`);
  log('READ-ONLY: this run writes no file and commits nothing.\n');
  log('Per side: player sums from players[].statistics, team figures from');
  log('result.<side>.statistics. The two are populated independently — game');
  log('7ce5b38c has team totals and no player rows at all — so this is a real');
  log('check and not a restatement.\n');

  let answered = 0, notScored = 0, rejected = 0;
  let sidesTotal = 0, sidesExact = 0, sidesPartial = 0, sidesEmpty = 0, sidesOver = 0;
  let teamArithOk = 0, teamArithBad = 0;
  const goalShortfall = [];
  let namedScorers = 0, playersSeen = 0;

  for (const id of ids) {
    await pace();
    let json;
    try { json = await specPost(Q_BOX, { id, scope: 'BY_PERIOD' }, 'game'); }
    catch (e) { rejected++; log(`  ${id}: THREW — ${String(e.message).slice(0, 160)}`); continue; }

    const errs = ((json && json.errors) || []).map(e => String((e && e.message) || e));
    if (errs.length && !errs.every(m => NOT_SCORED.test(m))) {
      // ⚠️ A VALIDATION ERROR IS NOT A FINDING.
      rejected++;
      log(`  ${id}: ⚠️ DOCUMENT REJECTED — ${errs.join(' | ').slice(0, 300)}`);
      if (rejected >= 2) {
        console.error('\nFATAL: the document is being rejected, so every figure below would be');
        console.error('measuring this probe rather than PlayHQ. Nothing was written.');
        process.exit(1);
      }
      continue;
    }
    if (errs.length) { notScored++; log(`  ${id}: not electronically scored`); continue; }
    const g = json && json.data && json.data.game;
    if (!g) { notScored++; log(`  ${id}: answered with a null game`); continue; }
    answered++;

    for (const sd of ['home', 'away']) {
      const players = ((g.statistics && g.statistics[sd]) || {}).players || [];
      const team = ((g.result && g.result[sd]) || {}).statistics || [];
      playersSeen += players.length;

      const pg = sumOver(players, '6_POINT_SCORE');
      const pb = sumOver(players, '1_POINT_SCORE');
      const pgAlt = sumOver(players, 'TOTAL_GOALS');
      const pbAlt = sumOver(players, 'TOTAL_BEHINDS');
      const scorers = players.filter(p =>
        (val(p.statistics, '6_POINT_SCORE') || 0) + (val(p.statistics, '1_POINT_SCORE') || 0) > 0).length;
      namedScorers += scorers;

      const tg = val(team, '6_POINT_SCORE');
      const tb = val(team, '1_POINT_SCORE');
      const ts = val(team, 'TOTAL_SCORE');

      // ⚠️ CHECK THE REFERENCE FIGURE BEFORE TRUSTING IT. If the team's own three
      // numbers do not agree, the player rows are being compared with something
      // already wrong, and a "match" would mean nothing.
      const arithOk = (tg !== null && tb !== null && ts !== null) ? (tg * 6 + tb === ts) : null;
      if (arithOk === true) teamArithOk++; else if (arithOk === false) teamArithBad++;

      sidesTotal++;
      let verdict;
      if (tg === null) verdict = 'no team figure to compare against';
      else if (!players.length) verdict = 'NO PLAYER ROWS AT ALL';
      else if (pg === 0 && pb === 0) { sidesEmpty++; verdict = `EMPTY — team kicked ${tg}.${tb}, not one player figure`; }
      else if (pg === tg && pb === tb) { sidesExact++; verdict = `EXACT — ${scorers} player(s) account for all ${tg}.${tb}`; }
      else if (pg > tg || pb > tb) { sidesOver++; verdict = `⚠️ OVER — players ${pg}.${pb} EXCEED the team's ${tg}.${tb}`; }
      else {
        sidesPartial++;
        goalShortfall.push(tg - pg);
        verdict = `PARTIAL — players ${pg}.${pb} against the team's ${tg}.${tb}, ` +
          `${tg - pg} goal(s) and ${tb - pb} behind(s) unattributed`;
      }

      const altNote = (pg !== pgAlt || pb !== pbAlt)
        ? `  ⚠️ TOTAL_GOALS/TOTAL_BEHINDS disagree with 6_/1_POINT_SCORE: ${pgAlt}.${pbAlt}` : '';
      log(`  ${id} ${sd.padEnd(4)} ${players.length.toString().padStart(2)} players  ` +
        `${arithOk === false ? '⚠️ team arithmetic wrong: ' : ''}${verdict}${altNote}`);
    }
  }

  log('\n═══ IS THE ATTRIBUTION COMPLETE? ═══');
  log(`games answered ${answered}; not e-scored ${notScored}; rejected ${rejected}`);
  log(`team sides examined: ${sidesTotal} (${playersSeen} player rows, ${namedScorers} carrying a score)`);
  log(`\n  EXACT — every goal and behind attributed:   ${sidesExact} of ${sidesTotal}`);
  log(`  PARTIAL — some of the score unattributed:   ${sidesPartial}`);
  log(`  EMPTY — team scored, no player figures:     ${sidesEmpty}`);
  log(`  OVER — players exceed the team total:       ${sidesOver}`);
  if (goalShortfall.length) {
    const tot = goalShortfall.reduce((a, b) => a + b, 0);
    log(`  goals unattributed on partial sides: ${tot} across ${goalShortfall.length} side(s)` +
      ` (mean ${(tot / goalShortfall.length).toFixed(1)})`);
  }
  log(`\n  team's own arithmetic (6 x goals + behinds = TOTAL_SCORE): ${teamArithOk} right, ${teamArithBad} wrong`);
  log('  ⚠️ If that right-hand number is not zero the comparison above is unsafe, because');
  log('     the player rows were measured against a team figure that disagrees with itself.');

  log('\n  What this decides: a box score that names four of ten goalkickers is worse than');
  log('  no box score, because nothing on the card tells a reader which six are missing.');
  log('  EXACT sides can be published. PARTIAL ones cannot, unless the page marks them.');

  log(`\n── summary ──`);
  log(`calls: 0 on api.playhq.com, ${answered + notScored + rejected} on spectator.playhq.com`);
  playhq.logSummary('probe-game-stats');
  if (!answered) {
    console.error('\nFATAL: not one game answered, so nothing above is a measurement.');
    process.exit(1);
  }
  log('Read-only: nothing was written. Exit 0.');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
