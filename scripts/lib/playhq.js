// scripts/lib/playhq.js
//
// Shared HTTP and session layer for every script that calls api.playhq.com.
// Replaces the copy-pasted getSession()/gqlPost() pairs in fetch-results.js and
// fetch-stats.js, which between them had three defects:
//
//   1. Only phq_session was captured. playhq_api_reference.md is explicit that
//      all three cookies are required, in the order phq_tier; phq_session;
//      phq_sub, and that the wrong order causes CloudFront 403s.
//   2. The session was acquired once at startup and never refreshed, while the
//      cookie lives 30-40 minutes. Any run longer than that lost its session
//      partway and every later call failed.
//   3. A non-200 was a generic error, retried twice then skipped. That cannot
//      tell a CloudFront WAF block from an expired session from a genuine
//      application error, and the three need opposite responses.
//
// The exported gqlPost keeps the exact signature and return shape the existing
// callers expect — resolves with the parsed body, rejects on failure — so call
// sites do not change.
//
// ⚠️ THE HTTP STACK IS NOW global fetch, NOT node's https module. This is the
// whole reason the nightly jobs stopped working, so it is worth being precise.
//
// MEASURED 2026-11-18, four requests seconds apart, same runner, same headers,
// same query (scripts/probe-waf-state.js v3):
//
//   fetch           + library headers              -> 200, all three cookies
//   fetch           + library headers + request-id -> 200, all three cookies
//   https.request   + library headers + request-id -> 403 HTML in  61 ms
//   https.request   + library headers, no request-id -> 403 HTML in   8 ms
//
// Eight milliseconds is CloudFront refusing at the edge before PlayHQ sees it.
// Node's https negotiates HTTP/1.1 with a TLS fingerprint their WAF now scores as
// a bot; undici negotiates h2 and passes. NOTHING about the headers, the
// User-Agent, the query or the account was involved — all four were held constant
// across those requests.
//
// ⚠️ DO NOT SWITCH BACK TO node:https "for consistency". It is blocked, instantly
// and every time, and the failure looks exactly like a rate-limit block: a 403
// with an HTML body. That cost seven weeks of a dead walk before anyone compared
// the two clients.
//
// The previous note here said the https module was deliberate, so that a
// regression in the outbound stack could not be confused with the session
// handling. That reasoning was sound and is now spent.

'use strict';

const crypto = require('crypto');

const API_URL = 'https://api.playhq.com/graphql';

// ⚠️ A SECOND HOST, for scores that do not exist on the main API yet.
//
// discoverFixtureByRound returns an EMPTY result block for any game not marked
// FINAL — measured 2026-08-20 across all 86 live EFNL grades, 46 non-final games,
// zero scores. discoverGame says the same. The spectator endpoint is where a game
// being scored on the app actually lives, and it answered for the two grand finals
// in progress at the time.
//
// It needs NO SESSION COOKIE on the afl tenant — 40 calls, zero 403s — and it uses
// its own status vocabulary: LIVE rather than IN_PROGRESS.
//
// ⚠️ It only knows ELECTRONICALLY SCORED games. Anything else returns
// "game could not be found or was not electronically scored", which is an answer
// rather than a failure and must not be retried.
const SPECTATOR_URL = 'https://spectator.playhq.com/graphql';
const USER_AGENT = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';
const TENANT = 'afl';

// Observed TTL is 30-40 minutes. Refresh well inside it rather than waiting for
// a failure to tell us.
const SESSION_MAX_AGE_MS = 25 * 60 * 1000;

// Operations where a 403 means "this record is not accessible to you" rather
// than "your session expired". Refreshing and retrying on these wastes the
// session quota and still fails. From playhq_api_reference.md, 403 handling.
const AUTH_403_IS_DATA = new Set(['publicProfileStatistics', 'ProfileSeasonStatistics']);

const MAX_ATTEMPTS = 4;
const SESSION_ATTEMPTS = 10;

