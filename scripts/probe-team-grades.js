#!/usr/bin/env node
// scripts/probe-team-grades.js
//
// READ-ONLY PROBE. Writes nothing, commits nothing, pushes nothing.
//
// WHY THIS EXISTS
// Earlier probes all went grade -> teams: pick a grade, sample a round or two,
// list who played. That answers the wrong question and produced two wrong
// conclusions in a row, because a sample of the first rounds is not the grade.
//
// This goes the other way. Take the teams a stored key ACTUALLY contains, and
// ask PlayHQ which grades and which competitions each of them is registered in.
// If a team's real grade is not the key it is stored under, that is a defect in
// our data. If PlayHQ says the team genuinely is in that grade, our data is
// right and the grade is simply broader than expected.
//
// The chain, per team:
//   stored logo URL  -> organisation code   (first 8 hex of the Cloudinary UUID)
//   discoverOrganisation(code)              -> club name and type
//   discoverTeams(seasonID, organisationID) -> that club's teams IN THIS SEASON,
//                                              each with grade { id name }
//   discoverCompetitions(organisationID)    -> every competition and season the
//                                              club plays in, which shows whether
//                                              it belongs to this league at all
//
// discoverTeams is season-scoped: a club registered under another league's
// season returns nothing here, which is itself the answer.
//
// Usage:
//   node scripts/probe-team-grades.js --key="EFNL 2026|U18 Girls|Grading"
//   node scripts/probe-team-grades.js --teams="Pearcedale Baxter JFC Girls,Fitzroy Youth Girls"
//   node scripts/probe-team-grades.js --key="..." --limit=12 --comps

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT        = path.resolve(__dirname, '..');
const DATA_PATH   = path.join(ROOT, 'data', 'data.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '250', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { key: null, teams: null, limit: 50, comps: false };
  const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const k   = eq === -1 ? arg : arg.slice(0, eq);
    const v   = eq === -1 ? '' : arg.slice(eq + 1);
    switch (k) {
      case '--key':   opts.key   = v.trim() || null; break;
      case '--teams': opts.teams = v.split(',').map(x => x.trim()).filter(Boolean); break;
      case '--limit': opts.limit = Math.max(1, intOr(v, 50)); break;
      case '--comps': opts.comps = true; break;
      default:
        if (k.startsWith('--')) { console.error(`Unknown argument: ${k}`); process.exit(1); }
    }
  }
  return opts;
}
const OPTS = parseArgs(process.argv.slice(2));

// ─── HTTP (copied from fetch-results.js) ──────────────────────────────────────

let SESSION_COOKIE = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function gqlPost(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     USER_AGENT,
        'Accept':         'application/json',
        'tenant':         'afl',
        'origin':         'https://www.playhq.com',
        'request-id':     crypto.randomUUID(),
        ...(SESSION_COOKIE ? { 'Cookie': SESSION_COOKIE } : {}),
      },
      timeout: 60000,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try { return resolve(JSON.parse(data)); }
          catch { return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)); }
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function getSession() {
  const body = JSON.stringify({
    operationName: 'TenantConfig', variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  });
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await sleep(attempt * 2000);
    const raw = await new Promise(resolve => {
      const req = https.request(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'User-Agent': USER_AGENT, 'Accept': 'application/json',
          'tenant': 'afl', 'origin': 'https://www.playhq.com',
          'request-id': crypto.randomUUID(),
        }, timeout: 30000,
      }, res => { resolve(res.headers['set-cookie']?.join(';') || ''); res.resume(); });
      req.on('error', () => resolve(''));
      req.write(body); req.end();
    });
    const m = raw.match(/phq_session=([^;]+)/);
    if (m) { SESSION_COOKIE = `phq_session=${m[1]}`; console.log('Session cookie obtained'); return; }
  }
  console.warn('Could not obtain session cookie — proceeding without');
}

// ─── Queries (argument shapes copied from the live playhq.com calls) ──────────

const Q_ORG = `
query discoverOrganisation($organisationCode: String!) {
  discoverOrganisation(code: $organisationCode) { id type name }
}`;

const Q_ORG_TEAMS = `
query discoverOrganisationTeams($seasonId: ID!, $organisationId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId, organisationID: $organisationId}) {
    id name gender { value } ageGroup { value } grade { id name }
  }
}`;

