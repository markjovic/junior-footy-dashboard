#!/usr/bin/env node
// scripts/probe-waf-state.js
//
// Is PlayHQ blocking this account, this runner, or one operation? FIVE REQUESTS,
// no retries, no waiting, nothing written.
//
// ⚠️ IT DELIBERATELY DOES NOT USE lib/playhq.js. That library retries, waits 80
// seconds and absorbs a block — which is exactly the behaviour that makes a
// standing block invisible and, by retrying into it, keeps it alive. This needs
// the RAW response: status, the CloudFront headers, and the first line of the
// body. It acquires no session and is not a template for anything that fetches.
//
// ⚠️ RUN IT ONLY AFTER THE DAILY SCHEDULES ARE OFF, and leave a gap. A walk run
// fires 72 requests into an active block; measuring while that continues tells
// you nothing except that it is still blocked.
//
// What the five answers mean together:
//   main API host refuses everything        → the account or the runner range
//   main API refuses, spectator answers     → host-level, not account-level
//   TenantConfig refuses, discoverX answers → per-operation, which would be new
//   everything answers                      → the block has lifted; re-enable
//
// Env: PW_NOTE (free text echoed into the log, e.g. "24h after disabling").

'use strict';

const VERSION = 'probe-waf-state v1 2026-11-18';
const NOTE = process.env.PW_NOTE || '';

const log = (...a) => console.log(...a);

// Headers a browser sends. No cookie: the point is to see what an unauthenticated
// request gets, which is what session acquisition itself is.
const BASE = {
  'content-type': 'application/json',
  'accept': '*/*',
  'accept-language': 'en-AU,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'origin': 'https://www.playhq.com',
  'referer': 'https://www.playhq.com/',
  'tenant': 'afl',
  'x-phq-tenant': 'afl',
};

const TARGETS = [
  {
    name: 'playhq.com (plain page)',
    url: 'https://www.playhq.com/',
    method: 'GET',
    why: 'the site itself — if this is blocked the block is not about the API',
  },
  {
    name: 'api.playhq.com TenantConfig',
    url: 'https://api.playhq.com/graphql',
    method: 'POST',
    body: { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfig { id } }' },
    why: 'the first call session acquisition makes — where both jobs die',
  },
  {
    name: 'api.playhq.com discoverCompetitions',
    url: 'https://api.playhq.com/graphql',
    method: 'POST',
    body: { operationName: 'probe', variables: { id: '383836bb' },
      query: 'query probe($id: String!) { discoverCompetitions(organisationID: $id) { id } }' },
    why: 'a different operation on the same host — is the block per-operation?',
  },
  {
    name: 'spectator.playhq.com',
    url: 'https://spectator.playhq.com/graphql',
    method: 'POST',
    body: { operationName: 'probe', variables: {}, query: 'query probe { __typename }' },
    why: 'a different host that needs no cookie on the afl tenant',
  },
  {
    name: 'api.playhq.com (GET, no GraphQL)',
    url: 'https://api.playhq.com/',
    method: 'GET',
    why: 'separates a WAF rule on the host from one on the GraphQL endpoint',
  },
];

const CF_HEADERS = ['x-amz-cf-id', 'x-cache', 'via', 'server', 'x-amzn-waf-action',
  'retry-after', 'content-type'];

async function one(t) {
  const started = Date.now();
  let res, bodyText = '', err = null;
  try {
    res = await fetch(t.url, {
      method: t.method,
      headers: t.method === 'POST' ? BASE : { ...BASE, 'content-type': undefined },
      body: t.body ? JSON.stringify(t.body) : undefined,
      redirect: 'manual',
    });
    bodyText = await res.text();
  } catch (e) { err = e; }
  const ms = Date.now() - started;

  log(`\n── ${t.name} ──`);
  log(`   ${t.why}`);
  if (err) { log(`   ⚠️ request threw: ${err.message}  (${ms} ms)`); return { t, err }; }

  log(`   HTTP ${res.status} ${res.statusText || ''}  (${ms} ms)`);
  for (const h of CF_HEADERS) {
    const v = res.headers.get(h);
    if (v) log(`   ${h}: ${v}`);
  }
  const first = bodyText.replace(/\s+/g, ' ').trim().slice(0, 220);
  log(`   body[0..220]: ${first || '(empty)'}`);

  // ⚠️ A 403 WITH AN HTML BODY IS THE WAF. A 403 with JSON is PlayHQ refusing
  // the request itself, which is a different problem with a different fix.
  const isHtml = /^\s*<|text\/html/i.test(bodyText) || /text\/html/i.test(res.headers.get('content-type') || '');
  let verdict;
  if (res.status === 403 && isHtml) verdict = 'WAF BLOCK (403 + HTML)';
  else if (res.status === 403) verdict = '403 but NOT html — PlayHQ refusing, not the WAF';
  else if (res.status === 429) verdict = 'rate limited (429)';
  else if (res.status >= 500) verdict = 'server error';
  else if (res.status >= 200 && res.status < 400) verdict = 'ANSWERED';
  else verdict = `unexpected ${res.status}`;
  log(`   ⇒ ${verdict}`);
  return { t, status: res.status, verdict, isHtml };
}

(async () => {
  log(`=== ${VERSION} ===`);
  log('FIVE requests, no retries, no waiting, nothing written.');
  if (NOTE) log(`note: ${NOTE}`);
  log('⚠️ If the daily schedules are still enabled, this measures a block they are');
  log('   actively feeding. Turn them off first and leave a gap.\n');

  const out = [];
  for (const t of TARGETS) {
    out.push(await one(t));
    // 3 seconds apart: enough that five requests cannot themselves look like a
    // burst, short enough that the whole probe is under a minute.
    await new Promise(r => setTimeout(r, 3000));
  }

  log('\n═══ WHAT THIS SAYS ═══');
  const answered = out.filter(o => o.verdict === 'ANSWERED').map(o => o.t.name);
  const waf = out.filter(o => o.verdict && o.verdict.startsWith('WAF')).map(o => o.t.name);
  log(`answered : ${answered.length ? answered.join(', ') : 'nothing'}`);
  log(`WAF block: ${waf.length ? waf.join(', ') : 'none'}`);

  if (!answered.length) {
    log('\nEverything is blocked, including a plain page fetch. That points at the');
    log('RUNNER or the account rather than anything about our queries. Re-run from a');
    log('different network before changing any code — if it answers elsewhere, no');
    log('amount of pacing in this repo will help.');
  } else if (waf.length && answered.length) {
    log('\nSome hosts answer and some do not, so this is NOT a blanket ban. The split');
    log('above says which, and that is the thing to design around.');
  } else {
    log('\nNothing is blocked right now. The block has lifted — re-enable the daily');
    log('schedules one at a time and read the next run before enabling the second.');
  }
  log('\n⚠️ One probe is one moment. A block that lifts and returns needs this run');
  log('   twice, hours apart, before anything is concluded from it.');
  process.exit(0);
})().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
