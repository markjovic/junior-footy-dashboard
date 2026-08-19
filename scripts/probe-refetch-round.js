#!/usr/bin/env node
// scripts/probe-refetch-round.js
//
// A8 — settles a contradiction in docs/dashboard_context.md §8.
//
// THE TWO OBSERVATIONS
//   2026-08-11: "discoverFixtureByRound returns 0 games for completed rounds that
//               were fetched in a prior run — the data is in storage, not
//               re-served by the API."
//   2026-08-13: probe-concurrent-comps.js fetched every round of seven SEJ 2026
//               U10 grades, 68 calls, and completed rounds returned their FULL
//               game lists.
//
// One of these is wrong. Until it is settled, A9 — the pre-v16 rename-duplicate
// cleanup — cannot proceed, because that cleanup deletes records and its safety
// depends on knowing whether a re-fetch returns a round COMPLETELY or partially.
//
// WHY PARTIAL IS THE DANGEROUS ANSWER, and what this measures.
// Engine v16 writes PlayHQ's own `gameId` onto every record it stores. A record
// written before v16 has none. If a re-fetch returns a completed round in full,
// then every real game in that round now carries a gameId and any record left
// without one is a phantom from a mid-season team rename. If a re-fetch returns
// only SOME games, a real game could be left without a gameId and a cleanup keyed
// on "no gameId" would delete it.
//
// So this does not ask "does it return anything". It asks, for each round:
//   stored games  vs  returned games  vs  how many of each side the other has.
//
// READ-ONLY. No writes, no commits. Makes GraphQL calls only.
//
// USAGE
//   node scripts/probe-refetch-round.js                      # 3 grades, live comps
//   PROBE_COMP="EFNL 2026" node scripts/probe-refetch-round.js
//   PROBE_GRADES=6 node scripts/probe-refetch-round.js
//
// Exit codes: 0 = ran and reported. 1 = fatal (no session, no stored data).

'use strict';

const VERSION = 'probe-refetch-round v1 2026-08-19';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
// The engine's OWN queries, imported rather than copied. A probe that answers a
// question about the fetcher must send what the fetcher sends; a second copy of
// the query would drift and the answer would be about the copy.
const engine = require('./lib/results-engine');

const COMP   = (process.env.PROBE_COMP || '').trim();
const NGRADE = Math.max(1, Math.min(20, Number(process.env.PROBE_GRADES || 3)));

const roundToken = engine.roundToken;