const Q_ORG_COMPS = `
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id name
    seasons { id name status { value } }
    organisation { id name }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };

// First 8 hex characters of the Cloudinary UUID are the public organisation code.
function clubIdFromLogo(url) {
  const m = String(url || '').match(/\/production\/[a-z]+\/([0-9a-f]{8})-[0-9a-f-]+\//i);
  return m ? m[1].toLowerCase() : '';
}

function readJson(p, label) {
  if (!fs.existsSync(p)) { console.error(`${label} not found at ${p}`); process.exit(1); }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`Could not parse ${label}: ${e.message}`); process.exit(1); }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('probe-team-grades.js — READ-ONLY. Nothing is written.');
  console.log(`Options: ${JSON.stringify(OPTS)}\n`);

  if (!OPTS.key && !OPTS.teams) {
    console.error('Give --key="Comp|Age|Grade" or --teams="A,B,C".');
    process.exit(1);
  }

  const config = readJson(CONFIG_PATH, 'config.json');
  const data   = readJson(DATA_PATH, 'data.json');
  const seasonByComp = new Map((config.competitions || []).map(c => [c.name, c.seasonID]));
  const matches = (data.matches || []).filter(m => !m.isBye && !m.isPartial);

  // Which teams, and which competition are we asking about.
  let comp, wanted = new Set();
  if (OPTS.key) {
    const [c, a, g] = OPTS.key.split('|');
    comp = c;
    for (const m of matches) {
      if (m.compName !== c || m.age !== a || (m.rawGrade || '') !== (g || '')) continue;
      for (const t of [m.home, m.away]) if (t && !t.startsWith('__')) wanted.add(t);
    }
    console.log(`Key "${OPTS.key}" holds ${wanted.size} distinct team(s).`);
  } else {
    comp = (config.competitions || [])[0]?.name;
    OPTS.teams.forEach(t => wanted.add(t));
    console.log(`Looking up ${wanted.size} named team(s) against ${comp}.`);
  }

  const seasonID = seasonByComp.get(comp);
  if (!seasonID) { console.error(`No seasonID in config.json for "${comp}".`); process.exit(1); }
  console.log(`Competition: ${comp}   seasonID: ${seasonID}\n`);

  // Resolve each team's organisation from any stored logo.
  const logoOf = new Map();
  for (const m of matches) {
    if (m.compName !== comp) continue;
    if (m.home && m.hLogo && !logoOf.has(m.home)) logoOf.set(m.home, m.hLogo);
    if (m.away && m.aLogo && !logoOf.has(m.away)) logoOf.set(m.away, m.aLogo);
  }

  const teams = [...wanted].sort().slice(0, OPTS.limit);
  const orgOf = new Map(); // org code -> { name, type, teams:[] }
  for (const t of teams) {
    const id = clubIdFromLogo(logoOf.get(t));
    if (!id) { console.log(`  ${pad(t, 38)} no logo stored — cannot resolve organisation`); continue; }
    if (!orgOf.has(id)) orgOf.set(id, { name: '', type: '', teams: [] });
    orgOf.get(id).teams.push(t);
  }
  console.log(`${teams.length} team(s) map to ${orgOf.size} organisation(s).\n`);

  await getSession();

  // ── Resolve organisations and their registered teams in THIS season ──
  console.log('='.repeat(78));
  console.log(`WHICH GRADES ARE THESE TEAMS ACTUALLY REGISTERED IN? (${comp})`);
  console.log('='.repeat(78));

  const notInSeason = [];
  for (const [code, info] of orgOf) {
    let org;
    try { org = await gqlPost(Q_ORG, { organisationCode: code }); await sleep(FETCH_DELAY); }
    catch (e) { console.log(`\n${code}: organisation lookup failed — ${e.message}`); continue; }
    const o = org?.data?.discoverOrganisation;
    info.name = o?.name || '(unresolved)';
    info.type = o?.type || '?';

    let res;
    try { res = await gqlPost(Q_ORG_TEAMS, { seasonId: seasonID, organisationId: code }); await sleep(FETCH_DELAY); }
    catch (e) { console.log(`\n${info.name}: discoverTeams failed — ${e.message}`); continue; }
    if (res?.errors?.length) {
      console.log(`\n${info.name}: GraphQL ${res.errors.map(e => e.message).join('; ').slice(0, 140)}`);
      continue;
    }
    const registered = res?.data?.discoverTeams || [];

    console.log(`\n${info.name}  [${code}]  type=${info.type}`);
    console.log(`  stored under this key: ${info.teams.join(', ')}`);
    if (!registered.length) {
      console.log(`  *** NOT REGISTERED in ${comp}'s season at all.`);
      console.log(`      discoverTeams returns nothing, so this club participates via another`);
      console.log(`      league's season. Our data has it under ${comp} because that is the`);
      console.log(`      season whose fixtures we crawled.`);
      notInSeason.push(info.name);
      continue;
    }
    console.log(`  registered in ${comp}: ${registered.length} team(s)`);
    for (const t of registered) {
      console.log(`      ${pad(t.name, 40)} ${t.grade?.name || '(no grade)'}`);
    }
  }

  // ── Optional: what competitions do these clubs actually belong to ──
  if (OPTS.comps) {
    console.log('\n' + '='.repeat(78));
    console.log('WHAT COMPETITIONS DO THESE CLUBS BELONG TO?');
    console.log('='.repeat(78));
    for (const [code, info] of orgOf) {
      let res;
      try { res = await gqlPost(Q_ORG_COMPS, { organisationID: code }); await sleep(FETCH_DELAY); }
      catch (e) { console.log(`\n${info.name}: failed — ${e.message}`); continue; }
      if (res?.errors?.length) {
        console.log(`\n${info.name}: GraphQL ${res.errors.map(e => e.message).join('; ').slice(0, 120)}`);
        continue;
      }
      const comps = res?.data?.discoverCompetitions || [];
      console.log(`\n${info.name}  [${code}]`);
      for (const c of comps) {
        const active = (c.seasons || []).filter(x => x.status?.value === 'ACTIVE').map(x => x.name).join(', ');
        console.log(`  ${pad(c.name, 46)} ${active ? 'active: ' + active : ''}`);
      }
      if (!comps.length) console.log('  (none returned)');
    }
  }

  // ── Conclusion ──
  console.log('\n' + '='.repeat(78));
  console.log('CONCLUSION');
  console.log('='.repeat(78));
  if (notInSeason.length) {
    console.log(`${notInSeason.length} of ${orgOf.size} club(s) are NOT registered in ${comp}'s season:`);
    notInSeason.forEach(n => console.log(`  ${n}`));
    console.log('\nTheir games are still returned by this season\'s fixtures, so the grade is');
    console.log('genuinely shared across leagues rather than our data being wrong.');
  } else {
    console.log(`All ${orgOf.size} club(s) are registered in ${comp}'s season. Compare the grade`);
    console.log('names above against the key these teams are stored under — a mismatch there');
    console.log('would be a defect in parseGradeName, not in the competition structure.');
  }
  console.log('\nProbe complete. Nothing was written.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
