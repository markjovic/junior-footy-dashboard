#!/usr/bin/env node
// scripts/probe-rate.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-rate v3 2026-11-22 concurrency-not-rate';

//
// What rate does publicProfileTeams actually tolerate?
//
// ⚠️ TWO MEASUREMENTS OF THE SAME OPERATION DISAGREE, AND BOTH CANNOT BE RIGHT.
//
//   this repo    publicProfileTeams blocked after 147 unpaced calls at 2.07
//                req/s. We have paced at 75/min ever since and never tripped.
//   StatTrack    the same backend, same operation: 200 probes, 0 blocked, and
//                other operations sustaining 940-1,340 calls/min at concurrency
//                25, recovering flat in ~80s with no escalation.
//
// Ours is the older figure and was taken serially; theirs is current and
// concurrent. If theirs holds on the `afl` tenant, a full cohort sweep goes from
// NINE HOURS to under twenty minutes.
//
// ⚠️ THIS RAMPS UNTIL IT BREAKS, ON PURPOSE. It is the only way to find a
// ceiling. It climbs in steps, stops at the FIRST block, and reports the rate
// that was running when it happened. Nothing is written and no other job may be
// running — it holds the data-write group for exactly that reason.
//
// ⚠️ A BLOCK COSTS ~80 SECONDS OF RECOVERY, NOT A DAY. Measured repeatedly:
// recovery is 76-77s and does not escalate. The risk here is a wasted hour, not
// another seven-week outage — that was node:https, which is fixed.
//
// ⚠️ IT READS REAL PLAYERS. Profile ids come from the cohort so the calls are
// representative; a repeated id might be cached and measure nothing.
//
// READ-ONLY: nothing is written.
//
// ⚠️ BLOCKS ARE COUNTED FROM THE LIBRARY, NOT FROM EXCEPTIONS. v1 reported
// "blocked 0" on every stage while the log showed eight `[waf] blocked` lines,
// because lib/playhq.js ABSORBS a block: it waits 80 seconds, retries, and the
// call succeeds. Nothing is thrown unless four attempts all fail. Reading
// phq.summary().blocked before and after each stage is the only honest count.
//
// ⚠️ SERIAL CALLS ARE CAPPED BY LATENCY, NOT BY A LIMIT. Measured 2026-11-22:
// 300 calls, ZERO blocks, and a target of 150/min achieved only 116. A round
// trip takes about 520 ms, so one-at-a-time cannot exceed roughly 115/min no
// matter what the target says. v2 read that as a throttle and reported a
// "ceiling" that was really the speed of light on a serial loop.
//
// ⚠️ CONCURRENCY IS THE LEVER, AND IT HAS NEVER BEEN TESTED HERE. StatTrack
// reach 940-1,340/min on the same backend at concurrency 25. This probe now
// ramps WORKERS, not the gap between calls, and watches for the first block.
//
// Env: PRATE_START (calls/min to begin, default 75), PRATE_STEP (increase per
//      stage, default 25), PRATE_MAX (stop climbing here, default 250),
//      PRATE_PER_STAGE (calls at each rate, default 150).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
// ⚠️ WORKERS, NOT A RATE. PRATE_WORKERS is a comma-separated ramp; 1 is the
// serial control we run today.
const WORKER_STAGES = (process.env.PRATE_WORKERS || '1,2,4,8,16,25')
  .split(',').map(x => Math.max(1, Number(x.trim()))).filter(x => isFinite(x));