function todayAEST() {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  const scope = COMP ? [COMP] : null;
  const data = store.load(scope, { players: false });
  const matches = (data.matches || []).filter(m => !m.isBye && !m.isPartial);
  if (!matches.length) {
    console.error('No stored matches. Nothing to compare against.');
    process.exit(1);
  }

  // Live seasons only: a retired season is never re-fetched in production, so its
  // answer would not tell us anything about the path A9 depends on.
  const live = new Set(store.liveComps(['ACTIVE']) || []);
  const today = todayAEST();

  // Build (compName, age, gradeId, round) -> stored records, keeping only rounds
  // that are unambiguously COMPLETE: every game in them has a date in the past.
  // A round still being played would return more games than are stored for a
  // perfectly ordinary reason and would tell us nothing.
  const groups = new Map();
  for (const m of matches) {
    if (!m.gradeId || m.round === undefined || m.round === null) continue;
    if (live.size && !live.has(m.compName)) continue;
    if (m.scheduled) continue;
    const key = `${m.compName}\u0000${m.age}\u0000${m.gradeId}\u0000${roundToken(m)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const complete = [...groups.entries()].filter(([, recs]) =>
    recs.every(r => r.date && r.date < today));

  if (!complete.length) {
    console.error('No completed rounds found in the live seasons. Nothing to probe.');
    process.exit(1);
  }

  // Pick rounds from DIFFERENT grades, and prefer ones that already carry a
  // gameId on at least one record — those are the rounds A9 would act on, so they
  // are the ones whose behaviour matters.
  const byGrade = new Map();
  for (const [key, recs] of complete) {
    const gradeId = key.split('\u0000')[2];
    const withId = recs.filter(r => r.gameId).length;
    const prev = byGrade.get(gradeId);
    const score = withId > 0 && withId < recs.length ? 2 : withId > 0 ? 1 : 0;
    if (!prev || score > prev.score) byGrade.set(gradeId, { key, recs, score });
  }
  const picks = [...byGrade.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, NGRADE);

  console.log(`${matches.length} stored record(s); ${complete.length} completed round(s) ` +
    `across ${byGrade.size} grade(s). Probing ${picks.length}.\n`);

  // Round ids are not stored, so each grade's rounds have to be discovered first.
  const results = [];
  for (const pick of picks) {
    const [compName, age, gradeId, rToken] = pick.key.split('\u0000');
    const stored = pick.recs;

    let roundsRes;
    try {
      roundsRes = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: gradeId });
    } catch (e) {
      results.push({ compName, age, gradeId, rToken, error: `rounds: ${e.message}` });
      continue;
    }
    const rounds = roundsRes?.data?.discoverGrade?.rounds || [];
    // Match the stored round token back to a PlayHQ round. Finals restart at 1,
    // so a bare number is not enough — the token carries F:<abbrev> for finals.
    const wantFinals = String(rToken).startsWith('F:');
    const wantAbbrev = wantFinals ? String(rToken).slice(2) : null;
    const round = rounds.find(r => wantFinals
      ? (r.isFinalsRound && (r.abbreviatedName || '') === wantAbbrev)
      : (!r.isFinalsRound && Number(r.number) === Number(rToken)));

    if (!round) {
      results.push({ compName, age, gradeId, rToken, stored: stored.length,
        error: `round ${rToken} not found among ${rounds.length} rounds` });
      continue;
    }

    let fixRes;
    try {
      fixRes = await gqlPost(engine.Q_FIXTURE, { roundID: round.id });
    } catch (e) {
      results.push({ compName, age, gradeId, rToken, stored: stored.length,
        error: `fixture: ${e.message}` });
      continue;
    }
    const games = fixRes?.data?.discoverFixtureByRound?.games || [];

    // Compare by PlayHQ's own game id where the stored record has one. Team names
    // are NOT used: a mid-season rename is the very thing that creates the records
    // this is about, so matching on names would beg the question.
    const returnedIds = new Set(games.map(g => g.id).filter(Boolean));
    const storedIds   = new Set(stored.map(r => r.gameId).filter(Boolean));
    const storedNoId  = stored.filter(r => !r.gameId).length;

    let inBoth = 0;
    for (const id of storedIds) if (returnedIds.has(id)) inBoth++;

    results.push({
      compName, age, gradeId, rToken, roundName: round.name,
      stored: stored.length, storedWithId: storedIds.size, storedNoId,
      returned: games.length, inBoth,
      returnedOnly: returnedIds.size - inBoth,
      storedOnly: storedIds.size - inBoth,
    });

    await sleep(400);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('─'.repeat(96));
  console.log('comp / age / grade                    round       stored  w/id  no-id  returned  both');
  console.log('─'.repeat(96));
  for (const r of results) {
    const label = `${r.compName} ${r.age} ${String(r.gradeId).slice(0, 8)}`.padEnd(36);
    if (r.error) { console.log(`${label} ${String(r.rToken).padEnd(11)} ERROR ${r.error}`); continue; }
    console.log(`${label} ${String(r.rToken).padEnd(11)} ` +
      `${String(r.stored).padStart(6)} ${String(r.storedWithId).padStart(5)} ` +
      `${String(r.storedNoId).padStart(6)} ${String(r.returned).padStart(9)} ` +
      `${String(r.inBoth).padStart(5)}`);
  }
  console.log('─'.repeat(96));

  const ok = results.filter(r => !r.error);
  const empty = ok.filter(r => r.returned === 0);
  const partial = ok.filter(r => r.returned > 0 && r.returned < r.stored);
  const full = ok.filter(r => r.returned >= r.stored);

  console.log('\nVERDICT');
  if (!ok.length) {
    console.log('  Every probe errored — no verdict. Check the session and the ids above.');
  } else if (empty.length === ok.length) {
    console.log('  discoverFixtureByRound returns NOTHING for a completed round.');
    console.log('  The 2026-08-11 observation is right; the 2026-08-13 one needs explaining.');
    console.log('  → A9 is SAFE in the narrow sense that no record will ever gain a gameId,');
    console.log('    so a "no gameId" test cannot be used at all. Use the score-twin rule.');
  } else if (full.length === ok.length) {
    console.log('  discoverFixtureByRound RE-SERVES completed rounds in full.');
    console.log('  The 2026-08-13 observation is right; the §8 note is wrong and must be');
    console.log('  corrected in dashboard_context.md and playhq_api_reference.md.');
    console.log('  → A9 may proceed: a re-fetched round carries a gameId on every real game.');
  } else if (partial.length) {
    console.log('  ⚠️  MIXED — at least one round came back INCOMPLETE.');
    console.log('  This is the dangerous answer. A record without a gameId is NOT');
    console.log('  necessarily a phantom, so A9 must NOT delete on that test alone.');
    for (const r of partial) {
      console.log(`     ${r.compName} ${r.age} ${r.gradeId} round ${r.rToken}: ` +
        `stored ${r.stored}, returned ${r.returned}`);
    }
  } else {
    console.log('  MIXED — some rounds re-served, some returned nothing. Neither note is');
    console.log('  universally true. Report the table above before building on either.');
  }

  console.log('\n  A round where `no-id` is 0 tells you nothing about pre-v16 records —');
  console.log('  it was already fully re-fetched. The rows that matter are those with a');
  console.log('  non-zero `no-id`.');

  if (typeof logSummary === 'function') logSummary('probe-refetch-round');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
