#!/usr/bin/env node
// scripts/probe-rate-sharded.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-rate-sharded v2 2026-11-24 gap-aware';

//
// WHAT LIMITS publicProfileTeams? Each worker gets its OWN guest session.
//
// ⚠️ v1 ANSWERED THE WRONG QUESTION AND SAID SO CONFIDENTLY. It ramped
// concurrency and, on any block, printed "that points to a PER-IP limit". Three
// runs on 2026-11-24 falsified that:
//
//   8 workers, gap    0ms  -> ~224/min per session, blocked after 179/session
//   2 workers, gap    0ms  -> ~134/min per session, blocked after 154/session
//   8 workers, gap 1200ms  ->  ~37/min per session, 2,800 ok, ZERO blocked
//
// Per-IP is impossible (1,434 ok in one run, 308 in the next, same runner).
// Aggregate rate is impossible (blocked at 268/min, clean at 298/min). A
// per-session CALL BUDGET is impossible (350/session clean, 179/session not).
// The one variable that separates them is the MINIMUM GAP BETWEEN CONSECUTIVE
// REQUESTS ON ONE SESSION. That is the quantity this probe now reports first.
//
// ⚠️ v1 ALSO CONTAMINATED ITS OWN HEADLINE FIGURE. It kept calling after the
// first block, and a blocked response returns almost instantly, so the 2,334/min
// it reported for the 8-worker stage included 566 fast failures. The real
// throughput was ~1,790/min. This version STOPS THE STAGE on the first block and
// computes the rate from OK CALLS over the OK PHASE only.
//
// ⚠️ v1 PRINTED NOTHING UNTIL A STAGE FINISHED. A paced stage is minutes of
// silence and reads exactly like a hung job. There is a heartbeat now.
//
// ⚠️ IT BOOTSTRAPS ITS OWN SESSIONS WITH RAW fetch. lib/playhq.js holds ONE
// module-level cookie and cannot run N independent sessions — that is the thing
// under test, so the lib cannot be the vehicle for it. Each worker does its own
// guest bootstrap (phq_tier; phq_session; phq_sub, in that fixed order — wrong
// order is a documented CloudFront 403) and replays its own cookie. fetch(), not
// node:https: the fingerprint that got this repo 403'd for seven weeks.
//
// READ-ONLY: nothing is written.
//
// Env: PRS_WORKERS (comma ramp, default 1,2,4,8), PRS_PER (calls per stage,
//      default 200), PRS_PACE_MS (per-worker gap AFTER each call, default 0),
//      PRS_HEARTBEAT_MS (progress line interval, default 10000).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const WORKERS = (process.env.PRS_WORKERS || '1,2,4,8').split(',').map(x => Math.max(1, Number(x.trim()))).filter(isFinite);
const PER = Math.max(10, Number(process.env.PRS_PER || 200));
const PACE = Math.max(0, Number(process.env.PRS_PACE_MS || 0));
const HEARTBEAT_MS = Math.max(1000, Number(process.env.PRS_HEARTBEAT_MS || 10000));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const Q = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) { ... on DiscoverTeam { id name } }
}`;

// ⚠️ ONE GUEST SESSION, OWNED BY THE CALLER. Mirrors the lib's bootstrap exactly:
// the same three cookies, picked by name, assembled tier; session; sub.
async function newSession() {
  const res = await fetch(phq.API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': phq.USER_AGENT,
      'tenant': phq.TENANT,
      'accept': '*/*',
      'origin': 'https://www.playhq.com',
    },
    body: JSON.stringify({ operationName: 'TenantConfig',
      query: 'query TenantConfig { tenantConfiguration { videoConsentEnabled } }', variables: {} }),
  });
  const setc = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
  const parts = setc.map(c => String(c).split(';')[0].trim());
  const pick = (n) => parts.find(p => p.startsWith(n + '=')) || null;
  const tier = pick('phq_tier'), sess = pick('phq_session'), sub = pick('phq_sub');
  if (tier && sess && sub) return `${tier}; ${sess}; ${sub}`;
  return null;
}

async function callWith(cookie, profileID) {
  const res = await fetch(phq.API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': phq.USER_AGENT,
      'tenant': phq.TENANT,
      'accept': '*/*',
      'origin': 'https://www.playhq.com',
      'Cookie': cookie,
    },
    body: JSON.stringify({ operationName: 'PublicProfileTeams', query: Q, variables: { profileID } }),
  });
  if (res.status === 403) return 'blocked';
  if (!res.ok) return 'error';
  const j = await res.json().catch(() => null);
  if (j && j.errors && j.errors.length) return 'error';
  return 'ok';
}

const fmt = (n, w) => String(n).padStart(w);
// Seconds, but never rounded to a bare "0s" — a block three hundred
// milliseconds in is a different finding from one thirty seconds in.
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0);

// One stage: `workers` sessions, each walking the shared queue, stopping the
// whole stage the moment any session is blocked.
async function runStage(workers, ids) {
  // ⚠️ EACH WORKER ITS OWN SESSION. That is the whole experiment.
  const cookies = [];
  for (let i = 0; i < workers; i++) {
    const c = await newSession();
    if (!c) { log(`  ${workers} workers: could not mint session ${i + 1} — skipping stage`); break; }
    cookies.push(c);
    await sleep(200);
  }
  if (cookies.length < workers) return { workers, skipped: true };

  const queue = ids.slice(0, PER);
  const per = cookies.map(() => ({ ok: 0, blocked: 0, err: 0 }));
  let next = 0, ok = 0, blocked = 0, errored = 0;
  let stop = false;
  let tBlock = null, okAtBlock = null;
  const t0 = Date.now();

  // ⚠️ A PACED STAGE IS MINUTES OF SILENCE WITHOUT THIS, and silence reads as a
  // hung job. It also shows the per-session count climbing, which is the figure
  // that distinguishes a call budget from a gap rule.
  const beat = setInterval(() => {
    const el = Date.now() - t0;
    const rate = el > 0 ? ok / (el / 60000) : 0;
    const counts = per.map(p => p.ok);
    log(`    ${fmt(secs(el), 4)}s  ok ${fmt(ok, 5)}  blocked ${fmt(blocked, 4)}  ` +
      `${fmt(rate.toFixed(0), 5)}/min aggregate  per-session ok ${Math.min(...counts)}-${Math.max(...counts)}`);
  }, HEARTBEAT_MS);

  await Promise.all(cookies.map(async (cookie, w) => {
    for (;;) {
      // ⚠️ STOP ON THE FIRST BLOCK. v1 ran the remaining calls into the block at
      // full pace, which burned minutes and inflated the reported rate with fast
      // failures. The block itself is the measurement; everything after it is noise.
      if (stop) return;
      const i = next++;
      if (i >= queue.length) return;
      const r = await callWith(cookie, queue[i]);
      if (r === 'ok') { ok++; per[w].ok++; }
      else if (r === 'blocked') {
        blocked++; per[w].blocked++;
        if (!stop) { stop = true; tBlock = Date.now(); okAtBlock = per[w].ok; }
        return;
      } else { errored++; per[w].err++; }
      if (PACE) await sleep(PACE);
    }
  }));
  clearInterval(beat);

  // ⚠️ RATE OVER THE OK PHASE, FROM OK CALLS. Anything else measures how fast
  // CloudFront can say no.
  const elapsed = (tBlock || Date.now()) - t0;
  const mins = elapsed / 60000;
  const rate = mins > 0 ? ok / mins : 0;
  const counts = per.map(p => p.ok);
  // The gap actually achieved per session, which is the variable under test —
  // PACE plus however long the round trip took.
  const gapMs = counts.length && Math.max(...counts) > 0
    ? elapsed / (ok / cookies.length) : null;

  return { workers, rate, ok, blocked, errored, elapsed, gapMs,
    perMin: Math.min(...counts), perMax: Math.max(...counts), okAtBlock };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: a fresh session per worker, ramping concurrency.\n');
  log(`  workers: ${WORKERS.join(', ')}  |  ${PER} calls per stage  |  per-worker gap ${PACE}ms  |  heartbeat ${HEARTBEAT_MS / 1000}s`);
  log('  ⚠️ THE GAP THAT MATTERS IS PACE + ROUND TRIP, reported per stage below.\n');

  if (!fs.existsSync(REG_PATH)) { console.error('FATAL: registrations.json.gz missing.'); process.exit(1); }
  const ids = Object.keys(JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8')).players || {});
  if (ids.length < PER) { console.error('FATAL: not enough ids.'); process.exit(1); }

  // Confirm a session can even be minted this way before trusting any stage.
  const probe = await newSession();
  log(`  control bootstrap: ${probe ? 'session acquired' : 'FAILED — cannot mint a session, results below are void'}\n`);
  if (!probe) process.exit(1);

  let blockedAt = null;
  const results = [];

  for (const workers of WORKERS) {
    if (blockedAt) break;
    const r = await runStage(workers, ids);
    results.push(r);
    if (r.skipped) continue;
    log(`  ${fmt(workers, 2)} worker(s), own session each  —  ${fmt(r.rate.toFixed(0), 5)}/min aggregate  ` +
      `${fmt((r.rate / workers).toFixed(0), 4)}/min per session  gap ~${r.gapMs ? r.gapMs.toFixed(0) : '?'}ms  ` +
      `ok ${fmt(r.ok, 5)} (${r.perMin}-${r.perMax} per session)  blocked ${fmt(r.blocked, 3)}  errors ${r.errored}` +
      `${r.blocked ? `  ← BLOCKED after ${r.okAtBlock} calls on that session, ${secs(r.elapsed)}s in` : ''}`);
    if (r.blocked > 0) blockedAt = workers;
  }

  log('\n═══ WHAT THIS SAYS ═══');
  const done = results.filter(r => !r.skipped);
  const clean = done.filter(r => !r.blocked);
  const best = clean.slice(-1)[0];
  const hit = done.find(r => r.blocked);

  if (hit) {
    log(`  Blocked at ${hit.workers} worker(s), each on its own session, after ${hit.okAtBlock}`);
    log(`  calls on the blocked session — a gap of about ${hit.gapMs ? hit.gapMs.toFixed(0) : '?'}ms between`);
    log(`  consecutive requests on one session, ${(hit.rate / hit.workers).toFixed(0)}/min per session.`);
    log('');
    log('  ⚠️ THIS DOES NOT NAME THE LIMIT ON ITS OWN. Compare it against the');
    log('     other stages and against the runs recorded at the top of this file:');
    log('       per-IP          — ruled out: same runner took 1,434 ok then 308 ok.');
    log('       aggregate rate  — ruled out: blocked at 268/min, clean at 298/min.');
    log('       per-session calls — ruled out: 350/session clean, 179/session blocked.');
    log('       per-session GAP — the one variable that has separated clean from');
    log('                         blocked in every run so far. Widen PRS_PACE_MS');
    log('                         and re-run before concluding anything else.');
  } else if (best) {
    log(`  No block up to ${best.workers} worker(s), each on its own session.`);
    log(`  ${best.rate.toFixed(0)}/min aggregate, ${(best.rate / best.workers).toFixed(0)}/min per session,`);
    log(`  ${best.perMax} calls on the busiest session, gap ~${best.gapMs ? best.gapMs.toFixed(0) : '?'}ms.`);
    log('');
    log('  ⚠️ A CLEAN STAGE BOUNDS THE SAFE GAP FROM ABOVE, NOTHING MORE. It does');
    log('     not establish the ceiling — narrow PRS_PACE_MS or add workers until');
    log('     something blocks, and the pair of readings brackets it.');
  } else {
    log('  No stage completed. Inconclusive.');
  }
  log('\n  ⚠️ ONE RUN IS ONE MOMENT, and the WAF window is shared across the account.');
  phq.logSummary('probe-rate-sharded');
  log('  (the lib counters read zero by design — this probe calls fetch directly,');
  log('   because one shared session is the thing it exists to avoid.)');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
