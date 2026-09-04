#!/usr/bin/env node
// scripts/backfill-game-ids.js
//
// Stamps PlayHQ's `gameId` onto stored match records that do not have one.
//
// WHY. Engine v16 (2026-08-16) started recording `gameId`. Everything written
// before that has none — 12,023 of 13,158 completed 2026 records, and effectively
// all of 2022-2025. Anything keyed on PlayHQ's game id therefore reaches about 8%
// of the data: quarter scores, live scores, and the player panel's exact join all
// depend on it.
//
// HOW. One discoverFixtureByRound call per round returns every game with its id
// and both team names. Those are matched to stored records for the same grade and
// round. About 18 calls per grade, against ~13,000 per-game calls.
//
// ⚠️ THIS IS THE FUZZY MATCH THAT PUT U9 SCORES ON A U11 PLAYER'S CARD.
//
// On 2026-08-20 the player panel joined PlayHQ rows to stored records on round
// plus team names. cleanTeam strips the age, so a club's U9, U10 and U11 sides all
// reduce to one string, and `find` returned whichever came first — wrong score,
// wrong result, wrong age, all looking perfectly consistent.
//
// The same trap is here, and the defences are:
//
//   SCOPED BY GRADE      the fixture call is per round of ONE grade, so a
//                        different age group is not in the candidate set at all
//   EXACT PAIR ONLY      both team names must match after the same cleanTeam the
//                        engine used; one-sided matches are refused
//   UNIQUE ONLY          if two stored records or two PlayHQ games in a round
//                        reduce to the same pair, ALL of them are refused — a
//                        double-header is exactly where a wrong id does damage
//   SCORE MUST AGREE     where PlayHQ reports a final score it must equal the
//                        stored one, or the id belongs to a different game
//
// Everything refused is counted and reported. A silent skip here would be
// indistinguishable from a game PlayHQ no longer serves.
//
// USAGE
//   node scripts/backfill-game-ids.js                       # dry run
//   node scripts/backfill-game-ids.js --apply
//   GID_COMP="EFNL 2026" GID_YEAR=2026 node scripts/backfill-game-ids.js --apply
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'backfill-game-ids v1 2026-09-04';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const APPLY   = process.argv.includes('--apply') || process.env.GID_APPLY === 'true';
const COMP    = (process.env.GID_COMP || '').trim();
const YEAR    = (process.env.GID_YEAR || '').trim();
const MAXCALL = Math.max(50, Number(process.env.GID_MAX_CALLS || 6000));