let sessionCookie = '';
let sessionAcquiredAt = 0;
let refreshing = null;

const counters = {
  ok: 0,
  graphqlError: 0,
  blocked: 0,
  auth403: 0,
  transient: 0,
  retries: 0,
  sessionRefreshes: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ `cookie` IS OPTIONAL AND ITS ABSENCE IS NOT THE SAME AS null. Omitted, the
// module-level session is used and every existing caller behaves exactly as
// before. Passed explicitly — including as null — that value wins, which is how
// a pool session sends its own cookie and how a bootstrap sends none.
function headers(extra, cookie) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    tenant: TENANT,
    origin: 'https://www.playhq.com',
    'request-id': crypto.randomUUID(),
  };
  const c = cookie === undefined ? sessionCookie : cookie;
  if (c) h.Cookie = c;
  return Object.assign(h, extra || {});
}

// Raw POST. Resolves with { status, text, setCookie } and NEVER rejects, so the
// classifier above it sees every outcome rather than only the happy path. The
// return shape is unchanged from the https version, so no caller changes.
async function rawPost(bodyStr, extraHeaders, timeoutMs, url, cookie) {
  const h = headers(extraHeaders, cookie);
  // ⚠️ NO Content-Length. fetch sets it from the body, and setting it by hand is
  // rejected as a forbidden header. The https version had to set it; this must not.

  // ⚠️ AbortSignal.timeout, NOT a `timeout` option. fetch has no such option and
  // would have silently ignored one, leaving a hung request to sit for the whole
  // run — which is the sort of thing that looks like a block and is not.
  let signal;
  try { signal = AbortSignal.timeout(timeoutMs || 60000); } catch (e) { signal = undefined; }

  try {
    const res = await fetch(url || API_URL, {
      method: 'POST',
      headers: h,
      body: bodyStr,
      // node's https does not follow redirects; keep that behaviour so a 30x
      // stays visible to the classifier instead of being chased silently.
      redirect: 'manual',
      signal,
    });
    const text = await res.text();
    // ⚠️ getSetCookie() RETURNS THE ARRAY. res.headers.get('set-cookie') joins
    // them into one string, and joining then regexing is exactly what once lost
    // phq_tier and phq_sub. Take the array.
    const setCookie = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    return { status: res.status, text, setCookie };
  } catch (err) {
    const msg = err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message) || String(err);
    return { status: 0, text: '', setCookie: [], networkError: msg };
  }
}

// A CloudFront WAF block is an HTML body with a 403 and is NOT an application
// 403. Test the body before deciding what a 403 means.
function isWafBlock(status, text) {
  return status === 403 && (/DOCTYPE/i.test(text) || /Request blocked/i.test(text));
}

// The three cookies, assembled in the one order that works. ⚠️ ONE PLACE KNOWS
// THIS ORDER. acquireSession and the session pool both come through here, so a
// pool cannot drift into assembling them differently — wrong order is a
// documented CloudFront 403.
function pickCookie(setCookie) {
  const parts = (setCookie || []).map((c) => String(c).split(';')[0].trim());
  const pick = (n) => parts.find((p) => p.startsWith(n + '=')) || null;
  const tier = pick('phq_tier');
  const sess = pick('phq_session');
  const sub = pick('phq_sub');
  return { cookie: (tier && sess && sub) ? `${tier}; ${sess}; ${sub}` : null, tier, sess, sub };
}

// ── Session ──────────────────────────────────────────────────────────────────

// Two alternating query shapes, because PlayHQ intermittently returns no
// Set-Cookie for one of them.
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  {
    operationName: 'ProfileSearch',
    variables: { fullName: 'a' },
    query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
  },
];