const PER_STAGE = Math.max(10, Number(process.env.PRATE_PER_STAGE || 150));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const Q = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) { ... on DiscoverTeam { id name } }
}`;

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written. It ramps until something blocks.\n');
  log(`  worker stages: ${WORKER_STAGES.join(', ')}  (${PER_STAGE} calls each)`);
  log('  ⚠️ 1 worker is the control — it is what the walk does today.');

  if (!fs.existsSync(REG_PATH)) { console.error('FATAL: registrations.json.gz is missing.'); process.exit(1); }
  const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
  const ids = Object.keys(reg.players || {});
  if (ids.length < PER_STAGE) { console.error('FATAL: not enough players to sample.'); process.exit(1); }
  log(`  ${ids.length} profile id(s) available\n`);

  await phq.ensureSession();

  let cursor = 0;
  const results = [];
  let blockedAt = null;

  // One measured round trip, so the serial ceiling is a number rather than an
  // assumption.
  const t1 = Date.now();
  try { await phq.gqlPost(Q, { profileID: ids[0] }, 'PublicProfileTeams'); } catch (e) { /* timed anyway */ }
  const rtt = Date.now() - t1;
  log(`  one round trip: ${rtt} ms  ->  a SERIAL loop cannot exceed ~${Math.round(60000 / rtt)}/min
`);

  for (const workers of WORKER_STAGES) {
    if (blockedAt) break;
    const t0 = Date.now();
    const before = phq.summary ? (phq.summary().blocked || 0) : 0;
    let ok = 0, errored = 0;

    // ⚠️ N WORKERS PULLING FROM ONE QUEUE, not N batches. A batch waits for its
    // slowest call before starting the next, which measures the tail rather than
    // the throughput.
    const queue = [];
    for (let i = 0; i < PER_STAGE; i++) queue.push(ids[cursor++ % ids.length]);
    let next = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= queue.length) return;
        try {
          const json = await phq.gqlPost(Q, { profileID: queue[i] }, 'PublicProfileTeams');
          if (json && json.errors && json.errors.length) errored++; else ok++;
        } catch (e) { errored++; }
      }
    }));

    const blocked = (phq.summary ? (phq.summary().blocked || 0) : 0) - before;
    const mins = (Date.now() - t0) / 60000;
    const actual = mins > 0 ? (ok + errored) / mins : 0;
    results.push({ workers, actual, ok, blocked, errored });
    log(`  ${String(workers).padStart(3)} worker(s)  achieved ${actual.toFixed(0).padStart(5)}/min  ` +
      `ok ${String(ok).padStart(4)}  blocked ${String(blocked).padStart(3)}  errors ${errored}` +
      `${blocked ? '  ← BLOCKED, stopping' : ''}`);
    // ⚠️ STOP AT THE FIRST BLOCK. Climbing past it measures the recovery wait,
    // not the ceiling — which is what made every stage above 225 in v1 report
    // 61-68/min.
    if (blocked > 0) blockedAt = workers;
  }

  log('\n═══ WHAT THIS SAYS ═══');
  const clean = results.filter(r => !r.blocked);
  const best = clean.slice(-1)[0];
  const serial = results.find(r => r.workers === 1);
  if (serial) log(`  Serial (what the walk does now): ${serial.actual.toFixed(0)}/min`);
  if (!best) {
    log('  Nothing completed cleanly. No conclusion.');
  } else {
    log(`  Fastest clean stage: ${best.workers} worker(s) at ${best.actual.toFixed(0)}/min` +
      `${serial ? ` — ${(best.actual / serial.actual).toFixed(1)}x serial` : ''}.`);
    const hours = 40382 / (best.actual * 0.8) / 60;
    log(`  At 80% of that, a 40,382-player sweep takes about ${hours.toFixed(1)} hour(s).`);
  }
  if (blockedAt) {
    log(`\n  ⚠️ BLOCKED at ${blockedAt} worker(s). The stage below it is the most`);
    log('     this account tolerates, and even that was measured once.');
  } else {
    log('\n  ⚠️ NOTHING BLOCKED, which is not the same as safe. This ran for minutes;');
    log('     the walk runs for hours and the WAF window is shared across every run');
    log('     on the account.');
  }
  log('\n  ⚠️ RAISE THE WALK ONE STEP AND READ A FULL RUN before going further.');
  log('     Seven weeks of outage came from assuming, not from measuring.');
  phq.logSummary('probe-rate');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
