#!/usr/bin/env node
// scripts/probe-game-stats.js
//
// READ-ONLY. Writes no file, commits nothing, touches no season file.
// Makes NO call to api.playhq.com and needs NO session: the spectator endpoint
// takes no cookie on the afl tenant. Twelve calls at the defaults.
//
// v4 (2026-09-11) — v3 FOUND THE ROUTE AND THEN MISREAD IT.
//
// v3 measured coverage correctly and then reported "goals 0-0" for all twelve
// electronically scored games, including 2c9b42bc, whose PlayHQ page shows ten
// goals to East Ringwood and four to Rowville. A figure that disagrees with a
// page anyone can open is not a measurement of PlayHQ; it is a defect here.
//
// TWO DEFECTS, BOTH IN THE READING RATHER THAN THE CALL:
//
//   1. v3 summed ONLY players[].statistics. The captured document also carries
//      periodStatistics[].statistics per player, and the per-period rows are
//      where a goal actually happens. It also dropped `side`, `type`, `status`
//      and `displayOrder` from those rows and `permitType` and `statisticsV2`
//      from the response — all present in the page's own document. One of those
//      discriminators is the likeliest explanation of a zeroed template.
//
//   2. ⚠️ IT PRINTED THE FIRST PLAYER. Steven May's line is legitimately all
//      zeroes — the page agrees, G 0 — so the one raw object in the log was the
//      least informative player in the sample and looked like proof of a
//      universal zero. A tool that reports something ABSENT must show what it
//      found instead, and the evidence it shows must be chosen to be capable of
//      contradicting it.
//
// So this run asks the captured document IN FULL, for a fixed list of games
// already known to be electronically scored, and reports where the non-zero
// numbers are — if they are anywhere.
//
// ⚠️ IT MAY FIND THAT THEY ARE NOWHERE. The page renders a Statistics tab, a
// Play-by-play tab and a Line-up tab, and only one request was captured. If
// every location in this response is zero for every player, then the numbers
// arrive on a SECOND request that the tab fires, and the next step is to capture
// that one rather than to guess again. The verdict block says so explicitly
// instead of leaving a silent zero to be read as "PlayHQ does not expose this" —
// which is exactly how result.periods was misread three times.
//
// WHAT IS ALREADY SETTLED AND IS NOT RE-ASKED:
//   coverage — 12 of 58 sampled games, Senior 5/5 and U18 2/2 against U10-U14
//     at roughly 1 in 20 (measured 2026-09-11, v3)
//   `game(id:)` does NOT exist on api.playhq.com — REJECTED, no suggestion
//   `periods(scope:)` on the main API — REJECTED twice over: there is no
//     `PeriodScore` type there and `GameTeamResult.periods` takes no argument.
//     The reference's "a real field that is always empty" therefore STANDS for
//     the main API; the scope argument is a spectator-side thing and was not the
//     explanation. That question is closed.
//
// Env: PROBE_GAME_IDS (csv; defaults to the twelve v3 found e-scored),
//      PROBE_RATE (100), PROBE_WINDOW_MS (80000), PROBE_MAX_GAMES (12).
//
// Exit codes: 0 = the probe ran, whatever it found. 1 = the document was
// rejected, or no game answered at all — either of which would otherwise print
// zeroes that look like a finding.

'use strict';

const playhq = require('./lib/playhq');
const { specPost, sleep } = playhq;

const VERSION = 'probe-game-stats v4 2026-09-11 where-are-the-numbers';

// The twelve games v3 found electronically scored on 2026-09-11. Hard-coded
// deliberately: re-sampling would spend ~70 main-API calls to rediscover ids we
// already have, and these are the only games in the sample that CAN answer.
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

// ⚠️ THE CAPTURED DOCUMENT, WITH NOTHING TRIMMED THAT DESCRIBES A PLAYER.
// v3 cut side, type, status, displayOrder, permitType and statisticsV2 because
// nothing needed them. One of them may be the discriminator that separates a
// zeroed template row from a real one, so they are all back. Only the cricket
// fragments, the clock and latestEvent are left out, and none of those touches a
// player. Every field name here came off the page's own request.
const Q_BOX = `query game($id: ID!, $scope: PeriodScore) {
  game(id: $id) {
    id
    status
    updatedAt
    lastEventRecordedAt
    statistics {
      home {
        statisticsV2 { type { type value } count }
        players {
          id profileID name playerNumber permitType
          statistics { type { value } count }
          periodStatistics {
            period { value }
            side
            type
            status
            displayOrder
            statistics { type { value } count }
          }
        }
      }
      away {
        statisticsV2 { type { type value } count }
        players {
          id profileID name playerNumber permitType
          statistics { type { value } count }
          periodStatistics {
            period { value }
            side
            type
            status
            displayOrder
            statistics { type { value } count }
          }
        }
      }
      shared { period { value } side }
    }
    result {
      home {
        statistics { type { value } count }
        periods(scope: $scope) { period { label shortName value } statistics { type { value } count } type role closureStatus }
      }
      away {
        statistics { type { value } count }
        periods(scope: $scope) { period { label shortName value } statistics { type { value } count } type role closureStatus }
      }
    }
  }
}`;

