#!/usr/bin/env node
// scripts/probe-game-stats.js
//
// READ-ONLY. Writes no file, commits nothing. NO call to api.playhq.com and NO
// session: the spectator endpoint takes no cookie on the afl tenant. Twelve
// calls at the defaults.
//
// v6 (2026-09-11) — THIS ONE DISCOVERS NAMES INSTEAD OF ASSERTING THEM.
//
// ⚠️ THE SAME MISTAKE FOUR TIMES. Every probe since v3 has asked for a statistic
// by a name carried over from somewhere else, got null or zero, and reported
// that as a fact about PlayHQ:
//
//   v3  summed players[].statistics GOAL_COUNT          -> 0.  Wrong name: the
//       spectator route calls a goal 6_POINT_SCORE.
//   v4  summed the same name again                      -> 0.
//   v4  called periodStatistics "per-quarter player goals" on the strength of
//       the rows existing                               -> every statistics
//       array empty in 528 rows. Accepted is not populated.
//   v5  read result.<side>.statistics 6_POINT_SCORE     -> null. v4 had already
//       MEASURED three populated entries per side, so the figures are there
//       under names nobody looked at.
//
// Four times the correct move was to print the keys rather than assert them, and
// four times a run was spent. So v6 asserts NOTHING. It collects every distinct
// `type.value` present at every location, prints the raw blocks for the first
// games, and reconciles using whichever goal-like key it actually FINDS —
// naming, in the output, which key it used. If PlayHQ's vocabulary differs again
// at some third location, this run says so instead of printing a zero.
//
// WHAT IS MEASURED AND SETTLED — none of it re-asked:
//   coverage: 12 of 58 sampled games electronically scored. Senior 5/5, U18 2/2,
//     roughly 1 in 20 across U8-U16, SER 0 of 12. (v3, 2026-09-11)
//   the box score is `query game($id: ID!)` on spectator.playhq.com — one call
//     per game, no cookie. `game(id:)` does NOT exist on api.playhq.com.
//   `periods(scope:)` is spectator-only; the main API has no PeriodScore type,
//     so the reference's "real field that is always empty" STANDS there.
//   per-player: 6_POINT_SCORE = goals, 1_POINT_SCORE = BEHINDS, plus
//     TOTAL_GOALS and TOTAL_BEHINDS. GOAL_COUNT, APPEARANCE and BEST_PLAYER are
//     zero for all 528 players in all 12 games.
//   ⚠️ BEHINDS EXIST on this route. The career work's "no behinds figure
//     anywhere" is true of the PROFILE route only.
//   82 of 528 player rows carry a score; 8 of 12 games have any player figure.
//
// THE ONE REMAINING QUESTION is whether the attribution is COMPLETE: does the
// sum of a side's player scores equal what that side actually kicked? A card
// naming four of ten goalkickers is worse than no card, because nothing tells
// the reader which six are missing.
//
// Env: PROBE_GAME_IDS (csv; defaults to the twelve known e-scored),
//      PROBE_RATE (100), PROBE_WINDOW_MS (80000), PROBE_MAX_GAMES (12),
//      PROBE_DUMP_GAMES (2) — how many games to print raw blocks for.
//
// Exit codes: 0 = it ran. 1 = the document was rejected, or nothing answered.

'use strict';

const playhq = require('./lib/playhq');
const { specPost, sleep } = playhq;

const VERSION = 'probe-game-stats v6 2026-09-11 discover-then-reconcile';

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
const DUMP_GAMES = Math.max(0, Number(process.env.PROBE_DUMP_GAMES || 2));
const IDS = String(process.env.PROBE_GAME_IDS || '')
  .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log(...a);

// statisticsV2 carries `type { type value }` — two fields, both selected,
// because which of them holds the name is itself something I have not verified.
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

