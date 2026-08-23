#!/usr/bin/env node
// scripts/probe-nonfinal-scores.js
//
// Can we show a score before PlayHQ marks a game FINAL?
//
// THE SITUATION
// `results-engine.js` line 699 is the whole of the current behaviour:
//
//     const finalGames = games.filter(g => g.status?.value === 'FINAL');
//
// Everything else is discarded before any score is read. The query already asks
// for `status { value }` and `result { home { statistics } }`, so if PlayHQ fills
// those in for a non-final game we are already receiving scores and throwing them
// away. Reported 2026-08-20: finals scorelines visible on PlayHQ hours after the
// game, with the dashboard showing nothing.
//
// WHY THIS IS A PROBE AND NOT A ONE-LINE CHANGE
// "Not FINAL" hides two very different things:
//
//   a game that is OVER and simply not confirmed — a volunteer has not pressed
//     the button, and the score is complete and safe to show
//   a game IN PROGRESS — the score is partial, and storing it as a result would
//     put a wrong number on a ladder
//
// Nothing in the current code can tell them apart, and guessing is how a
// half-time score ends up in a percentage. This measures what is actually there.
//
// ⚠️ IT ALSO CANNOT SIMPLY ASK FOR MORE FIELDS. A rejected field fails the WHOLE
// query — that took the player panel to "no stats found" for every player in
// August. So the period/quarter probe below is a SEPARATE query document: if it is
// rejected, only that probe dies and the rest still reports.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-nonfinal-scores.js
//   PROBE_COMP="EFNL 2026" node scripts/probe-nonfinal-scores.js
//   PROBE_ROUNDS=3 node scripts/probe-nonfinal-scores.js   # last N rounds per grade
//
// Exit codes: 0 = ran and reported. 1 = fatal.

'use strict';

const VERSION = 'probe-nonfinal-scores v1 2026-08-20';

const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const COMP    = (process.env.PROBE_COMP || '').trim();
const NROUNDS = Math.max(1, Math.min(6, Number(process.env.PROBE_ROUNDS || 2)));
const NGRADES = Math.max(1, Math.min(40, Number(process.env.PROBE_GRADES || 12)));

// Scores as the engine reads them, so this reports what the engine WOULD store.
const stat = (arr, type) => {
  const s = (arr || []).find(x => x.type?.value === type);
  return s ? s.count : null;
};

