#!/usr/bin/env node
// scripts/probe-waf-window.js
//
// How long does a CloudFront block ACTUALLY last?
//
// lib/playhq.js sleeps a flat 80 seconds on a WAF block, with a comment saying
// recovery is "roughly 80 seconds". That figure is inherited — nothing in this
// project has measured it.
//
// ⚠️ IT IS THE MOST EXPENSIVE UNVERIFIED NUMBER HERE. The enrich walk of
// 2026-09-05 took 242 minutes and recorded 122 blocks. At 80 seconds each that is
// 163 minutes — SIXTY-SEVEN PERCENT of the run spent asleep. If the real window is
// 20 seconds, three quarters of that is waste, on every walk and every weekly run.
// If it is longer than 80, the current code retries into the block and makes it
// worse.
//
// METHOD. Provoke a block by issuing a burst, then poll with a SHORT interval and
// record how long until the first success. Repeated a few times, because one
// sample is not a window.
//
// ⚠️ THIS DELIBERATELY TRIPS THE RATE LIMIT. It is the only way to observe the
// recovery. Do not run it alongside an enrich walk or a scheduled fetch — they
// share the limit and would each pay for the other's block. The
// playhq-data-write concurrency group does not cover read-only workflows, so this
// is on the operator.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-waf-window.js
//   PROBE_ROUNDS=5 PROBE_BURST=25 node scripts/probe-waf-window.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-waf-window v2 2026-09-05 discovergame-sustained';

const https = require('https');
const crypto = require('crypto');
const store = require('./lib/store');
const engine = require('./lib/results-engine');

const ROUNDS = Math.max(1, Math.min(8, Number(process.env.PROBE_ROUNDS || 3)));
// Concurrency, matching what the enrich walk actually uses rather than a burst
// size — the point is to reproduce its conditions.
const BURST  = Math.max(1, Math.min(20, Number(process.env.PROBE_BURST || 6)));
const POLL_S = Math.max(2, Number(process.env.PROBE_POLL_S || 5));
const GIVEUP_S = Math.max(60, Number(process.env.PROBE_GIVEUP_S || 240));
// How long, and how many calls, to keep pushing before accepting that this rate
// does not trip the limit.
const PROVOKE_S = Math.max(30, Number(process.env.PROBE_PROVOKE_S || 300));
const MAX_CALLS = Math.max(100, Number(process.env.PROBE_MAX_CALLS || 3000));

// ⚠️ A RAW POST, NOT lib/playhq.js. That module sleeps 80 seconds on a block,
// which is exactly the behaviour being measured — using it would return the
// assumption instead of the answer.
function rawPost(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request('https://api.playhq.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
        tenant: 'afl',
        origin: 'https://www.playhq.com',
        'request-id': crypto.randomUUID(),
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '' }); });
    req.write(data);
    req.end();
  });
}

