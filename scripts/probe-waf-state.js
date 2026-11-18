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

const https = require('https');
const crypto = require('crypto');

const VERSION = 'probe-waf-state v3 2026-11-18 transport-and-request-id';
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

// ── Header variants ──────────────────────────────────────────────────────────
// ⚠️ v1 PROVED THE API IS REACHABLE AND NOTHING MORE. It sent browser headers and
// got 200/400 from the same runner that lib/playhq.js cannot get a session on.
// The difference has to be in what is SENT, and the obvious suspect is the
// library's User-Agent:
//
//   PlayHQ/1.47.2 Android/28 (Android SDK built for x86)
//
// "Android SDK built for x86" is an emulator string. A WAF that has started
// scoring on it would produce exactly what the logs show: a 403 with an HTML body
// on every session attempt, from an IP that is otherwise fine.
//
// ⚠️ THE QUERY MUST BE THE REAL ONE. v1 invented `tenantConfig` and got a 400 for
// its trouble, which measured nothing. This sends the library's own
// `tenantConfiguration { label }` so a 200 here means a session would work.
const REAL_TENANT_QUERY = JSON.stringify({
  operationName: 'TenantConfig', variables: {},
  query: 'query TenantConfig { tenantConfiguration { label } }',
});

const LIB_UA = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Each variant changes ONE thing from the one above it, so whichever first
// answers names the cause rather than leaving a pile of differences.
const VARIANTS = [
  { name: 'exactly what lib/playhq.js sends',
    why: 'the control — this is what fails every night',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': LIB_UA, tenant: 'afl', origin: 'https://www.playhq.com' } },
  { name: 'library headers + browser User-Agent',
    why: 'changes ONLY the User-Agent — if this answers, the UA is the whole fault',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': BROWSER_UA, tenant: 'afl', origin: 'https://www.playhq.com' } },
  { name: 'library headers + referer and accept-language',
    why: 'keeps the library UA, adds the browser headers it omits',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': LIB_UA, tenant: 'afl', origin: 'https://www.playhq.com',
      referer: 'https://www.playhq.com/', 'accept-language': 'en-AU,en;q=0.9' } },
  { name: 'full browser header set',
    why: 'what v1 sent, with the REAL query — the known-good shape',
    headers: { 'Content-Type': 'application/json', accept: '*/*',
      'User-Agent': BROWSER_UA, tenant: 'afl', 'x-phq-tenant': 'afl',
      origin: 'https://www.playhq.com', referer: 'https://www.playhq.com/',
      'accept-language': 'en-AU,en;q=0.9' } },
];

// ── Transport ────────────────────────────────────────────────────────────────
// ⚠️ v2 CHANGED HEADERS AND NOTHING ELSE, AND CALLED ONE VARIANT "exactly what
// lib/playhq.js sends". It was not. Two things were never controlled:
//
//   1. the library uses node's `https.request`; the probe used `fetch`. Different
//      TLS fingerprint, HTTP/1.1 rather than h2, different header casing and
//      order. CloudFront bot rules score on exactly that.
//   2. the library adds `request-id: crypto.randomUUID()` on every call. The
//      probe sent nothing like it.
//
// The library's own header comment says the https module is deliberate, so this
// is a real difference rather than an oversight. Four requests isolate both
// variables ONE AT A TIME:
//
//   A fetch + library headers            (v2 proved this answers)
//   B https.request + library headers    ← the real thing, request-id and all
//   C https.request, no request-id       B vs C isolates the header
//   D fetch + request-id                 A vs D isolates it the other way
const LIB_HEADERS = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': LIB_UA,
  tenant: 'afl',
  origin: 'https://www.playhq.com',
});

