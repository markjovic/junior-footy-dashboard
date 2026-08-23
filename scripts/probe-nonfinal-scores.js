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

const VERSION = 'probe-nonfinal-scores v5 2026-08-20 every-game-by-status';

const store = require('./lib/store');
const { gqlPost, spectatorScore, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const COMP    = (process.env.PROBE_COMP || '').trim();
const NROUNDS = Math.max(1, Math.min(6, Number(process.env.PROBE_ROUNDS || 2)));
// 0 = EVERY grade in scope, and that is the default.
//
// ⚠️ A CAP MAKES A NEGATIVE RESULT WORTHLESS. v1 probed 12 grades and would have
// printed "NONE — PlayHQ is not filling in the score" on a sample of about 3% of
// live grades. That is a conclusion from a sample, and the question being asked
// is precisely whether such games exist ANYWHERE.
//
// A live-season sweep is roughly 350-400 grades — one rounds call each plus a
// fixture call per trailing round, so around 1,000-1,200 requests at 250ms. Five
// minutes for a read-only probe that answers the question properly.
const NGRADES = Math.max(0, Number(process.env.PROBE_GRADES || 0));

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
  const all = data.matches || [];

  // ⚠️ SHOW THE WORKING BEFORE BAILING. v1 printed "No live grades found" and
  // exited 1 — which could mean nothing loaded, no record carried a gradeId, or
  // the live filter removed everything, and there was no way to tell which.
  // working_practice.md: a tool that reports something is absent must show what it
  // found instead. Written the same day that rule was, and broken immediately.
  const liveList = store.liveComps(['ACTIVE', 'UPCOMING']) || [];
  const live = new Set(liveList);
  const compsInData = [...new Set(all.map(m => m.compName).filter(Boolean))];
  const withGrade = all.filter(m => m.gradeId).length;

  console.log('LOADED');
  console.log(`  ${all.length} match record(s) across ${compsInData.length} competition(s)`);
  console.log(`  ${withGrade} carry a gradeId`);
  console.log(`  manifest says ACTIVE/UPCOMING: ${liveList.length ? liveList.join(', ') : '(none)'}`);
  if (compsInData.length) {
    console.log(`  competitions in the data: ${compsInData.slice(0, 8).join(', ')}` +
      `${compsInData.length > 8 ? ` (+${compsInData.length - 8})` : ''}`);
  }

  // If the manifest marks nothing live — a season's status can lag, or the field
  // can be absent — fall back to every competition present rather than reporting
  // nothing. The probe is read-only; a wider sweep costs calls, not safety.
  const useLive = live.size > 0 && compsInData.some(c => live.has(c));
  if (!useLive && live.size) {
    console.log('  ⚠️  none of the live competitions appear in the loaded data — ' +
      'probing everything instead');
  } else if (!live.size) {
    console.log('  ⚠️  the manifest marks no season ACTIVE or UPCOMING — ' +
      'probing everything instead');
  }
  console.log('');

  const grades = [];
  const seen = new Set();
  for (const m of all) {
    if (!m.gradeId || seen.has(m.gradeId)) continue;
    if (useLive && !live.has(m.compName)) continue;
    seen.add(m.gradeId);
    grades.push({ gradeId: m.gradeId, compName: m.compName, age: m.age, rawGrade: m.rawGrade });
  }
  if (!grades.length) {
    console.error('Nothing to probe. From the figures above:');
    console.error(`  ${all.length ? '' : '— no records loaded at all; check the scope and data/seasons/'}`);
    console.error(`  ${all.length && !withGrade ? '— records loaded but none carry a gradeId' : ''}`);
    console.error(`  ${withGrade && useLive ? '— records carry gradeIds but none are in a live competition' : ''}`);
    process.exit(1);
  }

  // Finals grades first — they are the reason this exists.
  const finalsGrades = new Set((data.matches || []).filter(m => m.isFinals).map(m => m.gradeId));
  grades.sort((a, b) => (finalsGrades.has(b.gradeId) ? 1 : 0) - (finalsGrades.has(a.gradeId) ? 1 : 0));
  const picks = NGRADES > 0 ? grades.slice(0, NGRADES) : grades;
  const partial = picks.length < grades.length;
  console.log(`${grades.length} grade(s) in scope; probing ${picks.length}` +
    `${partial ? ' — A SAMPLE' : ' — all of them'}, finals grades first.`);
  console.log(`Roughly ${picks.length * (1 + NROUNDS)} request(s) at ~250ms each ` +
    `(~${Math.ceil(picks.length * (1 + NROUNDS) * 0.25 / 60)} min).\n`);

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
          gameId: game.id || null,
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

  // ── ⚠️ discoverFixtureByRound IS NOT THE ONLY SOURCE ──────────────────────
  //
  // v3 concluded "the scores are not there to show" from ONE endpoint. They are
  // visible on the PlayHQ website and app for PENDING games, so they exist —
  // discoverFixtureByRound simply returns an empty `result` block until FINAL.
  //
  // Two other documented routes, and this asks BOTH rather than picking one:
  //
  //   discoverGame(gameID) on the main API — same session, same transport, so if
  //     this carries the score there is nothing new to build
  //   the SPECTATOR endpoint — playhq_api_reference.md describes it as serving
  //     live e-scoring and hidden game scores, which is what an app showing a
  //     running score would be reading
  //
  // The spectator attempt is made WITHOUT a session cookie, because lib/playhq.js
  // does not expose one and it may not need it. A 403 is a useful answer, not a
  // failure — it says the endpoint is reachable and wants credentials.
  const Q_GAME = `query DiscoverGame($gameID: ID!) {
    discoverGame(gameID: $gameID) {
      id
      status { value }
      result {
        winner { value }
        outcome { value }
        home { statistics { count type { value } } }
        away { statistics { count type { value } } }
      }
    }
  }`;

  const Q_SPECTATOR = `query game($id: ID!) {
    game(id: $id) {
      id
      status
      result {
        home { statistics { type { value } count } }
        away { statistics { type { value } count } }
      }
    }
  }`;

  // ⚠️ EVERY non-final game, not the first 40.
  //
  // v4 capped this at 40 of 46 and then reported on PENDING — and there were
  // exactly 6 PENDING games, so the cap could have excluded precisely the case in
  // question. That is the second time in one script that a conclusion was drawn
  // from a slice; the first was the grade cap, fixed in v3.
  const nonFinalIds = rows.filter(r => r.gameId);
  // Counted PER STATUS. "2 of 40 carried a score" cannot answer "do PENDING games
  // have scores", which is the actual question.
  const mk = () => ({ tried: 0, scored: 0, errors: new Map(), samples: [],
                      byStatus: new Map() });
  const second = mk(), third = mk();
  const note = (r, st, got) => {
    if (!r.byStatus.has(st)) r.byStatus.set(st, { tried: 0, scored: 0 });
    const b = r.byStatus.get(st);
    b.tried++; if (got) b.scored++;
  };

  if (nonFinalIds.length) {
    console.log(`\nSECOND SOURCE — discoverGame on the main API (${nonFinalIds.length} game(s))`);
    for (const r of nonFinalIds) {
      second.tried++;
      try {
        const res = await gqlPost(Q_GAME, { gameID: r.gameId });
        const g = res?.data?.discoverGame;
        const hs = stat(g?.result?.home?.statistics, 'TOTAL_SCORE');
        const as = stat(g?.result?.away?.statistics, 'TOTAL_SCORE');
        const got = (hs != null && hs !== 0) || (as != null && as !== 0);
        note(second, r.status, got);
        if (got) {
          second.scored++;
          if (second.samples.length < 8) {
            second.samples.push(`${r.comp} ${r.age} ${r.grade} r${r.round} ` +
              `[${g?.status?.value || r.status}] ${hs}-${as}`);
          }
        }
      } catch (e) {
        const k = String(e.message).slice(0, 60);
        second.errors.set(k, (second.errors.get(k) || 0) + 1);
      }
      await sleep(200);
    }

    console.log(`THIRD SOURCE — spectator endpoint (${nonFinalIds.length} game(s))`);
    for (const r of nonFinalIds) {
      third.tried++;
      // Through lib/playhq.js rather than a second hand-rolled fetch, so the WAF
      // handling, retries and counters are the ones every other call uses.
      let sc = null;
      try { sc = await spectatorScore(r.gameId); }
      catch (e) {
        const k = String(e.message).slice(0, 60);
        third.errors.set(k, (third.errors.get(k) || 0) + 1);
      }
      const got = !!sc && ((sc.hScore != null && sc.hScore !== 0) || (sc.aScore != null && sc.aScore !== 0));
      note(third, r.status, got);
      if (got) {
        third.scored++;
        if (third.samples.length < 8) {
          third.samples.push(`${r.comp} ${r.age} ${r.grade} r${r.round} ` +
            `[api:${r.status} / spec:${sc.status}] ${sc.hScore}-${sc.aScore}` +
            (sc.hG != null ? `  (${sc.hG}.${sc.hB} v ${sc.aG}.${sc.aB})` : ''));
        }
      } else if (!sc) {
        third.errors.set('no score returned', (third.errors.get('no score returned') || 0) + 1);
      }
      await sleep(200);
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
    console.log('  discoverFixtureByRound returns an EMPTY result block for these —');
    console.log('  see the second and third sources below before concluding anything.');
    if (partial) {
      console.log(`  NONE — but only ${picks.length} of ${grades.length} grades were probed.`);
      console.log('  ⚠️  THAT PROVES NOTHING. A sample cannot show that something does not');
      console.log('      exist. Re-run with PROBE_GRADES=0 (the default) for every grade');
      console.log('      before concluding PlayHQ withholds the score.');
    } else {
      console.log(`  NONE, across ALL ${grades.length} grade(s) in scope and the last ` +
        `${NROUNDS} round(s) of each.`);
      console.log('  PlayHQ is not filling in the score until it marks a game FINAL, so');
      console.log('  there is nothing to show early.');
      console.log('  ⚠️  Timing still matters: run this while games are unconfirmed. A');
      console.log('      midweek run finds nothing because everything has been settled.');
    }
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

  // ── What the other two sources said ───────────────────────────────────────
  if (second.tried || third.tried) {
    const show = (name, r) => {
      console.log(`\n${name}`);
      console.log(`  ${r.scored} of ${r.tried} non-final game(s) carried a score`);
      for (const [st, b] of [...r.byStatus].sort((a, b2) => b2[1].tried - a[1].tried)) {
        console.log(`    ${String(st).padEnd(14)} ${String(b.scored).padStart(4)} of ` +
          `${String(b.tried).padStart(4)}`);
      }
      for (const sm of r.samples) console.log(`    ${sm}`);
      for (const [k, n] of [...r.errors].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        console.log(`    ${String(n).padStart(4)} x  ${k}`);
      }
    };
    show('SECOND SOURCE — discoverGame (main API)', second);
    show('THIRD SOURCE — spectator endpoint (no cookie)', third);
  }

  console.log('\nVERDICT');
  if (second.scored || third.scored) {
    // The interesting answer. Which endpoint carries it decides what gets built.
    if (second.scored) {
      console.log(`  ✅ discoverGame CARRIES THE SCORE for ${second.scored} non-final game(s).`);
      console.log('  Same endpoint, same session, same transport as everything else — so');
      console.log('  showing an unofficial score needs no new infrastructure, only a');
      console.log('  second call for games this round returned as non-FINAL.');
    }
    if (third.scored) {
      console.log(`  ✅ the SPECTATOR endpoint carries the score for ${third.scored} game(s).`);
      console.log('  That is a different host and header set; lib/playhq.js would need to');
      console.log('  learn it. It is what the PlayHQ app reads for a running score.');
    }
    console.log('\n  Next: docs/unofficial_scores_design.md — an `unofficial` record, shown');
    console.log('  with a marker, excluded from ladders and percentages until FINAL.');
  } else if (!withScore.length) {
    console.log(partial
      ? '  NO VERDICT — a sample was probed. Re-run with PROBE_GRADES=0.'
      : `  Not found on ANY of the three sources tried (fixture, discoverGame,\n` +
        `  spectator). If the score is visible on the site, it is coming from a\n` +
        `  fourth route — check the errors above before concluding anything.`);
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
