#!/usr/bin/env node
// scripts/probe-rate.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-rate v1 2026-11-22';

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
// Env: PRATE_START (calls/min to begin, default 75), PRATE_STEP (increase per
//      stage, default 75), PRATE_MAX (stop climbing here, default 900),
//      PRATE_PER_STAGE (calls at each rate, default 150).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const START = Math.max(1, Number(process.env.PRATE_START || 75));
const STEP = Math.max(1, Number(process.env.PRATE_STEP || 75));
const MAX = Math.max(START, Number(process.env.PRATE_MAX || 900));
const PER_STAGE = Math.max(10, Number(process.env.PRATE_PER_STAGE || 150));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const Q = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) { ... on DiscoverTeam { id name } }
}`;

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written. It ramps until something blocks.\n');
  log(`  start ${START}/min, +${STEP} per stage, stop at ${MAX}/min, ${PER_STAGE} calls per stage`);

  if (!fs.existsSync(REG_PATH)) { console.error('FATAL: registrations.json.gz is missing.'); process.exit(1); }
  const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
  const ids = Object.keys(reg.players || {});
  if (ids.length < PER_STAGE) { console.error('FATAL: not enough players to sample.'); process.exit(1); }
  log(`  ${ids.length} profile id(s) available\n`);

  await phq.ensureSession();

  let cursor = 0;
  const results = [];
  let blockedAt = null;

  for (let rate = START; rate <= MAX && !blockedAt; rate += STEP) {
    const gap = 60000 / rate;
    const t0 = Date.now();
    let ok = 0, blocked = 0, errored = 0;

    for (let i = 0; i < PER_STAGE; i++) {
      const id = ids[cursor++ % ids.length];
      const sent = Date.now();
      try {
        const json = await phq.gqlPost(Q, { profileID: id }, 'PublicProfileTeams');
        if (json && json.errors && json.errors.length) errored++; else ok++;
      } catch (e) {
        // ⚠️ THE LIBRARY ABSORBS A BLOCK — it waits 80s and retries up to four
        // times before throwing, so a throw here means it never recovered. The
        // counters are the reliable signal, not the exception text.
        const msg = String(e.message || '');
        if (/cloudfront|block|403/i.test(msg)) blocked++; else errored++;
      }
      const wait = gap - (Date.now() - sent);
      if (wait > 0) await sleep(wait);
      if (blocked) break;
    }

    const mins = (Date.now() - t0) / 60000;
    const actual = mins > 0 ? (ok + blocked + errored) / mins : 0;
    results.push({ rate, actual, ok, blocked, errored });
    log(`  target ${String(rate).padStart(4)}/min  achieved ${actual.toFixed(0).padStart(4)}/min  ` +
      `ok ${String(ok).padStart(4)}  blocked ${blocked}  errors ${errored}`);
    if (blocked) blockedAt = rate;
  }

  log('\n═══ WHAT THIS SAYS ═══');
  const best = results.filter(r => !r.blocked).slice(-1)[0];
  if (!blockedAt) {
    log(`  Nothing blocked, up to ${MAX}/min.`);
    log(`  The highest rate actually achieved was ${best ? best.actual.toFixed(0) : '?'}/min.`);
    log('  ⚠️ NOT BLOCKING IS NOT THE SAME AS SAFE. This ran for minutes; the walk');
    log('     runs for hours, and the WAF window is shared across every run on the');
    log('     account. Raise the walk in steps and read each run, rather than');
    log('     jumping to the number above.');
  } else {
    log(`  Blocked at a target of ${blockedAt}/min.`);
    log(`  The highest rate that did NOT block was ${best ? best.rate : 'none'}/min` +
      `${best ? ` (achieved ${best.actual.toFixed(0)}/min)` : ''}.`);
    log('  ⚠️ ONE RUN IS ONE MOMENT. The window is shared with every other job on');
    log('     the account, so a figure taken while something else was running is');
    log('     lower than the truth. Repeat before changing the walk.');
  }
  const cur = results.find(r => r.rate === 75);
  if (cur && !cur.blocked) {
    log('\n  Our current pace of 75/min did not block, which is the control working.');
  }
  log('\n  ⚠️ CHANGE NOTHING ON THE STRENGTH OF THIS ALONE. If it supports a higher');
  log('     rate, raise the walk one step and read the next full run before going');
  log('     further. Seven weeks of outage came from assuming, not from measuring.');
  phq.logSummary('probe-rate');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
