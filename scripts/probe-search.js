// scripts/probe-search.js
// THROWAWAY DIAGNOSTIC. Writes probe-search-report.json to the repo root for
// artifact upload only. Commits nothing, touches no data file, and is safe to
// delete once the questions below are answered.
//
// Answers, by execution rather than by reading:
//   A  Does search() work at all from our guest session on api.playhq.com?
//   B  Is it tenant-sensitive? (afl / account / basketball-victoria / none)
//   C  Does an empty query string enumerate, or is a search term mandatory?
//   D  Does omitting the query key entirely enumerate?
//   E  Is limit:8 the website's page size or a real cap?
//   F  What are the valid values of types[] and sports[]?
//   G  Does the organisation filter accept a state/region field?
//   H  What sibling keys does SearchFilter accept besides organisation?
//   I  What members does the results union have besides Organisation?
//   J  If enumeration works, how many AFL associations are there in total?
//
// The session cookie is NEVER printed. This repo is public and so is the
// Actions log.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'probe-search-report.json');
const API_URL = 'https://api.playhq.com/graphql';
// Third endpoint, not in playhq_api_reference.md. The website's organisation
// directory is served from here, not from api.playhq.com.
const SEARCH_URL = 'https://search.playhq.com/graphql';

// Filled in by the S sweep below once we know which header shape this host
// wants. Every operationName 'search' probe picks it up automatically.
const SEARCH_CTX = { extraHeaders: null, noCookie: false, useSearchCookie: false };

const HEADERS_BASE = {
  accept: '*/*',
  origin: 'https://www.playhq.com',
  'user-agent': 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'content-type': 'application/json',
};

// Copied byte-for-byte from the browser capture. Not reformatted, because the
// discoverCompetitions investigation found that document shape was one of the
// variables worth holding fixed.
const SEARCH_QUERY_VERBATIM =
  'query search($filter: SearchFilter!) {\n  search(filter: $filter) {\n    meta {\n      page\n      totalPages\n      totalRecords\n      __typename\n    }\n    results {\n      ... on Organisation {\n        id\n        routingCode\n        name\n        type\n        logo {\n          sizes {\n            url\n            dimensions {\n              width\n              height\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        tenant {\n          id\n          name\n          logo {\n            sizes {\n              url\n              dimensions {\n                width\n                height\n                __typename\n              }\n              __typename\n            }\n            __typename\n          }\n          slug\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n';

// Builds the Organisation fragment with extra fields appended. This is how we
// find out whether the search result carries an address: if it does, "in
// Victoria" can be done by scoping client-side even when the filter has no
// region field.
function orgFragment(extra) {
  return `... on Organisation { id routingCode name type${extra ? ' ' + extra : ''} }`;
}

const ORG_FRAGMENT = orgFragment('');

// Known-good values, so the discoverCompetitions probes do not depend on the
// search probes having worked.
const EFNL_CODE = '383836bb';
const EFNL_UUID = '383836bb-a225-4d92-b7b8-432535f4cc7a';
// config.json carries EFNL 2026 as seasonID 2dcbf383. If discoverCompetitions
// works, this id must appear in its output. That is a check against a known
// value rather than a plausible-looking result, which is the difference between
// verifying and being reassured.
const KNOWN_EFNL_SEASON = '2dcbf383';

function searchDoc(fragments) {
  return (
    'query search($filter: SearchFilter!) {\n' +
    '  search(filter: $filter) {\n' +
    '    meta { page totalPages totalRecords }\n' +
    '    results {\n' +
    '      __typename\n' +
    '      ' + fragments + '\n' +
    '    }\n' +
    '  }\n' +
    '}\n'
  );
}

const SEARCH_QUERY_MIN = searchDoc(ORG_FRAGMENT);

const REPORT = { startedAt: new Date().toISOString(), probes: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sessionCookie = null;
let searchCookie = null;
let cookieMethod = null;

function log(...args) {
  console.log(...args);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// The pattern documented in playhq_api_reference.md: all three cookies, in the
// order phq_tier; phq_session; phq_sub, ten attempts with backoff, two
// alternating query shapes because PlayHQ intermittently returns no Set-Cookie.
// This is also step 1 of the team_registry_design build order, so the probe
// doubles as a live test of it.
async function refreshSession(tenant) {
  const cookieQueries = [
    {
      operationName: 'TenantConfig',
      variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }',
    },
    {
      operationName: 'ProfileSearch',
      variables: { fullName: 'a' },
      query:
        'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }',
    },
  ];

  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 5000);
    for (const body of cookieQueries) {
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { ...HEADERS_BASE, tenant, 'request-id': crypto.randomUUID() },
          body: JSON.stringify(body),
        });
      } catch (err) {
        log(`  session attempt ${attempt} (${body.operationName}): network error ${err.message}`);
        continue;
      }

      // Node 18+ exposes getSetCookie(), which does not mangle the comma inside
      // an Expires date the way splitting on ',' can. Fall back to the
      // documented split when it is absent, and record which path was used so
      // the read-back proves it rather than assuming.
      let parts;
      if (typeof res.headers.getSetCookie === 'function') {
        parts = res.headers.getSetCookie().map((c) => c.split(';')[0].trim());
        cookieMethod = 'getSetCookie';
      } else {
        const raw = res.headers.get('set-cookie');
        if (!raw) continue;
        parts = raw.split(',').map((c) => c.trim().split(';')[0]);
        cookieMethod = 'split';
      }

      const get = (name) => parts.find((p) => p.startsWith(name + '=')) || null;
      const tier = get('phq_tier');
      const session = get('phq_session');
      const sub = get('phq_sub');

      log(
        `  session attempt ${attempt} (${body.operationName}, ${cookieMethod}): ` +
          `tier=${!!tier} session=${!!session} sub=${!!sub}`
      );

      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Typed request
