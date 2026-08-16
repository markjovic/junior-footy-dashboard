#!/usr/bin/env node
// scripts/repair-scheduled-results.js
//
// Clears the `scheduled` flag from stored records that are actually RESULTS.
//
// WHY THIS EXISTS
// fetch-fixtures.js writes a scheduled record under the SAME match id that
// results-engine.js builds — same compName, age, gradeId, round token and sorted
// team pair. When the game is played, the result merges into that record at
// `{ ...prev, ...m }`. A result record has no `scheduled` key, so there is
// nothing to overwrite `prev.scheduled` and `true` survives the spread.
//
// index.html splits on exactly that flag:
//   S.fixtures = d.matches.filter(m => m.scheduled)
//   S.matches  = d.matches.filter(m => !m.isBye && !m.scheduled)
// so the record never reaches the results list. It does reach finalsPool()
// through S.fixtures, but isPlayed() is `!m.scheduled && ...`, so the finals view
// draws it as an unplayed fixture with two blank score cells. Correct scores,
// stored, invisible.
//
// Engine v18 stops this happening again — it deletes the flag when a result
// supersedes a fixture. It cannot repair what is already on disk, because the
// repair only reaches a record whose round is re-fetched, and three things stop
// that: a round holding one proper result is skipped as "already stored"; a grade
// whose season has ended is skipped entirely; and archived seasons are out of
// scope for fetch-results.js altogether. This script has none of those limits —
// it reads every stored season directly and makes no API calls.
//
// THE RULE (agreed 2026-08-16)
// A record is a disguised result when ALL of the following hold:
//   1. scheduled === true
//   2. any of hScore, hG, hB, aScore, aG, aB is non-zero
//   3. it has no date, OR its date is today or earlier (AEST)
//
// (2) is what makes this safe: a genuinely unplayed game cannot carry a non-zero
// score, so no real fixture can be caught by it. (3) is the guard against a
// PlayHQ data-entry error or a mis-dated record — a future game with a score on
// it is a contradiction, and this script reports those rather than deciding for
// you.
//
// WHAT IT DELIBERATELY DOES NOT DO
// A real 0-0, or a forfeit recorded as all zeros, is indistinguishable from an
// unplayed fixture by rule (2) and is left alone. Those are counted and reported
// separately so the residue is a number rather than an assumption.
//
// Per-match logo URLs are NOT stripped here. results-engine.js harvests them into
// teamLogos and strips them in the same pass, and it will do that on the next run
// now these records are no longer scheduled. Stripping them here would delete the
// evidence before its new home had absorbed it.
//
// USAGE
//   node scripts/repair-scheduled-results.js            # dry run, writes nothing
//   node scripts/repair-scheduled-results.js --apply     # writes
//   REPAIR_APPLY=true node scripts/repair-scheduled-results.js
//   REPAIR_COMP="EFNL 2026" node scripts/repair-scheduled-results.js
//
// Exit codes: 0 = ran (whether or not anything was found). 1 = fatal.

'use strict';

const VERSION = 'v1 2026-08-16 scheduled-result-repair';

const store = require('./lib/store');

