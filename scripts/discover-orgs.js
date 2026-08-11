// scripts/discover-orgs.js
// Sweeps every AFL association on PlayHQ and records its competitions and
// seasons, so we can answer two questions with measurement rather than
// expectation: how many organisations are dormant, and whether dormancy and a
// missing address are the same population.
//
// Owns data/org-discovery.json and nothing else. Never writes data/data.json.
//
// Exit codes follow the repo convention: 0 = changed, commit. 2 = no change,
// skip commit. 1 = fatal.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'org-discovery.json');

const API_URL = 'https://api.playhq.com/graphql';
const SEARCH_URL = 'https://search.playhq.com/graphql';
const TENANT = 'afl';
const TENANT_SLUG = 'afl';

// Verified honoured 2026-08-11. Anything above this is untested.
const PAGE_LIMIT = 500;
const MAX_PAGES = 30;
const CONCURRENCY = 8;

const HEADERS_BASE = {
  accept: '*/*',
  origin: 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'content-type': 'application/json',
};

const SEARCH_QUERY =
  'query search($filter: SearchFilter!) {\n' +
  '  search(filter: $filter) {\n' +
  '    meta { page totalPages totalRecords }\n' +
  '    results {\n' +
  '      ... on Organisation {\n' +
  '        id routingCode name type\n' +
  '        address { suburb state postcode }\n' +
  '      }\n' +
  '    }\n' +
  '  }\n' +
  '}\n';

// seasons takes a required organisationID argument, and organisationID must be
// the 8-character code. Both verified 2026-08-11 by controlled comparison.
const COMPETITIONS_QUERY =
  'query discoverCompetitions($organisationID: ID!) {\n' +
  '  discoverCompetitions(organisationID: $organisationID) {\n' +
  '    id\n' +
  '    name\n' +
  '    seasons(organisationID: $organisationID) {\n' +
  '      id name startDate endDate status { name value }\n' +
  '    }\n' +
  '  }\n' +
  '}\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sessionCookie = null;

function log(...a) {
  console.log(...a);
}

// Generating today's date, not parsing one. Dates from the API are compared as
// YYYY-MM-DD strings, which sort correctly without ever constructing a Date.
const TODAY = new Date().toISOString().slice(0, 10);

const STATE_MAP = {
  'victoria': 'VIC', 'vic': 'VIC',
  'new south wales': 'NSW', 'nsw': 'NSW',
  'queensland': 'QLD', 'qld': 'QLD',
  'south australia': 'SA', 'sa': 'SA',
  'western australia': 'WA', 'wa': 'WA',
  'tasmania': 'TAS', 'tas': 'TAS',
  'northern territory': 'NT', 'nt': 'NT',
  'australian capital territory': 'ACT', 'act': 'ACT',
};

// Returns the normalised Australian state, or null when the value is absent or
// is not an Australian state. Null is NOT the same as "not Victorian" — an
// organisation with no address is unclassified, and the report keeps the two
// apart deliberately.
function normaliseState(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return STATE_MAP[raw.trim().toLowerCase()] || null;
}

async function refreshSession() {
  const cookieQueries = [
    { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
    {
      operationName: 'ProfileSearch',
      variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    },
  ];
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 5000);
    for (const body of cookieQueries) {
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { ...HEADERS_BASE, tenant: TENANT, 'request-id': crypto.randomUUID() },
          body: JSON.stringify(body),
        });
      } catch {
        continue;
      }
      const parts =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie().map((c) => c.split(';')[0].trim())
          : (res.headers.get('set-cookie') || '').split(',').map((c) => c.trim().split(';')[0]);
      const pick = (n) => parts.find((p) => p.startsWith(n + '=')) || null;
      const tier = pick('phq_tier');
      const sess = pick('phq_session');
      const sub = pick('phq_sub');
      if (tier && sess && sub) {
        sessionCookie = `${tier}; ${sess}; ${sub}`;
        return true;
      }
    }
  }
  return false;
}