// ---------------------------------------------------------------------------

// Never collapse a failure into "no data". Every call returns a kind.
async function gql({ tenant, query, variables, operationName, expect, url, extraHeaders, noCookie, useSearchCookie }) {
  // Any operation named search goes to the search host unless a url is forced.
  const isSearch = operationName === 'search';
  const target = url || (isSearch ? SEARCH_URL : API_URL);
  const extra = extraHeaders !== undefined ? extraHeaders : isSearch ? SEARCH_CTX.extraHeaders : null;
  const skipCookie = noCookie !== undefined ? noCookie : isSearch ? SEARCH_CTX.noCookie : false;
  const preferSearchCookie =
    useSearchCookie !== undefined ? useSearchCookie : isSearch ? SEARCH_CTX.useSearchCookie : false;

  const headers = { ...HEADERS_BASE, 'request-id': crypto.randomUUID() };
  if (tenant !== null && tenant !== undefined) headers.tenant = tenant;
  if (extra) Object.assign(headers, extra);
  if (!skipCookie) {
    const cookie = preferSearchCookie ? searchCookie || sessionCookie : sessionCookie;
    if (cookie) headers.Cookie = cookie;
  }

  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationName, query, variables }),
    });
  } catch (err) {
    return { kind: 'transient', status: 0, note: `network error: ${err.message}` };
  }

  const text = await res.text();

  // A CloudFront WAF block is an HTML body with a 403 and is NOT an application
  // 403. Test the body before deciding what a 403 means.
  if (res.status === 403 && (/DOCTYPE/i.test(text) || /Request blocked/i.test(text))) {
    return { kind: 'blocked', status: 403, note: 'CloudFront WAF block (HTML body)' };
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      kind: 'error',
      status: res.status,
      note: 'body was not JSON',
      bodyHead: text.slice(0, 300),
    };
  }

  if (json.errors && json.errors.length) {
    return {
      kind: 'graphql_error',
      status: res.status,
      errors: json.errors.map((e) => ({
        message: e.message,
        code: e.extensions && e.extensions.code,
      })),
      data: json.data || null,
    };
  }

  if (res.status !== 200) {
    return { kind: 'error', status: res.status, bodyHead: text.slice(0, 300) };
  }

  // expect names the field under data to unwrap. Pass null for operations that
  // are not search, to get the whole data node back untouched.
  const root = expect === undefined ? 'search' : expect;
  if (root === null) {
    return { kind: 'ok', status: 200, data: json.data || null };
  }

  const node = json.data && json.data[root];
  if (!node) return { kind: 'empty', status: 200, data: json.data || null };

  return {
    kind: 'ok',
    status: 200,
    meta: node.meta || null,
    results: node.results || [],
    data: json.data,
  };
}

function summarise(result) {
  if (result.kind !== 'ok') return null;
  const typenames = {};
  const types = {};
  for (const r of result.results || []) {
    typenames[r.__typename] = (typenames[r.__typename] || 0) + 1;
    if (r.type) types[r.type] = (types[r.type] || 0) + 1;
  }
  return {
    meta: result.meta,
    returned: (result.results || []).length,
    typenames,
    orgTypes: types,
    // Kept whole and unfiltered, so a field this script does not know about
    // still shows up in the log rather than being silently dropped.
    rawFirst: (result.results || [])[0] || null,
    sample: (result.results || []).slice(0, 5).map((r) => ({
      id: r.id,
      routingCode: r.routingCode,
      name: r.name,
      type: r.type,
      // Tests whether routingCode is the 8-character public code that
      // discoverOrganisation(code:) takes, and whether it is the id prefix.
      idPrefix8: typeof r.id === 'string' ? r.id.slice(0, 8) : null,
      routingCodeMatchesIdPrefix:
        typeof r.id === 'string' && typeof r.routingCode === 'string'
          ? r.id.slice(0, 8) === r.routingCode
          : null,
    })),
  };
}

