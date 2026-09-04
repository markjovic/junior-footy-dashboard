#!/usr/bin/env node
// scripts/enrich-games.js
//
// Backfills PlayHQ game ids AND per-quarter scores across every stored season,
// unattended, in one dispatch.
//
// WHY THIS REPLACES TWO SCRIPTS AND SIX RUNS
//
// backfill-game-ids.js and fetch-quarter-scores.js walked the same rounds for the
// same grades, one after the other, per season, and each needed re-running as
// extraction bugs were fixed. That is a workflow built for the author's
// convenience, not the operator's. This does the whole job from one dispatch:
//
//   per grade: fetch the round list ONCE
//              stamp gameId onto records that lack one
//              fetch each game's periods
//   commit and push every CHECKPOINT records
//   stop cleanly before the runner's time limit and RE-DISPATCH ITSELF
//   skip anything already complete, so a resumed run costs only the remainder
//
// ⚠️ IT IS DESIGNED TO BE INTERRUPTED. A six-hour job limit will not cover
// ~53,000 games. The run commits as it goes, records where it got to, and asks
// GitHub to start the next one. Nothing needs watching.
//
// WHAT IT WRITES, per match record:
//   gameId            PlayHQ's id, where it could be matched unambiguously
//   hQ / aQ           points per quarter, ordered by the grade's period list
//   hQGB / aQGB       [goals, behinds] per quarter, where PlayHQ reported them
//   hQDer / aQDer     index of a quarter CALCULATED from the total, if any
//   qFlag             [homeDiff, awayDiff] when the quarters do not sum to the score
//
// USAGE
//   node scripts/enrich-games.js                 # dry run, whole archive
//   node scripts/enrich-games.js --apply
//   EG_YEAR=2026 EG_APPLY=true node scripts/enrich-games.js
//
// Exit codes: 0 = finished. 75 = stopped on the time budget, more work remains
// (the workflow re-dispatches on this). 1 = fatal.

'use strict';

const VERSION = 'enrich-games v1 2026-09-04';
// Extraction version stamped on every record this script writes. Bump it when the
// EXTRACTION changes in a way that makes older records worth re-fetching.
//   1  points only (fetch-quarter-scores v5-v8)
//   2  points + goals/behinds + derived quarter + qFlag
const QV = 2;

const { execFileSync } = require('child_process');
const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');
const engine = require('./lib/results-engine');

const APPLY      = process.argv.includes('--apply') || process.env.EG_APPLY === 'true';
const YEAR       = (process.env.EG_YEAR || '').trim();      // blank = every year
const COMP       = (process.env.EG_COMP || '').trim();
const REDO       = process.env.EG_REDO === 'true';
const CHECKPOINT = Math.max(25, Number(process.env.EG_CHECKPOINT || 200));
const COMMIT     = APPLY && process.env.EG_COMMIT !== 'false';
// Stop this far into the run and hand over to the next one. GitHub's job limit is
// 360 minutes; leaving 40 covers the final commit and the re-dispatch.
const BUDGET_MIN = Math.max(5, Number(process.env.EG_BUDGET_MIN || 300));
const DELAY      = Math.max(60, Number(process.env.EG_DELAY_MS || 120));

const started = Date.now();
const overBudget = () => (Date.now() - started) / 60000 >= BUDGET_MIN;
const mins = () => ((Date.now() - started) / 60000).toFixed(1);

// ── Extraction ───────────────────────────────────────────────────────────────
// The period table is on `statistics`, NOT on `result`. result.<side>.periods is
// a valid field that is always empty — established 2026-09-04 by capturing the
// game-centre page's own request after three probes concluded, wrongly, that
// PlayHQ did not expose the data.
const PERIOD_BLOCK = 'periods { period { value } statistics { count type { value } } }';

const Q_GAME = `query DiscoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    round { grade { hasPeriodScores periods { value } } }
    statistics { home { ${PERIOD_BLOCK} } away { ${PERIOD_BLOCK} } }
  }
}`;

const Q_ROUND = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { name } ... on ProvisionalTeam { name } }
      result {
        home { statistics { count type { value } } }
        away { statistics { count type { value } } }
      }
    }
  }
}`;

const statOf = (stats, type) => {
  const s = (stats || []).find(x => x.type?.value === type);
  return s && s.count !== null && s.count !== undefined ? s.count : null;
};
// TOTAL_SCORE when present, otherwise derived from goals and behinds. Requiring
// the explicit total discarded whole games over one quarter that lacked it.
const pScore = (stats) => {
  const t = statOf(stats, 'TOTAL_SCORE');
  if (t !== null) return t;
  const g = statOf(stats, '6_POINT_SCORE'), b = statOf(stats, '1_POINT_SCORE');
  if (g === null && b === null) return null;
  return (g || 0) * 6 + (b || 0);
};
const pGB = (stats) => {
  const g = statOf(stats, '6_POINT_SCORE'), b = statOf(stats, '1_POINT_SCORE');
  if (g === null && b === null) return null;
  return [g || 0, b || 0];
};

// Ordered by the grade's own period list — PlayHQ returns the array shuffled.
function quarters(periods, order, total) {
  if (!Array.isArray(periods) || !periods.length) return { reason: 'empty' };
  const pts = new Map(), gb = new Map();
  for (const p of periods) {
    const v = p?.period?.value;
    if (!v) continue;
    pts.set(v, pScore(p.statistics));
    const x = pGB(p.statistics);
    if (x) gb.set(v, x);
  }
  const seq = (order && order.length) ? order
    : ['FIRST_QTR', 'SECOND_QTR', 'THIRD_QTR', 'FOURTH_QTR'];
  const out = seq.map(v => pts.get(v));
  const gbs = seq.map(v => gb.get(v) || null);
  if (out.every(v => v !== null && v !== undefined)) {
    return { q: out, gb: gbs.every(Boolean) ? gbs : null };
  }
  // Exactly one missing period is arithmetic: total minus the rest. It FORCES
  // reconciliation, so the index is recorded and the dashboard marks it.
  const miss = out.map((v, i) => (v === null || v === undefined) ? i : -1).filter(i => i >= 0);
  if (miss.length === 1 && total !== null && total !== undefined) {
    const d = total - out.reduce((a, v) => a + (Number(v) || 0), 0);
    if (d >= 0) { out[miss[0]] = d; return { q: out, gb: null, derivedAt: miss[0] }; }
  }
  return { reason: `${seq.length - miss.length} of ${seq.length}` };
}

// ── Matching, for the id backfill ────────────────────────────────────────────
// The same fuzzy join that put U9 scores on a U11 player's card. Scoped to one
// grade's round, exact pair only, and anything ambiguous refused outright.
const norm = (n, age) => {
  try { return engine.cleanTeam(String(n || ''), age) || ''; }
  catch (e) { return String(n || '').trim(); }
};
const pairKey = (a, b) => [a, b].map(x => x.toLowerCase()).sort().join('|');

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}`);
  console.log(`Scope: ${COMP || 'all competitions'}${YEAR ? `, ${YEAR}` : ', every season'}` +
    `${REDO ? ', REDO (re-fetch what is already stored)' : ''}`);
  console.log(`Budget: ${BUDGET_MIN} min, then commit and hand over to a fresh run.\n`);

  const scope = COMP ? [COMP] : null;
  const data = store.load(scope, { players: false });
  const yearOf = (c) => (String(c || '').match(/\b(\d{4})\b/) || [])[1] || '';

  const inScope = (data.matches || []).filter(m =>
    !m.isBye && !m.isPartial && !m.scheduled && !m.live && m.gradeId &&
    m.hScore !== null && m.hScore !== undefined &&
    (!YEAR || yearOf(m.compName) === YEAR));

  // ⚠️ A VERSION MARKER, NOT JUST "HAS hQ".
  //
  // Without it, a REDO run that hits its time budget cannot be continued: the
  // follow-up would either skip everything (redo off, so old points-only records
  // look done) or redo everything again (redo on, repeating the first run's work).
  // qV records WHICH extraction produced a record, so a continuation picks up
  // exactly where the last one stopped — which is what makes one dispatch enough.
  const done = (m) => {
    if (m.qV === QV) return true;             // this version already did it
    if (REDO) return false;                   // upgrading — anything older is fair game
    return !!(Array.isArray(m.hQ) && m.hQ.length); // has data from some version, leave it
  };
  const todo = inScope.filter(m => !done(m));

  console.log(`${inScope.length} completed record(s) in scope; ` +
    `${inScope.length - todo.length} already enriched, ${todo.length} to do.`);
  if (!todo.length) { console.log('Nothing to do.'); return 0; }

  // Grouped by grade: one round-list call serves every round of that grade, and
  // the id backfill and the period fetch share it.
  const byGrade = new Map();
  for (const m of todo) {
    if (!byGrade.has(m.gradeId)) byGrade.set(m.gradeId, []);
    byGrade.get(m.gradeId).push(m);
  }
  const grades = [...byGrade.keys()];
  console.log(`${grades.length} grade(s) to walk.\n`);

  let calls = 0, found = 0, empty = 0, flagged = 0, refused = 0;
  let stamped = 0, noGrade = 0, resolved = 0, committed = 0;
  const emptyWhy = new Map();

  const gitCommit = (label) => {
    if (!COMMIT) return;
    try {
      execFileSync('git', ['add', '-A', 'data/'], { stdio: 'pipe' });
      const staged = execFileSync('git', ['diff', '--staged', '--name-only'], { encoding: 'utf8' }).trim();
      if (!staged) return;
      execFileSync('git', ['commit', '-m', `Enrich games: ${label}`], { stdio: 'pipe' });
      execFileSync('git', ['pull', '--rebase'], { stdio: 'pipe' });
      execFileSync('git', ['push'], { stdio: 'pipe' });
      console.log(`    …pushed (${label})`);
    } catch (e) {
      const msg = (e.stderr || e.stdout || e.message || '').toString().split('\n')[0];
      console.error(`    ⚠️ push failed (${label}): ${msg.slice(0, 120)} — work is on disk, next checkpoint retries`);
    }
  };

  // Moves everything resolved onto the records, saves, and commits. Safe mid-run:
  // it only touches records this run resolved.
  let pending = 0;
  const flush = globalThis.__egFlush = (label) => {
    if (!APPLY) { for (const m of data.matches || []) delete m._e; pending = 0; return 0; }
    let n = 0;
    for (const m of data.matches || []) {
      const e = m._e;
      if (!e) continue;
      if (e.gameId) m.gameId = e.gameId;
      if (e.q) {
        m.hQ = e.q[0]; m.aQ = e.q[1];
        m.qV = QV;
        if (e.gb) { m.hQGB = e.gb[0]; m.aQGB = e.gb[1]; } else { delete m.hQGB; delete m.aQGB; }
        if (e.der && e.der[0] !== null) m.hQDer = e.der[0]; else delete m.hQDer;
        if (e.der && e.der[1] !== null) m.aQDer = e.der[1]; else delete m.aQDer;
        if (e.flag) m.qFlag = e.flag; else delete m.qFlag;
      }
      delete m._e;
      n++;
    }
    pending = 0;
    if (!n) return 0;
    try {
      store.save(data, scope, { players: false });
      committed += n;
      console.log(`    …checkpoint ${n} record(s) (${committed} this run) — ${label}`);
      gitCommit(label);
    } catch (e) {
      console.error(`    ⚠️ save failed: ${e.message}`);
    }
    return n;
  };

  const note = (m, patch) => {
    m._e = Object.assign(m._e || {}, patch);
    pending++;
  };

  let gi = 0, stopped = false;
  for (const gradeId of grades) {
    if (overBudget()) { stopped = true; break; }
    gi++;
    const recs = byGrade.get(gradeId);
    const s0 = recs[0];
    console.log(`[${gi}/${grades.length}] ${s0.compName} ${s0.age} ${s0.rawGrade}` +
      `  — ${found} quarters, ${stamped} ids, ${mins()} min`);

    // ── One round list per grade ──
    let rounds = [];
    try {
      const rr = await gqlPost(engine.Q_GRADE_ROUNDS, { gradeID: gradeId });
      rounds = rr?.data?.discoverGrade?.rounds || [];
      calls++;
    } catch (e) { continue; }

    // ── Stamp missing ids from the round fixtures ──
    const needId = recs.filter(m => !m.gameId);
    if (needId.length) {
      for (const round of rounds) {
        if (overBudget()) { stopped = true; break; }
        const isF = round.isFinalsRound === true;
        const rr = needId.filter(m => isF
          ? (m.isFinals && String(m.finalsAbbrev || '') === String(round.abbreviatedName || ''))
          : (!m.isFinals && String(m.round) === String(round.number)));
        if (!rr.length) continue;

        let games = [];
        try {
          const r = await gqlPost(Q_ROUND, { roundID: round.id }, 'discoverFixtureByRound');
          games = r?.data?.discoverFixtureByRound?.games || [];
          calls++;
        } catch (e) { continue; }

        const age = s0.age;
        const gMap = new Map(), gDup = new Set();
        for (const g of games) {
          const h = norm(g.home?.name, age), a = norm(g.away?.name, age);
          if (!h || !a || !g.id) continue;
          const k = pairKey(h, a);
          if (gMap.has(k)) gDup.add(k); else gMap.set(k, g);
        }
        const rMap = new Map(), rDup = new Set();
        for (const m of rr) {
          const k = pairKey(norm(m.home, age), norm(m.away, age));
          if (rMap.has(k)) rDup.add(k); else rMap.set(k, m);
        }
        for (const [k, m] of rMap) {
          if (rDup.has(k) || gDup.has(k)) { refused++; continue; }
          const g = gMap.get(k);
          if (!g) { refused++; continue; }
          const gh = statOf(g.result?.home?.statistics, 'TOTAL_SCORE');
          const ga = statOf(g.result?.away?.statistics, 'TOTAL_SCORE');
          if (gh !== null && ga !== null) {
            const ok = (gh === m.hScore && ga === m.aScore) || (gh === m.aScore && ga === m.hScore);
            if (!ok) { refused++; continue; }
          }
          note(m, { gameId: g.id });
          m.gameId = g.id;      // usable immediately by the period fetch below
          stamped++;
        }
        await sleep(DELAY);
      }
    }
    if (stopped) break;

    // ── Periods, per game ──
    for (const m of recs) {
      if (overBudget()) { stopped = true; break; }
      if (!m.gameId) continue;
      let g;
      try {
        const r = await gqlPost(Q_GAME, { gameID: m.gameId }, 'DiscoverGame');
        calls++;
        g = r?.data?.discoverGame;
      } catch (e) { continue; }
      if (!g) { empty++; continue; }
      if (g.round?.grade?.hasPeriodScores === false) { noGrade++; continue; }

      const order = (g.round?.grade?.periods || []).map(x => x.value);
      const rh = quarters(g.statistics?.home?.periods, order, m.hScore);
      const ra = quarters(g.statistics?.away?.periods, order, m.aScore);
      if (!rh.q || !ra.q) {
        empty++;
        const why = !rh.q && !ra.q ? `both: ${rh.reason}`
                  : !rh.q ? `home: ${rh.reason}` : `away: ${ra.reason}`;
        emptyWhy.set(why, (emptyWhy.get(why) || 0) + 1);
        continue;
      }

      const hs = rh.q.reduce((a, b) => a + b, 0), as = ra.q.reduce((a, b) => a + b, 0);
      const dh = hs - m.hScore, da = as - m.aScore;
      // Beyond a couple of goals is not a scorer slip — that is a different game.
      if (Math.abs(dh) > 12 || Math.abs(da) > 12) { refused++; continue; }
      note(m, {
        q: [rh.q, ra.q],
        gb: (rh.gb && ra.gb) ? [rh.gb, ra.gb] : null,
        der: [rh.derivedAt ?? null, ra.derivedAt ?? null],
        flag: (dh || da) ? [dh, da] : null,
      });
      found++;
      if (dh || da) flagged++;
      resolved++;
      if (pending >= CHECKPOINT) flush(`${gi}/${grades.length}`);
      await sleep(DELAY);
    }
    if (stopped) break;
  }

  flush('final');

  console.log('\nRESULT');
  console.log('─'.repeat(70));
  console.log(`  API calls                      ${calls}`);
  console.log(`  grades walked                  ${gi} of ${grades.length}`);
  console.log(`  game ids stamped               ${stamped}`);
  console.log(`  quarters found                 ${found}  (${flagged} do not sum to the score, flagged)`);
  console.log(`  returned nothing               ${empty}`);
  console.log(`  grade records no quarters      ${noGrade}`);
  console.log(`  refused (ambiguous or wrong)   ${refused}`);
  console.log(`  elapsed                        ${mins()} min`);
  console.log('─'.repeat(70));
  if (emptyWhy.size) {
    console.log('\n  Why nothing was returned:');
    for (const [w, n] of [...emptyWhy].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${String(n).padStart(6)}  ${w}`);
    }
    console.log('    "empty" = PlayHQ returned nothing. Anything else is a partial');
    console.log('    breakdown this code could not complete.');
  }

  if (stopped) {
    console.log(`\n⏸  Stopped on the ${BUDGET_MIN} min budget at grade ${gi} of ${grades.length}.`);
    console.log('   Everything so far is committed. A fresh run continues from here —');
    console.log('   the workflow re-dispatches automatically.');
    return 75;
  }
  console.log('\n✅ Complete for this scope.');
  return 0;
}

main()
  .then(code => { if (typeof logSummary === 'function') logSummary('enrich-games'); process.exit(code); })
  .catch(e => {
    console.error('Fatal:', e && e.stack ? e.stack : e);
    // Salvage whatever was resolved before the failure — the last checkpoint is
    // already pushed, this catches the tail.
    try { if (typeof globalThis.__egFlush === 'function') globalThis.__egFlush('after a fatal error'); }
    catch (e2) { console.error('Salvage failed:', e2.message); }
    process.exit(1);
  });
