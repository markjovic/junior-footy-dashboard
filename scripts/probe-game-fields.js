#!/usr/bin/env node
// scripts/probe-game-fields.js
//
// Does the MAIN API carry a per-quarter breakdown?
//
// ⚠️ THE PREVIOUS PROBE ASKED THE WRONG ENDPOINT. probe-quarter-scores.js only
// ever queried the spectator endpoint, because that is where
// playhq_api_reference.md documents `periods`. It found 24 of 66 games with a
// breakdown and 41 answering "not electronically scored" — but PlayHQ's own site
// shows quarter scores for virtually every game, so the site is reading something
// this project has never asked for.
//
// HOW TO FIND IT: introspection is disabled (`__schema` returns
// INTROSPECTION_DISABLED), so the documented technique is to ASK for a field and
// read the validation error, which usefully names valid alternatives. That is what
// this does — a candidate list, one isolated query each.
//
// ⚠️ EVERY CANDIDATE IS ITS OWN QUERY DOCUMENT. A rejected field fails the WHOLE
// query, so a single document listing ten candidates would report nothing except
// that the first one was wrong. One request per candidate is slower and is the
// only shape that yields an answer per field.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-game-fields.js
//   PROBE_GAME=<gameId> node scripts/probe-game-fields.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-game-fields v1 2026-08-31';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');

const ONE = (process.env.PROBE_GAME || '').trim();

// Candidates for a per-period breakdown, on the SIDE object inside result.
// Named the way PlayHQ names things elsewhere, plus the shape the spectator
// endpoint uses, plus the obvious guesses. A rejection is as informative as an
// acceptance because the error names what IS valid.
const SIDE_FIELDS = [
  'periods { period { value } statistics { type { value } count } }',
  'periods { period { label shortName value } statistics { type { value } count } }',
  'periodStatistics { period { value } statistics { type { value } count } }',
  'periodScores { period { value } score }',
  'scoreByPeriod { period { value } score }',
  'quarters { number score }',
  'periodStatisticsV2 { period { value } statistics { type { value } count } }',
  'statisticsByPeriod { period { value } statistics { type { value } count } }',
];

// And on the game itself, in case the breakdown hangs off the game rather than a
// side — which is how a scoreboard would naturally model it.
const GAME_FIELDS = [
  'periods { period { value } home { score } away { score } }',
  'scoreboard { periods { period { value } home away } }',
  'periodScores { period { value } home away }',
];

const q = (inner) => `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) { id ${inner} }
}`;
const qSide = (inner) => q(`result { home { ${inner} } }`);

async function tryField(label, doc, gameID) {
  let json;
  try { json = await gqlPost(doc, { gameID }, 'DiscoverGame'); }
  catch (e) { return { label, verdict: 'ERROR', detail: String(e.message).slice(0, 120) }; }

  const errs = json.errors || [];
  if (errs.length) {
    const msg = String(errs[0].message || '');
    // "Cannot query field X on type Y. Did you mean Z?" — the suggestion is the
    // point of the exercise.
    const suggest = msg.match(/Did you mean (.+?)\?/i);
    return {
      label,
      verdict: /Cannot query field/i.test(msg) ? 'NO SUCH FIELD' : 'REJECTED',
      detail: msg.slice(0, 160),
      suggest: suggest ? suggest[1] : null,
    };
  }
  // Accepted. Whether it carries DATA is a separate question from whether it
  // exists — an empty array still proves the field is real.
  const g = json?.data?.discoverGame;
  return { label, verdict: 'ACCEPTED', data: JSON.stringify(g).slice(0, 300) };
}

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  let gameID = ONE;
  if (!gameID) {
    const data = store.load(null, { players: false });
    // A recent COMPLETED game with an id — most likely to carry a full breakdown.
    const done = (data.matches || [])
      .filter(m => m.gameId && !m.isBye && !m.isPartial && !m.scheduled && !m.live &&
                   m.hScore !== null && m.hScore !== undefined)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (!done.length) {
      console.error('No completed record carries a gameId. Pass PROBE_GAME=<id>.');
      process.exit(1);
    }
    gameID = done[0].gameId;
    console.log(`Using ${done[0].compName} ${done[0].age} ${done[0].rawGrade} ` +
      `${done[0].home} v ${done[0].away} (${done[0].date})`);
    console.log(`  stored total ${done[0].hScore}-${done[0].aScore}, gameId ${gameID}\n`);
  }

  // The control. If this fails, nothing below means anything — the id is wrong or
  // the endpoint is unreachable, and every "NO SUCH FIELD" would be misleading.
  const control = await tryField('control: result.home.statistics',
    qSide('statistics { count type { value } }'), gameID);
  console.log(`CONTROL  ${control.verdict}`);
  if (control.verdict !== 'ACCEPTED') {
    console.error(`  ${control.detail || ''}`);
    console.error('  The known-good field failed, so the id or the endpoint is the');
    console.error('  problem, not the candidates. Stopping rather than reporting');
    console.error('  a list of false negatives.');
    process.exit(1);
  }
  console.log(`  ${control.data}\n`);
  await sleep(250);

  const hits = [], suggestions = new Set();

  console.log('CANDIDATES ON result.home');
  console.log('─'.repeat(78));
  for (const f of SIDE_FIELDS) {
    const name = f.split(/[\s{]/)[0];
    const r = await tryField(name, qSide(f), gameID);
    console.log(`  ${name.padEnd(22)} ${r.verdict}`);
    if (r.suggest) { console.log(`      → did you mean: ${r.suggest}`); suggestions.add(r.suggest); }
    else if (r.verdict !== 'ACCEPTED' && r.detail) console.log(`      ${r.detail}`);
    if (r.verdict === 'ACCEPTED') { hits.push({ where: 'result.home', name, data: r.data }); }
    await sleep(250);
  }

  console.log('\nCANDIDATES ON discoverGame');
  console.log('─'.repeat(78));
  for (const f of GAME_FIELDS) {
    const name = f.split(/[\s{]/)[0];
    const r = await tryField(name, q(f), gameID);
    console.log(`  ${name.padEnd(22)} ${r.verdict}`);
    if (r.suggest) { console.log(`      → did you mean: ${r.suggest}`); suggestions.add(r.suggest); }
    else if (r.verdict !== 'ACCEPTED' && r.detail) console.log(`      ${r.detail}`);
    if (r.verdict === 'ACCEPTED') { hits.push({ where: 'discoverGame', name, data: r.data }); }
    await sleep(250);
  }

  console.log('\nRESULT');
  if (hits.length) {
    console.log(`  ${hits.length} field(s) ACCEPTED:`);
    for (const h of hits) {
      console.log(`\n  ${h.where}.${h.name}`);
      console.log(`    ${h.data}`);
    }
    console.log('\n  ⚠️ Accepted means the field EXISTS. Whether it carries data for most');
    console.log('     games is the next question, and needs a sample — the spectator');
    console.log('     endpoint existed too and answered for barely a third.');
  } else {
    console.log('  No candidate was accepted on the main API.');
    if (suggestions.size) {
      console.log(`\n  But the schema suggested: ${[...suggestions].join(', ')}`);
      console.log('  Re-run with those added to the candidate list.');
    } else {
      console.log('\n  And nothing was suggested, so the breakdown is probably not on');
      console.log('  discoverGame at all. Next places to look: the fixture query\'s own');
      console.log('  result object, or a separate scoreboard query the site uses.');
    }
  }

  if (typeof logSummary === 'function') logSummary('probe-game-fields');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
