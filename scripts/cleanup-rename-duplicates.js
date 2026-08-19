#!/usr/bin/env node
// scripts/cleanup-rename-duplicates.js
//
// A9 — removes the phantom match records a mid-season team rename created before
// engine v16.
//
// THE DEFECT
// A match id embeds both team names:
//   EFNL 2026|U12|6f964e7b|8|Norwood|Vermont
// PlayHQ renames teams mid-season. When it does, the same game re-fetches under a
// new id and the old record stays, so one game becomes two records. Each one
// inflates its grade's ladder P column by one. Sixteen were found in SEJ
// `a5a8276d` and six in `cb7b3db3`; six are still on the SEJ 2026 U10 Girls A
// ladder today.
//
// Engine v16 stopped this happening: every record now carries `gameId`, PlayHQ's
// own fixture id, and a re-fetch whose gameId matches a stored record SUPERSEDES
// it rather than adding beside it. Records written BEFORE v16 have no gameId, so
// the engine cannot match them and they persist.
//
// ⚠️ WHY THE OBVIOUS RULE IS NOT USED
// The rule first proposed was: within a (gradeId, round) where at least one record
// carries a gameId, any record WITHOUT one is superseded. That is only sound if a
// re-fetch returns a completed round COMPLETELY — otherwise a real game can be
// left without a gameId and this would delete it. Whether that holds is A8, and
// A8 is unsettled: one observation says a completed round returns 0 games, another
// says it re-serves in full.
//
// THE RULE USED INSTEAD — safe under either answer.
// A record is a rename phantom when ALL of these hold:
//   1. it has no `gameId`
//   2. another record in the SAME (compName, age, gradeId, round) HAS a gameId
//   3. that record has the SAME six score fields and the same date
//   4. the two records share at least one team name
//
// (3) and (4) are what make this independent of A8. A real game that simply has
// not been re-fetched has no score-twin sitting beside it, so it is never touched
// — the rule can only fire where the same game demonstrably exists twice. (4)
// rules out the coincidence of two different fixtures in one grade and round
// finishing on identical scores on the same day: a rename changes ONE side's name,
// so the phantom and its survivor always share the other.
//
// Every record that fails (3) or (4) while passing (1) and (2) is REPORTED and
// never deleted. That residue is the measurement A8 would otherwise have to
// provide, and it costs nothing to look at.
//
// LIVE SEASONS ONLY by default. A retired season is never re-fetched, so its
// records will never acquire a gameId and condition (2) can never be met — running
// there would find nothing and only risks acting on data nothing can repair.
// STALE_INCLUDE_RETIRED=true overrides, for inspection.
//
// Offline: no PlayHQ calls.
//
// USAGE
//   node scripts/cleanup-rename-duplicates.js               # dry run
//   node scripts/cleanup-rename-duplicates.js --apply
//   CLEANUP_COMP="SEJ 2026" node scripts/cleanup-rename-duplicates.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'cleanup-rename-duplicates v3 2026-08-19 both-rename-shapes';

const store = require('./lib/store');

const SCORE_FIELDS = ['hScore', 'hG', 'hB', 'aScore', 'aG', 'aB'];

const sameScores = (a, b) => SCORE_FIELDS.every(k => (a[k] ?? null) === (b[k] ?? null));