// ── Token bucket ─────────────────────────────────────────────────────────────
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

const NOT_SCORED = /not electronically scored|could not be found/i;

const nonZero = (stats) => (stats || []).filter(s => Number(s && s.count) > 0);
const valOf = (stats, type) => {
  const s = (stats || []).find(x => x && x.type && x.type.value === type);
  return s && s.count !== null && s.count !== undefined ? Number(s.count) : null;
};
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const tallyLine = (m, indent) => [...m.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${indent}${String(k).padEnd(34)} ${n}`).join('\n');

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const ids = (IDS.length ? IDS : DEFAULT_IDS).slice(0, MAX_GAMES);
  log(`=== ${VERSION} ===`);
  log(`${ids.length} game(s), spectator endpoint only — no session, no main-API call.`);
  log(`pace: ${RATE} calls / ${WINDOW_MS / 1000}s`);
  log('READ-ONLY: this run writes no file and commits nothing.\n');

  let answered = 0, notScored = 0, rejected = 0;
  // Every place a number could be hiding, counted separately. A single "did we
  // find goals" boolean could not tell "the field is empty" from "we read the
  // wrong field", which is the whole reason this run exists.
  const where = {
    playerTop: 0,        // players[].statistics with any count > 0
    playerPeriod: 0,     // players[].periodStatistics[].statistics with any count > 0
    teamV2: 0,           // statisticsV2 with any count > 0
    teamResult: 0,       // result.<side>.statistics with any count > 0
    resultPeriods: 0,    // result.<side>.periods with any count > 0
  };
  const periodTypes = new Map(), periodStatuses = new Map(), periodSides = new Map();
  const permitTypes = new Map();
  let playersSeen = 0, playersWithAnything = 0;
  let best = null, bestScore = -1, zeroExample = null;

  for (const id of ids) {
    await pace();
    let json;
    try {
      json = await specPost(Q_BOX, { id, scope: 'BY_PERIOD' }, 'game');
    } catch (e) {
      rejected++;
      log(`  ${id}: THREW — ${String(e.message).slice(0, 160)}`);
      continue;
    }
    const errs = ((json && json.errors) || []).map(e => String((e && e.message) || e));
    if (errs.length && !errs.every(m => NOT_SCORED.test(m))) {
      // ⚠️ A VALIDATION ERROR IS NOT A FINDING. If the document is wrong, every
      // game reports nothing for a reason that has nothing to do with PlayHQ.
      rejected++;
      log(`  ${id}: ⚠️ DOCUMENT REJECTED — ${errs.join(' | ').slice(0, 300)}`);
      if (rejected >= 2) {
        console.error('\nFATAL: the document itself is being rejected, so every zero below would');
        console.error('be measuring this probe rather than PlayHQ. Every field in it was copied');
        console.error('from the page\'s own request, so the message above says which one did not');
        console.error('survive the copy. Nothing was written.');
        process.exit(1);
      }
      continue;
    }
    if (errs.length) { notScored++; log(`  ${id}: not electronically scored`); continue; }

    const g = json && json.data && json.data.game;
    if (!g) { notScored++; log(`  ${id}: answered with a null game`); continue; }
    answered++;

    const sides = ['home', 'away'];
    let topHits = 0, periodHits = 0, v2Hits = 0, resHits = 0, resPerHits = 0;
    let goalsTop = { home: 0, away: 0 }, goalsPeriod = { home: 0, away: 0 };

    for (const sd of sides) {
      const block = (g.statistics && g.statistics[sd]) || {};
      v2Hits += nonZero(block.statisticsV2).length;
      const res = (g.result && g.result[sd]) || {};
      resHits += nonZero(res.statistics).length;
      for (const p of (res.periods || [])) resPerHits += nonZero(p.statistics).length;

      for (const p of (block.players || [])) {
        playersSeen++;
        bump(permitTypes, p.permitType === null || p.permitType === undefined ? '(null)' : String(p.permitType));
        const top = nonZero(p.statistics);
        topHits += top.length;
        goalsTop[sd] += valOf(p.statistics, 'GOAL_COUNT') || 0;

        let perHits = 0;
        for (const ps of (p.periodStatistics || [])) {
          bump(periodTypes, ps.type === null || ps.type === undefined ? '(null)' : String(ps.type));
          bump(periodStatuses, ps.status === null || ps.status === undefined ? '(null)' : String(ps.status));
          bump(periodSides, ps.side === null || ps.side === undefined ? '(null)' : String(ps.side));
          const nz = nonZero(ps.statistics);
          perHits += nz.length;
          goalsPeriod[sd] += valOf(ps.statistics, 'GOAL_COUNT') || 0;
        }
        periodHits += perHits;
        if (top.length + perHits > 0) playersWithAnything++;

        // ⚠️ KEEP THE MOST INFORMATIVE PLAYER, NOT THE FIRST. v3 printed the
        // first and it was a legitimately blank line, which read as proof of a
        // universal zero. The blank one is kept too, so the log shows both.
        const score = top.length + perHits;
        if (score > bestScore) { bestScore = score; best = { id, sd, p }; }
        if (!zeroExample && score === 0) zeroExample = { id, sd, p };
      }
    }

    if (topHits) where.playerTop++;
    if (periodHits) where.playerPeriod++;
    if (v2Hits) where.teamV2++;
    if (resHits) where.teamResult++;
    if (resPerHits) where.resultPeriods++;

    log(`  ${id} ${String(g.status).padEnd(6)} non-zero counts — ` +
      `players.statistics ${topHits}, players.periodStatistics ${periodHits}, ` +
      `statisticsV2 ${v2Hits}, result.statistics ${resHits}, result.periods ${resPerHits}` +
      `  | goals top ${goalsTop.home}-${goalsTop.away}, per-period ${goalsPeriod.home}-${goalsPeriod.away}`);
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  log('\n═══ WHERE THE NUMBERS ARE ═══');
  log(`games answered: ${answered}; not e-scored: ${notScored}; rejected: ${rejected}`);
  log(`players seen: ${playersSeen}; players carrying ANY non-zero figure: ${playersWithAnything}`);
  log('\n   games with at least one non-zero value in each location:');
  log(`     players[].statistics                 ${where.playerTop} of ${answered}`);
  log(`     players[].periodStatistics[]         ${where.playerPeriod} of ${answered}`);
  log(`     statisticsV2 (team)                  ${where.teamV2} of ${answered}`);
  log(`     result.<side>.statistics (team)      ${where.teamResult} of ${answered}`);
  log(`     result.<side>.periods (team)         ${where.resultPeriods} of ${answered}`);

  log('\n   the periodStatistics discriminators v3 dropped:');
  log('     type:');   log(tallyLine(periodTypes, '       ') || '       (none)');
  log('     status:'); log(tallyLine(periodStatuses, '       ') || '       (none)');
  log('     side:');   log(tallyLine(periodSides, '       ') || '       (none)');
  log('     permitType on the player:');
  log(tallyLine(permitTypes, '       ') || '       (none)');

  if (best && bestScore > 0) {
    log(`\n── RAW: the player carrying the MOST non-zero values (${bestScore}) ──`);
    log(`   game ${best.id}, ${best.sd} side`);
    log(JSON.stringify(best.p));
  } else {
    log('\n⚠️ NO PLAYER IN ANY GAME CARRIED A SINGLE NON-ZERO VALUE.');
    log('   That is NOT "PlayHQ does not expose per-player statistics" — the page for');
    log('   2c9b42bc shows ten goals to East Ringwood, so the numbers exist and this');
    log('   response is not where they live. The Statistics tab fires its own request;');
    log('   only one request was captured on 2026-09-11 and it was evidently the');
    log('   scoreboard\'s. The next step is to capture the tab\'s request, not to guess');
    log('   another field name — guessing is what cost v1 and v2 five rejected trials');
    log('   while the answer sat in the network tab.');
  }
  if (zeroExample) {
    log(`\n── RAW: a player carrying NOTHING, for comparison (game ${zeroExample.id}) ──`);
    log(JSON.stringify(zeroExample.p));
  }

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