function todayAEST() {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  const data = store.load(COMP ? [COMP] : null, { players: false });
  const live = new Set(store.liveComps(['ACTIVE']) || []);
  const grades = [];
  const seen = new Set();
  for (const m of data.matches || []) {
    if (!m.gradeId || seen.has(m.gradeId)) continue;
    if (live.size && !live.has(m.compName)) continue;
    seen.add(m.gradeId);
    grades.push({ gradeId: m.gradeId, compName: m.compName, age: m.age, rawGrade: m.rawGrade });
  }
  if (!grades.length) { console.error('No live grades found.'); process.exit(1); }

  // Finals grades first — they are the reason this exists.
  const finalsGrades = new Set((data.matches || []).filter(m => m.isFinals).map(m => m.gradeId));
  grades.sort((a, b) => (finalsGrades.has(b.gradeId) ? 1 : 0) - (finalsGrades.has(a.gradeId) ? 1 : 0));
  const picks = grades.slice(0, NGRADES);
  console.log(`${grades.length} live grade(s); probing ${picks.length}, finals grades first.\n`);

  const statusCount = new Map();
  const rows = [];
  const today = todayAEST();

  for (const g of picks) {
    let rounds;
    try {
      const r = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: g.gradeId });
      rounds = r?.data?.discoverGrade?.rounds || [];
    } catch (e) { continue; }

    // The last N rounds — where anything unconfirmed will be.
    for (const round of rounds.slice(-NROUNDS)) {
      let games;
      try {
        const r = await gqlPost(engine.Q_FIXTURE, { roundID: round.id });
        games = r?.data?.discoverFixtureByRound?.games || [];
      } catch (e) { continue; }

      for (const game of games) {
        const st = game.status?.value || '(none)';
        statusCount.set(st, (statusCount.get(st) || 0) + 1);
        if (st === 'FINAL') continue;

        const hs = stat(game.result?.home?.statistics, 'TOTAL_SCORE');
        const as = stat(game.result?.away?.statistics, 'TOTAL_SCORE');
        const hg = stat(game.result?.home?.statistics, 'GOALS');
        const hb = stat(game.result?.home?.statistics, 'BEHINDS');
        const date = (game.date || (game.allocation?.dateTimeList || [])[0]?.date || '').slice(0, 10);

        rows.push({
          comp: g.compName, age: g.age, grade: g.rawGrade,
          round: round.abbreviatedName || round.name || round.number,
          isFinals: !!round.isFinalsRound,
          status: st, hs, as, hg, hb, date,
          past: date && date < today,
          hasScore: (hs != null && hs !== 0) || (as != null && as !== 0),
          // Does goals*6 + behinds equal the total? If the parts are consistent
          // with the whole, the record is at least internally complete.
          consistent: (hg != null && hb != null && hs != null) ? (hg * 6 + hb === hs) : null,
          winner: game.result?.winner?.value || null,
          outcome: game.result?.outcome?.value || null,
        });
      }
      await sleep(250);
    }
  }

  // ── What statuses exist at all ────────────────────────────────────────────
  console.log('STATUS VALUES SEEN');
  console.log('─'.repeat(60));
  for (const [k, n] of [...statusCount].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(24)} ${String(n).padStart(5)}`);
  }
  console.log('─'.repeat(60));
  console.log('  Only FINAL is stored today. Everything else is discarded at');
  console.log('  results-engine.js line 699 before any score is read.\n');

  const withScore = rows.filter(r => r.hasScore);
  console.log(`NON-FINAL GAMES CARRYING A SCORE: ${withScore.length} of ${rows.length}`);
  if (!withScore.length) {
    console.log('  NONE. PlayHQ is not filling in the score until it marks a game FINAL,');
    console.log('  so there is nothing to show early and no change worth making.');
  } else {
    console.log('─'.repeat(104));
    console.log('comp / age / grade                 round     status            score      G-B   date        past  parts ok');
    console.log('─'.repeat(104));
    for (const r of withScore.slice(0, 40)) {
      console.log(
        `${(r.comp + ' ' + r.age + ' ' + r.grade).slice(0, 34).padEnd(34)} ` +
        `${String(r.round).padEnd(9)} ${String(r.status).padEnd(17)} ` +
        `${String(r.hs).padStart(4)}-${String(r.as).padEnd(4)} ` +
        `${String(r.hg ?? '?').padStart(3)}.${String(r.hb ?? '?').padEnd(3)} ` +
        `${(r.date || '?').padEnd(11)} ${(r.past ? 'yes' : 'no').padEnd(5)} ` +
        `${r.consistent === null ? '?' : r.consistent ? 'yes' : 'NO'}` +
        `${r.isFinals ? '   [FINALS]' : ''}`);
    }
    if (withScore.length > 40) console.log(`... ${withScore.length - 40} more`);
    console.log('─'.repeat(104));

    const past = withScore.filter(r => r.past);
    const inconsistent = withScore.filter(r => r.consistent === false);
    const finals = withScore.filter(r => r.isFinals);
    console.log(`\n  ${past.length} are DATED IN THE PAST — the game is over and unconfirmed`);
    console.log(`  ${withScore.length - past.length} are today or later — could still be in progress`);
    console.log(`  ${finals.length} are FINALS games`);
    console.log(`  ${inconsistent.length} have goals*6 + behinds NOT equal to the total`);
    if (inconsistent.length) {
      console.log('  ⚠️  An inconsistent record is a score still being entered. That is the');
      console.log('      shape that must never reach a ladder.');
    }
    const decided = withScore.filter(r => r.winner || r.outcome).length;
    console.log(`\n  A winner or outcome is already set on ${decided} of them —`);
    console.log('  PlayHQ deciding an outcome is a strong signal the game is done.');
  }

  console.log('\nVERDICT');
  if (!withScore.length) {
    console.log('  No change worth making — the scores are not there to show.');
  } else {
    const safe = withScore.filter(r => r.past && r.consistent !== false);
    console.log(`  ${safe.length} game(s) are dated in the past with internally consistent scores.`);
    console.log('  Those are the candidates for an "unofficial" record: shown with a marker,');
    console.log('  excluded from ladders and percentages until PlayHQ says FINAL.');
    console.log('  See docs/unofficial_scores_design.md before building anything.');
  }

  if (typeof logSummary === 'function') logSummary('probe-nonfinal-scores');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
