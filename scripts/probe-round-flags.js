#!/usr/bin/env node
// scripts/probe-round-flags.js
//
// What is actually in `rounds[].current`?
//
// The round walk stops at the first round past `current`, and finds it with:
//
//     const currentRoundIndex = roundList.findIndex(r => r.current);
//
// findIndex returns the FIRST match. That is correct only if exactly one round
// carries a truthy `current` and the field is the boolean it is assumed to be —
// neither of which has ever been checked.
//
// On 2026-08-31 the engine reported `current is FR1` for Premier Eastland Senior
// Men while FR2 had been played and was FINAL on the site. Two explanations fit
// equally well and nothing in the log separates them:
//
//   PlayHQ's flag genuinely lags behind the games
//   more than one round is flagged, and findIndex is taking the earliest
//
// This prints the raw array so the answer is read rather than inferred.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-round-flags.js                    # grades with finals, live seasons
//   PROBE_GRADE=<gradeId> node scripts/probe-round-flags.js
//   PROBE_GRADES=20 node scripts/probe-round-flags.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-round-flags v1 2026-08-31';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const ONE     = (process.env.PROBE_GRADE || '').trim();
const NGRADES = Math.max(1, Math.min(60, Number(process.env.PROBE_GRADES || 8)));

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  let picks;
  if (ONE) {
    picks = [{ gradeId: ONE, compName: '(given)', age: '', rawGrade: '' }];
  } else {
    const data = store.load(null, { players: false });
    const all = data.matches || [];
    // Grades that HAVE finals — that is where the flag was seen to disagree.
    const finalsGrades = new Set(all.filter(m => m.isFinals).map(m => m.gradeId));
    const seen = new Set();
    picks = [];
    for (const m of all) {
      if (!m.gradeId || seen.has(m.gradeId) || !finalsGrades.has(m.gradeId)) continue;
      seen.add(m.gradeId);
      picks.push({ gradeId: m.gradeId, compName: m.compName, age: m.age, rawGrade: m.rawGrade });
    }
    if (!picks.length) { console.error('No grades with finals found in storage.'); process.exit(1); }
    picks = picks.slice(0, NGRADES);
    console.log(`${seen.size} grade(s) with finals; showing ${picks.length}.\n`);
  }

  let multi = 0, none = 0, nonBool = 0;

  for (const g of picks) {
    let rounds;
    try {
      const r = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: g.gradeId });
      rounds = r?.data?.discoverGrade?.rounds || [];
    } catch (e) { console.log(`${g.gradeId}: rounds error — ${e.message}`); continue; }

    const flagged = rounds.filter(r => r.current);
    if (flagged.length > 1) multi++;
    if (flagged.length === 0) none++;
    if (rounds.some(r => r.current !== undefined && typeof r.current !== 'boolean')) nonBool++;

    console.log(`${g.compName} ${g.age} ${g.rawGrade}  ${g.gradeId}`);
    console.log(`  ${rounds.length} round(s); ${flagged.length} flagged current`);
    console.log(`  idx  ${'name'.padEnd(18)} ${'abbr'.padEnd(6)} ${'num'.padEnd(4)} ` +
      `${'finals'.padEnd(7)} ${'current'.padEnd(18)} dates`);
    rounds.forEach((r, i) => {
      // The RAW value and its type. `current: false`, `current: null` and a missing
      // key are three different things, and only one of them is what the code
      // assumes.
      const cur = r.current === undefined ? '(absent)'
        : `${JSON.stringify(r.current)} <${typeof r.current}>`;
      const d = (r.provisionalDates || []).map(x => String(x || '').slice(0, 10))
        .filter(Boolean).join(',') || '-';
      const mark = r.current ? ' <<<' : '';
      console.log(`  ${String(i).padStart(3)}  ${String(r.name || '').slice(0, 18).padEnd(18)} ` +
        `${String(r.abbreviatedName || '').padEnd(6)} ${String(r.number ?? '').padEnd(4)} ` +
        `${String(!!r.isFinalsRound).padEnd(7)} ${cur.padEnd(18)} ${d}${mark}`);
    });

    // What the engine would conclude, spelled out, so the probe and the walk
    // cannot disagree about what the code does.
    const idx = rounds.findIndex(r => r.current);
    const chosen = idx === -1 ? '(none)' :
      (rounds[idx].abbreviatedName || rounds[idx].name || `R${rounds[idx].number}`);
    console.log(`  -> findIndex picks index ${idx} (${chosen})` +
      (flagged.length > 1
        ? `  ⚠️ ${flagged.length} rounds are flagged — findIndex takes the EARLIEST`
        : ''));
    console.log('');
    await sleep(250);
  }

  console.log('SUMMARY');
  console.log(`  grades where MORE THAN ONE round is flagged current : ${multi}`);
  console.log(`  grades where NO round is flagged                    : ${none}`);
  console.log(`  grades where current is not a boolean               : ${nonBool}`);
  console.log('');
  if (multi) {
    console.log('  ⚠️  findIndex is taking the earliest of several flagged rounds.');
    console.log('      The walk has been stopping short for that reason, not because');
    console.log('      PlayHQ lags. The fix is to take the LAST flagged round.');
  } else if (nonBool) {
    console.log('  ⚠️  `current` is not a boolean. A truthy test may be reading it wrong.');
  } else {
    console.log('  Exactly one round flagged per grade, and it is a boolean — so');
    console.log('  findIndex is correct and the flag genuinely lags behind the games.');
  }

  if (typeof logSummary === 'function') logSummary('probe-round-flags');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