const isBlocked = (r) => r.status === 403 &&
  (/DOCTYPE/i.test(r.text) || /Request blocked/i.test(r.text));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log('READ-ONLY — no writes, no commits.');
  console.log('⚠️ This deliberately trips the rate limit. Do not run it alongside');
  console.log('   an enrich walk or a scheduled fetch.\n');

  // ⚠️ discoverGame, NOT discoverGrade.
  //
  // v1 burst 60 discoverGrade calls and never tripped the limit, while the enrich
  // walk was blocked 122 times — EVERY ONE of them reported "blocked on
  // DiscoverGame". Never on discoverGrade, never on discoverFixtureByRound. So
  // v1 measured an operation that is not the one being limited, and concluded
  // nothing.
  //
  // ⚠️ AND SUSTAINED, NOT A BURST. The enrich run reaches its first block after
  // roughly a thousand calls, not sixty, so the limit may be cumulative over a
  // window rather than about instantaneous concurrency. A short burst cannot
  // reach it.
  const data = store.load(null, { players: false });
  const ids = (data.matches || [])
    .filter(m => m.gameId).slice(0, 4000).map(m => m.gameId);
  if (ids.length < 100) {
    console.error(`Only ${ids.length} stored record(s) carry a gameId — not enough`);
    console.error('to sustain load. Run enrich-games first.');
    process.exit(1);
  }
  console.log(`${ids.length} game id(s) available to cycle through.\n`);

  const Q_GAME = `query DiscoverGame($gameID: ID!) {
    discoverGame(gameID: $gameID) {
      id
      statistics { home { periods { period { value } statistics { count type { value } } } } }
    }
  }`;
  let idx = 0;
  const nextBody = () => ({
    operationName: 'DiscoverGame',
    query: Q_GAME,
    variables: { gameID: ids[idx++ % ids.length] },
  });

  const windows = [];
  for (let r = 1; r <= ROUNDS; r++) {
    console.log(`ROUND ${r} of ${ROUNDS}`);

    // Sustain load at the concurrency the enrich run uses, until it blocks.
    let blockedAt = null, sent = 0;
    const started = Date.now();
    while (!blockedAt && sent < MAX_CALLS &&
           (Date.now() - started) / 1000 < PROVOKE_S) {
      const batch = await Promise.all(
        Array.from({ length: BURST }, () => rawPost(nextBody())));
      sent += BURST;
      if (batch.some(isBlocked)) blockedAt = Date.now();
      else if (sent % 200 < BURST) {
        process.stdout.write(`    ${sent} calls, no block yet ` +
          `(${((Date.now() - started) / 60000).toFixed(1)} min)\r`);
      }
    }
    if (!blockedAt) {
      console.log(`    ${sent} call(s) in ${((Date.now() - started) / 60000).toFixed(1)} min ` +
        `did not trip it.                `);
      console.log('    So the block is not reached by volume alone at this rate —');
      console.log('    which itself is worth knowing. Raise PROBE_BURST or MAX_CALLS.\n');
      continue;
    }
    console.log(`    blocked after ${sent} call(s) ` +
      `(${((Date.now() - started) / 60000).toFixed(1)} min) — polling every ${POLL_S}s`);

    // Poll gently until it clears.
    let cleared = null;
    while (!cleared && (Date.now() - blockedAt) / 1000 < GIVEUP_S) {
      await sleep(POLL_S * 1000);
      const res = await rawPost(nextBody());
      const secs = ((Date.now() - blockedAt) / 1000).toFixed(0);
      if (isBlocked(res)) {
        process.stdout.write(`    ${secs}s still blocked\r`);
      } else if (res.status === 200) {
        cleared = (Date.now() - blockedAt) / 1000;
        console.log(`    ${secs}s CLEARED                        `);
      } else {
        process.stdout.write(`    ${secs}s HTTP ${res.status}\r`);
      }
    }
    if (cleared) windows.push(cleared);
    else console.log(`    gave up after ${GIVEUP_S}s — the window is longer than that`);
    console.log('');
    // Settle before provoking again, or the next round measures the tail of this.
    await sleep(30000);
  }

  console.log('RESULT');
  console.log('─'.repeat(60));
  if (!windows.length) {
    console.log('  No window measured. Either the burst never tripped the limit or');
    console.log('  it never cleared inside the give-up time. Nothing can be concluded');
    console.log('  and lib/playhq.js should keep its 80s.');
  } else {
    const avg = windows.reduce((a, b) => a + b, 0) / windows.length;
    const max = Math.max(...windows), min = Math.min(...windows);
    for (let i = 0; i < windows.length; i++) {
      console.log(`  round ${i + 1}: ${windows[i].toFixed(0)}s`);
    }
    console.log('─'.repeat(60));
    console.log(`  min ${min.toFixed(0)}s   avg ${avg.toFixed(0)}s   max ${max.toFixed(0)}s`);
    console.log(`  lib/playhq.js currently sleeps 80s`);
    console.log('');
    // The recommendation follows the measurement, and is bounded by the WORST
    // observed rather than the average — sleeping too little means retrying into
    // the block, which extends it.
    const rec = Math.ceil((max + 5) / 5) * 5;
    if (rec < 75) {
      const saved = (80 - rec) * 122 / 60;
      console.log(`  ⚠️ 80s is ${(80 - max).toFixed(0)}s longer than the worst case observed.`);
      console.log(`     Setting it to ${rec}s would have saved about ${saved.toFixed(0)} min`);
      console.log('     on the 2026-09-05 walk, which recorded 122 blocks.');
    } else if (rec > 85) {
      console.log(`  ⚠️ 80s is TOO SHORT — the worst case was ${max.toFixed(0)}s, so the`);
      console.log('     current code retries into the block and extends it.');
    } else {
      console.log('  80s is about right. Nothing to change, and the figure is now measured');
      console.log('  rather than inherited.');
    }
    console.log('');
    console.log('  ⚠️ Three rounds is a small sample and the limit may vary by time of');
    console.log('     day and by how much has been requested recently. Treat this as an');
    console.log('     order of magnitude, not a constant.');
  }
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
