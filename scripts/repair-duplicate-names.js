#!/usr/bin/env node
// scripts/repair-duplicate-names.js
//
// Repairs the duplicate records a mid-season team RENAME leaves behind, in the
// case `cleanup-rename-duplicates.js` deliberately refuses to touch: where NEITHER
// record carries a `gameId`.
//
// WHY THAT CASE NEEDS ITS OWN TOOL
// A match id embeds both team names, so a rename stores the same game twice. When
// one of the two records has a `gameId`, that record is PlayHQ's current answer and
// the other can be deleted offline — `cleanup-rename-duplicates.js` does exactly
// that. When NEITHER has one, both records predate engine v16 and nothing stored
// says which name PlayHQ serves now. Deleting the wrong one leaves a name the API
// will never confirm, so that script reports and stops.
//
// Measured 2026-08-19: 34 such pairs across six seasons — 21 of them in LIVE
// seasons, so this is not only an archive problem. Two rename shapes:
//   " - LP" appended to BOTH teams        (Lightning Premiership, SEJ 2026)
//   an age token inserted into ONE team    ("Mt Eliza JFC Boys Red" ->
//                                           "Mt Eliza JFC U17 Boys Red", SER 2026)
//
// THE REPAIR — ask, do not infer.
// discoverFixtureByRound re-serves completed rounds IN FULL, settled 2026-08-19 by
// probe-refetch-round.js. So for each affected round this fetches the round and
// reads the team names PlayHQ serves TODAY. The stored record whose names match is
// current; the other is stale and is removed. Neither the newer-looking name nor
// the longer one is assumed to win — the API is asked.
//
// It also stamps the surviving record with PlayHQ's `gameId`. That is what stops
// the pair recurring: the record becomes self-identifying, and any future rename
// supersedes it in place through the engine's v16 path instead of adding beside it.
//
// ⚠️ ROUNDS ARE NOT RE-FETCHED BY THE NORMAL PATH. `knownRounds` is built in
// memory from stored records and fetchGrade skips anything at or below it, so
// neither fetch-results nor backfill will ever revisit these rounds. That is why a
// dedicated tool is needed rather than "just run a fetch".
//
// USAGE
//   node scripts/repair-duplicate-names.js                  # dry run
//   node scripts/repair-duplicate-names.js --apply
//   REPAIR_COMP="SEJ 2026" node scripts/repair-duplicate-names.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'repair-duplicate-names v3 2026-08-20 carnival-guards';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const SCORE_FIELDS = ['hScore', 'hG', 'hB', 'aScore', 'aG', 'aB'];
const sameScores = (a, b) => SCORE_FIELDS.every(k => (a[k] ?? null) === (b[k] ?? null));

const CLUB_WORDS = /\b(jfc|fc|jfnc|fnc|jnr|junior|juniors|football|netball|club|inc|assoc|association)\b/g;
const normTeam = (n) => String(n || '')
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(CLUB_WORDS, ' ')
  .replace(/\s+/g, ' ').trim();

const NEVER_A_MARKER = new Set([
  'blue', 'gold', 'red', 'green', 'white', 'black', 'yellow', 'navy', 'maroon',
  'purple', 'orange', 'silver', 'teal', 'grey', 'gray', 'brown', 'pink',
  'girls', 'boys', 'mixed', 'a', 'b', 'c', 'd', '1', '2', '3', '4',
]);
function extraToken(x, y) {
  if (!x || !y.startsWith(x + ' ')) return null;
  const rest = y.slice(x.length + 1).trim();
  return rest && !rest.includes(' ') ? rest : null;
}
// The same pairing test cleanup-rename-duplicates.js uses, so the two tools agree
// about what a duplicate IS and only differ in what they do about it.
function samePair(a, b) {
  const A = [normTeam(a.home), normTeam(a.away)].sort();
  const B = [normTeam(b.home), normTeam(b.away)].sort();
  if (!A[0] || !B[0]) return false;
  if (A[0] === B[0] && A[1] === B[1]) return true;
  for (const [b0, b1] of [[B[0], B[1]], [B[1], B[0]]]) {
    for (const [x0, y0, x1, y1] of [[A[0], b0, A[1], b1], [b0, A[0], b1, A[1]]]) {
      const t0 = extraToken(x0, y0), t1 = extraToken(x1, y1);
      if (t0 && t0 === t1 && !NEVER_A_MARKER.has(t0)) return true;
    }
  }
  return false;
}
const sharesTeamExactly = (a, b) =>
  a.home === b.home || a.away === b.away || a.home === b.away || a.away === b.home;