const Q_ROUND = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      status { value }
      home { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      result {
        home { statistics { count type { value } } }
        away { statistics { count type { value } } }
      }
    }
  }
}`;

const scoreOf = (stats) => {
  const s = (stats || []).find(x => x.type?.value === 'TOTAL_SCORE');
  return s ? s.count : null;
};

// The SAME normalisation the engine stored with, so the two sides are comparable.
// Anything else and a match would depend on which script wrote the record.
const norm = (n, age) => {
  try { return engine.cleanTeam(String(n || ''), age) || ''; }
  catch (e) { return String(n || '').trim(); }
};
const pairKey = (a, b) => [a, b].map(x => x.toLowerCase()).sort().join('|');

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log(`Mode: ${APPLY ? 'APPLY — ids will be written' : 'DRY RUN — nothing will be written'}`);
  console.log(`${COMP ? `Competition ${COMP}` : 'All competitions'}${YEAR ? `, year ${YEAR}` : ''}\n`);

  const scope = COMP ? [COMP] : null;
  const data = store.load(scope, { players: false });
  const yearOf = (c) => (String(c || '').match(/\b(\d{4})\b/) || [])[1] || '';

  const all = (data.matches || []).filter(m =>
    !m.isBye && !m.isPartial && (!YEAR || yearOf(m.compName) === YEAR));
  const missing = all.filter(m => !m.gameId && m.gradeId);

  console.log(`${all.length} record(s) in scope; ${missing.length} without a gameId.`);
  if (!missing.length) { console.log('Nothing to do.'); return; }

  // Grouped by grade so one rounds call serves every round of that grade.
  const byGrade = new Map();
  for (const m of missing) {
    if (!byGrade.has(m.gradeId)) byGrade.set(m.gradeId, []);
    byGrade.get(m.gradeId).push(m);
  }
  const grades = [...byGrade.keys()];
  console.log(`${grades.length} grade(s) to walk. Roughly ` +
    `${Math.ceil(grades.length * 12 * 0.25 / 60)} min.\n`);

  let calls = 0, stamped = 0;
  const refused = { pair: 0, ambiguous: 0, score: 0, noGame: 0 };
  const examples = [];
  const started = Date.now();
  let gi = 0;

  for (const gradeId of grades) {
    if (calls >= MAXCALL) {
      console.log(`\nCall cap reached at grade ${gi} of ${grades.length}.`);
      break;
    }
    gi++;
    const recs = byGrade.get(gradeId);
    const sample = recs[0];
    if (gi % 25 === 1) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`  [${gi}/${grades.length}] ${sample.compName} ${sample.age} ${sample.rawGrade}` +
        ` — ${stamped} stamped (${mins} min)`);
    }

    let rounds = [];
    try {
      const rr = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: gradeId });
      rounds = rr?.data?.discoverGrade?.rounds || [];
      calls++;
    } catch (e) { continue; }

    // Only the rounds that actually contain a record needing an id.
    const wanted = new Set(recs.map(m => String(m.round)));
    for (const round of rounds) {
      if (calls >= MAXCALL) break;
      const rNum = String(round.number);
      const isF = round.isFinalsRound === true;
      // Finals restart numbering at 1, so a bare number cannot identify the round
      // — the stored records carry finalsAbbrev and that is what must match.
      const roundRecs = recs.filter(m => isF
        ? (m.isFinals && String(m.finalsAbbrev || '') === String(round.abbreviatedName || ''))
        : (!m.isFinals && String(m.round) === rNum));
      if (!roundRecs.length) continue;
      if (!isF && !wanted.has(rNum)) continue;

      let games = [];
      try {
        const r = await gqlPost(Q_ROUND, { roundID: round.id }, 'discoverFixtureByRound');
        games = r?.data?.discoverFixtureByRound?.games || [];
        calls++;
      } catch (e) { continue; }

      const age = sample.age;

      // Index BOTH sides on the normalised pair, and count collisions. A pair
      // that appears twice on either side is refused outright.
      const gameByPair = new Map(), gameDupes = new Set();
      for (const g of games) {
        const h = norm(g.home?.name, age), a = norm(g.away?.name, age);
        if (!h || !a || !g.id) continue;
        const k = pairKey(h, a);
        if (gameByPair.has(k)) gameDupes.add(k); else gameByPair.set(k, g);
      }
      const recByPair = new Map(), recDupes = new Set();
      for (const m of roundRecs) {
        const k = pairKey(norm(m.home, age), norm(m.away, age));
        if (recByPair.has(k)) recDupes.add(k); else recByPair.set(k, m);
      }

      for (const [k, m] of recByPair) {
        if (recDupes.has(k) || gameDupes.has(k)) {
          refused.ambiguous++;
          if (examples.length < 12) examples.push(`AMBIGUOUS  ${m.id}`);
          continue;
        }
        const g = gameByPair.get(k);
        if (!g) {
          refused.pair++;
          if (examples.length < 12) examples.push(`NO PAIR    ${m.id}`);
          continue;
        }
        // Where PlayHQ has a final score it must agree. A disagreement means the
        // pair matched a different fixture — two teams can meet twice.
        const gh = scoreOf(g.result?.home?.statistics);
        const ga = scoreOf(g.result?.away?.statistics);
        if (gh !== null && ga !== null &&
            m.hScore !== null && m.hScore !== undefined) {
          const sameOrder = gh === m.hScore && ga === m.aScore;
          const flipped   = gh === m.aScore && ga === m.hScore;
          if (!sameOrder && !flipped) {
            refused.score++;
            if (examples.length < 12) {
              examples.push(`SCORE      ${m.id}  stored ${m.hScore}-${m.aScore}, PlayHQ ${gh}-${ga}`);
            }
            continue;
          }
        }
        m._gid = g.id;
        stamped++;
      }
      await sleep(150);
    }
  }

  console.log('\nRESULT');
  console.log('─'.repeat(72));
  console.log(`  API calls made                 ${calls}${calls >= MAXCALL ? '  (hit the cap)' : ''}`);
  console.log(`  records without a gameId       ${missing.length}`);
  console.log(`  ids matched                    ${stamped}`);
  console.log(`  refused — no matching pair     ${refused.pair}`);
  console.log(`  refused — ambiguous pair       ${refused.ambiguous}  (two fixtures reduce to one name pair)`);
  console.log(`  refused — score disagrees      ${refused.score}`);
  console.log('─'.repeat(72));
  if (examples.length) {
    console.log('\nRefused, first few:');
    for (const e of examples) console.log(`  ${e}`);
  }

  if (!stamped) { console.log('\nNothing to write.'); return; }
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. ${stamped} record(s) would gain a gameId.`);
    for (const m of data.matches || []) delete m._gid;
    return;
  }

  let written = 0;
  for (const m of data.matches || []) {
    if (!m._gid) continue;
    m.gameId = m._gid;
    delete m._gid;
    written++;
  }
  console.log(`\n${written} record(s) gained a gameId.`);
  store.report(store.save(data, scope, { players: false }), 'backfill-game-ids');
  if (typeof logSummary === 'function') logSummary('backfill-game-ids');
  console.log(`=== ${VERSION} complete ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