// Every call returns a kind. A failure is never collapsed into "no data",
// because an organisation that errored is not an organisation with no seasons.
async function gql(url, body, useCookie) {
  const headers = { ...HEADERS_BASE, tenant: TENANT, 'request-id': crypto.randomUUID() };
  if (useCookie && sessionCookie) headers.Cookie = sessionCookie;

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return { kind: 'transient', note: err.message };
  }
  const text = await res.text();

  if (res.status === 403 && (/DOCTYPE/i.test(text) || /Request blocked/i.test(text))) {
    return { kind: 'blocked' };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'error', note: `non-JSON body, status ${res.status}` };
  }
  if (json.errors && json.errors.length) {
    return { kind: 'graphql_error', note: json.errors.map((e) => e.message).join(' | ') };
  }
  return { kind: 'ok', data: json.data };
}

async function fetchAllAssociations() {
  const orgs = new Map();
  let page = 1;
  let totalPages = null;

  while (page <= MAX_PAGES) {
    const r = await gql(
      SEARCH_URL,
      {
        operationName: 'search',
        query: SEARCH_QUERY,
        variables: {
          filter: {
            meta: { page, limit: PAGE_LIMIT },
            organisation: { types: ['ASSOCIATION'], tenantSlug: TENANT_SLUG },
          },
        },
      },
      false
    );
    if (r.kind !== 'ok') throw new Error(`association page ${page} failed: ${r.kind} ${r.note || ''}`);

    const s = r.data && r.data.search;
    if (!s) throw new Error(`association page ${page} returned no search node`);
    totalPages = s.meta && s.meta.totalPages;

    for (const o of s.results || []) if (o && o.routingCode) orgs.set(o.routingCode, o);
    log(`  page ${page}/${totalPages} — ${(s.results || []).length} results, ${orgs.size} distinct`);

    if (!totalPages || page >= totalPages) break;
    page++;
    await sleep(300);
  }

  // A wrong tenantSlug returns zero records with no error, so an empty result
  // is indistinguishable from a typo unless it is asserted against.
  if (orgs.size === 0) throw new Error('zero associations returned — check tenantSlug before trusting this');

  return [...orgs.values()];
}

