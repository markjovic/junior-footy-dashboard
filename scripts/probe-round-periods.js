#!/usr/bin/env node
// scripts/probe-round-periods.js
//
// Can quarter scores come from the ROUND call the engine already makes?
//
// TODAY: results-engine.js calls discoverFixtureByRound once per round. Quarter
// scores come from discoverGame.statistics.<side>.periods — one call PER GAME.
// If the fixture query exposes the same `statistics` block, quarters arrive free
// with the results run and nothing extra is needed, ever.
//
// ⚠️ WHY THIS IS A PROBE AND NOT AN EDIT TO THE ENGINE. A rejected field fails
// the WHOLE query. The engine's fixture query is what every scheduled run depends
// on, and adding an unknown field to it is precisely what blanked the player panel
// for every player in August 2026. Probed in isolation first, always.
//
// ⚠️ AND "ACCEPTED" IS NOT "POPULATED". discoverGame.result.<side>.periods is a
// valid field that is ALWAYS empty, and three separate probes concluded from it
// that PlayHQ did not expose quarter data at all. So this checks a round whose
// games are KNOWN to have a breakdown — established by asking discoverGame for
// the same games — and compares the two answers game by game.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-round-periods.js
//   PROBE_GRADE=<gradeId> node scripts/probe-round-periods.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-round-periods v1 2026-09-04';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const ONE = (process.env.PROBE_GRADE || '').trim();

const PERIODS = 'periods { period { value } statistics { count type { value } } }';

// Candidate shapes on the fixture query, cheapest first. One isolated document
// each — a single document listing all three would only ever report the first
// rejection.
const SHAPES = [
  ['games.statistics.<side>.periods',
   `statistics { home { ${PERIODS} } away { ${PERIODS} } }`],
  ['games.statistics.<side>.periods (home only)',
   `statistics { home { ${PERIODS} } }`],
  ['games.periods',
   PERIODS],
];

const roundQuery = (inner) => `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) { games { id ${inner} } }
}`;

const Q_GAME = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) { id statistics { home { ${PERIODS} } } }
}`;

const total = (stats) => {
  const s = (stats || []).find(x => x.type?.value === 'TOTAL_SCORE');
  return s ? s.count : null;
};
const line = (periods) => Array.isArray(periods)
  ? periods.map(p => `${p.period?.value?.slice(0, 2) || '?'}:${total(p.statistics)}`).join(' ')
  : '(none)';

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  const data = store.load(null, { players: false });
  // A game KNOWN to carry a breakdown, so an empty answer from the fixture query
  // means the query, not the game.
  const withQ = (data.matches || []).filter(m =>
    m.gameId && Array.isArray(m.hQ) && m.hQ.length && m.gradeId);
  if (!withQ.length) {
    console.error('No stored record has quarters yet — run enrich-games first, or');
    console.error('pass PROBE_GRADE for a grade you know has them.');
    process.exit(1);
  }

  const seed = ONE ? withQ.find(m => m.gradeId === ONE) || withQ[0] : withQ[0];
  console.log(`Seed: ${seed.compName} ${seed.age} ${seed.rawGrade} round ${seed.round}`);
  console.log(`      ${seed.home} v ${seed.away}  stored quarters ${seed.hQ.join(' ')}\n`);

  let rounds = [];
  try {
    const rr = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: seed.gradeId });
    rounds = rr?.data?.discoverGrade?.rounds || [];
  } catch (e) { console.error(`rounds failed: ${e.message}`); process.exit(1); }

  const round = rounds.find(r => !r.isFinalsRound && String(r.number) === String(seed.round))
    || rounds[0];
  if (!round) { console.error('Could not find that round.'); process.exit(1); }
  console.log(`Round: ${round.abbreviatedName || round.name} (${round.id})\n`);

  console.log('FIXTURE QUERY — candidate shapes');
  console.log('─'.repeat(74));
  let winner = null;
  for (const [label, inner] of SHAPES) {
    let json;
    try { json = await gqlPost(roundQuery(inner), { roundID: round.id }, 'discoverFixtureByRound'); }
    catch (e) { console.log(`  ${label.padEnd(42)} ERROR  ${String(e.message).slice(0, 60)}`); continue; }

    if (json.errors && json.errors.length) {
      const msg = String(json.errors[0].message || '');
      console.log(`  ${label.padEnd(42)} REJECTED`);
      console.log(`      ${msg.slice(0, 150)}`);
      const sug = msg.match(/Did you mean (.+?)\?/i);
      if (sug) console.log(`      → did you mean: ${sug[1]}`);
      await sleep(250);
      continue;
    }

    const games = json?.data?.discoverFixtureByRound?.games || [];
    const withData = games.filter(g =>
      (g.statistics?.home?.periods || g.periods || []).length).length;
    console.log(`  ${label.padEnd(42)} ACCEPTED — ${games.length} game(s), ` +
      `${withData} with periods`);
    if (withData && !winner) winner = { label, inner, games };
    await sleep(250);
  }

  if (!winner) {
    console.log('\nRESULT');
    console.log('  The fixture query does NOT carry a period breakdown.');
    console.log('  Quarters need a separate discoverGame call per game, which means');
    console.log('  either a scheduled enrich pass or a per-game call added to the');
    console.log('  results run. Costs are in the notes below.');
    if (typeof logSummary === 'function') logSummary('probe-round-periods');
    return;
  }

  // ── Cross-check against discoverGame for the SAME games ──
  console.log(`\nCROSS-CHECK — do the two agree, game by game?`);
  console.log('─'.repeat(74));
  let same = 0, differ = 0, checked = 0;
  for (const g of winner.games.slice(0, 6)) {
    const fromRound = g.statistics?.home?.periods || g.periods || [];
    let fromGame = [];
    try {
      const r = await gqlPost(Q_GAME, { gameID: g.id }, 'DiscoverGame');
      fromGame = r?.data?.discoverGame?.statistics?.home?.periods || [];
    } catch (e) { /* leave empty */ }
    checked++;
    const a = line(fromRound), b = line(fromGame);
    if (a === b) { same++; console.log(`  ${g.id}  MATCH   ${a}`); }
    else { differ++; console.log(`  ${g.id}  DIFFER  round: ${a}\n${' '.repeat(20)}game:  ${b}`); }
    await sleep(250);
  }

  console.log('\nRESULT');
  if (differ) {
    console.log(`  ⚠️ ${differ} of ${checked} disagree. The fixture query returns SOMETHING`);
    console.log('     but not the same thing — do not swap the engine over on this.');
  } else {
    console.log(`  ✅ ${same} of ${checked} identical.`);
    console.log(`     "${winner.label}" gives the same breakdown as discoverGame.`);
    console.log('');
    console.log('     So the engine can carry quarters with NO extra calls: add the');
    console.log('     block to Q_FIXTURE and store hQ/aQ alongside the score.');
    console.log('     ⚠️ Still add it behind a tolerant read — a field that vanishes');
    console.log('        must not fail the query every scheduled run depends on.');
  }

  if (typeof logSummary === 'function') logSummary('probe-round-periods');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
