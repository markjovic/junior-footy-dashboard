#!/usr/bin/env node
// scripts/probe-api-session.js
//
// READ-ONLY PROBE. Writes nothing, commits nothing, pushes nothing.
//
// Three questions, as a controlled comparison rather than a guess.
//
// 1. IS OUR SESSION INCOMPLETE?
//    Every AFL script builds its cookie with
//        raw.match(/phq_session=([^;]+)/)
//    and sends that one cookie. playhq_api_reference.md, written from the
//    basketball system, states PlayHQ issues THREE and that the order matters:
//        phq_tier=cookie-no-jwt; phq_session=<jwt>; phq_sub=<sub>
//    with "Wrong order causes CloudFront 403s".
//
//    discoverCompetitions has failed on every attempt from our scripts —
//    46 consecutive calls returning "There was an error. Please try again
//    later." — while working from a browser. That is a server error, not a
//    validation error, which is what an incomplete session looks like.
//
//    Stage 1 runs the same query with the one-cookie session and again with the
//    full three-cookie session, so the difference is attributable.
//
// 2. DOES operationName MATTER?
//    Our gqlPost sends only { query, variables }. The reference's examples and
//    the live playhq.com calls both send operationName. Tested separately so it
//    is not confounded with the cookie change.
//
// 3. CAN WE GET EVERY REGISTERED TEAM IN ONE CALL?
//    discoverTeams(filter:{seasonID, organisationID}) is how the site uses it.
//    If organisationID is optional, one call per season returns every
//    registered team WITH its grade — which would give both a registration
//    flag and an authoritative grade, removing the need to derive grades from
//    names in parseGradeName.
//
// Usage:
//   node scripts/probe-api-session.js
//   node scripts/probe-api-session.js --comp="EFNL 2026"

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT        = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const API_URL    = 'https://api.playhq.com/graphql';
const USER_AGENT = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A club known to exist, used as the discoverCompetitions subject.
const TEST_ORG      = process.env.TEST_ORG || '6d405ccb';       // Norwood
const TEST_ORG_NAME = 'Norwood';

function parseArgs(argv) {
  const opts = { comp: null };
  for (const a of argv) {
    const eq = a.indexOf('='), k = eq === -1 ? a : a.slice(0, eq), v = eq === -1 ? '' : a.slice(eq + 1);
    if (k === '--comp') opts.comp = v.trim() || null;
    else if (k.startsWith('--')) { console.error(`Unknown argument: ${k}`); process.exit(1); }
  }
  return opts;
}
const OPTS = parseArgs(process.argv.slice(2));

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function post(bodyObj, cookie) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'accept':         '*/*',
        'origin':         'https://www.playhq.com',
        'user-agent':     USER_AGENT,
        'tenant':         'afl',
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(body),
        'request-id':     crypto.randomUUID(),
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      timeout: 60000,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: data.slice(0, 300), setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// The session our scripts build today: phq_session only.
async function sessionCurrent() {
  const r = await post({ operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }' }, '');
  const raw = (r.setCookie || []).join(';');
  const m = raw.match(/phq_session=([^;]+)/);
  return { cookie: m ? `phq_session=${m[1]}` : '', names: m ? ['phq_session'] : [] };
}

// The session the reference describes: all three, in order, with retries and a
// second query shape because PlayHQ intermittently returns no Set-Cookie.
async function sessionFull() {
  const queries = [
    { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch', variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  ];
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 1500);
    for (const q of queries) {
      let r;
      try { r = await post(q, ''); } catch { continue; }
      const raw = (r.setCookie || []).join(',');
      if (!raw) continue;
      const parts = raw.split(',').map(c => c.trim().split(';')[0]);
      const get = n => parts.find(p => p.startsWith(n + '='));
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      const have = [tier && 'phq_tier', session && 'phq_session', sub && 'phq_sub'].filter(Boolean);
      // Order is load-bearing per the reference; build it explicitly.
      const cookie = [tier, session, sub].filter(Boolean).join('; ');
      if (session) return { cookie, names: have, attempt };
    }
  }
  return { cookie: '', names: [] };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_COMPS = `
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id name
    seasons { id name startDate endDate status { value } }
  }
}`;

// The full document shape the website sends: both queries, both variables.
const Q_COMPS_FULL = `
query discoverCompetitions($organisationID: ID!, $organisationCode: String!) {
  discoverCompetitions(organisationID: $organisationID) {
    id name
    seasons { id name startDate endDate status { value } }
    organisation { id name }
  }
  discoverOrganisation(code: $organisationCode) { id type name }
}`;

const Q_TEAMS_SEASON = `
query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id name gender { value } ageGroup { value }
    grade { id name }
    organisation { id name }
  }
}`;

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
const verdict = r => {
  if (!r) return 'no response';
  if (r.body?.errors?.length) return `ERROR: ${r.body.errors.map(e => e.message).join('; ').slice(0, 90)}`;
  if (r.status !== 200) return `HTTP ${r.status}`;
  return 'OK';
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('probe-api-session.js — READ-ONLY. Nothing is written.\n');

  console.log('='.repeat(78));
  console.log('STAGE 1 — SESSION COOKIES');
  console.log('='.repeat(78));

  const cur = await sessionCurrent();
  console.log(`  current method : ${cur.names.length ? cur.names.join(', ') : 'none'}`);
  const full = await sessionFull();
  console.log(`  full method    : ${full.names.length ? full.names.join(', ') : 'none'}${full.attempt > 1 ? `  (attempt ${full.attempt})` : ''}`);
  if (full.names.length > cur.names.length) {
    console.log(`\n  >>> PlayHQ issues ${full.names.length} cookie(s); our scripts send ${cur.names.length}.`);
  } else if (full.names.length === cur.names.length) {
    console.log('\n  >>> Both methods yield the same cookies. The session is not the difference.');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`STAGE 2 — discoverCompetitions (organisation ${TEST_ORG}, ${TEST_ORG_NAME})`);
  console.log('='.repeat(78));
  console.log('  Same query, four variations. Any that says OK is the fix.\n');

  const trials = [
    ['one cookie, no operationName',   { query: Q_COMPS, variables: { organisationID: TEST_ORG } }, cur.cookie],
    ['one cookie, with operationName', { operationName: 'discoverCompetitions', query: Q_COMPS, variables: { organisationID: TEST_ORG } }, cur.cookie],
    ['full cookies, no operationName', { query: Q_COMPS, variables: { organisationID: TEST_ORG } }, full.cookie],
    ['full cookies, with operationName', { operationName: 'discoverCompetitions', query: Q_COMPS, variables: { organisationID: TEST_ORG } }, full.cookie],
    ['full cookies, full document (as the website sends it)',
      { operationName: 'discoverCompetitions', query: Q_COMPS_FULL,
        variables: { organisationID: TEST_ORG, organisationCode: TEST_ORG } }, full.cookie],
  ];

  let winner = null;
  for (const [label, body, cookie] of trials) {
    let r;
    try { r = await post(body, cookie); } catch (e) { console.log(`  ${pad(label, 52)} request failed: ${e.message}`); continue; }
    await sleep(400);
    const v = verdict(r);
    const n = r.body?.data?.discoverCompetitions?.length;
    console.log(`  ${pad(label, 52)} ${v}${n !== undefined ? `  (${n} competition(s))` : ''}`);
    if (v === 'OK' && !winner) winner = { label, body, cookie, res: r };
  }

  if (winner) {
    console.log(`\n  >>> WORKS: ${winner.label}`);
    for (const c of (winner.res.body?.data?.discoverCompetitions || [])) {
      console.log(`      ${c.name}`);
      for (const s of (c.seasons || [])) {
        console.log(`        ${pad(s.name, 8)} ${pad(s.id, 10)} ${pad(s.status?.value || '?', 10)} ${s.startDate} -> ${s.endDate}`);
      }
    }
  } else {
    console.log('\n  >>> None worked. The session is not the cause; something else gates this query.');
  }

  console.log('\n' + '='.repeat(78));
  console.log('STAGE 3 — discoverTeams WITHOUT an organisation');
  console.log('='.repeat(78));
  console.log('  If a season alone is enough, one call returns every registered team');
  console.log('  with its authoritative grade.\n');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  let comps = config.competitions || [];
  if (OPTS.comp) comps = comps.filter(c => c.name.toLowerCase().includes(OPTS.comp.toLowerCase()));
  const cookie = full.cookie || cur.cookie;

  for (const comp of comps) {
    let r;
    try { r = await post({ operationName: 'discoverTeamsBySeason', query: Q_TEAMS_SEASON, variables: { seasonId: comp.seasonID } }, cookie); }
    catch (e) { console.log(`  ${pad(comp.name, 14)} request failed: ${e.message}`); continue; }
    await sleep(400);
    const v = verdict(r);
    const teams = r.body?.data?.discoverTeams || [];
    console.log(`  ${pad(comp.name, 14)} ${pad(v, 46)} ${teams.length ? teams.length + ' team(s)' : ''}`);
    if (v === 'OK' && teams.length) {
      const graded = teams.filter(t => t.grade?.name).length;
      const orgs   = new Set(teams.map(t => t.organisation?.id).filter(Boolean));
      console.log(`      ${graded} with a grade, ${teams.length - graded} without; ${orgs.size} organisation(s)`);
      console.log('      sample:');
      teams.slice(0, 5).forEach(t =>
        console.log(`        ${pad(t.name, 34)} ${pad(t.grade?.name || '(none)', 32)} ${t.organisation?.name || ''}`));
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('CONCLUSION');
  console.log('='.repeat(78));
  console.log(winner
    ? `discoverCompetitions works with: ${winner.label}. Apply that to every script.`
    : 'discoverCompetitions still fails. Do not build the multi-season work on it.');
  console.log('\nProbe complete. Nothing was written.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