// ⚠️ EXACT name matching is not enough, which v1 got wrong.
//
// v1 required the phantom and its survivor to share one team name exactly, on the
// reasoning that a rename changes ONE side. That holds for a single club renaming
// itself. It does NOT hold when a league standardises its club names in bulk —
// every team in the round changes at once, no name matches exactly, and the rule
// never fires. Measured 2026-08-19 against SEJ 2026 U10 Girls `cb7b3db3` round 9:
// three records with a gameId and three without, all six on the same date, and v1
// removed nothing.
//
// Normalising strips the club-type words PlayHQ adds and removes — JFC, FC,
// Junior Football Club and so on — plus punctuation and case. "Cardinia JFC Girls"
// and "Cardinia Girls" then agree, while "Cardinia" and "Clyde" still do not.
//
// The COLOUR and the age word are deliberately KEPT. "Berwick Springs Blue" and
// "Berwick Springs Gold" are two different teams from one club, and stripping the
// colour would let one be deleted as a duplicate of the other.
const CLUB_WORDS = /\b(jfc|fc|jfnc|fnc|jnr|junior|juniors|football|netball|club|inc|assoc|association)\b/g;
const normTeam = (n) => String(n || '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(CLUB_WORDS, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// The two sides as an unordered normalised pair, so a home/away swap between the
// two records does not defeat the comparison.
const teamPair = (m) => [normTeam(m.home), normTeam(m.away)].sort().join(' v ');
const samePair = (a, b) => teamPair(a) === teamPair(b) && normTeam(a.home) !== '';

// Kept as a separate, stricter signal so the report can say WHICH kind of rename
// it found — one club, or the whole league.
const sharesTeamExactly = (a, b) =>
  a.home === b.home || a.away === b.away || a.home === b.away || a.away === b.home;

// The round token, matching results-engine.js: finals restart numbering at 1, so a
// bare number would merge a grand final with home-and-away round 1.
const roundKey = (m) => (m.isFinals ? `F:${m.finalsAbbrev || 'F'}` : String(m.round));

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply') || process.env.CLEANUP_APPLY === 'true';
  const comp = (process.env.CLEANUP_COMP || '').trim();
  const includeRetired = process.env.CLEANUP_INCLUDE_RETIRED === 'true';

  console.log(`=== ${VERSION} ===`);
  console.log(`Mode: ${apply ? 'APPLY — records will be deleted' : 'DRY RUN — nothing will be written'}`);
  console.log(`Scope: ${comp || 'every live season'}${includeRetired ? ' + retired' : ''}`);

  const scope = comp ? [comp] : null;
  let data;
  try {
    data = store.load(scope, { players: false });
  } catch (e) {
    console.error(`store.load failed: ${e.message}`);
    process.exit(1);
  }

  const all = data.matches || [];
  console.log(`\nLoaded ${all.length} match record(s)`);

  const liveComps = new Set(store.liveComps(['ACTIVE']) || []);
  const inScope = (m) => includeRetired || !liveComps.size || liveComps.has(m.compName);

  // Group by the identity a rename does NOT change.
  const groups = new Map();
  for (const m of all) {
    if (m.isBye || m.isPartial) continue;
    if (!m.gradeId) continue;          // pre-migration; grade identity is not reliable
    if (!inScope(m)) continue;
    const k = `${m.compName}\u0000${m.age}\u0000${m.gradeId}\u0000${roundKey(m)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const doomed = [];      // phantoms to remove
  const unmatched = [];   // no gameId, but no score-twin — never touched
  let groupsWithMixedIds = 0;

  for (const [k, recs] of groups) {
    const withId = recs.filter(r => r.gameId);
    const without = recs.filter(r => !r.gameId);
    if (!withId.length || !without.length) continue;
    groupsWithMixedIds++;

    for (const orphan of without) {
      // Same grade, same round, same date, all six score fields identical, and the
      // same two clubs once names are normalised. Each condition on its own is
      // weak; together they can only describe one game stored twice.
      // EITHER shape of rename, because they are different and each misses the
      // other:
      //   one club renames itself   Berwick -> Berwick Springs, opponent unchanged
      //     normalised pair does NOT match ("berwick" vs "berwick springs"), but a
      //     team name is shared exactly.
      //   the league standardises    Cardinia JFC Girls -> Cardinia Girls, both sides
      //     no name is shared exactly, but the normalised pair matches.
      // v2 used only the second and silently lost the first — caught by rebuilding
      // the v1 fixture rather than trusting that a later rule was a superset.
      const twin = withId.find(s =>
        sameScores(orphan, s) &&
        (orphan.date || '') === (s.date || '') &&
        (samePair(orphan, s) || sharesTeamExactly(orphan, s)));
      if (twin) {
        doomed.push({ orphan, twin, group: k,
          kind: sharesTeamExactly(orphan, twin) ? 'one club renamed' : 'names standardised' });
      } else {
        unmatched.push({ orphan, group: k, siblings: withId });
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`${groups.size} (comp, age, grade, round) group(s); ` +
    `${groupsWithMixedIds} hold both a record with a gameId and one without`);

  console.log(`\n── Rename phantoms to remove: ${doomed.length} ──`);
  if (doomed.length) {
    const byComp = {};
    for (const d of doomed) {
      const c = d.orphan.compName || '(none)';
      byComp[c] = (byComp[c] || 0) + 1;
    }
    for (const c of Object.keys(byComp).sort()) console.log(`  ${c}: ${byComp[c]}`);
    console.log('\n  Each line is the phantom, then the record that supersedes it:');
    for (const d of doomed.slice(0, 15)) {
      console.log(`    REMOVE ${d.orphan.id}`);
      console.log(`      keep ${d.twin.id}`);
      console.log(`           ${d.orphan.hScore}-${d.orphan.aScore} on ${d.orphan.date || 'no date'}, ` +
        `gameId ${d.twin.gameId}  [${d.kind}]`);
    }
    if (doomed.length > 15) console.log(`    ... ${doomed.length - 15} more`);
  }

  // The residue. This is the number that would otherwise need A8 to interpret:
  // records with no gameId sitting beside records that have one, but with no
  // matching score — so either the round was re-served incompletely, or they are
  // genuinely different games.
  console.log(`\n── Left alone: ${unmatched.length} record(s) with no gameId and no score-twin ──`);
  if (unmatched.length) {
    console.log('  NOT deleted. Each is either a real game the API has not re-served,');
    console.log('  or a genuinely different fixture. Deleting on "no gameId" alone would');
    console.log('  take these with it — which is why that rule is not used.');
    // The SIBLINGS are printed too. Without them a non-match cannot be diagnosed:
    // "3 records with a gameId in this round" says nothing about whether they are
    // the same games under different names, which is the only question that
    // matters here. v1 printed only the count and the answer was unobtainable.
    for (const u of unmatched.slice(0, 10)) {
      console.log(`    ORPHAN  ${u.orphan.id}`);
      console.log(`            ${u.orphan.hScore}-${u.orphan.aScore} on ${u.orphan.date || 'no date'}`);
      for (const sib of u.siblings.slice(0, 6)) {
        const why = [];
        if (!sameScores(u.orphan, sib)) why.push('scores differ');
        if ((u.orphan.date || '') !== (sib.date || '')) why.push('dates differ');
        if (!samePair(u.orphan, sib)) why.push(`teams differ (${teamPair(u.orphan)} vs ${teamPair(sib)})`);
        console.log(`      vs  ${sib.id}`);
        console.log(`            ${sib.hScore}-${sib.aScore} on ${sib.date || 'no date'} ` +
          `gameId ${sib.gameId} — ${why.join(', ') || 'MATCHES (should have been caught)'}`);
      }
    }
    if (unmatched.length > 10) console.log(`    ... ${unmatched.length - 10} more`);
    console.log('\n  A large number here is A8 answering itself: it means completed rounds');
    console.log('  are NOT being re-served in full.');
  }

  if (!doomed.length) {
    console.log('\nNothing to remove.');
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with apply: true to delete.');
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const kill = new Set(doomed.map(d => d.orphan.id));
  const before = data.matches.length;
  data.matches = data.matches.filter(m => !kill.has(m.id));
  const removed = before - data.matches.length;

  // A count check, not a trust exercise. store.save writes whatever it is handed,
  // and a filter that removed the wrong number means the id set was not what this
  // thought it was — throw rather than persist it.
  if (removed !== kill.size) {
    console.error(`\nABORT: expected to remove ${kill.size} record(s), removed ${removed}. ` +
      `Nothing written.`);
    process.exit(1);
  }
  console.log(`\nRemoved ${removed} record(s) from memory (${before} -> ${data.matches.length})`);

  try {
    store.report(store.save(data, scope, { players: false }), 'cleanup-rename-duplicates');
  } catch (e) {
    console.error(`store.save failed: ${e.message}`);
    process.exit(1);
  }

  console.log('\nRun Audit Data next, and check the affected ladders: the P column');
  console.log('should drop by one for each team that held a phantom.');
  console.log(`=== ${VERSION} complete ===`);
}

try {
  main();
} catch (e) {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
}