async function acquireSession() {
  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt++) {
    // Ramp for ordinary failures. A WAF block is handled separately below with a
    // full 80s wait — this ramp is far too short for one.
    if (attempt > 1) await sleep(Math.min(attempt * 2000, 15000));

    for (const body of COOKIE_QUERIES) {
      const prev = sessionCookie;
      sessionCookie = ''; // never send a stale cookie while asking for a new one
      const res = await rawPost(JSON.stringify(body), null, 30000);
      sessionCookie = prev;

      const { cookie, tier, sess, sub } = pickCookie(res.setCookie);

      if (cookie) {
        sessionCookie = cookie;
        sessionAcquiredAt = Date.now();
        counters.sessionRefreshes++;
        console.log(`  [session] acquired on attempt ${attempt} (${body.operationName})`);
        return true;
      }

      // ⚠️ A WAF BLOCK HERE NEEDS THE FULL 80 SECONDS, NOT THE RAMP.
      //
      // This loop retried on a 2-15s ramp whatever the cause, so ten attempts
      // fitted inside roughly 90 seconds — barely one CloudFront window — and
      // every attempt extended the block it was waiting out. Observed
      // 2026-09-04: nine consecutive attempts, all 403, no cookie of any kind,
      // then the run gave up.
      //
      // Distinguishing the two matters because they want opposite responses: a
      // missing cookie on a 200 is worth an immediate retry with the other query
      // shape, a WAF block is worth waiting for.
      if (isWafBlock(res.status, res.text)) {
        counters.blocked++;
        console.warn(`  [session] attempt ${attempt} (${body.operationName}): ` +
          `CloudFront block — waiting 80s rather than retrying into it`);
        await sleep(80000);
        continue;
      }

      console.warn(
        `  [session] attempt ${attempt} (${body.operationName}): ` +
          `status=${res.status} tier=${!!tier} session=${!!sess} sub=${!!sub}` +
          (res.networkError ? ` err=${res.networkError}` : '')
      );
    }
  }
  return false;
}