// ⚠️ TWO GUARDS ON THE PAIRING, both added 2026-08-20 after the report listed 13
// pairs that were not duplicates at all.
//
// A LIGHTNING CARNIVAL breaks the score+date+shared-team signature completely.
// Every game is 0-0, every game is on one day, and each team plays several — so
// "Cobras v Vikings" and "Dragons v Vikings" match on all three and are plainly
// two different fixtures. All 13 false positives were that shape.
//
//   1. ALL-ZERO SCORES ARE NOT EVIDENCE. Six matching zeroes say nothing; in a
//      carnival grade they are the norm. At least one score field must be non-zero
//      before identical scores count for anything.
//
//   2. WHEN ONLY ONE TEAM IS SHARED, the other two must be plausibly the same club.
//      A rename changes one side — "Berwick" to "Berwick Springs", "Mt Eliza JFC
//      Boys Red" to "Mt Eliza JFC U17 Boys Red" — so the two non-shared names
//      still start with the same club word. "Cobras" and "Dragons" do not.
//      A prefix test is too strict: the U17 case inserts the token in the middle.
const anyScore = (a) => SCORE_FIELDS.some(k => Number(a[k] || 0) !== 0);
const firstTok = (n) => normTeam(n).split(' ')[0] || '';
// The sides NOT shared between two records, compared on their opening word.
function otherSidesAgree(a, b) {
  const A = [a.home, a.away], B = [b.home, b.away];
  const shared = A.find(x => B.includes(x));
  if (!shared) return true;               // nothing shared — samePair decided it
  const oa = A.find(x => x !== shared), ob = B.find(x => x !== shared);
  if (!oa || !ob) return false;
  const ta = firstTok(oa), tb = firstTok(ob);
  return !!ta && ta === tb;
}


