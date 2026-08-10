#!/usr/bin/env node
// scripts/probe-club-index.js
//
// READ-ONLY PROBE. Writes nothing, commits nothing, pushes nothing.
//
// PlayHQ has a first-class club, but DiscoverTeam does not expose it — proven
// on 2026-08-09: "Cannot query field \"club\" on type \"DiscoverTeam\"".
// Introspection is disabled, so the schema cannot be read directly.
//
// Two routes to a club exist instead:
//   discoverOrganisation(code)                          -> id, type:"CLUB", name
//   discoverTeams(filter:{seasonID, organisationID})    -> that club's teams
//
// Both need a club id, and we have no list of them. This probe tests the
// hypothesis that we already store one: PlayHQ logo URLs look like
//   /production/afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/1696902165682/logo.png
// where the first 8 hex characters match Norwood's organisation code 6d405ccb.
// If team logos are club logos, then every match record in data.json has
// carried its club id all along and no re-crawl is needed.
//
// That is a hypothesis drawn from two samples. It is not assumed anywhere here
// — it is tested, and the probe reports how often it holds.
//
// Stages:
//   1. Derive club-id candidates from the logo URLs already in data.json.
//   2. Validate each candidate against discoverOrganisation. A real club
//      returns type "CLUB". A wrong guess returns nothing.
//   3. Cross-check: ask each club for its teams and see whether our stored
//      team names appear. This is the test that matters, because it is what
//      grouping would rely on.
//   4. Reconnaissance for the multi-season work: discoverCompetitions on a
//      club id lists every season it has played, with dates and status.
//      Not part of the finals change — gathered because it is one call.
//
// Usage:
//   node scripts/probe-club-index.js
//   node scripts/probe-club-index.js --comp="EFNL 2026" --limit=12
//   node scripts/probe-club-index.js --club=6d405ccb

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT        = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH   = path.join(ROOT, 'data.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '250', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { comp: null, club: null, limit: 10, seasons: 2 };
  const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--comp':    opts.comp    = val.trim() || null; break;
      case '--club':    opts.club    = val.trim() || null; break;
      case '--limit':   opts.limit   = Math.max(1, intOr(val, 10)); break;
      case '--seasons': opts.seasons = Math.max(0, intOr(val, 2)); break;
      default:
        if (key.startsWith('--')) { console.error(`Unknown argument: ${key}`); process.exit(1); }
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
        // A GraphQL validation error arrives as HTTP 400 with a useful body.
        // Resolve rather than reject so the caller can read it.
        if (res.statusCode !== 200) {
          try { return resolve(JSON.parse(data)); }
          catch { return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`)); }
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
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  });
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await sleep(attempt * 2000);
    const raw = await new Promise(resolve => {
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
        },
        timeout: 30000,
      }, res => { resolve(res.headers['set-cookie']?.join(';') || ''); res.resume(); });
      req.on('error', () => resolve(''));
      req.write(body);
      req.end();
    });
    const m = raw.match(/phq_session=([^;]+)/);
    if (m) { SESSION_COOKIE = `phq_session=${m[1]}`; console.log('Session cookie obtained'); return; }
  }
  console.warn('Could not obtain session cookie — proceeding without');
}

// ─── Queries ──────────────────────────────────────────────────────────────────
// Argument names and shapes copied from the live playhq.com calls
// (discoverOrganisationTeams / discoverCompetitions), not written from scratch.

const Q_ORG = `
query discoverOrganisation($organisationCode: String!) {
  discoverOrganisation(code: $organisationCode) {
    id
    type
    name
  }
}`;

const Q_ORG_TEAMS = `
query discoverOrganisationTeams($seasonId: ID!, $organisationId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId, organisationID: $organisationId}) {
    id
    name
    gender { value }
    ageGroup { value }
    grade { id name }
  }
}`;

const Q_ORG_COMPS = `
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons {
      id
      name
      startDate
      endDate
      status { value }
    }
    organisation { id name }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };

// Copied verbatim from fetch-results.js so stored names and PlayHQ names are
// compared the same way the pipeline would compare them.
function cleanTeam(name, gradeAge) {
  if (gradeAge) {
    const ageNum = gradeAge.match(/^(U\d+(?:\.\d+)?)/i)?.[1];
    if (ageNum) {
      return name.replace(new RegExp('\\s+' + ageNum.replace('.','\\.') + '\\b\\s*', 'gi'), ' ').replace(/\s+$/,'').trim();
    }
  }
  return name.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/,'').trim();
}

