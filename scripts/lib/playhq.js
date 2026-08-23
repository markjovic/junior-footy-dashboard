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
// The HTTP stack is deliberately still node's https module rather than global
// fetch. Changing the outbound stack in the same commit as the session handling
// would make a regression impossible to attribute.

'use strict';

const https = require('https');
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

function headers(extra) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    tenant: TENANT,
    origin: 'https://www.playhq.com',
    'request-id': crypto.randomUUID(),
  };
  if (sessionCookie) h.Cookie = sessionCookie;
  return Object.assign(h, extra || {});
}

// Raw POST. Resolves with { status, text, setCookie } and never rejects, so the
// classifier above it sees every outcome rather than only the happy path.
function rawPost(bodyStr, extraHeaders, timeoutMs, url) {
  return new Promise((resolve) => {
    const h = headers(extraHeaders);
    h['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(url || API_URL, { method: 'POST', headers: h, timeout: timeoutMs || 60000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          text: data,
          // node's http gives set-cookie as an ARRAY. The previous code joined
          // it and then regexed the result, which is what lost phq_tier and
          // phq_sub. Take the array as it comes.
          setCookie: res.headers['set-cookie'] || [],
        });
      });
    });

    req.on('error', (err) => resolve({ status: 0, text: '', setCookie: [], networkError: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '', setCookie: [], networkError: 'timeout' }); });
    req.write(bodyStr);
    req.end();
  });
}

// A CloudFront WAF block is an HTML body with a 403 and is NOT an application
// 403. Test the body before deciding what a 403 means.
function isWafBlock(status, text) {
  return status === 403 && (/DOCTYPE/i.test(text) || /Request blocked/i.test(text));
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
    if (attempt > 1) await sleep(Math.min(attempt * 2000, 15000));

    for (const body of COOKIE_QUERIES) {
      const prev = sessionCookie;
      sessionCookie = ''; // never send a stale cookie while asking for a new one
      const res = await rawPost(JSON.stringify(body), null, 30000);
      sessionCookie = prev;

      const parts = res.setCookie.map((c) => String(c).split(';')[0].trim());
      const pick = (n) => parts.find((p) => p.startsWith(n + '=')) || null;
      const tier = pick('phq_tier');
      const sess = pick('phq_session');
      const sub = pick('phq_sub');

      if (tier && sess && sub) {
        // Order matters — wrong order causes CloudFront 403s.
        sessionCookie = `${tier}; ${sess}; ${sub}`;
        sessionAcquiredAt = Date.now();
        counters.sessionRefreshes++;
        console.log(`  [session] acquired on attempt ${attempt} (${body.operationName})`);
        return true;
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

module.exports = {
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