function classify(comps) {
  const seasons = [];
  for (const c of comps || []) {
    for (const s of c.seasons || []) {
      seasons.push({ competition: c.name, competitionId: c.id, ...s });
    }
  }
  if (!seasons.length) return { activity: 'noSeasons', seasons, latestEnd: null };

  let latestEnd = null;
  let live = false;
  for (const s of seasons) {
    const v = s.status && s.status.value;
    // The status enum is not assumed. Anything that is not COMPLETED and not
    // in the past counts as live, and every distinct value seen is reported so
    // an unexpected one is visible rather than silently bucketed.
    if (v && v !== 'COMPLETED') live = true;
    if (typeof s.endDate === 'string' && (!latestEnd || s.endDate > latestEnd)) latestEnd = s.endDate;
  }
  if (!live && latestEnd && latestEnd >= TODAY) live = true;

  return { activity: live ? 'active' : 'dormant', seasons, latestEnd };
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

function sample(list, n) {
  return list.slice(0, n).map((o) => `${o.code} ${o.name}`);
}

async function main() {
  log('=== organisation discovery sweep ===');
  log(`today: ${TODAY}`);

  log('acquiring session...');
  if (!(await refreshSession())) {
    console.error('FATAL: no session cookie after 10 attempts');
    process.exit(1);
  }

  log('enumerating associations from search.playhq.com...');
  const raw = await fetchAllAssociations();
  log(`  ${raw.length} associations`);

  log(`fetching competitions for ${raw.length} organisations at concurrency ${CONCURRENCY}...`);
  let done = 0;
  const statusCounts = {};

  const records = await pool(raw, CONCURRENCY, async (o) => {
    let r = await gql(
      API_URL,
      { operationName: 'discoverCompetitions', query: COMPETITIONS_QUERY, variables: { organisationID: o.routingCode } },
      true
    );

    // 403 on this operation means the session expired. Refresh once and retry.
    if (r.kind === 'blocked') {
      await sleep(2000);
      await refreshSession();
      r = await gql(
        API_URL,
        { operationName: 'discoverCompetitions', query: COMPETITIONS_QUERY, variables: { organisationID: o.routingCode } },
        true
      );
    }

    done++;
    if (done % 100 === 0) log(`  ${done}/${raw.length}`);

    const stateRaw = (o.address && o.address.state) || null;
    const base = {
      code: o.routingCode,
      uuid: o.id,
      name: o.name,
      suburb: (o.address && o.address.suburb) || null,
      postcode: (o.address && o.address.postcode) || null,
      stateRaw,
      state: normaliseState(stateRaw),
      hasAddress: !!stateRaw,
    };

    if (r.kind !== 'ok') {
      return { ...base, activity: 'error', errorKind: r.kind, errorNote: r.note || null, competitions: [], seasons: [] };
    }

    const comps = (r.data && r.data.discoverCompetitions) || [];
    const { activity, seasons, latestEnd } = classify(comps);
    for (const s of seasons) {
      const v = (s.status && s.status.value) || '(none)';
      statusCounts[v] = (statusCounts[v] || 0) + 1;
    }

    return {
      ...base,
      activity,
      latestEnd,
      competitions: comps.map((c) => ({ id: c.id, name: c.name })),
      seasons: seasons.map((s) => ({
        id: s.id,
        name: s.name,
        competition: s.competition,
        competitionId: s.competitionId,
        startDate: s.startDate,
        endDate: s.endDate,
        status: (s.status && s.status.value) || null,
      })),
    };
  });

  // Cross-tabulation: the question this sweep exists to answer.
  const crosstab = {
    hasAddress: { active: 0, dormant: 0, noSeasons: 0, error: 0 },
    noAddress: { active: 0, dormant: 0, noSeasons: 0, error: 0 },
  };
  const byState = {};
  const examples = { noAddressActive: [], noAddressDormant: [], vicActive: [], errors: [] };

  for (const rec of records) {
    const bucket = rec.hasAddress ? 'hasAddress' : 'noAddress';
    crosstab[bucket][rec.activity] = (crosstab[bucket][rec.activity] || 0) + 1;
    const key = rec.state || (rec.stateRaw ? `other:${rec.stateRaw}` : '(none)');
    byState[key] = (byState[key] || 0) + 1;

    if (!rec.hasAddress && rec.activity === 'active') examples.noAddressActive.push(rec);
    if (!rec.hasAddress && rec.activity === 'dormant') examples.noAddressDormant.push(rec);
    if (rec.state === 'VIC' && rec.activity === 'active') examples.vicActive.push(rec);
    if (rec.activity === 'error') examples.errors.push(rec);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    today: TODAY,
    totalOrganisations: records.length,
    crosstab,
    byState,
    seasonStatusValues: statusCounts,
    // A counter without examples is a number that cannot be checked.
    examples: {
      noAddressActive: sample(examples.noAddressActive, 10),
      noAddressDormant: sample(examples.noAddressDormant, 10),
      vicActive: sample(examples.vicActive, 10),
      errors: sample(examples.errors, 10),
    },
    counts: {
      noAddressActive: examples.noAddressActive.length,
      noAddressDormant: examples.noAddressDormant.length,
      vicActive: examples.vicActive.length,
      errors: examples.errors.length,
    },
  };

  log('\n--- summary ---');
  log(`organisations: ${records.length}`);
  log(`with address:    ${JSON.stringify(crosstab.hasAddress)}`);
  log(`without address: ${JSON.stringify(crosstab.noAddress)}`);
  log(`season status values seen: ${JSON.stringify(statusCounts)}`);
  log(`VIC active: ${summary.counts.vicActive}`);
  log(`no address but active: ${summary.counts.noAddressActive}`);
  log(`errors: ${summary.counts.errors}`);
  for (const [k, v] of Object.entries(summary.examples)) {
    if (v.length) log(`  ${k}: ${v.slice(0, 5).join(' / ')}`);
  }

  const payload = { summary, organisations: records.sort((a, b) => a.name.localeCompare(b.name)) };
  // data.json in this repo is pretty-printed; org-discovery.json matches it.
  const next = JSON.stringify(payload, null, 2);

  let prev = null;
  try {
    prev = fs.readFileSync(OUT_PATH, 'utf8');
  } catch {
    prev = null;
  }

  // generatedAt changes every run, so comparing whole files would always report
  // a change. Compare everything except that field.
  const strip = (s) => (s ? s.replace(/"generatedAt": "[^"]*",\n/, '') : null);
  const changed = strip(prev) !== strip(next);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, next);
  log(`\nwrote ${OUT_PATH} (${(next.length / 1024 / 1024).toFixed(2)} MB)`);

  if (!changed) {
    log('no substantive change — exit 2');
    process.exit(2);
  }
  log('changed — exit 0');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