// The hypothesis under test: PlayHQ Cloudinary paths embed the owning
// organisation's UUID, whose first 8 characters are the public org code.
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
  console.log('probe-club-index.js — READ-ONLY. Nothing is written or committed.');
  console.log(`Options: ${JSON.stringify(OPTS)}`);

  const config = readJson(CONFIG_PATH, 'config.json');
  const data   = readJson(DATA_PATH, 'data.json');
  const seasonByComp = new Map((config.competitions || []).map(c => [c.name, c.seasonID]));

  // ── Stage 1 ──
  console.log('\n' + '='.repeat(78));
  console.log('STAGE 1 — CLUB IDS DERIVED FROM STORED LOGO URLS');
  console.log('='.repeat(78));

  // compName -> clubId -> Set(teamName);  plus teams whose logo gave nothing.
  const byComp   = new Map();
  const noLogo   = new Map(); // compName -> Set(teamName)
  let teamSeen   = 0;

  for (const m of (data.matches || [])) {
    if (m.isBye || m.isPartial) continue;
    const comp = m.compName || '';
    if (OPTS.comp && !comp.toLowerCase().includes(OPTS.comp.toLowerCase())) continue;
    for (const [name, logo] of [[m.home, m.hLogo], [m.away, m.aLogo]]) {
      if (!name || name.startsWith('__')) continue;
      const id = clubIdFromLogo(logo);
      if (!byComp.has(comp)) byComp.set(comp, new Map());
      if (!id) {
        if (!noLogo.has(comp)) noLogo.set(comp, new Set());
        // Only count as missing if no other record gave this team a logo.
        noLogo.get(comp).add(name);
        continue;
      }
      const clubs = byComp.get(comp);
      if (!clubs.has(id)) clubs.set(id, new Set());
      clubs.get(id).add(name);
    }
  }
  // A team with at least one logo anywhere is not missing.
  for (const [comp, clubs] of byComp) {
    const withLogo = new Set();
    for (const teams of clubs.values()) for (const t of teams) withLogo.add(t);
    const miss = noLogo.get(comp);
    if (miss) for (const t of [...miss]) if (withLogo.has(t)) miss.delete(t);
  }

  for (const [comp, clubs] of byComp) {
    let teams = 0;
    for (const s of clubs.values()) teams += s.size;
    teamSeen += teams;
    const miss = noLogo.get(comp)?.size || 0;
    console.log(`  ${pad(comp, 14)} ${pad(clubs.size + ' club id(s)', 18)} ${teams} team(s) mapped, ${miss} without a logo`);
  }
  if (!teamSeen) { console.log('  No teams found — check --comp.'); return; }

  await getSession();

  // ── Stage 2 ──
  console.log('\n' + '='.repeat(78));
  console.log('STAGE 2 — DO THOSE IDS RESOLVE AS REAL CLUBS?');
  console.log('='.repeat(78));

  const allIds = new Set();
  for (const clubs of byComp.values()) for (const id of clubs.keys()) allIds.add(id);
  let candidates = [...allIds].sort();
  if (OPTS.club) candidates = candidates.filter(c => c === OPTS.club.toLowerCase());
  const probeIds = candidates.slice(0, OPTS.limit);
  console.log(`${allIds.size} distinct candidate id(s); validating ${probeIds.length}.\n`);

  const orgs = new Map(); // id -> { type, name }
  let confirmed = 0, rejected = 0;
  for (const id of probeIds) {
    let res;
    try {
      res = await gqlPost(Q_ORG, { organisationCode: id });
      await sleep(FETCH_DELAY);
    } catch (e) {
      console.log(`  ${pad(id, 10)} request failed: ${e.message}`);
      continue;
    }
    if (res?.errors?.length) {
      console.log(`  ${pad(id, 10)} GraphQL error: ${res.errors.map(e => e.message).join('; ').slice(0, 120)}`);
      rejected++;
      continue;
    }
    const o = res?.data?.discoverOrganisation;
    if (!o) { console.log(`  ${pad(id, 10)} no organisation returned — candidate is wrong`); rejected++; continue; }
    orgs.set(id, { type: o.type, name: o.name });
    if (o.type === 'CLUB') confirmed++;
    console.log(`  ${pad(id, 10)} ${pad(o.type || '?', 8)} ${o.name || ''}`);
  }
  console.log(`\n${confirmed} confirmed as CLUB, ${rejected} did not resolve, out of ${probeIds.length} tried.`);

  // ── Stage 3 ──
  console.log('\n' + '='.repeat(78));
  console.log('STAGE 3 — DO OUR STORED TEAM NAMES MATCH THE CLUB\'S OWN TEAM LIST?');
  console.log('='.repeat(78));
  console.log('This is the test that matters: grouping would rely on it.\n');

  let totalOurs = 0, totalMatched = 0;
  for (const [comp, clubs] of byComp) {
    const seasonID = seasonByComp.get(comp);
    if (!seasonID) { console.log(`  ${comp}: no seasonID in config.json — skipping`); continue; }
    for (const id of probeIds) {
      if (!clubs.has(id)) continue;
      const ours = [...clubs.get(id)].sort();
      let res;
      try {
        res = await gqlPost(Q_ORG_TEAMS, { seasonId: seasonID, organisationId: id });
        await sleep(FETCH_DELAY);
      } catch (e) {
        console.log(`  ${id} (${comp}) discoverTeams failed: ${e.message}`);
        continue;
      }
      if (res?.errors?.length) {
        console.log(`  ${id} (${comp}) GraphQL error: ${res.errors.map(e => e.message).join('; ').slice(0, 140)}`);
        continue;
      }
      const theirs = res?.data?.discoverTeams || [];
      // Index BOTH the raw name and the age-stripped name. The pipeline strips
      // only a grade's own age, so a team called "Vermont U12" playing up in a
      // U14 grade is stored with the age intact. Indexing only the stripped
      // form would report those as unmatched when they are not.
      const theirClean = new Map();
      theirs.forEach(t => {
        const raw = (t.name || '').trim();
        if (raw) theirClean.set(raw, t);
        const cleaned = cleanTeam(raw);
        if (cleaned && !theirClean.has(cleaned)) theirClean.set(cleaned, t);
      });
      const matched   = ours.filter(o => theirClean.has(o));
      const unmatched = ours.filter(o => !theirClean.has(o));
      totalOurs    += ours.length;
      totalMatched += matched.length;

      const org = orgs.get(id);
      console.log(`  ${pad(org?.name || id, 44)} ${matched.length}/${ours.length} of our teams found in ${theirs.length} PlayHQ team(s)`);
      if (unmatched.length) {
        console.log(`      unmatched (ours):   ${unmatched.join(', ')}`);
        const oursSet = new Set(ours);
        const extra = [...theirClean.keys()].filter(t => !oursSet.has(t));
        if (extra.length) console.log(`      only in PlayHQ:     ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` (+${extra.length - 8})` : ''}`);
      }
    }
  }
  if (totalOurs) {
    const pct = (totalMatched / totalOurs * 100).toFixed(1);
    console.log(`\nOverall: ${totalMatched}/${totalOurs} stored team names matched their club's PlayHQ list (${pct}%).`);
  }

  // ── Stage 4 ──
  if (OPTS.seasons > 0) {
    console.log('\n' + '='.repeat(78));
    console.log('STAGE 4 — SEASON HISTORY (reconnaissance for the multi-season work)');
    console.log('='.repeat(78));
    console.log('Not part of the finals change. One call per club lists every season.\n');

    for (const id of probeIds.slice(0, OPTS.seasons)) {
      const org = orgs.get(id);
      if (!org) continue;
      let res;
      try {
        res = await gqlPost(Q_ORG_COMPS, { organisationID: id });
        await sleep(FETCH_DELAY);
      } catch (e) {
        console.log(`  ${org.name}: failed — ${e.message}`);
        continue;
      }
      if (res?.errors?.length) {
        console.log(`  ${org.name}: GraphQL error: ${res.errors.map(e => e.message).join('; ').slice(0, 140)}`);
        continue;
      }
      const comps = res?.data?.discoverCompetitions || [];
      console.log(`  ${org.name} (${id}) — ${comps.length} competition(s)`);
      for (const c of comps) {
        console.log(`    ${c.name} [${c.id}]  org=${c.organisation?.id || '?'} ${c.organisation?.name || ''}`);
        for (const s of (c.seasons || [])) {
          console.log(`      ${pad(s.name, 8)} ${pad(s.id, 10)} ${pad(s.status?.value || '?', 10)} ${s.startDate} -> ${s.endDate}`);
        }
      }
    }
  }

  // ── Conclusion ──
  console.log('\n' + '='.repeat(78));
  console.log('CONCLUSION');
  console.log('='.repeat(78));
  const pct = totalOurs ? (totalMatched / totalOurs * 100) : 0;
  if (confirmed && pct >= 95) {
    console.log('The logo URL is a reliable club id. data.json already contains the club');
    console.log('for nearly every team, so a club index can be built without re-crawling');
    console.log('match data — one discoverOrganisation call per distinct club for names.');
  } else if (confirmed) {
    console.log(`Club ids resolve, but only ${pct.toFixed(1)}% of stored team names matched.`);
    console.log('Read the unmatched lists above before relying on this — the gap is the');
    console.log('answer, not the percentage.');
  } else {
    console.log('No candidate resolved as a CLUB. The logo hypothesis is wrong; clubs must');
    console.log('be enumerated another way. Do not fall back to name-stripping by default.');
  }
  console.log('\nProbe complete. Nothing was written.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
