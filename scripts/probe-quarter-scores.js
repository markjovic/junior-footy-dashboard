#!/usr/bin/env node
// scripts/probe-quarter-scores.js
//
// Can we show per-quarter scores, and for how many games?
//
// WHAT IS STORED TODAY: hScore, hG, hB, aScore, aG, aB. Totals only. Nothing in
// discoverFixtureByRound carries a period breakdown, so no switch on the existing
// data can produce one — the data is not there.
//
// WHERE QUARTERS LIVE: the spectator endpoint. playhq_api_reference.md documents
// `periods(scope: BY_PERIOD)` on the `game` type, and that is what the PlayHQ app
// reads for a quarter-by-quarter view.
//
// ⚠️ THE COVERAGE QUESTION IS THE WHOLE QUESTION. The spectator endpoint only
// knows ELECTRONICALLY SCORED games — measured 2026-08-20, 44 of 46 non-final
// games answered "game could not be found or was not electronically scored". If
// that ratio holds for completed games, a detailed view would be blank almost
// everywhere and is not worth building.
//
// This samples FINAL games and reports, per competition and age, how many carry a
// period breakdown. It also prints one full breakdown so the shape is known
// before anything is designed against it.
//
// ⚠️ THE PERIOD QUERY IS ISOLATED. A rejected field fails the WHOLE query, which
// is how the player panel went to "no stats found" for every player in August.
// The documented `periods` shape is from the basketball tenant and may differ
// here, so it is tried in its own document: if it is rejected, only that probe
// dies and the totals-only fallback still reports.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-quarter-scores.js
//   PROBE_COMP="EFNL 2026" PROBE_SAMPLE=120 node scripts/probe-quarter-scores.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-quarter-scores v1 2026-08-31';

const store = require('./lib/store');
const { specPost, sleep, logSummary } = require('./lib/playhq');

const COMP   = (process.env.PROBE_COMP || '').trim();
const SAMPLE = Math.max(10, Math.min(400, Number(process.env.PROBE_SAMPLE || 80)));

// Two documents. The first asks for periods; the second does not. If the first is
// rejected the second still establishes whether the game is e-scored at all, so a
// schema mismatch cannot be mistaken for "no games have quarters".
const Q_PERIODS = `query game($id: ID!, $scope: PeriodScore) {
  game(id: $id) {
    id status
    result {
      home { periods(scope: $scope) { period { label shortName value }
                                      statistics { type { value } count } } }
      away { periods(scope: $scope) { period { label shortName value }
                                      statistics { type { value } count } } }
    }
  }
}`;

const Q_PLAIN = `query game($id: ID!) {
  game(id: $id) {
    id status
    result { home { statistics { type { value } count } } }
  }
}`;