// ─── Date helper ─────────────────────────────────────────────────────────────
// Never new Date(string) for parsing. AEST is UTC+10; the same expression
// results-engine.js uses, so "today" means the same thing in both.
function todayAEST() {
  const now = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

const SCORE_FIELDS = ['hScore', 'hG', 'hB', 'aScore', 'aG', 'aB'];

// Rule (2). Guards against null and undefined as well as zero, because a fixture
// record may carry the fields absent rather than zeroed.
function hasScore(m) {
  return SCORE_FIELDS.some(k => {
    const v = m[k];
    return v !== null && v !== undefined && v !== 0 && v !== '0';
  });
}

// Rule (3). A string compare on YYYY-MM-DD, which is exactly what a lexical
// compare gives for that format. An absent or malformed date is treated as "no
// date" and passes, because the score is the load-bearing evidence and a record
// with no date has nothing to contradict it.
function dateIsPast(m, today) {
  const d = String(m.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d <= today;
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply') || process.env.REPAIR_APPLY === 'true';
  const compFilter = (process.env.REPAIR_COMP || '').trim();
  const today = todayAEST();

  console.log(`=== repair-scheduled-results ${VERSION} ===`);
  console.log(`Mode: ${apply ? 'APPLY — files will be written' : 'DRY RUN — nothing will be written'}`);
  console.log(`Today (AEST): ${today}`);
  if (compFilter) console.log(`Scope: ${compFilter}`);
  else console.log('Scope: every stored season');

  // Players are 78% of stored bytes and cannot contain a match record. Not
  // loading them means this neither reads 82 MB it will not use nor rewrites
  // eighteen player files that cannot have changed.
  const scope = compFilter ? [compFilter] : null;
  let data;
  try {
    data = store.load(scope, { players: false });
  } catch (e) {
    console.error(`store.load failed: ${e.message}`);
    process.exit(1);
  }

  const matches = data.matches || [];
  console.log(`\nLoaded ${matches.length} match record(s)`);

  const scheduled = matches.filter(m => m.scheduled === true);
  console.log(`${scheduled.length} carry scheduled: true`);

  // Four buckets, so the residue is a number rather than an assumption.
  const promote = [];        // rule 1 + 2 + 3 — a disguised result
  const futureDated = [];    // rule 1 + 2, but dated ahead — a contradiction
  const scoreless = [];      // rule 1 only, all scores zero or absent
  for (const m of scheduled) {
    if (!hasScore(m)) { scoreless.push(m); continue; }
    if (!dateIsPast(m, today)) { futureDated.push(m); continue; }
    promote.push(m);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const byComp = {};
  for (const m of promote) {
    const k = m.compName || '(no competition)';
    byComp[k] = (byComp[k] || 0) + 1;
  }

  console.log(`\n── To promote: ${promote.length} ──`);
  if (promote.length) {
    for (const k of Object.keys(byComp).sort()) {
      console.log(`  ${k}: ${byComp[k]}`);
    }
    console.log('\n  Examples:');
    for (const m of promote.slice(0, 10)) {
      const rd = m.isFinals ? (m.finalsAbbrev || 'F') : `R${m.round}`;
      console.log(`    ${m.compName} ${m.age} ${rd}  ${m.home} ${m.hScore} v ${m.aScore} ${m.away}  (${m.date || 'no date'})`);
    }
    if (promote.length > 10) console.log(`    ... ${promote.length - 10} more`);
  }

  // Loud, and never repaired automatically. A future-dated record carrying a
  // score means either the date or the score is wrong, and this script cannot
  // tell which. Deciding would be guessing with a write attached.
  if (futureDated.length) {
    console.log(`\n  ⚠️  ${futureDated.length} record(s) carry a score but are dated in the FUTURE.`);
    console.log('     NOT repaired — a score on an unplayed game means the date or the');
    console.log('     score is wrong, and this cannot tell which. Listed in full:');
    for (const m of futureDated) {
      const rd = m.isFinals ? (m.finalsAbbrev || 'F') : `R${m.round}`;
      console.log(`       ${m.compName} ${m.age} ${rd}  ${m.home} ${m.hScore} v ${m.aScore} ${m.away}  (${m.date})`);
    }
  }

  console.log(`\n── Left alone: ${scoreless.length} scheduled record(s) with no score ──`);
  console.log('  These are ordinary upcoming fixtures, plus any genuine 0-0 or');
  console.log('  all-zero forfeit, which this rule cannot tell apart from an');
  console.log('  unplayed game. Deliberate: see the header.');

  if (!promote.length) {
    console.log('\nNothing to repair.');
    console.log(`=== repair-scheduled-results ${VERSION} complete ===`);
    process.exit(0);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with apply: true to write.');
    console.log(`=== repair-scheduled-results ${VERSION} complete ===`);
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  // Mutating the objects in `data.matches` directly, because that array IS what
  // store.save writes back. Building a new array and assigning it would work too,
  // but this keeps every other key on each record untouched by construction
  // rather than by a spread that has to be got right.
  //
  // `provisional` goes with the flag. Its reader is isProvSide(), which tests
  // `m.provisional && !m.hLogo` — and results-engine.js strips hLogo from records
  // that are no longer scheduled. A surviving provisional flag would therefore
  // render a PLAYED team as a greyed "Winner Game 1" placeholder on the next run.
  let cleared = 0, clearedProvisional = 0;
  for (const m of promote) {
    delete m.scheduled;
    if (m.provisional !== undefined) { delete m.provisional; clearedProvisional++; }
    cleared++;
  }
  console.log(`\nCleared scheduled on ${cleared} record(s)` +
    (clearedProvisional ? `, and provisional on ${clearedProvisional} of them` : ''));

  // players: false passed EXPLICITLY. store.load marks its return with a
  // non-enumerable __hadPlayers, and this script does not spread the object so the
  // marker survives — but the guard in store.save is the backstop, not the
  // intention, and working_practice.md is explicit that the parameter is the
  // intention. Without it a writer that never loaded players can blank them.
  try {
    store.report(store.save(data, scope, { players: false }), 'repair-scheduled-results');
  } catch (e) {
    console.error(`store.save failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`\n${cleared} record(s) repaired. They will appear in results and in the`);
  console.log('finals view on the next page load.');
  console.log(`=== repair-scheduled-results ${VERSION} complete ===`);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
}
