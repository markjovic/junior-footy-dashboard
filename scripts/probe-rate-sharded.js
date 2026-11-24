#!/usr/bin/env node
// scripts/probe-rate-sharded.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-rate-sharded v1 2026-11-24';

//
// Does a FRESH SESSION PER WORKER lift the concurrency ceiling?
//
// ⚠️ THIS IS THE EXPERIMENT THAT SEPARATES "OUR CLIENT" FROM "PLAYHQ'S LIMIT".
// probe-rate found TWO shared-cookie workers block instantly. StatTrack runs
// publicProfileTeams at 200 probes, 0 blocks, anonymously, SAME TIER — and says
// the limit is "per-shard/per-IP, not a shared-IP aggregate", with each matrix
// job holding its OWN session. If the block is per-session rather than per-IP,
// giving every worker its own cookie removes it. If it is per-IP, it will not,
// because every worker here shares one runner IP.
//
// ⚠️ IT BOOTSTRAPS ITS OWN SESSIONS WITH RAW fetch. lib/playhq.js holds ONE
// module-level cookie and cannot run N independent sessions — that is exactly
// the thing under test, so the lib cannot be the vehicle for it. Each worker
// here does its own guest bootstrap (phq_tier; phq_session; phq_sub, in that
// fixed order — wrong order is a documented CloudFront 403) and replays its own
// cookie. fetch(), not node:https: the fingerprint that got this repo 403'd for
// seven weeks.
//
// ⚠️ STOP AT THE FIRST BLOCK. Climbing past it measures the ~90s recovery wait,
// not the ceiling.
//
// READ-ONLY: nothing is written.
//
// Env: PRS_WORKERS (comma ramp, default 1,2,4,8), PRS_PER (calls per stage,
//      default 200 — StatTrack's clean figure), PRS_PACE_MS (per-worker min gap,
//      default 0 — the point is to push concurrency, not pace).

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

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: a fresh session per worker, ramping concurrency.\n');
  log(`  workers: ${WORKERS.join(', ')}  |  ${PER} calls per stage  |  per-worker gap ${PACE}ms`);

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
    // ⚠️ EACH WORKER ITS OWN SESSION. That is the whole experiment.
    const cookies = [];
    for (let i = 0; i < workers; i++) {
      const c = await newSession();
      if (!c) { log(`  ${workers} workers: could not mint session ${i + 1} — skipping stage`); break; }
      cookies.push(c);
      await sleep(200);
    }
    if (cookies.length < workers) { results.push({ workers, skipped: true }); continue; }

    const queue = ids.slice(0, PER);
    let next = 0, ok = 0, blocked = 0, errored = 0;
    const t0 = Date.now();
    await Promise.all(cookies.map(async (cookie) => {
      for (;;) {
        const i = next++;
        if (i >= queue.length) return;
        const r = await callWith(cookie, queue[i]);
        if (r === 'ok') ok++; else if (r === 'blocked') blocked++; else errored++;
        if (PACE) await sleep(PACE);
      }
    }));
    const mins = (Date.now() - t0) / 60000;
    const rate = mins > 0 ? (ok + errored + blocked) / mins : 0;
    results.push({ workers, rate, ok, blocked, errored });
    log(`  ${String(workers).padStart(2)} worker(s), own session each  —  ${rate.toFixed(0).padStart(5)}/min  ` +
      `ok ${String(ok).padStart(4)}  blocked ${String(blocked).padStart(3)}  errors ${errored}` +
      `${blocked ? '  ← BLOCKED, stopping' : ''}`);
    if (blocked > 0) blockedAt = workers;
  }

  log('\n═══ WHAT THIS SAYS ═══');
  const clean = results.filter(r => !r.blocked && !r.skipped);
  const best = clean.slice(-1)[0];
  if (blockedAt) {
    log(`  Blocked at ${blockedAt} workers EVEN WITH a session each.`);
    log('  ⚠️ That points to a PER-IP limit, not a per-session one — every worker');
    log('     here shares the one runner IP, so a session each cannot help. This is');
    log('     a different limit from the one StatTrack sharded across matrix jobs on');
    log('     separate IPs, and the walk cannot beat it from a single runner.');
  } else if (best) {
    log(`  No block up to ${best.workers} workers with a session each: ${best.rate.toFixed(0)}/min.`);
    log('  ⚠️ IF THIS CLEARS WHERE probe-rate BLOCKED AT 2, the ceiling was the');
    log('     SHARED COOKIE, not the rate — and the walk can run concurrent with one');
    log('     session per worker. Confirm with a second run before rebuilding the walk.');
  } else {
    log('  No clean stage completed. Inconclusive.');
  }
  log('\n  ⚠️ ONE RUN IS ONE MOMENT, and the WAF window is shared across the account.');
  phq.logSummary('probe-rate-sharded');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