const total = (stats) => {
  const s = (stats || []).find(x => x.type?.value === 'TOTAL_SCORE');
  return s ? s.count : null;
};

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  const data = store.load(COMP ? [COMP] : null, { players: false });
  // FINAL games only, and only those carrying PlayHQ's own game id — the
  // spectator endpoint is keyed on it, and a record without one cannot be asked
  // about at all. Records written before engine v16 have none.
  const done = (data.matches || []).filter(m =>
    m.gameId && !m.isBye && !m.isPartial && !m.scheduled && !m.live &&
    m.hScore !== null && m.hScore !== undefined);

  if (!done.length) {
    console.error('No completed records carry a gameId. Nothing can be asked about.');
    console.error(`(${(data.matches || []).length} record(s) loaded)`);
    process.exit(1);
  }

  const withId = done.length;
  const noId = (data.matches || []).filter(m =>
    !m.gameId && !m.isBye && !m.isPartial && !m.scheduled &&
    m.hScore !== null && m.hScore !== undefined).length;

  console.log('COVERAGE BEFORE ASKING PLAYHQ');
  console.log(`  ${withId} completed record(s) carry a gameId`);
  console.log(`  ${noId} do NOT — pre-v16 records, which can never be asked about`);
  if (noId) {
    console.log(`  so the ceiling for any quarter view is ${(withId / (withId + noId) * 100).toFixed(1)}% ` +
      `of completed games, before PlayHQ is even involved`);
  }

  // Spread the sample across competitions and ages rather than taking the first N,
  // which would all be one grade and say nothing about the rest.
  const byBucket = new Map();
  for (const m of done) {
    const k = `${m.compName}|${m.age}`;
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k).push(m);
  }
  const buckets = [...byBucket.keys()];
  const perBucket = Math.max(1, Math.floor(SAMPLE / buckets.length));
  const picks = [];
  for (const k of buckets) {
    const arr = byBucket.get(k);
    // Newest first — if e-scoring is being adopted, recent games are where it is.
    arr.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    picks.push(...arr.slice(0, perBucket));
  }
  console.log(`\n${done.length} completed game(s) with an id, across ${buckets.length} ` +
    `competition/age bucket(s). Sampling ${picks.length}.\n`);

  let scored = 0, withPeriods = 0, notEScored = 0, errors = 0;
  let periodsRejected = false;
  const byAge = new Map();
  let example = null;

  for (const m of picks) {
    const k = `${m.compName} ${m.age}`;
    if (!byAge.has(k)) byAge.set(k, { n: 0, escored: 0, periods: 0 });
    const b = byAge.get(k);
    b.n++;

    let json = null;
    if (!periodsRejected) {
      try { json = await specPost(Q_PERIODS, { id: m.gameId, scope: 'BY_PERIOD' }, 'game'); }
      catch (e) { errors++; await sleep(150); continue; }
      // A field rejection is about the SCHEMA, not this game — stop asking for
      // periods and fall back, rather than reporting every game as periodless.
      if ((json.errors || []).some(e => /Cannot query field|Unknown (type|argument)/i
          .test(String(e?.message || '')))) {
        console.log('⚠️  The periods query was REJECTED by the schema:');
        for (const e of json.errors.slice(0, 3)) console.log(`      ${e.message}`);
        console.log('    Falling back to a totals-only query — coverage of e-scoring');
        console.log('    can still be measured, but the period shape is different here.\n');
        periodsRejected = true;
        json = null;
      }
    }
    if (!json) {
      try { json = await specPost(Q_PLAIN, { id: m.gameId }, 'game'); }
      catch (e) { errors++; await sleep(150); continue; }
    }

    const benign = (json.errors || []).some(e =>
      /not electronically scored|could not be found/i.test(String(e?.message || '')));
    const g = json?.data?.game;
    if (benign || !g) { notEScored++; await sleep(150); continue; }

    scored++; b.escored++;
    const hp = g.result?.home?.periods || [];
    if (hp.length) {
      withPeriods++; b.periods++;
      if (!example) {
        example = {
          id: m.id, date: m.date, comp: m.compName, age: m.age,
          home: m.home, away: m.away, stored: `${m.hScore}-${m.aScore}`,
          h: hp.map(p => `${p.period?.shortName || p.period?.value}:${total(p.statistics)}`),
          a: (g.result?.away?.periods || [])
            .map(p => `${p.period?.shortName || p.period?.value}:${total(p.statistics)}`),
        };
      }
    }
    await sleep(150);
  }

  console.log('RESULT');
  console.log('─'.repeat(78));
  console.log(`  sampled                          ${picks.length}`);
  console.log(`  answered by the spectator API    ${scored}`);
  console.log(`  NOT electronically scored        ${notEScored}`);
  console.log(`  errors                           ${errors}`);
  console.log(`  carrying a PERIOD breakdown      ${withPeriods}` +
    (periodsRejected ? '  (periods query rejected — see above)' : ''));
  console.log('─'.repeat(78));

  if (example) {
    console.log('\nEXAMPLE — what a breakdown looks like');
    console.log(`  ${example.comp} ${example.age}  ${example.date}`);
    console.log(`  ${example.home} v ${example.away}   stored total ${example.stored}`);
    console.log(`  home  ${example.h.join('  ')}`);
    console.log(`  away  ${example.a.join('  ')}`);
    console.log('  ⚠️ Check the periods SUM to the stored total. If they do not, the');
    console.log('     breakdown is of something else and must not be shown beside it.');
  }

  const rows = [...byAge.entries()].filter(([, b]) => b.n >= 2)
    .sort((a, b) => (b[1].periods / b[1].n) - (a[1].periods / a[1].n));
  if (rows.length) {
    console.log('\nBY COMPETITION AND AGE (sampled)');
    for (const [k, b] of rows.slice(0, 25)) {
      console.log(`  ${k.padEnd(28)} ${String(b.periods).padStart(4)} of ${String(b.n).padStart(4)} ` +
        `have quarters   (${String(b.escored).padStart(4)} e-scored)`);
    }
  }

  console.log('\nVERDICT');
  const pct = picks.length ? (withPeriods / picks.length * 100) : 0;
  if (!scored) {
    console.log('  NOTHING answered. Either these games are not e-scored at all, or the');
    console.log('  ids are not the ones the spectator endpoint knows. Not buildable.');
  } else if (!withPeriods) {
    console.log(`  ${scored} game(s) answered but NONE carried periods. E-scoring exists`);
    console.log('  here but the quarter breakdown does not come with it.');
  } else {
    console.log(`  ${withPeriods} of ${picks.length} sampled (${pct.toFixed(1)}%) have a quarter breakdown.`);
    console.log('');
    console.log('  ⚠️ This is a SAMPLE, and a percentage from it is an estimate. What it');
    console.log('     decides is whether a detailed view would be mostly full or mostly');
    console.log('     empty — a switch that shows nothing for four games in five is');
    console.log('     worse than no switch.');
    console.log('');
    console.log('  If this is worth building, quarters would be a SEPARATE stored field');
    console.log('  fetched only for games that have them, not a new required column —');
    console.log('  and the storage cost needs measuring before anything is designed.');
  }

  if (typeof logSummary === 'function') logSummary('probe-quarter-scores');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