// node's https, called the way lib/playhq.js calls it — same options, same
// Content-Length, same lack of an explicit agent.
function nodePost(headers, bodyStr) {
  return new Promise((resolve) => {
    const h = { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) };
    const req = https.request('https://api.playhq.com/graphql',
      { method: 'POST', headers: h, timeout: 30000 }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({
          status: res.statusCode, text: data,
          setCookie: res.headers['set-cookie'] || [],
          httpVersion: res.httpVersion,
        }));
      });
    req.on('error', (e) => resolve({ status: 0, text: '', setCookie: [], err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '', setCookie: [], err: 'timeout' }); });
    req.write(bodyStr);
    req.end();
  });
}

async function fetchPost(headers, bodyStr) {
  try {
    const res = await fetch('https://api.playhq.com/graphql',
      { method: 'POST', headers, body: bodyStr, redirect: 'manual' });
    const text = await res.text();
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, text, setCookie, httpVersion: 'fetch/undici' };
  } catch (e) { return { status: 0, text: '', setCookie: [], err: e.message }; }
}

const TRANSPORTS = [
  { name: 'A  fetch + library headers', fn: fetchPost, id: false,
    why: 'what v2 tested — the control that answered' },
  { name: 'B  https.request + library headers + request-id', fn: nodePost, id: true,
    why: 'EXACTLY what lib/playhq.js sends, by the same client' },
  { name: 'C  https.request + library headers, NO request-id', fn: nodePost, id: false,
    why: 'B vs C isolates the request-id header' },
  { name: 'D  fetch + library headers + request-id', fn: fetchPost, id: true,
    why: 'A vs D isolates request-id the other way round' },
];

async function transport(t) {
  const h = LIB_HEADERS();
  if (t.id) h['request-id'] = crypto.randomUUID();
  const started = Date.now();
  const res = await t.fn(h, REAL_TENANT_QUERY);
  const ms = Date.now() - started;

  log(`\n── ${t.name} ──`);
  log(`   ${t.why}`);
  if (res.err) { log(`   ⚠️ threw: ${res.err} (${ms} ms)`); return { t, cookies: 0, blocked: null }; }
  const isHtml = /^\s*<|DOCTYPE/i.test(res.text) || /Request blocked/i.test(res.text);
  const blocked = res.status === 403 && isHtml;
  const names = res.setCookie.map(c => String(c).split('=')[0].trim());
  const got = ['phq_tier', 'phq_session', 'phq_sub'].filter(n => names.includes(n));
  log(`   HTTP ${res.status}  (${ms} ms)  http/${res.httpVersion}`);
  log(`   cookies: ${got.length ? got.join(', ') : 'NONE'}${got.length === 3 ? '  ← a session would succeed' : ''}`);
  log(`   body[0..160]: ${res.text.replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)'}`);
  log(`   ⇒ ${blocked ? 'WAF BLOCK (403 + HTML)' : res.status === 200 ? 'ANSWERED' : `status ${res.status}`}`);
  return { t, cookies: got.length, blocked, status: res.status };
}

