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
// ~10,000 AFL clubs at limit 500 is about 21 pages. Headroom, not a target.
const CLUB_MAX_PAGES = 60;
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

// Member clubs of a season. The organisation on a team is the club — verified
// by the 60-organisations-in-EFNL result, which could not be true if it were
// the league.
const TEAMS_QUERY =
  'query discoverTeamsBySeason($seasonId: ID!) {\n' +
  '  discoverTeams(filter: {seasonID: $seasonId}) {\n' +
  '    id\n' +
  '    organisation { id name }\n' +
  '  }\n' +
  '}\n';

// discoverOrganisation takes the 8-character code and returns null for a UUID.
const ORG_QUERY =
  'query discoverOrganisation($organisationCode: String!) {\n' +
  '  discoverOrganisation(code: $organisationCode) {\n' +
  '    id type name address { state }\n' +
  '  }\n' +
  '}\n';

// Ceiling on club lookups so a pathological run cannot exhaust the job timeout.
// If it is hit, the report says so rather than quietly returning less.
const CLUB_LOOKUP_BUDGET = 8000;

// A club-derived state below this share is recorded but NOT used. SANFL
// Interleague Games came back VIC on a 50/50 split, which is a coin toss
// dressed as an answer.
const INFER_MIN_SHARE = 0.6;

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

// Paged enumeration from search.playhq.com. `strict` throws on a failed page,
// which is right for associations because a partial list is a wrong answer.
// Clubs are a lookup table, so a partial one is still useful and truncation is
// recorded instead.
async function fetchAllOrgs(type, { strict, maxPages }) {
  const orgs = new Map();
  let page = 1;
  let totalPages = null;
  let totalRecords = null;
  let truncated = null;

  while (page <= maxPages) {
    const r = await gql(
      SEARCH_URL,
      {
        operationName: 'search',
        query: SEARCH_QUERY,
        variables: {
          filter: {
            meta: { page, limit: PAGE_LIMIT },
            organisation: { types: [type], tenantSlug: TENANT_SLUG },
          },
        },
      },
      false
    );

    if (r.kind !== 'ok') {
      if (strict) throw new Error(`${type} page ${page} failed: ${r.kind} ${r.note || ''}`);
      truncated = `page ${page} failed: ${r.kind} ${r.note || ''}`;
      break;
    }

    const s = r.data && r.data.search;
    if (!s) {
      if (strict) throw new Error(`${type} page ${page} returned no search node`);
      truncated = `page ${page} returned no search node`;
      break;
    }

    totalPages = s.meta && s.meta.totalPages;
    totalRecords = s.meta && s.meta.totalRecords;
    for (const o of s.results || []) if (o && o.routingCode) orgs.set(o.routingCode, o);
    log(`  ${type} page ${page}/${totalPages} — ${(s.results || []).length} results, ${orgs.size} distinct`);

    if (!totalPages || page >= totalPages) break;
    page++;
    await sleep(300);
  }

  if (page > maxPages && totalPages && page <= totalPages) {
    truncated = `stopped at maxPages ${maxPages} of ${totalPages}`;
  }

  // A wrong tenantSlug returns zero records with no error, so an empty result
  // is indistinguishable from a typo unless it is asserted against.
  if (strict && orgs.size === 0) {
    throw new Error('zero results returned — check tenantSlug before trusting this');
  }

  return { list: [...orgs.values()], totalPages, totalRecords, truncated };
}

async function fetchAllAssociations() {
  const r = await fetchAllOrgs('ASSOCIATION', { strict: true, maxPages: MAX_PAGES });
  return r.list;
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

// ---------------------------------------------------------------------------
// Location resolution for organisations with no address of their own.
// ---------------------------------------------------------------------------

// Built once from search.playhq.com, so the common case costs no request at all.
const clubIndex = new Map();
let clubIndexTruncated = null;

// Individual lookups are now the fallback, not the mechanism — used only for
// club codes the bulk index did not contain.
const clubCache = new Map();
let clubLookups = 0;

async function buildClubIndex() {
  const r = await fetchAllOrgs('CLUB', { strict: false, maxPages: CLUB_MAX_PAGES });
  for (const c of r.list) {
    clubIndex.set(c.routingCode, {
      name: c.name,
      stateRaw: (c.address && c.address.state) || null,
      state: normaliseState(c.address && c.address.state),
    });
  }
  clubIndexTruncated = r.truncated;
  // totalRecords is clamped at 10,000 on this host while totalPages is not, so
  // the two disagreeing is expected rather than a fault. Both are recorded.
  return { size: clubIndex.size, totalRecords: r.totalRecords, totalPages: r.totalPages, truncated: r.truncated };
}

// The cache holds the in-flight promise, not the settled value. Caching the
// value instead lets two concurrent workers both miss on the same code before
// either has finished, which measured out at roughly double the necessary
// requests.
function clubState(code) {
  const hit = clubIndex.get(code);
  if (hit) return Promise.resolve(hit);

  if (clubCache.has(code)) return clubCache.get(code);
  if (clubLookups >= CLUB_LOOKUP_BUDGET) return Promise.resolve({ budgetExhausted: true });

  clubLookups++;
  const p = (async () => {
    let r = await gql(API_URL, { operationName: 'discoverOrganisation', query: ORG_QUERY, variables: { organisationCode: code } }, true);
    if (r.kind === 'blocked') {
      await sleep(2000);
      await refreshSession();
      r = await gql(API_URL, { operationName: 'discoverOrganisation', query: ORG_QUERY, variables: { organisationCode: code } }, true);
    }
    if (r.kind !== 'ok') return { error: r.kind };
    const o = r.data && r.data.discoverOrganisation;
    // A null organisation is not an error and is not "no state" — it is a
    // lookup that did not resolve, and it is counted separately.
    return o
      ? { stateRaw: (o.address && o.address.state) || null, state: normaliseState(o.address && o.address.state), name: o.name }
      : { notFound: true };
  })();

  clubCache.set(code, p);
  return p;
}

// Prefer a season that is currently running, then one about to, then the most
// recently finished. A dormant organisation still has clubs worth resolving.
function pickSeason(seasons) {
  const byStatus = (v) => (seasons || []).filter((s) => s.status === v);
  const active = byStatus('ACTIVE');
  if (active.length) return active[0];
  const upcoming = byStatus('UPCOMING');
  if (upcoming.length) return upcoming[0];
  const done = (seasons || [])
    .filter((s) => typeof s.endDate === 'string')
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
  return done[0] || (seasons || [])[0] || null;
}

async function resolveFromClubs(rec) {
  const season = pickSeason(rec.seasons);
  if (!season) return { resolution: 'noSeason' };

  let r = await gql(API_URL, { operationName: 'discoverTeamsBySeason', query: TEAMS_QUERY, variables: { seasonId: season.id } }, true);
  if (r.kind === 'blocked') {
    await sleep(2000);
    await refreshSession();
    r = await gql(API_URL, { operationName: 'discoverTeamsBySeason', query: TEAMS_QUERY, variables: { seasonId: season.id } }, true);
  }
  if (r.kind !== 'ok') return { resolution: 'teamsFailed', errorKind: r.kind, seasonUsed: season.id };

  const teams = (r.data && r.data.discoverTeams) || [];
  const codes = new Set();
  for (const t of teams) {
    const id = t && t.organisation && t.organisation.id;
    // routingCode is the first eight hex characters of the UUID, so slicing is
    // safe whichever form the id arrives in.
    if (id) codes.add(String(id).slice(0, 8));
  }
  if (!codes.size) return { resolution: 'noClubs', seasonUsed: season.id, teams: teams.length };

  const tally = {};
  const clubList = [];
  let known = 0;
  let unknown = 0;
  let budgetHit = false;

  for (const code of codes) {
    const c = await clubState(code);
    if (c.budgetExhausted) {
      budgetHit = true;
      break;
    }
    clubList.push({ code, name: c.name || null, state: c.state || null, stateRaw: c.stateRaw || null });
    if (c.state) {
      tally[c.state] = (tally[c.state] || 0) + 1;
      known++;
    } else if (c.stateRaw) {
      tally['other:' + c.stateRaw] = (tally['other:' + c.stateRaw] || 0) + 1;
      known++;
    } else {
      unknown++;
    }
  }

  clubList.sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code)));

  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    return { resolution: 'clubsHadNoAddress', seasonUsed: season.id, clubs: codes.size, unknown, budgetHit, clubList };
  }

  return {
    resolution: 'resolved',
    seasonUsed: season.id,
    clubs: codes.size,
    clubsWithState: known,
    clubsWithoutState: unknown,
    // The full distribution is kept, not just the winner, so a 51/49 split is
    // visible rather than being reported as a clean answer.
    distribution: Object.fromEntries(ranked),
    inferredState: ranked[0][0],
    inferredShare: Number((ranked[0][1] / known).toFixed(3)),
    budgetHit,
    clubList,
  };
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

  // -------------------------------------------------------------------------
  // Phase 3 — resolve a state for every organisation with no address of its
  // own, from the addresses of its member clubs. Runs every sweep, so a newly
  // added organisation is classified without anyone looking at it.
  // Organisations with no seasons are skipped: they have no clubs to ask.
  // -------------------------------------------------------------------------

  // Every organisation with seasons, not only the unaddressed ones: the club
  // list is the evidence for checking a classification by hand, and it is worth
  // having for organisations whose own address we already trust.
  const needResolution = records.filter((r) => r.activity === 'active' || r.activity === 'dormant');

  let clubIndexStats = { size: 0 };
  if (needResolution.length) {
    log('\nbuilding club index from search.playhq.com...');
    clubIndexStats = await buildClubIndex();
    log(`  ${clubIndexStats.size} clubs indexed (totalRecords reported ${clubIndexStats.totalRecords}, totalPages ${clubIndexStats.totalPages})`);
    if (clubIndexStats.truncated) log(`  WARNING: club index truncated — ${clubIndexStats.truncated}`);
  }

  log(`fetching clubs for ${needResolution.length} organisations with seasons...`);

  let resolved = 0;
  await pool(needResolution, CONCURRENCY, async (rec) => {
    const res = await resolveFromClubs(rec);
    rec.clubResolution = res;
    rec.clubCount = typeof res.clubs === 'number' ? res.clubs : 0;
    if (res.resolution === 'resolved') {
      rec.inferredState = res.inferredState;
      rec.inferredShare = res.inferredShare;
      rec.inferredAmbiguous = res.inferredShare < INFER_MIN_SHARE;
    }
    resolved++;
    if (resolved % 50 === 0) log(`  ${resolved}/${needResolution.length} (${clubLookups} fallback lookups)`);
  });

  // effectiveState is what downstream code should read: the organisation's own
  // address where it has one, the club-derived value otherwise, null when
  // neither is available.
  for (const rec of records) {
    if (typeof rec.clubCount !== 'number') rec.clubCount = 0;
    // An address outside Australia is a KNOWN location, not an unknown one.
    // Folding it in with the addressless organisations overstated how much we
    // could not place.
    if (rec.state) {
      rec.effectiveState = rec.state;
      rec.stateSource = 'own';
    } else if (rec.stateRaw) {
      rec.effectiveState = 'other:' + rec.stateRaw;
      rec.stateSource = 'own-foreign';
    } else if (rec.inferredState && !rec.inferredAmbiguous) {
      rec.effectiveState = rec.inferredState;
      rec.stateSource = 'clubs';
    } else {
      rec.effectiveState = null;
      rec.stateSource = rec.inferredAmbiguous ? 'ambiguous' : 'none';
    }
  }

  const unresolved = records.filter((r) => !r.effectiveState);
  const unresolvedByActivity = {};
  const unresolvedReason = {};
  for (const r of unresolved) {
    unresolvedByActivity[r.activity] = (unresolvedByActivity[r.activity] || 0) + 1;
    const reason =
      r.stateSource === 'ambiguous'
        ? 'clubsDisagreed'
        : (r.clubResolution && r.clubResolution.resolution) || 'noSeasonsSoNotAttempted';
    unresolvedReason[reason] = (unresolvedReason[reason] || 0) + 1;
  }

  const resolutionCounts = {};
  for (const rec of needResolution) {
    const k = (rec.clubResolution && rec.clubResolution.resolution) || 'notAttempted';
    resolutionCounts[k] = (resolutionCounts[k] || 0) + 1;
  }

  const effectiveByState = {};
  for (const rec of records) {
    const k = rec.effectiveState || '(unresolved)';
    effectiveByState[k] = (effectiveByState[k] || 0) + 1;
  }

  // A low share means the clubs disagreed. Surfaced rather than buried, because
  // a 51/49 split is a different fact from a unanimous one.
  // Only disagreements that actually mattered. An organisation with its own
  // address is placed by that address, so its clubs disagreeing changes nothing
  // and reporting it as a problem is noise.
  const lowConfidence = records
    .filter((r) => r.stateSource === 'ambiguous')
    .map((r) => `${r.code} ${r.name} -> ${r.inferredState} ${Math.round(r.inferredShare * 100)}%`);

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
    clubResolution: {
      attempted: needResolution.length,
      outcomes: resolutionCounts,
      clubIndexSize: clubIndexStats.size,
      clubIndexTotalRecords: clubIndexStats.totalRecords || null,
      clubIndexTruncated: clubIndexTruncated || null,
      fallbackLookups: clubLookups,
      budgetExhausted: clubLookups >= CLUB_LOOKUP_BUDGET,
      lowConfidence,
    },
    effectiveByState,
    effectiveVicActive: records.filter((r) => r.effectiveState === 'VIC' && r.activity === 'active').length,
    unresolved: {
      total: unresolved.length,
      byActivity: unresolvedByActivity,
      byReason: unresolvedReason,
      examples: sample(unresolved.filter((r) => r.activity === 'active'), 15),
    },
  };

  log('\n--- summary ---');
  log(`organisations: ${records.length}`);
  log(`with address:    ${JSON.stringify(crosstab.hasAddress)}`);
  log(`without address: ${JSON.stringify(crosstab.noAddress)}`);
  log(`season status values seen: ${JSON.stringify(statusCounts)}`);
  log(`club resolution: ${JSON.stringify(resolutionCounts)}`);
  log(`club index: ${clubIndexStats.size} clubs, ${clubLookups} individual fallback lookups`);
  if (clubLookups >= CLUB_LOOKUP_BUDGET) log('WARNING: club lookup budget exhausted — resolution is incomplete');
  log(`VIC by own address, active: ${summary.counts.vicActive}`);
  log(`VIC by own address or clubs, active: ${summary.effectiveVicActive}`);
  log(`UNRESOLVED location: ${unresolved.length} of ${records.length}`);
  log(`  by activity: ${JSON.stringify(unresolvedByActivity)}`);
  log(`  by reason:   ${JSON.stringify(unresolvedReason)}`);
  if (lowConfidence.length) {
    log(`clubs disagreed on ${lowConfidence.length} organisations:`);
    for (const l of lowConfidence.slice(0, 10)) log(`  ${l}`);
  }
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