const tokenOfMatch = (m) =>
  engine.roundToken(m.round, m.isFinals ? (m.finalsAbbrev || String(m.round)) : '');

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply') || process.env.REPAIR_APPLY === 'true';
  const comp = (process.env.REPAIR_COMP || '').trim();

  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log(`Mode: ${apply ? 'APPLY — a stale record will be deleted per repaired pair'
                              : 'DRY RUN — nothing will be written'}`);
  console.log(`Scope: ${comp || 'all seasons loaded'}`);

  const scope = comp ? [comp] : null;
  let data;
  try { data = store.load(scope, { players: false }); }
  catch (e) { console.error(`store.load failed: ${e.message}`); process.exit(1); }

  const all = data.matches || [];
  console.log(`\nLoaded ${all.length} match record(s)`);

  // ── Find the pairs, exactly as the offline report does ────────────────────
  const groups = new Map();
  for (const m of all) {
    if (m.isBye || m.isPartial || !m.gradeId) continue;
    const k = `${m.compName}\u0000${m.age}\u0000${m.gradeId}\u0000${tokenOfMatch(m)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const pairs = [];
  for (const [k, recs] of groups) {
    if (recs.length < 2) continue;
    const used = new Set();
    for (let i = 0; i < recs.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < recs.length; j++) {
        if (used.has(j)) continue;
        const a = recs[i], b = recs[j];
        if (a.gameId && b.gameId) continue;
        if (!sameScores(a, b)) continue;
        if ((a.date || '') !== (b.date || '')) continue;
        if (!anyScore(a)) continue;
        if (!samePair(a, b) && !sharesTeamExactly(a, b)) continue;
        if (!otherSidesAgree(a, b)) continue;
        used.add(i); used.add(j);
        pairs.push({ key: k, a, b });
        break;
      }
    }
  }

  if (!pairs.length) {
    console.log('\nNo duplicate pairs found. Nothing to repair.');
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }
  console.log(`${pairs.length} duplicate pair(s) across ${new Set(pairs.map(p => p.key)).size} round(s)`);

  // ── Ask PlayHQ which names it serves, one fetch per affected ROUND ────────
  const byRound = new Map();
  for (const p of pairs) {
    if (!byRound.has(p.key)) byRound.set(p.key, []);
    byRound.get(p.key).push(p);
  }
  console.log(`Fetching ${byRound.size} round(s) from PlayHQ...\n`);

  const repairs = [], skipped = [];

  for (const [key, group] of byRound) {
    const [compName, age, gradeId, rToken] = key.split('\u0000');
    const label = `${compName} ${age} ${gradeId} round ${rToken}`;

    let rounds;
    try {
      const res = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: gradeId });
      rounds = res?.data?.discoverGrade?.rounds || [];
    } catch (e) { skipped.push({ label, why: `rounds: ${e.message}`, group }); continue; }

    const wantFinals = String(rToken).startsWith('F:');
    const wantAbbrev = wantFinals ? String(rToken).slice(2) : null;
    const round = rounds.find(r => wantFinals
      ? (r.isFinalsRound && (r.abbreviatedName || '') === wantAbbrev)
      : (!r.isFinalsRound && Number(r.number) === Number(rToken)));
    if (!round) { skipped.push({ label, why: `round not found among ${rounds.length}`, group }); continue; }

    let games;
    try {
      const res = await gqlPost(engine.Q_FIXTURE, { roundID: round.id });
      games = res?.data?.discoverFixtureByRound?.games || [];
    } catch (e) { skipped.push({ label, why: `fixture: ${e.message}`, group }); continue; }

    if (!games.length) { skipped.push({ label, why: 'the API returned no games', group }); continue; }

    // ⚠️ STORED NAMES ARE CLEANED; THE API'S ARE RAW.
    //
    // results-engine.js runs every team name through cleanTeam(name, gradeAge)
    // before storing, which strips the GRADE'S OWN age token and nothing else. v1
    // compared the raw API name against the cleaned stored one, so nothing ever
    // matched and all 34 pairs reported "NEITHER name is served" — a confident
    // answer produced entirely by my own comparison.
    //
    // Worse, that mechanism is where most of these duplicates came from. cleanTeam
    // has two paths: with a gradeAge it strips only that exact token, and without
    // one it strips ANY U-number. So the same PlayHQ name stored at different times
    // yields "Mt Eliza JFC U17 Boys Red" and "Mt Eliza JFC Boys Red" — one game,
    // two ids, and no rename involved. In a U17.5 grade the exact-token path cannot
    // match "U17", which is why that grade is over-represented in the report.
    //
    // Both forms are tried, so a genuine PlayHQ rename is still detected.
    const formsOf = (g, which) => {
      const raw = g[which]?.name;
      if (!raw) return [];
      const cleaned = engine.cleanTeam(raw, age);
      return cleaned === raw ? [raw] : [raw, cleaned];
    };
    const matchOf = (rec) => games.find(g => {
      const H = formsOf(g, 'home'), A = formsOf(g, 'away');
      return (H.includes(rec.home) && A.includes(rec.away)) ||
             (H.includes(rec.away) && A.includes(rec.home));
    });

    for (const p of group) {
      const ga = matchOf(p.a), gb = matchOf(p.b);
      if (ga && gb) { skipped.push({ label, why: 'BOTH names are still served — two real games', group: [p] }); continue; }
      if (!ga && !gb) {
        // The names PlayHQ actually returned, so a non-match is diagnosable. v1
        // printed the verdict alone and there was no way to tell a real rename
        // from a broken comparison — which is exactly what it turned out to be.
        const served = games.map(g => `${g.home?.name} v ${g.away?.name}`).slice(0, 4);
        skipped.push({ label, why: 'NEITHER name is served — cannot tell which is current',
          detail: [`stored A: ${p.a.home} v ${p.a.away}`,
                   `stored B: ${p.b.home} v ${p.b.away}`,
                   `served  : ${served.join(' | ')}${games.length > 4 ? ` (+${games.length - 4})` : ''}`],
          group: [p] });
        continue;
      }
      const keep = ga ? p.a : p.b;
      const drop = ga ? p.b : p.a;
      const game = ga || gb;
      repairs.push({ label, keep, drop, gameId: game.id });
    }
    await sleep(400);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`── Repairable: ${repairs.length} ──`);
  for (const r of repairs.slice(0, 20)) {
    console.log(`  ${r.label}`);
    console.log(`    KEEP   ${r.keep.id}`);
    console.log(`      + gameId ${r.gameId}${r.keep.gameId ? ' (already had one)' : ' (stamped)'}`);
    console.log(`    REMOVE ${r.drop.id}`);
  }
  if (repairs.length > 20) console.log(`  ... ${repairs.length - 20} more`);

  if (skipped.length) {
    console.log(`\n── Left alone: ${skipped.length} ──`);
    for (const s of skipped.slice(0, 15)) {
      console.log(`  ${s.label} — ${s.why}`);
      for (const d of (s.detail || [])) console.log(`      ${d}`);
    }
    if (skipped.length > 15) console.log(`  ... ${skipped.length - 15} more`);
    console.log('\n  "BOTH names are still served" means these are two genuinely different');
    console.log('  fixtures that happen to share a score and a date. Not duplicates.');
  }

  if (!repairs.length) {
    console.log('\nNothing to repair.');
    if (typeof logSummary === 'function') logSummary('repair-duplicate-names');
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }
  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with apply: true.');
    if (typeof logSummary === 'function') logSummary('repair-duplicate-names');
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const kill = new Set(repairs.map(r => r.drop.id));
  // Counted BEFORE the loop. `r.keep` and the record found below are the SAME
  // object — both come from data.matches — so counting after the mutation reads
  // zero every time. It reported "Stamped 0" while stamping two.
  const toStamp = repairs.filter(r => !r.keep.gameId).length;
  for (const r of repairs) {
    const rec = data.matches.find(m => m.id === r.keep.id);
    if (rec && !rec.gameId) rec.gameId = r.gameId;
  }
  const before = data.matches.length;
  data.matches = data.matches.filter(m => !kill.has(m.id));
  const removed = before - data.matches.length;

  // The id set is what this acted on; if the filter removed a different number,
  // it was not the set this thought it was. Throw rather than persist.
  if (removed !== kill.size) {
    console.error(`\nABORT: expected to remove ${kill.size}, removed ${removed}. Nothing written.`);
    process.exit(1);
  }
  console.log(`\nRemoved ${removed} stale record(s) (${before} -> ${data.matches.length})`);
  console.log(`Stamped ${toStamp} survivor(s) with a gameId`);

  try {
    store.report(store.save(data, scope, { players: false }), 'repair-duplicate-names');
  } catch (e) { console.error(`store.save failed: ${e.message}`); process.exit(1); }

  console.log('\nRun Audit Data, then check the affected ladders — the P column should');
  console.log('drop by one for each team that held a duplicate.');
  if (typeof logSummary === 'function') logSummary('repair-duplicate-names');
  console.log(`=== ${VERSION} complete ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