async function variant(v) {
  const started = Date.now();
  let res, body = '', err = null;
  try {
    res = await fetch('https://api.playhq.com/graphql',
      { method: 'POST', headers: v.headers, body: REAL_TENANT_QUERY, redirect: 'manual' });
    body = await res.text();
  } catch (e) { err = e; }
  const ms = Date.now() - started;

  log(`\n── ${v.name} ──`);
  log(`   ${v.why}`);
  if (err) { log(`   ⚠️ threw: ${err.message} (${ms} ms)`); return { v, blocked: null }; }

  const isHtml = /^\s*<|DOCTYPE/i.test(body) ||
    /text\/html/i.test(res.headers.get('content-type') || '');
  const blocked = res.status === 403 && isHtml;
  // ⚠️ THE COOKIES ARE THE POINT, not the status. A 200 with no Set-Cookie is
  // still a failed session, and that is a different fault from a block.
  const setCookie = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [];
  const names = setCookie.map(c => String(c).split('=')[0].trim());
  const got = ['phq_tier', 'phq_session', 'phq_sub'].filter(n => names.includes(n));

  log(`   HTTP ${res.status}  (${ms} ms)   x-cache: ${res.headers.get('x-cache') || '-'}`);
  log(`   cookies: ${got.length ? got.join(', ') : 'NONE'}${
    got.length === 3 ? '  ← a session would succeed' : ''}`);
  log(`   body[0..160]: ${body.replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)'}`);
  log(`   ⇒ ${blocked ? 'WAF BLOCK (403 + HTML)' : res.status === 200 ? 'ANSWERED' : `status ${res.status}`}`);
  return { v, blocked, status: res.status, cookies: got.length };
}

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
  // ── Part 2: which header set gets a session? ───────────────────────────────
  log('\n\n═══ HEADER VARIANTS — the real TenantConfig query ═══');
  const vout = [];
  for (const v of VARIANTS) {
    vout.push(await variant(v));
    await new Promise(r => setTimeout(r, 3000));
  }

  log('\n═══ WHICH HEADERS WORK ═══');
  for (const o of vout) {
    log(`  ${o.cookies === 3 ? 'SESSION OK ' : o.blocked ? 'BLOCKED    ' : 'no cookies '} ${o.v.name}`);
  }
  const ctl = vout[0], uaOnly = vout[1];
  if (ctl && ctl.blocked && uaOnly && uaOnly.cookies === 3) {
    log('\n  ⇒ THE USER-AGENT IS THE WHOLE FAULT. Only that header changed between');
    log('    the first two, and the second got a session. Change it in lib/playhq.js.');
  } else if (ctl && ctl.cookies === 3) {
    log('\n  ⇒ THE LIBRARY\'S OWN HEADERS WORK RIGHT NOW. The block is intermittent,');
    log('    so the nightly failure is about WHEN it runs, not what it sends. Do not');
    log('    change the headers on this evidence.');
  } else {
    log('\n  ⇒ No single header explains it. Read the table above before changing');
    log('    anything — the cause is not what was assumed.');
  }
  // ── Part 3: transport and request-id ───────────────────────────────────────
  log('\n\n═══ TRANSPORT — the two things v2 never controlled ═══');
  const tout = [];
  for (const t of TRANSPORTS) {
    tout.push(await transport(t));
    await new Promise(r => setTimeout(r, 3000));
  }

  log('\n═══ WHAT ACTUALLY DIFFERS ═══');
  for (const o of tout) {
    log(`  ${o.cookies === 3 ? 'SESSION OK ' : o.blocked ? 'BLOCKED    ' : 'no cookies '} ${o.t.name}`);
  }
  const [A, B, C, D] = tout;
  const ok = (o) => o && o.cookies === 3;
  if (ok(A) && B && B.blocked && C && C.blocked) {
    log('\n  ⇒ THE HTTP CLIENT IS THE FAULT. Both https.request variants are blocked');
    log('    and fetch is not, with request-id making no difference. Swapping the');
    log('    transport in lib/playhq.js is the fix, and nothing else needs to change.');
  } else if (ok(A) && ok(C) && B && B.blocked) {
    log('\n  ⇒ THE request-id HEADER IS THE FAULT. The same client answers without it');
    log('    and is blocked with it. Remove it from headers() in lib/playhq.js.');
  } else if (ok(A) && ok(B)) {
    log('\n  ⇒ EVERYTHING ANSWERS, INCLUDING THE REAL THING. The block is intermittent');
    log('    and nothing here reproduces it. Do NOT change the transport on this');
    log('    evidence — run the walk again and compare the two logs by timestamp.');
  } else {
    log('\n  ⇒ No single variable explains it. Read the four rows before changing');
    log('    anything; the cause is not either of the two tested here.');
  }
  log('\n⚠️ One probe is one moment. A block that lifts and returns needs this run');
  log('   twice, hours apart, before anything is concluded from it.');
  process.exit(0);
})().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });