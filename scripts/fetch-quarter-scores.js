#!/usr/bin/env node
// scripts/fetch-quarter-scores.js
//
// Adds a per-quarter breakdown to stored match records.
//
// WHERE THE DATA IS. `result.home.periods` is accepted on discoverGame on the
// MAIN API — probed 2026-08-31. Every other candidate name was rejected
// (periodStatistics, periodScores, scoreByPeriod, quarters, statisticsByPeriod).
// It returned an empty array without arguments, which is why this asks for
// `periods(scope: BY_PERIOD)` — the same argument the spectator endpoint takes.
//
// ⚠️ NOT THE SPECTATOR ENDPOINT. An earlier probe only asked there, found 24 of
// 66 games, and reported that as the coverage. That was the wrong endpoint: the
// spectator API only knows electronically-scored games, while PlayHQ's site shows
// quarters for virtually everything.
//
// TWO ROUTES, cheapest first:
//   ROUND   one discoverFixtureByRound call returns every game in a round. If
//           periods work there, a whole grade costs ~18 calls.
//   GAME    one discoverGame call per game. ~5,500 calls for a season.
// Which is available is TESTED at startup rather than assumed, because a rejected
// field fails the whole query and would otherwise look like "no game has
// quarters".
//
// STORAGE. Two new fields on a match record, and only where the data exists:
//   hQ: [8, 3, 17, 3]   aQ: [12, 19, 6, 15]
// Cumulative or per-quarter is whatever PlayHQ returns; this stores it as given
// and CHECKS the total against the stored score before writing.
//
// USAGE
//   node scripts/fetch-quarter-scores.js                    # dry run, reports coverage
//   node scripts/fetch-quarter-scores.js --apply
//   QS_COMP="EFNL 2026" node scripts/fetch-quarter-scores.js --apply
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'fetch-quarter-scores v8 2026-09-04 checkpointed';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const APPLY  = process.argv.includes('--apply') || process.env.QS_APPLY === 'true';
const COMP   = (process.env.QS_COMP || '').trim();
const YEAR   = (process.env.QS_YEAR || '2026').trim();
const MAXCALL = Math.max(50, Number(process.env.QS_MAX_CALLS || 4000));
// ⚠️ RESUMABLE. A record that already carries hQ/aQ is not asked about again.
//
// Without this, fixing a extraction bug means re-fetching every game to recover
// the ones that were wrongly discarded — 5,077 calls and half an hour to gather
// perhaps 1,500. With it, a re-run costs only the gaps.
//
// Set QS_REDO=true to force a full re-fetch, which is what you want if the
// EXTRACTION changed in a way that could alter values already stored, rather than
// only rescuing ones that were skipped.
const REDO = process.env.QS_REDO === 'true';
// ⚠️ CHECKPOINT. Everything used to be held in memory and written once at the
// end, so a WAF block, a timeout or any crash at minute 29 threw away half an
// hour of calls — and the commit step then found nothing to commit and reported
// success. Written every N resolved records instead.
//
// The cost is a whole-file write per checkpoint. The season file is a few MB and
// the write is local, so 250 is cheap; the commit still happens once, in the
// workflow, at the end.
const CHECKPOINT = Math.max(0, Number(process.env.QS_CHECKPOINT || 250));

// ⚠️ NO ARGUMENT. `periods` on GameTeamResult takes none —
// `Unknown argument "scope" on field "GameTeamResult.periods"`, measured
// 2026-09-04. The bare field was accepted the first time it was probed and
// returned an empty array for that one game, which I read as "needs an argument"
// rather than "that game has none". One game is not a sample.
// ⚠️ THE PERIODS ARE ON `statistics`, NOT ON `result`.
//
//   discoverGame.statistics.home.periods[]     ← the period table
//   discoverGame.result.home.periods[]         ← exists, always empty
//
// Captured from the game-centre page's own request, 2026-09-04. Every earlier
// probe asked `result`, found a valid `periods` field there, got an empty array,
// and concluded PlayHQ did not expose the data. The field was real and the wrong
// one — being accepted proved nothing about being correct.
//
// SHAPE, from the Mt Eliza v Narre North game (42-33):
//   statistics.home.periods = [
//     { period: { value: 'THIRD_QTR' },  statistics: [ { type:{value:'TOTAL_SCORE'}, count: 26 }, ... ] },
//     { period: { value: 'FIRST_QTR' },  statistics: [ { type:{value:'TOTAL_SCORE'}, count: 10 }, ... ] },
//     ...
//   ]
//
// ⚠️ TWO THINGS THAT WILL BITE:
//
// 1. THE ARRAY IS UNORDERED. That game returned THIRD, FIRST, FOURTH, SECOND.
//    Reading it positionally gives a scrambled quarter line. Order comes from
//    round.grade.periods, which lists Q1..Q4 properly.
//
// 2. THE API IS PER-QUARTER; THE SITE SHOWS CUMULATIVE. Home was 10, 6, 26, 0 —
//    which sums to the stored 42. The site's "10, 16, 42, 42" is that running
//    total, because the grade's periodScoresDisplayType is END_OF_PERIOD. Stored
//    here as PER-QUARTER, and the dashboard can total it if that is what you
//    want to show.
const PERIOD_BLOCK =
  'periods { period { value } statistics { count type { value } } }';

const Q_GAME_PERIODS = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    round { grade { hasPeriodScores periods { value shortName } } }
    statistics { home { ${PERIOD_BLOCK} } away { ${PERIOD_BLOCK} } }
  }
}`;

// ⚠️ TOTAL_SCORE IS NOT ALWAYS PRESENT — DERIVE IT.
//
// v5 required TOTAL_SCORE in every period and returned null for the WHOLE game if
// any period lacked it, so one quarter recorded as goals and behinds alone threw
// away the other three. That is the most likely reason 36% came back "empty" in a
// set of grades where quarter scores are near-universal.
//
// The tenant config gives the arithmetic: 6_POINT_SCORE has pointValue 6,
// 1_POINT_SCORE has 1. Deriving is exact, not an estimate.
// TOTAL_SCORE out of a period's statistics array.
const pScore = (stats) => {
  const arr = stats || [];
  const t = arr.find(x => x.type?.value === 'TOTAL_SCORE');
  if (t && t.count !== null && t.count !== undefined) return t.count;
  const g = arr.find(x => x.type?.value === '6_POINT_SCORE');
  const b = arr.find(x => x.type?.value === '1_POINT_SCORE');
  if (g || b) return (g?.count || 0) * 6 + (b?.count || 0);
  return null;
};
// ⚠️ ORDERED BY THE GRADE'S OWN PERIOD LIST, never by array position.
// The Mt Eliza game returned THIRD, FIRST, FOURTH, SECOND.
// Returns the quarters, or a REASON string. A single "empty" counter cannot
// distinguish "PlayHQ has nothing" from "this code rejected it", and that is
// exactly the distinction needed to tell a data gap from a defect.
const toQuarters = (periods, order) => {
  if (!Array.isArray(periods)) return { reason: 'no periods field' };
  if (!periods.length) return { reason: 'periods array empty' };
  const byValue = new Map();
  for (const p of periods) {
    const v = p?.period?.value;
    if (v) byValue.set(v, pScore(p.statistics));
  }
  // Fall back to the standard AFL sequence if the grade did not supply one.
  const seq = (order && order.length ? order : ['FIRST_QTR','SECOND_QTR','THIRD_QTR','FOURTH_QTR']);
  const out = seq.map(v => byValue.get(v));
  // A quarter genuinely scoreless is 0, not missing. Only a MISSING period is a
  // reason to reject the row.
  if (out.every(v => v !== null && v !== undefined)) return { q: out };
  const got = seq.filter(v => byValue.has(v)).length;
  return { reason: `${got} of ${seq.length} periods present`, partial: out };
};

const isRejection = (json) => (json.errors || []).some(e =>
  /Cannot query field|Unknown (type|argument)|not defined|Expected type/i.test(String(e?.message || '')));

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log(`Mode: ${APPLY ? 'APPLY — records will be updated' : 'DRY RUN — nothing will be written'}`);
  console.log(`Season year: ${YEAR}${COMP ? `, competition ${COMP}` : ''}\n`);

  const scope = COMP ? [COMP] : null;
  const data = store.load(scope, { players: false });

  // Completed games in the target year, with or without a stored gameId — the
  // ROUND route supplies the id, so a record written before engine v16 is not
  // excluded the way a game-id-only approach would exclude 98% of them.
  const yearOf = (c) => (String(c || '').match(/\b(\d{4})\b/) || [])[1] || '';
  const target = (data.matches || []).filter(m =>
    yearOf(m.compName) === YEAR && !m.isBye && !m.isPartial && !m.scheduled && !m.live &&
    m.hScore !== null && m.hScore !== undefined);

  if (!target.length) {
    console.error(`No completed ${YEAR} records in scope.`);
    process.exit(1);
  }
  const already = target.filter(m => Array.isArray(m.hQ) && m.hQ.length).length;
  console.log(`${target.length} completed ${YEAR} record(s); ${already} already carry quarters.`);
  if (already && !REDO) {
    console.log(`Skipping those ${already} — only the gaps will be asked about.`);
    console.log('Set redo=true to re-fetch everything.');
  } else if (already && REDO) {
    console.log(`REDO — all ${already} will be re-fetched and overwritten.`);
  }

  // ── Which route works? Tested, not assumed. ───────────────────────────────
  // ⚠️ SEVERAL GAMES, NOT ONE. An empty array from a single game says nothing
  // about the field — it may simply be a game nobody entered quarters for. The
  // first probe of this field drew exactly that wrong conclusion.
  const samples = target.filter(m => m.gameId).slice(0, 6);
  let gameRoute = false, gameWithData = 0;
  for (const smp of samples) {
    let r;
    try { r = await gqlPost(Q_GAME_PERIODS, { gameID: smp.gameId }, 'DiscoverGame'); }
    catch (e) { console.log(`  discoverGame probe failed: ${e.message}`); break; }
    if (isRejection(r)) {
      console.log('  discoverGame + periods REJECTED:');
      for (const e of (r.errors || []).slice(0, 2)) console.log(`    ${e.message}`);
      gameRoute = false;
      break;
    }
    gameRoute = true;
    const g = r?.data?.discoverGame;
    const order = (g?.round?.grade?.periods || []).map(x => x.value);
    const r0 = toQuarters(g?.statistics?.home?.periods, order);
    if (r0.q) gameWithData++;
    console.log(`    ${smp.date} ${smp.home} v ${smp.away} — ` +
      `${r0.q ? r0.q.join(', ') : '(' + r0.reason + ')'}`);
    await sleep(200);
  }
  if (gameRoute) {
    console.log(`  discoverGame.periods accepted; ${gameWithData} of ${samples.length} ` +
      `sampled game(s) carried a breakdown`);
  }

  const roundRoute = false;   // periods are not on discoverFixtureByRound

  if (!gameRoute && !roundRoute) {
    console.error('\nNeither route accepts a periods field. Nothing can be fetched.');
    process.exit(1);
  }
  if (gameRoute && !gameWithData && !roundRoute) {
    console.log('\n⚠️  The field EXISTS but every sampled game returned an empty array.');
    console.log('    That is a real answer: PlayHQ is not exposing a breakdown through');
    console.log('    this field for these games. Continuing anyway across the full set —');
    console.log('    six games is a small sample and the run costs only calls — but do');
    console.log('    not expect much.');
  }
  console.log(`\nRoute: ${roundRoute ? 'ROUND (cheap)' : 'GAME (one call per game)'}\n`);

  // Moves resolved quarters onto the records and writes the file. Safe to call
  // mid-run: it only touches records this run resolved, and clears the scratch
  // field so a later checkpoint does not rewrite the same ones.
  let checkpointed = 0;
  const flush = globalThis.__qsFlush = (why) => {
    if (!APPLY) return 0;
    let n = 0;
    for (const m of data.matches || []) {
      if (!m._q) continue;
      m.hQ = m._q[0]; m.aQ = m._q[1];
      delete m._q;
      n++;
    }
    if (!n) return 0;
    try {
      store.save(data, scope, { players: false });
      checkpointed += n;
      console.log(`    …checkpoint: ${n} record(s) written (${checkpointed} this run) — ${why}`);
    } catch (e) {
      console.error(`    ⚠️ checkpoint FAILED: ${e.message}`);
      // Not fatal. The records keep their values in memory and the next
      // checkpoint or the final save will try again.
    }
    return n;
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const byGameId = new Map();
  for (const m of target) if (m.gameId) byGameId.set(m.gameId, m);

  let calls = 0, found = 0, mismatch = 0, empty = 0, noPeriodGrade = 0;
  const emptyWhy = new Map();
  const emptyEx = [];
  const mismatches = [];

  const applyTo = (rec, hq, aq) => {
    // ⚠️ THE PARTS MUST MAKE THE WHOLE. If the quarters do not sum to the stored
    // score, the breakdown belongs to a different game or a different scale, and
    // showing it beside the total would be worse than showing nothing.
    const hs = hq.reduce((a, b) => a + b, 0);
    const as = aq.reduce((a, b) => a + b, 0);
    // PER-QUARTER is what the API returns, so the sum is the expected match.
    // Cumulative is accepted too in case a grade is configured differently —
    // measured once, not assumed to hold everywhere.
    const cum = hq[hq.length - 1] === rec.hScore && aq[aq.length - 1] === rec.aScore;
    if (hs === rec.hScore && as === rec.aScore) { rec._q = [hq, aq, 'per-quarter']; return true; }
    if (cum) { rec._q = [hq, aq, 'cumulative']; return true; }
    mismatch++;
    if (mismatches.length < 10) {
      mismatches.push(`${rec.id}  stored ${rec.hScore}-${rec.aScore}  ` +
        `quarters ${hq.join('.')}=${hs} / ${aq.join('.')}=${as}`);
    }
    return false;
  };

  if (roundRoute) {
    const roundsByGrade = new Map();
    for (const m of target) {
      if (!m.gradeId) continue;
      if (!roundsByGrade.has(m.gradeId)) roundsByGrade.set(m.gradeId, new Set());
    }
    // ⚠️ SAY SOMETHING WHILE IT WORKS. v2 printed nothing between the route
    // decision and the final report — about 1,000 grades and up to 3,000 round
    // calls, eight minutes of silence, indistinguishable from a hang.
    const gradeList = [...roundsByGrade.keys()];
    const started = Date.now();
    console.log(`Walking ${gradeList.length} grade(s). Cap ${MAXCALL} calls.\n`);
    let gi = 0;
    for (const gradeId of gradeList) {
      if (calls >= MAXCALL) {
        console.log(`\nCall cap reached at grade ${gi} of ${gradeList.length} — ` +
          `re-run to continue, or raise max_calls.`);
        break;
      }
      gi++;
      const sample = target.find(m => m.gradeId === gradeId);
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${gi}/${gradeList.length}] ${sample ? sample.compName + ' ' + sample.age + ' ' + sample.rawGrade : gradeId}` +
        `  (${calls} calls, ${mins} min, ${found} found)`);
      // Nothing in this grade can be matched without a stored gameId, so the
      // rounds call would be spent for certain. 98% of records predate engine
      // v16 — skipping these is most of the run.
      const matchable = target.some(m => m.gradeId === gradeId && m.gameId);
      if (!matchable) { console.log('    no record here carries a gameId — skipped'); continue; }

      let rounds = [];
      try {
        const rr = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: gradeId });
        rounds = rr?.data?.discoverGrade?.rounds || [];
        calls++;
      } catch (e) { continue; }
      for (const round of rounds) {
        if (calls >= MAXCALL) break;
        let games = [];
        try {
          const r = await gqlPost(Q_ROUND_PERIODS, { roundID: round.id }, 'discoverFixtureByRound');
          games = r?.data?.discoverFixtureByRound?.games || [];
          calls++;
        } catch (e) { continue; }
        for (const g of games) {
          const rec = byGameId.get(g.id);
          if (!rec) continue;                    // pre-v16 record, or another season
          const hq = toQuarters(g.result?.home?.periods);
          const aq = toQuarters(g.result?.away?.periods);
          if (!hq || !aq) { empty++; continue; }
          if (applyTo(rec, hq, aq)) found++;
        }
        await sleep(120);
      }
    }
  } else {
    // ⚠️ PROGRESS ON THIS ROUTE TOO. v3 added it to the round route only, and the
    // game route is the one that actually runs — 1,135 calls of silence, which is
    // indistinguishable from a hang. Reported twice.
    const todo = target.filter(m => m.gameId &&
      (REDO || !(Array.isArray(m.hQ) && m.hQ.length)));
    const started = Date.now();
    console.log(`${todo.length} game(s) carry a gameId and can be asked about.`);
    console.log(`${target.length - todo.length} cannot — written before engine v16.`);
    console.log(`Roughly ${Math.ceil(todo.length * 0.35 / 60)} min.\n`);
    let i = 0;
    for (const m of todo) {
      if (calls >= MAXCALL) {
        console.log(`\nCall cap reached after ${i} of ${todo.length} — re-run or raise max_calls.`);
        break;
      }
      i++;
      // Every 50, not every game: 1,135 lines is its own kind of unreadable.
      if (i % 50 === 1) {
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        console.log(`  [${i}/${todo.length}] ${m.compName} ${m.age} ${m.rawGrade} ` +
          `— ${found} found, ${empty} empty, ${mismatch} unreconciled (${mins} min)`);
      }
      try {
        const r = await gqlPost(Q_GAME_PERIODS, { gameID: m.gameId }, 'DiscoverGame');
        calls++;
        const g = r?.data?.discoverGame;
        // The grade says whether a period table should exist at all. A grade with
        // hasPeriodScores false is not a gap — nobody records quarters there.
        if (g?.round?.grade?.hasPeriodScores === false) { noPeriodGrade++; continue; }
        const order = (g?.round?.grade?.periods || []).map(x => x.value);
        const rh = toQuarters(g?.statistics?.home?.periods, order);
        const ra = toQuarters(g?.statistics?.away?.periods, order);
        if (!rh.q || !ra.q) {
          empty++;
          // Which side, and why. "empty" alone cannot separate a PlayHQ gap from
          // a rejection by this code.
          const why = !rh.q && !ra.q ? `both: ${rh.reason}`
                    : !rh.q ? `home: ${rh.reason}` : `away: ${ra.reason}`;
          emptyWhy.set(why, (emptyWhy.get(why) || 0) + 1);
          if (emptyEx.length < 10) emptyEx.push(`${m.id}  ${why}`);
          continue;
        }
        if (applyTo(m, rh.q, ra.q)) found++;
      } catch (e) { /* counted as empty below */ }
      if (CHECKPOINT && found && found % CHECKPOINT === 0) flush(`${i}/${todo.length}`);
      await sleep(120);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const withId = target.filter(m => m.gameId).length;
  console.log('RESULT');
  console.log('─'.repeat(72));
  console.log(`  API calls made                 ${calls}${calls >= MAXCALL ? '  (hit QS_MAX_CALLS)' : ''}`);
  console.log(`  ${YEAR} completed records        ${target.length}`);
  console.log(`  ...carrying a gameId           ${withId}` +
    (withId < target.length
      ? `  ⚠️ ${target.length - withId} cannot be matched — written before engine v16`
      : ''));
  console.log(`  quarters found and consistent  ${found}`);
  console.log(`  returned nothing               ${empty}`);
  console.log(`  grade records no quarters      ${noPeriodGrade}  (hasPeriodScores false — not a gap)`);
  if (emptyWhy.size) {
    console.log('\n  Why nothing was returned:');
    for (const [why, n] of [...emptyWhy].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${why}`);
    }
    console.log('\n  Examples:');
    for (const e of emptyEx) console.log(`    ${e}`);
    console.log('\n  ⚠️ "periods array empty" means PlayHQ returned nothing for that side.');
    console.log('     Anything else is this code rejecting data that was present —');
    console.log('     check those against the game on the PlayHQ site before trusting');
    console.log('     the coverage figure.');
  }
  console.log(`  quarters that did NOT reconcile ${mismatch}`);
  console.log('─'.repeat(72));
  if (mismatches.length) {
    console.log('\n⚠️ NOT WRITTEN — the parts do not make the whole:');
    for (const s of mismatches) console.log(`  ${s}`);
  }

  const sample = target.find(m => m._q);
  if (sample) {
    const [hq, aq, kind] = sample._q;
    console.log(`\nEXAMPLE (${kind})`);
    console.log(`  ${sample.compName} ${sample.age} ${sample.rawGrade}  ${sample.date}`);
    console.log(`  ${sample.home} v ${sample.away}   stored ${sample.hScore}-${sample.aScore}`);
    console.log(`  home  ${hq.join('  ')}`);
    console.log(`  away  ${aq.join('  ')}`);
  }

  if (!found) {
    console.log('\nNothing to write.');
    console.log(`=== ${VERSION} complete ===`);
    return;
  }
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. ${found} record(s) would gain hQ/aQ.`);
    console.log(`=== ${VERSION} complete ===`);
    return;
  }

  // flush() writes the file itself. A second store.save here would rewrite an
  // identical file and report it as a change.
  const written = flush('final');
  console.log(`\n${written} record(s) written in the final pass; ` +
    `${checkpointed} in total this run.`);
  if (typeof logSummary === 'function') logSummary('fetch-quarter-scores');
  console.log(`=== ${VERSION} complete ===`);
}

// ⚠️ A CRASH MUST NOT DISCARD WHAT WAS ALREADY GATHERED. The last checkpoint is
// already on disk, and anything resolved since is flushed here before exiting.
// Exit 1 still, so the workflow shows the failure — but the commit step runs on
// always() and picks up the partial file.
main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  try {
    if (typeof globalThis.__qsFlush === 'function') {
      const n = globalThis.__qsFlush('after a fatal error');
      console.error(`Salvaged ${n} record(s) resolved before the failure.`);
    }
  } catch (e2) {
    console.error('Salvage also failed:', e2.message);
  }
  process.exit(1);
});