// Collapses concurrent refreshes into one, so a pool of workers hitting an
// expired session together does not fire ten refreshes at once.
function refreshSession() {
  if (!refreshing) {
    refreshing = acquireSession().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function ensureSession() {
  if (!sessionCookie || Date.now() - sessionAcquiredAt > SESSION_MAX_AGE_MS) {
    const ok = await refreshSession();
    if (!ok && !sessionCookie) {
      console.warn('  [session] could not obtain a session — proceeding without');
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

// Same signature and resolved shape as the gqlPost it replaces: resolves with
// the parsed response body, rejects on failure. Callers are unchanged.
async function gqlPost(query, variables, operationName) {
  await ensureSession();

  const bodyStr = JSON.stringify(operationName ? { operationName, query, variables } : { query, variables });
  const authIsData = operationName && AUTH_403_IS_DATA.has(operationName);
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) counters.retries++;

    const res = await rawPost(bodyStr);

    // Network error or timeout — transient, worth another go.
    if (res.status === 0) {
      counters.transient++;
      lastReason = `network: ${res.networkError}`;
      await sleep(attempt * 2000);
      continue;
    }

    // CloudFront WAF. Recovery is flat, roughly 80 seconds, so a short backoff
    // is wasted — wait properly rather than burning attempts.
    if (isWafBlock(res.status, res.text)) {
      counters.blocked++;
      lastReason = 'cloudfront block';
      console.warn(`  [waf] blocked on ${operationName || 'query'} — waiting 80s`);
      await sleep(80000);
      continue;
    }

    if (res.status === 403) {
      counters.auth403++;
      if (authIsData) {
        // Private or inaccessible record. Refreshing will not help.
        throw new Error(`403 not accessible: ${operationName}`);
      }
      lastReason = 'session 403';
      await refreshSession();
      continue;
    }

    // ⚠️ A 400 IS A VALIDATION ERROR AND WILL NEVER SUCCEED ON A RETRY.
    //
    // This retried it four times like any other non-200. Probing eleven candidate
    // field names on 2026-09-04 therefore cost 36 requests instead of 11, and that
    // burst is the most likely reason the WAF then blocked every session attempt
    // for the next run. Retrying a query the server has already told us is
    // malformed is pure cost.
    //
    // The body is returned rather than thrown, because it carries the GraphQL
    // error — including "Did you mean...?", which is the whole point of probing a
    // field this way.
    if (res.status === 400) {
      counters.graphqlError++;
      try { return JSON.parse(res.text); }
      catch (e) { throw new Error(`${operationName || 'query'} rejected (400): ${res.text.slice(0, 200)}`); }
    }

    if (res.status !== 200) {
      lastReason = `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      counters.transient++;
      await sleep(attempt * 1000);
      continue;
    }

    let json;
    try {
      json = JSON.parse(res.text);
    } catch (e) {
      counters.transient++;
      lastReason = `JSON parse: ${e.message}`;
      await sleep(attempt * 1000);
      continue;
    }

    // GraphQL errors are returned, not thrown — callers already inspect
    // res.errors themselves and a validation error will not fix itself on a
    // retry.
    if (json.errors && json.errors.length) counters.graphqlError++;
    else counters.ok++;

    return json;
  }

  throw new Error(`${operationName || 'query'} failed after ${MAX_ATTEMPTS} attempts — ${lastReason}`);
}

// Spectator POST. Same retry, WAF and counter handling as gqlPost — a second
// transport with its own error handling is how two code paths start disagreeing
// about what a 403 means.
//
// Differences from the main endpoint, all deliberate:
//   no session is required, so it does not call ensureSession and a 403 is NOT
//     treated as an expired session to refresh
//   `x-phq-tenant` is sent as well as `tenant`
//   "not electronically scored" is a real answer and is returned, not retried
async function specPost(query, variables, operationName) {
  const bodyStr = JSON.stringify(operationName
    ? { operationName, query, variables } : { query, variables });
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) counters.retries++;
    const res = await rawPost(bodyStr, { 'x-phq-tenant': TENANT }, 30000, SPECTATOR_URL);

    if (res.status === 0) {
      counters.transient++;
      lastReason = `network: ${res.networkError}`;
      await sleep(attempt * 2000);
      continue;
    }
    if (isWafBlock(res.status, res.text)) {
      counters.blocked++;
      lastReason = 'cloudfront block';
      console.warn(`  [waf] spectator blocked on ${operationName || 'query'} — waiting 80s`);
      await sleep(80000);
      continue;
    }
    // NOT a session problem: this endpoint takes no cookie, so refreshing one
    // would loop forever. Report it and stop.
    if (res.status === 403) {
      counters.auth403++;
      throw new Error(`spectator 403 on ${operationName || 'query'}`);
    }
    if (res.status !== 200) {
      lastReason = `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      counters.transient++;
      await sleep(attempt * 1000);
      continue;
    }

    let json;
    try { json = JSON.parse(res.text); }
    catch (e) {
      counters.transient++;
      lastReason = `JSON parse: ${e.message}`;
      await sleep(attempt * 1000);
      continue;
    }

    // ⚠️ "NOT ELECTRONICALLY SCORED" IS AN ANSWER, NOT AN ERROR.
    //
    // Most games are not scored on the app, so this arrives for the majority of
    // calls — 44 of 46 on 2026-08-20. Counting it as a GraphQL error made the run
    // summary read `graphqlError=44` on a run where nothing went wrong, which is
    // the sort of figure that gets ignored and then hides a real one.
    const benign = (json.errors || []).every(e =>
      /not electronically scored|could not be found/i.test(String(e?.message || '')));
    if (json.errors && json.errors.length && !benign) counters.graphqlError++;
    else counters.ok++;
    return json;
  }
  throw new Error(`spectator ${operationName || 'query'} failed after ${MAX_ATTEMPTS} attempts — ${lastReason}`);
}

// The live score for one game, or null.
//
// null means "no score available" for every reason that is not an outage — the
// game is not e-scored, has not started, or the id is unknown. A caller wanting to
// show a live score cannot act on the difference, and treating "not e-scored" as
// an error would fill the log with a message that is really just an answer.
const Q_SPECTATOR_GAME = `query game($id: ID!) {
  game(id: $id) {
    id
    status
    result {
      home { statistics { type { value } count } }
      away { statistics { type { value } count } }
    }
  }
}`;

async function spectatorScore(gameId) {
  if (!gameId) return null;
  let json;
  try { json = await specPost(Q_SPECTATOR_GAME, { id: gameId }, 'game'); }
  catch (e) { return null; }
  if (json.errors && json.errors.length) return null;
  const g = json?.data?.game;
  if (!g) return null;
  const pick = (side, type) => {
    const s = (g.result?.[side]?.statistics || []).find(x => x.type?.value === type);
    return s ? s.count : null;
  };
  const hScore = pick('home', 'TOTAL_SCORE');
  const aScore = pick('away', 'TOTAL_SCORE');
  if (hScore == null && aScore == null) return null;
  return {
    gameId: g.id,
    status: g.status || null,          // LIVE, FINAL — its own vocabulary
    hScore, aScore,
    hG: pick('home', 'GOALS'), hB: pick('home', 'BEHINDS'),
    aG: pick('away', 'GOALS'), aB: pick('away', 'BEHINDS'),
  };
}

function summary() {
  return { ...counters };
}

function logSummary(label) {
  const c = counters;
  console.log(
    `\n[${label || 'playhq'}] ok=${c.ok} graphqlError=${c.graphqlError} ` +
      `blocked=${c.blocked} auth403=${c.auth403} transient=${c.transient} ` +
      `retries=${c.retries} sessionRefreshes=${c.sessionRefreshes}`
  );
}

// ── Session pool ─────────────────────────────────────────────────────────────
//
// N INDEPENDENT GUEST SESSIONS, each paced by a minimum gap. Additive: nothing
// above this line changed behaviour, and every existing export keeps its
// signature. docs/walk_pool_design.md is the approved design.
//
// ⚠️ WHAT THE LIMIT ACTUALLY IS (measured 2026-11-24, six runs of
// scripts/probe-rate-sharded.js, one runner, anonymous cookie-no-jwt):
//
//   workers  gap      per session   aggregate    calls/session   result
//      8       270ms    224/min      ~1,790/min       179        BLOCKED
//      2       450ms    134/min         268/min       154        BLOCKED
//      8     1,600ms     37/min         298/min       350        clean
//     16     1,490ms     40/min         644/min       302        clean
//      8       776ms     77/min         618/min       261        clean
//     16       662ms     91/min       1,451/min       308        clean
//
// The limit is the MINIMUM GAP BETWEEN CONSECUTIVE REQUESTS ON ONE SESSION.
// Blocked at or below 450ms, clean at or above 662ms. Throughput scales
// linearly with the number of independent sessions.
//
// Falsified by those rows, each of which had been asserted somewhere in this
// repo or its brief:
//   per-IP                  the same runner took 1,434 ok, then 308.
//   an aggregate rate       blocked at 268/min; clean at 1,451/min.
//   a ~250-290 call budget  261, 302, 308 and 350 per session all clean, and
//                           both blocks happened BELOW it, at 154 and 179.
//
// ⚠️ A TOKEN BUCKET IS THE WRONG INSTRUMENT HERE, and walk-registrations v11
// used one. "110 calls per rolling 60s" fires at full speed until the allowance
// empties and then idles — bursts spaced at the round trip alone, 262-376ms,
// which is exactly the blocked region. Pace by the GAP, never by a rate.
//
// ⚠️ THE GAP IS TARGETED START-TO-START, not slept after the call. A fixed
// sleep drifts with latency: the same 400ms pace produced a 776ms gap at one
// latency and 662ms at another.
//
// ROTATION IS NOT FORCED BY A CALL BUDGET — no such budget was observed. It is
// forced by the cookie's 30-40 minute TTL, which a 67-minute sweep outlives
// twice. The caps below stay inside every clean reading above, so no session
// enters territory that has not been measured.
//
// ⚠️ A HANDLER MUST NOT MUTATE ANYTHING BEFORE ITS CALL RETURNS. When a call is
// blocked the pool requeues the item and the handler never completes, so any
// state written ahead of the call would be written twice.

const LIB_VERSION = 'playhq.js v2 2026-11-24 session-pool';

class PoolBlocked extends Error {
  constructor(msg) { super(msg || 'cloudfront block'); this.name = 'PoolBlocked'; }
}

// One independent guest session, or null. Uses the same two query shapes and
// the same cookie assembly as acquireSession — via pickCookie, so there is one
// place that knows the order — but touches no module state.
async function mintCookie() {
  for (const body of COOKIE_QUERIES) {
    // cookie: null, explicitly. Never offer an existing cookie while asking for
    // a new one, and never fall back to the module-level session here.
    const res = await rawPost(JSON.stringify(body), null, 30000, null, null);
    const { cookie } = pickCookie(res.setCookie);
    if (cookie) return cookie;
    // A WAF block will not be fixed by trying the other query shape.
    if (isWafBlock(res.status, res.text)) return null;
  }
  return null;
}

function createPool(opts) {
  const o = opts || {};
  const size = Math.max(1, Number(o.size || 8));
  const baseGapMs = Number(o.gapMs == null ? 800 : o.gapMs);
  // ⚠️ Math.max(1, ...), NOT Math.max(10, ...). A floor here silently overrode a
  // smaller maxCalls — the caller asked for 5 and got 10 with nothing said.
  const maxCalls = Math.max(1, Number(o.maxCalls || 300));
  const stagger = Math.max(0, Number(o.stagger == null ? 20 : o.stagger));
  const maxAgeMs = Math.max(1000, Number(o.maxAgeMs || 15 * 60 * 1000));
  const blockWaitMs = Number(o.blockWaitMs == null ? 80000 : o.blockWaitMs);
  const clusterMs = Number(o.clusterMs == null ? 10000 : o.clusterMs);
  const maxBlocks = Number(o.maxBlocks == null ? 20 : o.maxBlocks);
  const mintAttempts = Math.max(1, Number(o.mintAttempts || 5));
  const log = typeof o.log === 'function' ? o.log : console.log;

  let gapMs = baseGapMs;
  let poolPauseUntil = 0;
  let aborted = false;
  const blocks = [];
  const stats = {
    calls: 0, ok: 0, blockCount: 0, rotations: 0,
    mintFailures: 0, requeued: 0, handlerErrors: 0, widened: 0,
  };

  // ⚠️ STAGGERED CAPS. Eight sessions minted together and capped identically
  // all retire in the same few seconds, and the sweep stalls while the whole
  // pool re-bootstraps. Session n retires sooner, so replacement is rolling.
  //
  // ⚠️ THE STAGGER IS CLAMPED, NOT THE CAP. An earlier version floored each cap
  // at 25, which SILENTLY IGNORED any maxCalls below that — a pool asked for 5
  // calls a session quietly did 25. Clamping the stagger instead keeps the last
  // session at no less than half of maxCalls and leaves maxCalls meaning what
  // it says at every pool size: 8 sessions of 300 stagger by 18, 16 by 9.
  const stepMs = Math.min(stagger, Math.floor(maxCalls / (2 * size)));
  const sessions = [];
  for (let i = 0; i < size; i++) {
    sessions.push({
      i, cookie: null, calls: 0, bornAt: 0, lastStart: 0, blocks: 0,
      pauseUntil: 0, cap: Math.max(1, maxCalls - stepMs * i),
    });
  }

  async function waitForPause(s) {
    for (;;) {
      const now = Date.now();
      const until = Math.max(poolPauseUntil, s ? s.pauseUntil : 0);
      if (now >= until) return;
      await sleep(until - now);
    }
  }

  // Mint on first use, and whenever the session has hit its cap, its age, or a
  // block. Throws only when a cookie cannot be obtained at all.
  async function ensureFresh(s) {
    const now = Date.now();
    if (s.cookie && s.calls < s.cap && (now - s.bornAt) < maxAgeMs) return;
    if (s.cookie) {
      const why = s.calls >= s.cap ? `cap ${s.cap}` : 'age';
      log(`  [pool ${s.i}] retiring session: ${s.calls} calls, ` +
        `${Math.round((now - s.bornAt) / 1000)}s old (${why})`);
      stats.rotations++;
    }
    s.cookie = null;
    for (let attempt = 1; attempt <= mintAttempts; attempt++) {
      const c = await mintCookie();
      if (c) {
        s.cookie = c; s.calls = 0; s.bornAt = Date.now(); s.lastStart = 0;
        counters.sessionRefreshes++;
        return;
      }
      stats.mintFailures++;
      log(`  [pool ${s.i}] could not mint a session (attempt ${attempt}/${mintAttempts}) — waiting ${Math.round(blockWaitMs / 1000)}s`);
      await sleep(blockWaitMs);
    }
    throw new Error(`pool worker ${s.i}: could not obtain a session after ${mintAttempts} attempts`);
  }

  function noteBlock(s) {
    const at = Date.now();
    s.blocks++;
    stats.blockCount++;
    counters.blocked++;
    blocks.push({ at, atIso: new Date(at).toISOString(), worker: s.i, callsOnSession: s.calls });
    log(`  [pool ${s.i}] ⚠️ BLOCKED after ${s.calls} calls on this session, ` +
      `${Math.round((at - s.bornAt) / 1000)}s old`);
    // Retired, never reused. ensureFresh mints a replacement on the next call.
    s.cookie = null;

    // ⚠️ CLUSTERED BLOCKS ARE TREATED AS RUNNER-WIDE. Whether a WAF block
    // penalises the cookie or the whole runner is NOT established: in both
    // blocked probe runs every session stopped succeeding at once, but every
    // session was identically paced and in lockstep, so the runs cannot tell
    // the two apart. Pausing the pool is correct under both readings and costs
    // nothing under the per-cookie one.
    const recent = blocks.filter(b => at - b.at <= clusterMs);
    if (recent.length >= 2) {
      poolPauseUntil = Math.max(poolPauseUntil, at + blockWaitMs);
      log(`  [pool] ${recent.length} blocks within ${Math.round(clusterMs / 1000)}s — ` +
        `pausing the WHOLE pool for ${Math.round(blockWaitMs / 1000)}s`);
    } else {
      s.pauseUntil = at + blockWaitMs;
    }

    // Fires once per session, on its second block: one unlucky session should
    // not widen the gap, a repeat offender means the gap itself is too narrow.
    if (s.blocks === 2) {
      gapMs = Math.round(gapMs * 1.25);
      stats.widened++;
      log(`  [pool] session ${s.i} has blocked twice — widening the gap to ${gapMs}ms for the rest of the run`);
    }

    if (blocks.length >= maxBlocks) {
      aborted = true;
      log(`  [pool] ${blocks.length} blocks — ABORTING the sweep; what has been collected is kept`);
    }
  }

  // One GraphQL call on one session. Same classification as gqlPost, with one
  // difference that matters: a WAF block throws PoolBlocked instead of sleeping
  // 80s inline, so the pool can requeue the item and keep the other sessions
  // working.
  async function callOn(s, query, variables, operationName) {
    const bodyStr = JSON.stringify(operationName
      ? { operationName, query, variables } : { query, variables });
    const authIsData = operationName && AUTH_403_IS_DATA.has(operationName);
    let lastReason = 'unknown';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) counters.retries++;
      await waitForPause(s);
      await ensureFresh(s);

      // The gap, targeted start-to-start. If the previous round trip already
      // took longer than the gap, this waits for nothing.
      if (s.lastStart) {
        const wait = (s.lastStart + gapMs) - Date.now();
        if (wait > 0) await sleep(wait);
      }
      s.lastStart = Date.now();
      s.calls++;
      stats.calls++;

      const res = await rawPost(bodyStr, null, 60000, null, s.cookie);

      if (isWafBlock(res.status, res.text)) {
        noteBlock(s);
        throw new PoolBlocked(`blocked on ${operationName || 'query'}`);
      }
      if (res.status === 0) {
        counters.transient++;
        lastReason = `network: ${res.networkError}`;
        await sleep(attempt * 1000);
        continue;
      }
      if (res.status === 403) {
        counters.auth403++;
        if (authIsData) throw new Error(`403 not accessible: ${operationName}`);
        // Not a WAF body, so the cookie has expired rather than been punished.
        lastReason = 'session 403';
        s.cookie = null;
        continue;
      }
      if (res.status === 400) {
        counters.graphqlError++;
        try { return JSON.parse(res.text); }
        catch (e) { throw new Error(`${operationName || 'query'} rejected (400): ${res.text.slice(0, 200)}`); }
      }
      if (res.status !== 200) {
        counters.transient++;
        lastReason = `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
        await sleep(attempt * 1000);
        continue;
      }
      let json;
      try { json = JSON.parse(res.text); }
      catch (e) {
        counters.transient++;
        lastReason = `JSON parse: ${e.message}`;
        await sleep(attempt * 1000);
        continue;
      }
      if (json.errors && json.errors.length) counters.graphqlError++;
      else { counters.ok++; stats.ok++; }
      return json;
    }
    throw new Error(`${operationName || 'query'} failed after ${MAX_ATTEMPTS} attempts — ${lastReason}`);
  }

  // Run `handler(item, call)` over every item, `size` sessions at a time.
  // `call(query, variables, operationName)` is bound to that worker's session.
  //
  // A blocked item goes BACK ON THE QUEUE and is retried by whichever session
  // reaches it. It is never reported as done and never reported as empty.
  async function each(items, handler, runOpts) {
    const ro = runOpts || {};
    const shouldStop = typeof ro.shouldStop === 'function' ? ro.shouldStop : () => false;
    const onError = typeof ro.onError === 'function' ? ro.onError : null;
    const queue = items.slice();
    const requeue = [];
    let next = 0;
    let stopped = false;

    await Promise.all(sessions.map(async (s) => {
      for (;;) {
        if (aborted || stopped) return;
        if (shouldStop()) { stopped = true; return; }
        let item;
        if (next < queue.length) item = queue[next++];
        else if (requeue.length) item = requeue.shift();
        else return;
        try {
          await handler(item, (q, v, op) => callOn(s, q, v, op));
        } catch (e) {
          if (e instanceof PoolBlocked) {
            requeue.push(item);
            stats.requeued++;
            await waitForPause(s);
            continue;
          }
          stats.handlerErrors++;
          if (onError) onError(item, e);
        }
      }
    }));

    return {
      ...stats,
      blocks: blocks.slice(),
      aborted,
      stoppedEarly: stopped,
      gapMs,
      // ⚠️ NOT ZERO IS NOT A BUG, BUT IT IS NOT NOTHING EITHER. An item requeued
      // after the last worker had already run out of queue is left here rather
      // than silently dropped. Those players keep their previous `at` and are
      // walked first on the next run.
      requeuePending: requeue.length,
    };
  }

  function describe() {
    return { size, gapMs, maxCalls, stagger: stepMs, maxAgeMs, caps: sessions.map(s => s.cap) };
  }

  return { each, describe, stats, blocks };
}

module.exports = {
  LIB_VERSION,
  createPool,
  PoolBlocked,
  gqlPost,
  specPost,
  spectatorScore,
  SPECTATOR_URL,
  refreshSession,
  ensureSession,
  summary,
  logSummary,
  sleep,
  API_URL,
  USER_AGENT,
  TENANT,
};
