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

const VERSION = 'enrich-games v18 2026-09-05 honest-gb-reason';
// Extraction version stamped on every record this script writes. Bump it when the
// EXTRACTION changes in a way that makes older records worth re-fetching.
//   1  points only (fetch-quarter-scores v5-v8)
//   2  points + goals/behinds + derived quarter + qFlag
//   3  goals/behinds KEPT on derived and partial breakdowns — v2 discarded them
//      whenever any quarter was calculated or missing, which is a large share of
//      games, so a v2 record may be missing g.b it could have had
const QV = 3;

const { execFileSync } = require('child_process');
const fs = require('fs');
const store = require('./lib/store');
const { gqlPost, sleep, logSummary, summary } = require('./lib/playhq');
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
const DELAY      = Math.max(0, Number(process.env.EG_DELAY_MS || 120));
// ⚠️ CONCURRENCY. A serial walk measured 0.83 s per call — 13,120 calls in 182
// minutes — because almost all of that is waiting for PlayHQ, not the 120 ms
// delay. Six at a time turns three hours into about half an hour.
//
// Six, not more: the fetchers elsewhere in this repo use 8 and the WAF has been
// tripped at that rate today. This is a background walk with hours to spare, so
// there is nothing to gain from crowding it.
const CONC = Math.max(1, Math.min(12, Number(process.env.EG_CONC || 6)));
// Minutes of clear running before concurrency steps back up. Time, not batches:
// a batch is only `conc` requests and passes in seconds.
const RECOVER_MIN = Math.max(0.25, Number(process.env.EG_RECOVER_MIN || 2));
// Minutes of clear running AT THE CEILING before the ceiling itself is lifted. The
// blocks come in bursts rather than as a standing limit, so a cap earned during a
// bad patch must not survive the whole run.
const CEIL_RECOVER_MIN = Math.max(1, Number(process.env.EG_CEIL_RECOVER_MIN || 8));
// ⚠️ PUSHING IS NOT FREE — EVERY PUSH REBUILDS AND REDEPLOYS GITHUB PAGES.
//
// v1 pushed at every checkpoint, roughly every 90 seconds, which over a 17-hour
// archive walk is several hundred Pages builds. Pages throttles well before that,
// and the deploys are pure waste: nobody needs the dashboard updated every 90
// seconds during a backfill.
//
// So the two are decoupled. The local SAVE still happens every CHECKPOINT records
// — it costs a file write and is the insurance against losing work. The PUSH
// happens at most every PUSH_MIN minutes, and always at the end of a run.
const PUSH_MIN = Math.max(0, Number(process.env.EG_PUSH_MIN || 20));
// How long a "PlayHQ has nothing" answer stands for a LIVE season before it is
// worth asking again. Retired seasons are never re-asked.
//
// ONE DAY. A scorer filling quarters in on the Monday after a game is the normal
// case, not the exception, and a 45-day window would have meant a game played in
// September carried "no quarters" until the season was over. The saving this
// exists for comes from the RETIRED seasons — 45,000 of the 52,000 records — where
// the answer is settled for good. A live season is a few thousand games and
// re-asking them daily costs little.
const QNO_DAYS = Math.max(0, Number(process.env.EG_QNO_DAYS || 1));
// ⚠️ SEED THE CURSOR — for the transition only.
//
// Runs 1-3 walked roughly the first 900 grades under v1/v2, which recorded no
// cursor. Without this, v5's first run starts at grade 0 and repeats all of it.
// Setting this marks the first N grades as walked WITHOUT asking about them.
//
// It relies on the grade order being the same between runs. It is — the list
// comes from the order records sit in the season files, which nothing reorders —
// but if it were ever wrong the cost is bounded: those grades are recorded in the
// cursor, so they are revisited on the NEXT pass once it clears. Nothing is
// permanently skipped.
//
// Defaults to 0. It briefly defaulted to 600 to carry over runs 1-3, which were
// made by versions that recorded no cursor. That pass has completed, so the
// carry-over is done and leaving it in would make every future pass silently skip
// its first 600 grades.
const SKIP_FIRST = Math.max(0, Number(process.env.EG_SKIP_FIRST || 0));

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
    if (d >= 0) {
      out[miss[0]] = d;
      // ⚠️ KEEP THE GOALS AND BEHINDS THAT WERE REPORTED. Returning gb: null here
      // threw away three good quarters' worth because the fourth was calculated —
      // and a derived quarter is common, so this silently emptied the g.b line on
      // a large share of games. Null only at the derived index, which has none.
      const keep = gbs.slice(); keep[miss[0]] = null;
      return { q: out, gb: keep.some(Boolean) ? keep : null, derivedAt: miss[0] };
    }
  }
  // ⚠️ A PARTIAL BREAKDOWN IS KEPT, NOT DISCARDED.
  //
  // Two or three quarters recorded and the rest blank is still information —
  // "10 – 26 –" says more than an empty row. Earlier versions threw all of it
  // away because the set could not be completed, which on one 605-grade pass
  // discarded about 1,340 records PlayHQ had real data for.
  //
  // The NULLS ARE PRESERVED so the dashboard can show a gap where a quarter was
  // never recorded rather than a zero. A blank quarter and a scoreless quarter
  // are different things and must not look the same.
  if (miss.length < seq.length) {
    // Same again: the quarters that WERE recorded keep their goals and behinds.
    return { q: out, gb: gbs.some(Boolean) ? gbs : null, derivedAt: null, partial: miss };
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
  // ⚠️ A MISS MUST BE REMEMBERED, NOT JUST A HIT.
  //
  // v1 and v2 stamped qV only on records that GOT quarters. A record PlayHQ has
  // nothing for carried no mark at all, so every chained run asked about it
  // again — roughly 1,300 per pass, and by run 3 the first three and a half hours
  // were re-asking grades that had already answered "nothing" twice.
  //
  // `qNo` records the date PlayHQ was last asked and returned nothing:
  //   a RETIRED season is never asked again — nobody edits a 2022 scoresheet
  //   a live season is asked again after QNO_DAYS, because a scorer may fill it
  //     in late, which is the whole reason not to make this permanent
  // The manifest comes from core.json — store.load() does not return it. Getting
  // this wrong reported every season as unknown in probe-preseason-roster v1.
  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8')).manifest || [];
  } catch (e) {
    console.error(`⚠️ Could not read the manifest: ${e.message}`);
    console.error('   Retired seasons cannot be identified, so misses will be re-asked');
    console.error(`   after ${QNO_DAYS} days rather than never. Not fatal.`);
  }
  const retiredSeasons = new Set(manifest.filter(m => m.retired).map(m => m.compName));

  const missIsStale = (m) => {
    if (!m.qNo) return true;
    if (retiredSeasons.has(m.compName)) return false;   // settled for good
    const age = (Date.now() - Date.parse(m.qNo)) / 86400000;
    return !(age >= 0 && age < QNO_DAYS);
  };

  // ⚠️ `qV` IS THE ONLY THING THAT MEANS DONE — NOT THE PRESENCE OF `hQ`.
  //
  // The last line used to be `return !!(m.hQ && m.hQ.length)`, so ANY record with
  // quarters counted as finished. About 3,300 were written by
  // fetch-quarter-scores before goals and behinds were captured: they have hQ, no
  // qV, and no hQGB — and were skipped for ever unless someone ran a full `redo`,
  // which re-walks all 52,000.
  //
  // qV means "asked by THIS extraction", whatever it found. A record with
  // quarters but no qV was written by an older one and is re-asked. A record
  // written by this version with no goals and behinds is left alone, because
  // PlayHQ genuinely did not report them and asking again returns the same.
  const done = (m) => {
    if (m.qV === QV) return true;              // this version asked; keep whatever it got
    if (REDO) return false;                    // upgrading — anything older is fair game
    if (m.qNo && !missIsStale(m)) return true; // asked, PlayHQ had nothing, still fresh
    return false;                              // older version, or never asked — ask
  };
  const todo = inScope.filter(m => !done(m));

  const skippedMiss = inScope.filter(m => !todo.includes(m) && m.qNo && m.qV !== QV).length;
  console.log(`${inScope.length} completed record(s) in scope; ` +
    `${inScope.length - todo.length} already handled, ${todo.length} to do.`);
  const upgrading = todo.filter(m => Array.isArray(m.hQ) && m.hQ.length && m.qV !== QV).length;
  if (upgrading) {
    console.log(`  ${upgrading} already have quarters from an older version and will be ` +
      `re-asked to pick up goals and behinds.`);
  }
  if (skippedMiss) {
    console.log(`  of those, ${skippedMiss} are known to have no quarters — asked ` +
      `before, PlayHQ had nothing, not asked again.`);
  }
  if (!todo.length) { console.log('Nothing to do.'); return 0; }

  // Grouped by grade: one round-list call serves every round of that grade, and
  // the id backfill and the period fetch share it.
  const byGrade = new Map();
  for (const m of todo) {
    if (!byGrade.has(m.gradeId)) byGrade.set(m.gradeId, []);
    byGrade.get(m.gradeId).push(m);
  }
  let grades = [...byGrade.keys()];

  // ⚠️ A PASS CURSOR, so a chained run does not re-walk what the last one did.
  //
  // qNo (v3) stops a MISS being re-asked, but only from the run that recorded it
  // onwards. Runs 1-3 left no marker, so run 4 would still re-ask every one of
  // them — three and a half hours of repeating work before reaching anything new.
  //
  // The cursor is the list of grade ids ALREADY WALKED in this pass, kept in
  // core.json. It is exact and it does not care that the grade list shrinks
  // between runs as records get done, which an index-based cursor would.
  //
  // When every grade has been walked the pass is complete and the cursor clears,
  // so the next dispatch starts fresh — by which point qNo is doing the filtering
  // and there is far less to do.
  const cursorKey = `enrichPass${REDO ? 'Redo' : ''}`;
  let walked = new Set();
  try {
    const c = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'))[cursorKey];
    if (c && Array.isArray(c.grades)) walked = new Set(c.grades);
  } catch (e) { /* no cursor yet */ }

  // Seeding happens before anything else, so the count printed below is honest.
  if (SKIP_FIRST && !walked.size) {
    const seed = grades.slice(0, SKIP_FIRST);
    seed.forEach(g => walked.add(g));
    console.log(`⚠️ SEEDED: the first ${seed.length} grade(s) marked as walked WITHOUT`);
    console.log('   being asked — carrying over progress from runs that recorded no');
    console.log('   cursor. They are IN the cursor, so the next pass covers them.');
    console.log('');
    console.log('   ⚠️ EG_SKIP_FIRST defaults to 600 and should be set back to 0 once');
    console.log('      this pass completes. Left as it is, every future pass skips its');
    console.log('      first 600 grades.');
    console.log('');
  } else if (SKIP_FIRST && walked.size) {
    // A real cursor exists, so the seed is not applied — worth saying, because a
    // default that quietly stops mattering is one nobody remembers to remove.
    console.log(`(EG_SKIP_FIRST=${SKIP_FIRST} ignored — a real cursor exists. Set it to 0.)`);
  }

  const before = grades.length;
  if (walked.size) {
    grades = grades.filter(g => !walked.has(g));
    console.log(`${before} grade(s) have work; ${walked.size} already walked this pass, ` +
      `${grades.length} remaining.`);
    if (!grades.length) {
      // Everything has been seen once. Clear and let the next dispatch start over
      // with qNo filtering the misses out.
      console.log('\nPass complete — every grade walked. Clearing the cursor.');
      writeCursor(null);
      return 0;
    }
  } else {
    console.log(`${grades.length} grade(s) to walk.`);
  }
  console.log('');

  // Written at every checkpoint, so an interrupted run does not lose its place.
  //
  // ⚠️ NOT via store.saveCore — that copies only keys in CORE_KEYS and drops
  // anything it does not recognise, silently. Adding the cursor to CORE_KEYS
  // would put a scratch value in the file every reader loads. Read, patch, write.
  const writeCursor = (value) => {
    if (!APPLY) return;
    try {
      const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
      if (value === null) delete core[cursorKey]; else core[cursorKey] = value;
      fs.writeFileSync(store.CORE_PATH, JSON.stringify(core, null, 2), 'utf8');
    } catch (e) { console.error(`    ⚠️ cursor write failed: ${e.message}`); }
  };
  const saveCursor = () =>
    writeCursor({ grades: [...walked], at: new Date().toISOString(), version: VERSION });

  let calls = 0, found = 0, empty = 0, flagged = 0, refused = 0;
  let stamped = 0, noGrade = 0, resolved = 0, committed = 0, partialCount = 0;
  const emptyWhy = new Map();

  const gitCommit = (label) => {
    if (!COMMIT) return;
    try {
      execFileSync('git', ['add', '-A', 'data/'], { stdio: 'pipe' });
      const staged = execFileSync('git', ['diff', '--staged', '--name-only'], { encoding: 'utf8' }).trim();
      if (!staged) return;
      execFileSync('git', ['commit', '-m', `Enrich games: ${label}`], { stdio: 'pipe' });
      // ⚠️ NAME THE BRANCH. A bare `git pull --rebase` fails on a DETACHED HEAD —
      // "You are not currently on a branch" — which is what actions/checkout
      // leaves behind without a `ref:`. The commits then pile up locally and the
      // runner is discarded with them, having reported checkpoints all along.
      const branch = process.env.GITHUB_REF_NAME || 'main';
      execFileSync('git', ['pull', '--rebase', 'origin', branch], { stdio: 'pipe' });
      execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'pipe' });
      pushFailures = 0;
      console.log(`    …pushed (${label})`);
    } catch (e) {
      const msg = (e.stderr || e.stdout || e.message || '').toString().split('\n')[0];
      pushFailures++;
      console.error(`    ⚠️ push failed (${label}): ${msg.slice(0, 140)}`);
      // ⚠️ A push that fails EVERY time is not transient, and "work is on disk"
      // is false comfort — the disk goes away with the runner. Three in a row and
      // the run stops, so a broken push costs one checkpoint rather than a whole
      // three-hour walk.
      if (pushFailures >= 3) {
        console.error('');
        console.error('    THREE CONSECUTIVE PUSH FAILURES — stopping.');
        console.error('    Nothing after the last successful push will survive this runner.');
        console.error('    Check the checkout has a `ref:` — a detached HEAD cannot rebase.');
        throw new Error('push is not working; stopping rather than discarding hours of work');
      }
    }
  };

  // Moves everything resolved onto the records, saves, and commits. Safe mid-run:
  // it only touches records this run resolved.
  let pending = 0;
  let pushFailures = 0;
  let lastPush = Date.now();
  const flush = globalThis.__egFlush = (label) => {
    if (!APPLY) { for (const m of data.matches || []) delete m._e; pending = 0; return 0; }
    let n = 0;
    for (const m of data.matches || []) {
      const e = m._e;
      if (!e) continue;
      if (e.gameId) m.gameId = e.gameId;
      if (e.qNo) m.qNo = e.qNo;
      if (e.q) {
        // Quarters arrived, so any previous miss is history.
        delete m.qNo;
        m.hQ = e.q[0]; m.aQ = e.q[1];
        m.qV = QV;
        if (e.gb) { m.hQGB = e.gb[0]; m.aQGB = e.gb[1]; } else { delete m.hQGB; delete m.aQGB; }
        if (e.der && e.der[0] !== null) m.hQDer = e.der[0]; else delete m.hQDer;
        if (e.der && e.der[1] !== null) m.aQDer = e.der[1]; else delete m.aQDer;
        if (e.flag) m.qFlag = e.flag; else delete m.qFlag;
        // qPart is [homeMissingIdx[], awayMissingIdx[]] — which quarters were
        // never recorded. Its presence tells the dashboard to show a gap rather
        // than a zero.
        // ⚠️ A LIST, NOT A BOOLEAN. Two lines wrote this, the second overwriting
        // the first with `true` — a leftover from an earlier edit. `true` says a
        // breakdown has holes but not WHERE, so the dashboard could not tell a gap
        // from a scoreless quarter, which is the whole reason the field exists.
        if (e.partial) m.qPart = e.partial; else delete m.qPart;
      }
      delete m._e;
      n++;
    }
    pending = 0;
    if (!n) return 0;
    try {
      store.save(data, scope, { players: false });
      committed += n;
      const due = label === 'final' || label === 'after a fatal error' ||
        PUSH_MIN === 0 || (Date.now() - lastPush) / 60000 >= PUSH_MIN;
      console.log(`    …checkpoint ${n} record(s) (${committed} this run) — ${label}` +
        (due ? '' : `, next push in ${Math.max(0, PUSH_MIN - (Date.now() - lastPush) / 60000).toFixed(0)} min`));
      if (due) { lastPush = Date.now(); gitCommit(label); }
    } catch (e) {
      console.error(`    ⚠️ save failed: ${e.message}`);
    }
    return n;
  };

  const note = (m, patch) => {
    m._e = Object.assign(m._e || {}, patch);
    pending++;
  };

  // Current concurrency, tuned as the run proceeds.
  //
  // `ceiling` is LEARNED: whenever a level gets blocked, the ceiling drops below
  // it permanently for this run, so the walk converges on a rate PlayHQ tolerates
  // instead of oscillating around the one that fails.
  let conc = CONC;
  let ceiling = CONC;
  let lastBlockAt = 0;
  let lastCeilingLift = Date.now();
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

    // ── Periods, CONC games at a time ──
    //
    // ⚠️ handleGame() IS DEFINED HERE. A previous edit introduced the concurrent
    // batch loop and left the per-game body sitting below it as dead code after a
    // `continue`, so the run died on the first grade with
    // "ReferenceError: handleGame is not defined". node --check does not catch a
    // missing function — only running it does.
    //
    // Each worker handles one record end to end. Results are applied as they
    // arrive, which is safe because note() writes to the record itself rather than
    // to a shared list where order would matter. The counters are incremented from
    // several workers, but Node is single-threaded between awaits so ++ is atomic
    // here.
    const handleGame = async (m) => {
      if (!m.gameId) return;
      const today = new Date().toISOString().slice(0, 10);
      let g;
      try {
        const r = await gqlPost(Q_GAME, { gameID: m.gameId }, 'DiscoverGame');
        calls++;
        g = r?.data?.discoverGame;
      } catch (e) { return; }

      if (!g) { empty++; note(m, { qNo: today }); return; }
      // A grade that records no quarters at all is settled, not a gap.
      if (g.round?.grade?.hasPeriodScores === false) {
        noGrade++; note(m, { qNo: today }); return;
      }

      const order = (g.round?.grade?.periods || []).map(x => x.value);
      const rh = quarters(g.statistics?.home?.periods, order, m.hScore);
      const ra = quarters(g.statistics?.away?.periods, order, m.aScore);
      if (!rh.q || !ra.q) {
        empty++;
        const why = !rh.q && !ra.q ? `both: ${rh.reason}`
                  : !rh.q ? `home: ${rh.reason}` : `away: ${ra.reason}`;
        emptyWhy.set(why, (emptyWhy.get(why) || 0) + 1);
        note(m, { qNo: today });
        return;
      }

      const isPartial = !!(rh.partial || ra.partial);
      // ⚠️ NO SUM CHECK ON A PARTIAL. Quarters with a hole in them cannot add up
      // to the final score, and treating that as a mismatch would refuse every
      // one of them.
      let dh = 0, da = 0;
      if (!isPartial) {
        const hs = rh.q.reduce((x, y) => x + (y || 0), 0);
        const as = ra.q.reduce((x, y) => x + (y || 0), 0);
        dh = hs - m.hScore; da = as - m.aScore;
        // Beyond a couple of goals is a different game, not a scorer slip.
        if (Math.abs(dh) > 12 || Math.abs(da) > 12) {
          refused++; note(m, { qNo: today }); return;
        }
      }
      note(m, {
        q: [rh.q, ra.q],
        gb: (rh.gb && ra.gb) ? [rh.gb, ra.gb] : null,
        der: [rh.derivedAt ?? null, ra.derivedAt ?? null],
        flag: (!isPartial && (dh || da)) ? [dh, da] : null,
        partial: isPartial ? [rh.partial || [], ra.partial || []] : null,
      });
      found++;
      if (isPartial) partialCount++;
      if (!isPartial && (dh || da)) flagged++;
      resolved++;
    };

    // ⚠️ ADAPTIVE CONCURRENCY. A fixed 6 tripped PlayHQ's rate limit roughly every
    // two minutes: all six workers blocked at once, each waited 80 seconds, and
    // about 40% of the run went on backoff. Measured 2026-09-05.
    //
    // Guessing a lower fixed number is another blind experiment costing a
    // dispatch. Instead the run watches the WAF counter that lib/playhq.js already
    // keeps and tunes itself: halve on a block, step back up after a clear spell.
    // A run on a quiet API converges upward; one on a busy API settles low.
    const queue = recs.filter(m => m.gameId);
    for (let i = 0; i < queue.length; i += conc) {
      if (overBudget()) { stopped = true; break; }
      const before = summary().blocked;
      const batch = queue.slice(i, i + conc);
      await Promise.all(batch.map(m => handleGame(m)));
      const blockedNow = summary().blocked - before;

      // ⚠️ A BLOCK COSTS 80 SECONDS WHATEVER THE CONCURRENCY.
      //
      // Every in-flight request waits the CloudFront window out IN PARALLEL, so
      // the penalty per block event is the same at 1 as at 6 — but at 6 the run
      // does six times as much work between blocks. Measured 2026-09-05 on this
      // very walk: 17 grades in 0.5 min at concurrency 6, then 12 grades in 7 min
      // at concurrency 1. Backing off hard made the run SLOWER, not safer.
      //
      // So the response is gentle: step down by one, not halve. And the ceiling
      // RECOVERS — v16 ratcheted it down permanently, so one bad patch capped the
      // rest of a five-hour walk at 1.
      if (blockedNow > 0) {
        const was = conc;
        if (conc > 1) conc--;
        ceiling = Math.max(2, Math.min(ceiling, was));
        lastBlockAt = Date.now();
        lastCeilingLift = Date.now();
        if (conc !== was) {
          console.log(`    ↓ concurrency ${was} → ${conc} (rate limited, ceiling ${ceiling})`);
        }
      } else {
        const clearMin = (Date.now() - lastBlockAt) / 60000;
        if (conc < ceiling && clearMin >= RECOVER_MIN) {
          conc++;
          lastBlockAt = Date.now();
          console.log(`    ↑ concurrency → ${conc} (${RECOVER_MIN} min clear)`);
        } else if (conc >= ceiling && ceiling < CONC &&
                   (Date.now() - lastCeilingLift) / 60000 >= CEIL_RECOVER_MIN) {
          // Sustained clear running at the ceiling means the earlier block was a
          // burst, not a standing limit. Lift the cap and try again.
          ceiling++;
          lastCeilingLift = Date.now();
          console.log(`    ⇧ ceiling → ${ceiling} (${CEIL_RECOVER_MIN} min clear at the cap)`);
        }
      }

      if (pending >= CHECKPOINT) { saveCursor(); flush(`${gi}/${grades.length}`); }
      if (DELAY) await sleep(DELAY);
    }
    if (stopped) break;
    walked.add(gradeId);
    // Walked to completion — recorded so a later run skips it. NOT recorded if
    // the budget stopped us mid-grade, or the rest of that grade would be lost.
    if (!stopped) walked.add(gradeId);
    if (stopped) break;
  }

  saveCursor();
  flush('final');

  // ⚠️ WHAT THIS RUN DID IS NOT WHAT THE FILE HOLDS.
  //
  // Every report so far described only the current run — "quarters found 658" says
  // nothing about the other 52,000 records, so "do all games have goals and
  // behinds now?" could not be answered without re-reading the data by hand.
  //
  // Counted across EVERYTHING in scope, touched by this run or not.
  const cov = { total: 0, q: 0, gb: 0, partial: 0, derived: 0, flagged: 0,
                none: 0, asked: 0, noId: 0, qOldVer: 0, gbMissingCurrent: 0 };
  for (const m of inScope) {
    cov.total++;
    if (!m.gameId) cov.noId++;
    const hasQ = Array.isArray(m.hQ) && m.hQ.length;
    if (hasQ) {
      cov.q++;
      if (Array.isArray(m.hQGB) && Array.isArray(m.aQGB)) cov.gb++;
      else if (m.qV === QV) cov.gbMissingCurrent++;   // asked; PlayHQ had none
      if (m.qV !== QV) cov.qOldVer++;                 // older extraction
      if (m.qPart) cov.partial++;
      if (m.hQDer !== undefined || m.aQDer !== undefined) cov.derived++;
      if (m.qFlag) cov.flagged++;
    } else if (m.qNo) { cov.asked++; }
    else { cov.none++; }
  }
  const pc = (n) => cov.total ? `${(n / cov.total * 100).toFixed(1)}%` : '—';

  console.log('\nCOVERAGE — the whole scope, not just this run');
  console.log('─'.repeat(70));
  console.log(`  records in scope               ${cov.total}`);
  console.log(`  with quarter scores            ${cov.q}  (${pc(cov.q)})`);
  console.log(`  ...WITH goals and behinds      ${cov.gb}  (${pc(cov.gb)})`);
  console.log(`  ...partial, some quarters blank ${cov.partial}`);
  console.log(`  ...a quarter calculated        ${cov.derived}`);
  console.log(`  ...do not sum to the score     ${cov.flagged}`);
  console.log(`  asked, PlayHQ had nothing      ${cov.asked}  (${pc(cov.asked)})`);
  console.log(`  NEVER ASKED                    ${cov.none}  (${pc(cov.none)})`);
  console.log(`  no gameId, cannot be asked     ${cov.noId}`);
  console.log('─'.repeat(70));
  if (cov.none === 0) {
    console.log('  ✅ Every record in scope has been asked about.');
  } else {
    console.log(`  ⚠️ ${cov.none} record(s) have never been asked. Re-run to cover them.`);
  }
  if (cov.q && cov.gb < cov.q) {
    // ⚠️ SAY WHICH, DO NOT ASSERT A CAUSE.
    //
    // This used to blame "a version before v10" for every record without goals
    // and behinds. Once qV reached 3 that was simply false — those records HAD
    // been re-asked, and PlayHQ had not supplied the breakdown. A message that
    // names a cause it cannot know sends the reader to re-run something that will
    // change nothing.
    const old = cov.qOldVer, now = cov.gbMissingCurrent;
    console.log(`  ⚠️ ${cov.q - cov.gb} record(s) have quarters but no goals/behinds:`);
    if (now) {
      console.log(`       ${now} were asked by THIS extraction and PlayHQ did not`);
      console.log('       supply them. Re-running changes nothing.');
    }
    if (old) {
      console.log(`       ${old} were stored by an older extraction and will be`);
      console.log('       re-asked on the next run.');
    }
  }

  console.log('\nTHIS RUN');
  console.log('─'.repeat(70));
  console.log(`  API calls                      ${calls}`);
  console.log(`  grades walked                  ${gi} of ${grades.length}`);
  console.log(`  game ids stamped               ${stamped}`);
  console.log(`  quarters found                 ${found}  (${flagged} do not sum to the score, flagged)`);
  console.log(`  ...of which PARTIAL            ${partialCount}  (1-3 of 4 periods recorded)`);
  console.log(`  returned nothing               ${empty}`);
  console.log(`  grade records no quarters      ${noGrade}`);
  console.log(`  refused (ambiguous or wrong)   ${refused}`);
  console.log(`  elapsed                        ${mins()} min`);
  console.log(`  concurrency ended at           ${conc} (learned ceiling ${ceiling}, started ${CONC})`);
  console.log(`  rate-limit blocks              ${summary().blocked}`);
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