// ── Discovery, not assertion ─────────────────────────────────────────────────
// A statistics array becomes a plain map of name -> count, and the NAMES are
// collected as evidence in their own right. Nothing below asks for a key it has
// not first seen in the response.
function toMap(stats) {
  const m = new Map();
  for (const s of (stats || [])) {
    const k = (s && s.type && (s.type.value !== undefined && s.type.value !== null ? s.type.value : s.type.type));
    if (k === undefined || k === null || k === '') continue;
    m.set(String(k), Number(s.count));
  }
  return m;
}
// Candidates in preference order. The FIRST one actually present wins, and the
// caller reports which — so a silent fallback can never be mistaken for a match
// on the preferred name.
const GOAL_KEYS = ['6_POINT_SCORE', 'TOTAL_GOALS', 'GOALS', 'GOAL_COUNT'];
const BEHIND_KEYS = ['1_POINT_SCORE', 'TOTAL_BEHINDS', 'BEHINDS', 'BEHIND_COUNT'];
const SCORE_KEYS = ['TOTAL_SCORE', 'SCORE', 'POINTS'];
function pick(map, keys) {
  for (const k of keys) if (map.has(k)) return { key: k, value: map.get(k) };
  return { key: null, value: null };
}
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const tally = (m, indent) => [...m.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${indent}${String(k).padEnd(28)} ${n}`).join('\n');
const showMap = (m) => m.size ? [...m.entries()].map(([k, v]) => `${k}=${v}`).join(' ') : '(empty)';

async function main() {
  const ids = (IDS.length ? IDS : DEFAULT_IDS).slice(0, MAX_GAMES);
  log(`=== ${VERSION} ===`);
  log(`${ids.length} game(s), spectator endpoint only — no session, no main-API call.`);
  log('READ-ONLY: this run writes no file and commits nothing.\n');
  log('⚠️ This run ASSERTS NO FIELD NAME. It prints the keys it finds at each location,');
  log('   then reconciles with whichever it found, naming the key it used.\n');

  let answered = 0, notScored = 0, rejected = 0, dumped = 0;
  const keysResult = new Map(), keysV2 = new Map(), keysPlayer = new Map(), keysPeriod = new Map();
  let sides = 0, exact = 0, partial = 0, empty = 0, over = 0, noRef = 0, noRows = 0;
  let arithOk = 0, arithBad = 0, arithUnknown = 0;
  let unattributedGoals = 0, partialSides = 0;
  const goalKeyUsed = new Map(), refSourceUsed = new Map();

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
      const sblock = ((g.statistics && g.statistics[sd]) || {});
      const rblock = ((g.result && g.result[sd]) || {});
      const players = sblock.players || [];

      const mResult = toMap(rblock.statistics);
      const mV2 = toMap(sblock.statisticsV2);
      for (const k of mResult.keys()) bump(keysResult, k);
      for (const k of mV2.keys()) bump(keysV2, k);
      for (const p of players) for (const k of toMap(p.statistics).keys()) bump(keysPlayer, k);
      for (const per of (rblock.periods || [])) for (const k of toMap(per.statistics).keys()) bump(keysPeriod, k);

      // ⚠️ SHOW THE RAW BLOCKS. Four runs were spent on names asserted rather
      // than read; the cheapest insurance against a fifth is printing them.
      if (dumped < DUMP_GAMES) {
        log(`\n  ── raw keys, ${id} ${sd} ──`);
        log(`     result.${sd}.statistics : ${showMap(mResult)}`);
        log(`     statisticsV2           : ${showMap(mV2)}`);
        const scorer = players.find(p => [...toMap(p.statistics).values()].some(v => v > 0));
        log(`     a player WITH figures  : ${scorer ? `${scorer.name} -> ${showMap(toMap(scorer.statistics))}` : '(none on this side)'}`);
        const per0 = (rblock.periods || [])[0];
        log(`     result.periods[0]      : ${per0 ? `${per0.period && per0.period.value} -> ${showMap(toMap(per0.statistics))}` : '(none)'}`);
      }

      // The reference figure: result.<side>.statistics first, statisticsV2 as a
      // fallback, and the source is REPORTED so a fallback cannot pass as the
      // primary.
      let ref = mResult, refName = `result.${sd}.statistics`;
      if (pick(mResult, GOAL_KEYS).key === null && pick(mV2, GOAL_KEYS).key !== null) {
        ref = mV2; refName = 'statisticsV2';
      }
      const tg = pick(ref, GOAL_KEYS), tb = pick(ref, BEHIND_KEYS), ts = pick(ref, SCORE_KEYS);

      const pgKey = GOAL_KEYS.find(k => players.some(p => toMap(p.statistics).has(k))) || null;
      const pbKey = BEHIND_KEYS.find(k => players.some(p => toMap(p.statistics).has(k))) || null;
      const pg = pgKey ? players.reduce((n, p) => n + (toMap(p.statistics).get(pgKey) || 0), 0) : null;
      const pb = pbKey ? players.reduce((n, p) => n + (toMap(p.statistics).get(pbKey) || 0), 0) : null;
      const scorers = players.filter(p => [...toMap(p.statistics).values()].some(v => v > 0)).length;

      sides++;
      if (tg.key) bump(refSourceUsed, `${refName}.${tg.key}`);
      if (pgKey) bump(goalKeyUsed, `players.${pgKey}`);

      // ⚠️ CHECK THE REFERENCE BEFORE TRUSTING IT: 6 x goals + behinds must be
      // the total, or the player rows are being compared with a figure that
      // disagrees with itself.
      if (tg.value !== null && tb.value !== null && ts.value !== null) {
        if (tg.value * 6 + tb.value === ts.value) arithOk++; else arithBad++;
      } else arithUnknown++;

      let verdict;
      if (tg.key === null) { noRef++; verdict = `NO GOAL-LIKE KEY in either team block — keys were: ${showMap(ref)}`; }
      else if (!players.length) { noRows++; verdict = 'NO PLAYER ROWS AT ALL'; }
      else if (pgKey === null) { empty++; verdict = `team kicked ${tg.value}.${tb.value}, NO goal-like key on any player row`; }
      else if (pg === 0 && (pb || 0) === 0) { empty++; verdict = `EMPTY — team kicked ${tg.value}.${tb.value}, every player figure zero`; }
      else if (pg === tg.value && (tb.value === null || pb === tb.value)) { exact++; verdict = `EXACT — ${scorers} player(s) account for all ${tg.value}.${tb.value}`; }
      else if (pg > tg.value || (tb.value !== null && pb > tb.value)) { over++; verdict = `⚠️ OVER — players ${pg}.${pb} EXCEED the team's ${tg.value}.${tb.value}`; }
      else {
        partial++; partialSides++; unattributedGoals += (tg.value - pg);
        verdict = `PARTIAL — players ${pg}.${pb} against ${tg.value}.${tb.value}, ` +
          `${tg.value - pg} goal(s) unattributed`;
      }
      log(`  ${id} ${sd.padEnd(4)} ${String(players.length).padStart(2)} players  ${verdict}` +
        `${tg.key ? `   [ref ${refName}.${tg.key}${pgKey ? `, players.${pgKey}` : ''}]` : ''}`);
    }
    if (dumped < DUMP_GAMES) dumped++;
  }

  log('\n═══ KEYS ACTUALLY PRESENT ═══');
  log('  result.<side>.statistics:'); log(tally(keysResult, '    ') || '    (none)');
  log('  statisticsV2:');             log(tally(keysV2, '    ') || '    (none)');
  log('  players[].statistics:');     log(tally(keysPlayer, '    ') || '    (none)');
  log('  result.<side>.periods[].statistics:'); log(tally(keysPeriod, '    ') || '    (none)');

  log('\n═══ IS THE ATTRIBUTION COMPLETE? ═══');
  log(`games answered ${answered}; not e-scored ${notScored}; rejected ${rejected}`);
  log(`team sides examined: ${sides}`);
  log(`\n  EXACT — every goal and behind attributed:   ${exact} of ${sides}`);
  log(`  PARTIAL — some of the score unattributed:   ${partial}`);
  log(`  EMPTY — team scored, no player figures:     ${empty}`);
  log(`  OVER — players exceed the team total:       ${over}`);
  log(`  no goal-like key in the team block:         ${noRef}`);
  log(`  no player rows at all:                      ${noRows}`);
  if (partialSides) {
    log(`  goals unattributed on partial sides: ${unattributedGoals} across ${partialSides} side(s)` +
      ` (mean ${(unattributedGoals / partialSides).toFixed(1)})`);
  }
  log(`\n  team arithmetic (6 x goals + behinds = total): ${arithOk} right, ${arithBad} wrong, ${arithUnknown} not checkable`);
  log('  ⚠️ A non-zero "wrong" makes every verdict above unsafe: the player rows would');
  log('     have been measured against a reference that disagrees with itself.');
  log('\n  keys the reconciliation actually used:');
  log(tally(refSourceUsed, '    ') || '    (none)');
  log(tally(goalKeyUsed, '    ') || '    (none)');

  log('\n  What this decides: EXACT sides can be published. PARTIAL ones cannot, unless');
  log('  the card says so — naming four of ten goalkickers is worse than naming none.');

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