async function probe(name, description, req) {
  const result = await gql(req);
  const record = {
    name,
    description,
    tenant: req.tenant === null ? '(header omitted)' : req.tenant,
    variables: req.variables,
    kind: result.kind,
    status: result.status,
    note: result.note || null,
    errors: result.errors || null,
    bodyHead: result.bodyHead || null,
    summary: summarise(result),
  };
  REPORT.probes.push(record);

  log(`\n[${name}] ${description}`);
  log(`  tenant=${record.tenant} kind=${result.kind} status=${result.status}`);
  if (result.note) log(`  note: ${result.note}`);
  if (result.errors) for (const e of result.errors) log(`  error: ${e.message}`);
  if (record.summary) {
    log(`  meta: ${JSON.stringify(record.summary.meta)}`);
    log(`  returned=${record.summary.returned} typenames=${JSON.stringify(record.summary.typenames)}`);
    for (const s of record.summary.sample) {
      log(`    ${s.type || '?'} ${s.routingCode || '-'} ${s.name} (id ${s.id})`);
    }
    log(`  first result raw: ${JSON.stringify(record.summary.rawFirst)}`);
  }

  await sleep(500);
  return result;
}

const baseFilter = (organisation, meta) => ({
  meta: meta || { limit: 8, page: 1 },
  organisation,
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== PlayHQ search() probe ===');
  log(`endpoint: ${API_URL}`);
  log('acquiring session (tenant: afl)...');

  if (!(await refreshSession('afl'))) {
    log('FATAL: no session cookie after 10 attempts.');
    REPORT.fatal = 'no session cookie';
    fs.writeFileSync(REPORT_PATH, JSON.stringify(REPORT, null, 2));
    process.exit(1);
  }
  log(`session acquired via ${cookieMethod}`);
  REPORT.cookieMethod = cookieMethod;

  // -------------------------------------------------------------------------
  // S — which header shape does search.playhq.com want?
  // Cookies are host-scoped, so the api.playhq.com session may be worthless
  // here, and the spectator endpoint already sets a precedent for a host in
  // this family needing a different header set. Establish the shape first and
  // run everything else with whatever worked, rather than assuming one.
  // -------------------------------------------------------------------------

  const directoryVars = {
    filter: {
      meta: { page: 1, limit: 12 },
      organisation: { types: ['ASSOCIATION'], tenantSlug: 'afl' },
    },
  };

  // Try to obtain a cookie from the search host itself.
  try {
    const r0 = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { ...HEADERS_BASE, tenant: 'afl', 'request-id': crypto.randomUUID() },
      body: JSON.stringify({
        operationName: 'search',
        query: SEARCH_QUERY_MIN,
        variables: directoryVars,
      }),
    });
    const parts =
      typeof r0.headers.getSetCookie === 'function'
        ? r0.headers.getSetCookie().map((c) => c.split(';')[0].trim())
        : (r0.headers.get('set-cookie') || '').split(',').map((c) => c.trim().split(';')[0]);
    const pick = (n) => parts.find((p) => p.startsWith(n + '=')) || null;
    const tier = pick('phq_tier');
    const sess = pick('phq_session');
    const sub = pick('phq_sub');
    if (tier && sess && sub) searchCookie = `${tier}; ${sess}; ${sub}`;
    log(`search host session: status=${r0.status} tier=${!!tier} session=${!!sess} sub=${!!sub}`);
  } catch (err) {
    log(`search host session: network error ${err.message}`);
  }
  REPORT.searchHostCookieObtained = !!searchCookie;

  const shapes = [
    { label: 'S1-tenant-afl-apicookie', tenant: 'afl', extraHeaders: null, noCookie: false, useSearchCookie: false },
    { label: 'S2-tenant-afl-nocookie', tenant: 'afl', extraHeaders: null, noCookie: true, useSearchCookie: false },
    { label: 'S3-no-tenant-apicookie', tenant: null, extraHeaders: null, noCookie: false, useSearchCookie: false },
    { label: 'S4-x-phq-tenant', tenant: 'afl', extraHeaders: { 'x-phq-tenant': 'afl' }, noCookie: false, useSearchCookie: false },
    { label: 'S5-searchhost-cookie', tenant: 'afl', extraHeaders: null, noCookie: false, useSearchCookie: true },
  ];

  let chosenShape = null;
  for (const s of shapes) {
    const r = await probe(s.label, `search.playhq.com header shape: ${s.label}`, {
      tenant: s.tenant,
      operationName: 'search',
      query: SEARCH_QUERY_MIN,
      variables: directoryVars,
      extraHeaders: s.extraHeaders,
      noCookie: s.noCookie,
      useSearchCookie: s.useSearchCookie,
    });
    if (!chosenShape && r.kind === 'ok') chosenShape = s;
  }

  if (chosenShape) {
    SEARCH_CTX.extraHeaders = chosenShape.extraHeaders;
    SEARCH_CTX.noCookie = chosenShape.noCookie;
    SEARCH_CTX.useSearchCookie = chosenShape.useSearchCookie;
    log(`\n>>> search.playhq.com accepts ${chosenShape.label}; remaining search probes use it.`);
  } else {
    log('\n>>> No header shape worked against search.playhq.com.');
    log('>>> The remaining search probes still run, to collect their error text.');
  }
  REPORT.searchHeaderShape = chosenShape ? chosenShape.label : null;

  // The second capture, from https://www.playhq.com/afl?page=1&types=ASSOCIATION.
  // It has NO query key at all, and uses tenantSlug instead of sports. The
  // GraphQL document is byte-identical to the first capture — only the
  // variables differ — so this is the same operation used two ways.
  const directoryFilter = { types: ['ASSOCIATION'], tenantSlug: 'afl' };
  // The first capture: keyword search, sports instead of tenantSlug.
  const keywordFilter = { query: 'football', types: ['ASSOCIATION'], sports: ['AFL'] };

  // A — the directory capture, verbatim document, verbatim variables.
  // This is the one that matters: the website enumerates with it.
  await probe('A-directory-verbatim', 'Directory capture verbatim (no query key, tenantSlug)', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_VERBATIM,
    variables: { filter: { meta: { page: 1, limit: 12 }, organisation: directoryFilter } },
  });

  // A1 — the keyword capture, to confirm query and sports still work.
  await probe('A1-keyword-verbatim', 'Keyword capture verbatim (query + sports)', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_VERBATIM,
    variables: { filter: baseFilter(keywordFilter) },
  });

  // A2 — same thing with the minimised document, to see whether shape matters.
  await probe('A2-directory-minimised', 'Directory filter, trimmed document', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter(directoryFilter) },
  });

  // B — tenant sweep. More interesting now that tenantSlug is inside the filter:
  // if the filter carries the tenant, the header may be irrelevant.
  // basketball-victoria is included deliberately as the contradiction case.
  for (const t of ['account', 'basketball-victoria', null]) {
    await probe(
      `B-tenant-${t === null ? 'omitted' : t}`,
      `Tenant header sensitivity: ${t === null ? 'no tenant header' : t}`,
      {
        tenant: t,
        operationName: 'search',
        query: SEARCH_QUERY_MIN,
        variables: { filter: baseFilter(directoryFilter) },
      }
    );
  }

  // B2 / B3 — is tenantSlug doing the scoping, or the header?
  await probe('B2-no-tenantslug', 'tenantSlug removed from filter, header still afl', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter({ types: ['ASSOCIATION'] }) },
  });

  await probe('B3-bad-tenantslug', 'tenantSlug: "zzzz" — error, or silently empty?', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter({ types: ['ASSOCIATION'], tenantSlug: 'zzzz' }) },
  });

  // C — does an explicit empty query change anything, now that we know the key
  // can be omitted entirely?
  await probe('C-empty-query', 'query: "" alongside tenantSlug', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter({ query: '', types: ['ASSOCIATION'], tenantSlug: 'afl' }) },
  });

  // D — the enumeration path. Named to stay the primary candidate for paging.
  await probe('D-no-query-key', 'Directory filter, no query key (enumeration candidate)', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter(directoryFilter) },
  });

  // D2 — clubs as well as associations. If CLUB enumerates under tenantSlug afl
  // that is every AFL club on PlayHQ, a far larger set than the associations.
  await probe('D2-clubs', 'types: ["CLUB"] with tenantSlug, no query', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter({ types: ['CLUB'], tenantSlug: 'afl' }) },
  });

  // E — 8 and 12 have both been seen in the wild, so neither is a cap.
  // gradePlayerStatistics taught us not to assume an observed limit is the max.
  for (const limit of [50, 100, 500]) {
    await probe(`E-limit-${limit}`, `Page size ${limit}`, {
      tenant: 'afl',
      operationName: 'search',
      query: SEARCH_QUERY_MIN,
      variables: { filter: baseFilter(directoryFilter, { limit, page: 1 }) },
    });
  }

  // F — enum discovery. Introspection is disabled, so a deliberately invalid
  // value is the only way to make the server name the valid ones.
  await probe('F-bad-type', 'types: ["ZZZZ"] — expect the error to name valid values', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter({ types: ['ZZZZ'], tenantSlug: 'afl' }) },
  });

  await probe('F2-bad-sport', 'sports: ["ZZZZ"] — does sports still exist alongside tenantSlug?', {
    tenant: 'afl',
    operationName: 'search',
    query: SEARCH_QUERY_MIN,
    variables: { filter: baseFilter({ types: ['ASSOCIATION'], sports: ['ZZZZ'] }) },
  });

  // G — is there a region filter? This is what "in Victoria" depends on.
  // tenantSlug is held constant so the tested field is the only variable.
  for (const field of ['state', 'region', 'location', 'postcode', 'stat']) {
    await probe(`G-field-${field}`, `organisation.${field} — valid filter field?`, {
      tenant: 'afl',
      operationName: 'search',
      query: SEARCH_QUERY_MIN,
      variables: {
        filter: baseFilter({ types: ['ASSOCIATION'], tenantSlug: 'afl', [field]: 'VIC' }),
      },
    });
  }

  // K — the other route to Victoria. If the filter cannot narrow by state but
  // the RESULT carries an address, we can scope client-side. discoverOrganisation
  // returns address { suburb state }, so the field exists on some Organisation
  // type; whether this union member exposes it is the open question.
  const resultFields = [
    'address { suburb state postcode }',
    'address { state }',
    'state',
    'location { state }',
    'contacts { email }',
  ];
  let workingAddressField = null;
  for (let i = 0; i < resultFields.length; i++) {
    const r = await probe(`K-resultfield-${i + 1}`, `Organisation result field: ${resultFields[i]}`, {
      tenant: 'afl',
      operationName: 'search',
      query: searchDoc(orgFragment(resultFields[i])),
      variables: { filter: baseFilter(directoryFilter) },
    });
    // Accepting the field is not the same as it carrying data. Require a
    // non-null value in an actual result before believing it.
    if (!workingAddressField && r.kind === 'ok') {
      const first = (r.results || [])[0];
      if (first && (first.address || first.state) && resultFields[i] !== 'contacts { email }') {
        workingAddressField = resultFields[i];
        log(`  -> ${resultFields[i]} returned data; enumeration will use it`);
      }
    }
  }
  REPORT.workingAddressField = workingAddressField;

  // H — sibling keys on SearchFilter. If search can return seasons directly it
  // bypasses discoverCompetitions, which is the call we cannot use.
  for (const key of ['season', 'competition', 'team', 'venue', 'organisatio']) {
    await probe(`H-key-${key}`, `SearchFilter.${key} — valid key?`, {
      tenant: 'afl',
      operationName: 'search',
      query: SEARCH_QUERY_MIN,
      variables: { filter: { meta: { limit: 8, page: 1 }, [key]: { query: 'football' } } },
    });
  }

  // I — union members. An unknown fragment type produces a naming error.
  for (const type of ['Season', 'Competition', 'Team', 'Grade', 'Venue', 'Association']) {
    await probe(`I-union-${type}`, `results union member ${type}?`, {
      tenant: 'afl',
      operationName: 'search',
      query: searchDoc(`${ORG_FRAGMENT}\n      ... on ${type} { id name }`),
      variables: { filter: baseFilter(directoryFilter) },
    });
  }

  // J — if anything above enumerated, page it out and count.
  // Preference order, not run order. Array.find scans the probe list in the
  // order the probes ran, which is not the order we want to prefer them in.
  const usable = (p) =>
    p && p.kind === 'ok' && p.summary && p.summary.meta && p.summary.meta.totalRecords;
  let enumerating = null;
  for (const name of ['D-no-query-key', 'A2-directory-minimised', 'C-empty-query']) {
    const hit = REPORT.probes.find((p) => p.name === name);
    if (usable(hit)) {
      enumerating = hit;
      break;
    }
  }

  if (!enumerating) {
    log('\n[J] Skipped — no enumerating filter found in C/D/D2.');
    REPORT.enumeration = { attempted: false, reason: 'no enumerating filter succeeded' };
  } else {
    // The largest requested limit the server actually HONOURED, not the largest
    // count it happened to return. A limit of 500 that comes back with 12 rows
    // because there are only 12 records is honoured; one that comes back with 20
    // when 57 exist has been silently capped at 20.
    const bestLimit = REPORT.probes
      .filter((p) => p.name.startsWith('E-limit-') && p.kind === 'ok' && p.summary && p.summary.meta)
      .reduce((acc, p) => {
        const requested = p.variables.filter.meta.limit;
        const expected = Math.min(requested, p.summary.meta.totalRecords);
        const honoured = p.summary.returned === expected;
        log(`  limit ${requested}: returned ${p.summary.returned}, expected ${expected} — ${honoured ? 'honoured' : 'CAPPED'}`);
        return honoured ? Math.max(acc, requested) : acc;
      }, 8);

    const enumDoc = workingAddressField
      ? searchDoc(orgFragment(workingAddressField))
      : SEARCH_QUERY_MIN;
    log(`\n[J] Enumerating via ${enumerating.name} at limit ${bestLimit}...`);
    log(`  document includes address: ${workingAddressField || 'no — state grouping unavailable'}`);
    const orgFilter = enumerating.variables.filter.organisation;
    const seen = new Map();
    let page = 1;
    let totalPages = null;
    const MAX_PAGES = 40;

    while (page <= MAX_PAGES) {
      const r = await gql({
        tenant: 'afl',
        operationName: 'search',
        query: enumDoc,
        variables: { filter: { meta: { limit: bestLimit, page }, organisation: orgFilter } },
      });
      if (r.kind !== 'ok') {
        log(`  page ${page}: ${r.kind} — stopping`);
        break;
      }
      totalPages = r.meta && r.meta.totalPages;
      for (const o of r.results || []) if (o.id) seen.set(o.id, o);
      log(`  page ${page}/${totalPages} — ${(r.results || []).length} results, ${seen.size} distinct so far`);
      if (!totalPages || page >= totalPages) break;
      page++;
    }

    const stateOf = (o) => (o.address && o.address.state) || o.state || null;
    const byState = {};
    for (const o of seen.values()) {
      const s = stateOf(o) || '(none)';
      byState[s] = (byState[s] || 0) + 1;
    }

    REPORT.enumeration = {
      attempted: true,
      via: enumerating.name,
      limit: bestLimit,
      pagesRead: page,
      totalPages,
      cappedAtMaxPages: page > MAX_PAGES,
      distinctOrganisations: seen.size,
      byState,
      organisations: [...seen.values()].map((o) => ({
        id: o.id,
        routingCode: o.routingCode,
        name: o.name,
        type: o.type,
        state: stateOf(o),
      })),
    };
    log(`  distinct organisations: ${seen.size}`);
    log(`  by state: ${JSON.stringify(byState)}`);
    // A counter without examples cannot be checked.
    for (const o of [...seen.values()].slice(0, 20)) {
      log(`    ${o.type} ${o.routingCode} ${stateOf(o) || '--'} ${o.name}`);
    }
  }

  // -------------------------------------------------------------------------
  // L / M — the other half of the problem: organisation to seasons.
  // These use hardcoded EFNL identifiers so they run even if every search
  // probe above failed.
  // -------------------------------------------------------------------------

  const DISCOVER_ORG_FULL =
    'query discoverOrganisation($organisationCode: String!) {\n' +
    '  discoverOrganisation(code: $organisationCode) {\n' +
    '    id type name email contactNumber websiteUrl\n' +
    '    address { id line1 suburb postcode state country }\n' +
    '    contacts { id firstName lastName position email phone }\n' +
    '    shopVisible\n' +
    '  }\n' +
    '}\n';

  const DISCOVER_ORG_MIN =
    'query discoverOrganisation($organisationCode: String!) {\n' +
    '  discoverOrganisation(code: $organisationCode) {\n' +
    '    id type name address { suburb state postcode }\n' +
    '  }\n' +
    '}\n';

  // The website's shape: seasons takes an organisationID argument.
  const COMPS_WEBSITE =
    'query discoverCompetitions($organisationID: ID!) {\n' +
    '  discoverCompetitions(organisationID: $organisationID) {\n' +
    '    id name\n' +
    '    seasons(organisationID: $organisationID) {\n' +
    '      id name startDate endDate status { name value }\n' +
    '    }\n' +
    '    organisation { id name }\n' +
    '  }\n' +
    '}\n';

  // The shape documented in playhq_api_reference.md: bare seasons, no argument.
  const COMPS_REFERENCE =
    'query discoverCompetitions($organisationID: ID!) {\n' +
    '  discoverCompetitions(organisationID: $organisationID) {\n' +
    '    id name\n' +
    '    seasons { id name startDate endDate status { value } }\n' +
    '    organisation { id name }\n' +
    '  }\n' +
    '}\n';

  async function probeOp(name, description, req) {
    const result = await gql({ ...req, expect: null });
    REPORT.probes.push({
      name,
      description,
      tenant: req.tenant,
      variables: req.variables,
      kind: result.kind,
      status: result.status,
      note: result.note || null,
      errors: result.errors || null,
      data: result.data || null,
    });
    log(`\n[${name}] ${description}`);
    log(`  kind=${result.kind} status=${result.status}`);
    if (result.note) log(`  note: ${result.note}`);
    if (result.errors) for (const e of result.errors) log(`  error: ${e.message}`);
    if (result.data) log(`  data: ${JSON.stringify(result.data).slice(0, 600)}`);
    await sleep(500);
    return result;
  }

  await probeOp('L1-org-full', `discoverOrganisation(code: "${EFNL_CODE}"), full fragment`, {
    tenant: 'afl',
    operationName: 'discoverOrganisation',
    query: DISCOVER_ORG_FULL,
    variables: { organisationCode: EFNL_CODE },
  });

  await probeOp('L2-org-min', 'discoverOrganisation, address only', {
    tenant: 'afl',
    operationName: 'discoverOrganisation',
    query: DISCOVER_ORG_MIN,
    variables: { organisationCode: EFNL_CODE },
  });

  await probeOp('L3-org-uuid', 'discoverOrganisation with the full UUID as code', {
    tenant: 'afl',
    operationName: 'discoverOrganisation',
    query: DISCOVER_ORG_MIN,
    variables: { organisationCode: EFNL_UUID },
  });

  // M — the four-way split that separates the three candidate causes of the
  // documented failure: the id form, the seasons argument, or the session tier.
  // If the code form works and the UUID form does not, the reference's
  // "not usable from a guest session" is wrong and needs retracting.
  const mResults = {};
  mResults.M1 = await probeOp('M1-comps-code-witharg', 'Website shape, 8-character code', {
    tenant: 'afl',
    operationName: 'discoverCompetitions',
    query: COMPS_WEBSITE,
    variables: { organisationID: EFNL_CODE },
  });

  mResults.M2 = await probeOp('M2-comps-uuid-witharg', 'Website shape, full UUID', {
    tenant: 'afl',
    operationName: 'discoverCompetitions',
    query: COMPS_WEBSITE,
    variables: { organisationID: EFNL_UUID },
  });

  mResults.M3 = await probeOp('M3-comps-code-noarg', 'Reference shape (bare seasons), 8-character code', {
    tenant: 'afl',
    operationName: 'discoverCompetitions',
    query: COMPS_REFERENCE,
    variables: { organisationID: EFNL_CODE },
  });

  mResults.M4 = await probeOp('M4-comps-uuid-noarg', 'Reference shape (bare seasons), full UUID', {
    tenant: 'afl',
    operationName: 'discoverCompetitions',
    query: COMPS_REFERENCE,
    variables: { organisationID: EFNL_UUID },
  });

  // N — if any variant worked, check it against a value we already know rather
  // than against whether the output looks plausible.
  const working = Object.entries(mResults).find(
    ([, r]) => r.kind === 'ok' && r.data && Array.isArray(r.data.discoverCompetitions) && r.data.discoverCompetitions.length
  );

  if (!working) {
    log('\n[N] Skipped — no discoverCompetitions variant returned competitions.');
    REPORT.seasonDiscovery = { works: false };
  } else {
    const [label, r] = working;
    const comps = r.data.discoverCompetitions;
    const seasons = [];
    for (const c of comps) for (const s of c.seasons || []) seasons.push({ comp: c.name, ...s });

    const knownFound = seasons.some((s) => typeof s.id === 'string' && s.id.startsWith(KNOWN_EFNL_SEASON));

    log(`\n[N] ${label} worked. ${comps.length} competitions, ${seasons.length} seasons.`);
    for (const s of seasons) {
      log(`    ${s.comp} | ${s.name} | ${s.startDate} to ${s.endDate} | ${s.status && s.status.value} | ${s.id}`);
    }
    log(`  config.json EFNL 2026 season ${KNOWN_EFNL_SEASON} present: ${knownFound}`);
    if (!knownFound) {
      log('  WARNING: the known season id is absent. Do not trust this output until that is explained.');
    }

    REPORT.seasonDiscovery = {
      works: true,
      via: label,
      competitions: comps.length,
      seasons: seasons.length,
      knownSeasonPresent: knownFound,
      knownSeasonChecked: KNOWN_EFNL_SEASON,
      list: seasons,
    };
  }

  // -------------------------------------------------------------------------
  // P — does discoverTeams work for COMPLETED seasons?
  // The sweep found 89 organisations returning no clubs, most of them dormant.
  // discoverFixtureByRound is documented as active-seasons-only; if
  // discoverTeams shares that restriction, a per-season team registry cannot be
  // built for past years and the multi-season plan needs rethinking.
  // EFNL's three seasons are the test: one ACTIVE, two COMPLETED.
  // -------------------------------------------------------------------------

  const TEAMS_PROBE_QUERY =
    'query discoverTeamsBySeason($seasonId: ID!) {\n' +
    '  discoverTeams(filter: {seasonID: $seasonId}) {\n' +
    '    id name\n' +
    '    grade { id name }\n' +
    '    organisation { id name }\n' +
    '  }\n' +
    '}\n';

  const seasonsToTest = [
    { label: 'P1-2026-ACTIVE', id: '2dcbf383', note: 'EFNL 2026, status ACTIVE' },
    { label: 'P2-2025-COMPLETED', id: '75d8a232', note: 'EFNL 2025, status COMPLETED' },
    { label: 'P3-2024-COMPLETED', id: 'ca9cc98b', note: 'EFNL 2024, status COMPLETED' },
  ];

  REPORT.teamsBySeason = {};

  for (const s of seasonsToTest) {
    const r = await gql({
      tenant: 'afl',
      operationName: 'discoverTeamsBySeason',
      query: TEAMS_PROBE_QUERY,
      variables: { seasonId: s.id },
      expect: null,
    });

    const teams = (r.data && r.data.discoverTeams) || [];
    const orgIds = new Set();
    const idLengths = {};
    let withGrade = 0;

    for (const t of teams) {
      if (t.grade && t.grade.id) withGrade++;
      const oid = t.organisation && t.organisation.id;
      if (oid) {
        orgIds.add(oid);
        idLengths[String(oid).length] = (idLengths[String(oid).length] || 0) + 1;
      }
    }

    const rec = {
      seasonId: s.id,
      note: s.note,
      kind: r.kind,
      errors: r.errors || null,
      teams: teams.length,
      withGrade,
      distinctOrganisations: orgIds.size,
      organisationIdLengths: idLengths,
      sampleOrganisations: [...orgIds].slice(0, 3),
      sampleTeams: teams.slice(0, 3).map((t) => ({
        name: t.name,
        grade: t.grade && t.grade.name,
        org: t.organisation && t.organisation.name,
      })),
    };
    REPORT.teamsBySeason[s.label] = rec;

    log(`\n[${s.label}] ${s.note}`);
    log(`  kind=${r.kind} teams=${teams.length} withGrade=${withGrade} distinctOrgs=${orgIds.size}`);
    if (r.errors) for (const e of r.errors) log(`  error: ${e.message}`);
    log(`  organisation id lengths: ${JSON.stringify(idLengths)}`);
    for (const t of rec.sampleTeams) log(`    ${t.name} | ${t.grade} | ${t.org}`);
    await sleep(500);
  }

  // EFNL 2026 returning many organisations rather than one settles the standing
  // question of whether organisation on a team is the club or the league.
  const active = REPORT.teamsBySeason['P1-2026-ACTIVE'];
  if (active && active.distinctOrganisations > 1) {
    log(`\n>>> organisation on a team is the CLUB, not the league: ${active.distinctOrganisations} distinct organisations in one EFNL season.`);
  }

  // -------------------------------------------------------------------------
  // R — can historic player statistics be fetched at all?
  // The two-phase backfill in storage_ingestion_design.md §6.1 assumes both of
  // these work for a COMPLETED season. Neither has been verified, and the
  // reference already records other calls that degrade on completed seasons
  // (publicProfileTeams returns a null grade). Chains from the season id so it
  // needs nothing hardcoded beyond EFNL's seasons.
  // -------------------------------------------------------------------------

  const SEASON_GRADES_QUERY =
    'query gradeListDiscoverSeason($id: String!) {\n' +
    '  discoverSeason(seasonID: $id) {\n' +
    '    id name status { value }\n' +
    '    grades { id name age { name value } gender { name value } }\n' +
    '  }\n' +
    '}\n';

  const GRADE_STATS_QUERY =
    'query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {\n' +
    '  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {\n' +
    '    meta { page totalPages totalRecords }\n' +
    '    results { profile { id firstName lastName } team { name } statistics { count details { value } } }\n' +
    '  }\n' +
    '}\n';

  REPORT.historicStats = {};

  for (const s of seasonsToTest) {
    const rec = { seasonId: s.id, note: s.note };

    const gr = await gql({
      tenant: 'afl',
      operationName: 'gradeListDiscoverSeason',
      query: SEASON_GRADES_QUERY,
      variables: { id: s.id },
      expect: null,
    });

    const season = gr.data && gr.data.discoverSeason;
    const grades = (season && season.grades) || [];
    rec.discoverSeasonKind = gr.kind;
    rec.discoverSeasonErrors = gr.errors || null;
    rec.seasonStatus = season && season.status && season.status.value;
    rec.gradeCount = grades.length;

    log(`\n[R-${s.label}] discoverSeason grades for ${s.note}`);
    log(`  kind=${gr.kind} status=${rec.seasonStatus || '?'} grades=${grades.length}`);
    if (gr.errors) for (const e of gr.errors) log(`  error: ${e.message}`);

    // Only worth asking for player stats if a grade came back to ask about.
    if (grades.length) {
      const g = grades[0];
      rec.sampleGrade = { id: g.id, name: g.name };
      log(`  sample grade: ${g.name} (${g.id})`);

      const ps = await gql({
        tenant: 'afl',
        operationName: 'publicGradeStatistics',
        query: GRADE_STATS_QUERY,
        variables: { gradeID: g.id, filter: { pagination: { page: 1, limit: 50 } } },
        expect: null,
      });

      const gps = ps.data && ps.data.gradePlayerStatistics;
      rec.gradeStatsKind = ps.kind;
      rec.gradeStatsErrors = ps.errors || null;
      rec.gradeStatsMeta = (gps && gps.meta) || null;
      rec.gradeStatsReturned = (gps && gps.results ? gps.results.length : 0);
      rec.gradeStatsSample = (gps && gps.results ? gps.results : []).slice(0, 3).map((r) => ({
        name: r.profile ? `${r.profile.firstName} ${r.profile.lastName}` : '(private)',
        team: r.team && r.team.name,
      }));

      log(`  gradePlayerStatistics: kind=${ps.kind} meta=${JSON.stringify(rec.gradeStatsMeta)} returned=${rec.gradeStatsReturned}`);
      if (ps.errors) for (const e of ps.errors) log(`  error: ${e.message}`);
      for (const x of rec.gradeStatsSample) log(`    ${x.name} | ${x.team}`);
      await sleep(500);
    } else {
      log('  no grades returned — cannot ask for player statistics');
    }

    REPORT.historicStats[s.label] = rec;
    await sleep(500);
  }

  const hist = Object.values(REPORT.historicStats).filter((r) => /COMPLETED/.test(r.note));
  const gradesOk = hist.every((r) => r.gradeCount > 0);
  const statsOk = hist.every((r) => r.gradeStatsReturned > 0);
  log(`\n>>> Historic player statistics reachable: grades=${gradesOk} stats=${statsOk}`);
  if (!gradesOk || !statsOk) {
    log('>>> Phase B of the backfill is NOT possible as designed. Do not build it.');
  }
  REPORT.historicStatsUsable = { gradesOk, statsOk };

  REPORT.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(REPORT, null, 2));
  log(`\nReport written to ${REPORT_PATH}`);

  const kinds = {};
  for (const p of REPORT.probes) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  log(`Probe outcomes: ${JSON.stringify(kinds)}`);
  log(`\nEndpoints: search -> ${SEARCH_URL}, everything else -> ${API_URL}`);
  log(`search header shape that worked: ${REPORT.searchHeaderShape || 'none'}`);
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  REPORT.fatal = String(err && err.message ? err.message : err);
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(REPORT, null, 2));
  } catch {}
  process.exit(1);
});
