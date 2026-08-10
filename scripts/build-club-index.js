#!/usr/bin/env node
// scripts/build-club-index.js
//
// Builds a first-class club index and merges it into data.json.
//
// WHY THIS EXISTS
// PlayHQ has a real club concept, but DiscoverTeam does not expose it — proven
// on 2026-08-09: "Cannot query field \"club\" on type \"DiscoverTeam\"", and
// introspection is disabled so the schema cannot be read. Deriving clubs from
// team names is not viable: "Norwood Gold/Heathmont U12" is a merged team, and
// no stripping rule maps it to Norwood.
//
// The route that works was established by probe-club-index.js:
//   PlayHQ logo URLs embed the owning organisation's UUID —
//     /production/afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/.../logo.png
//   whose first 8 hex characters are the public organisation code (6d405ccb =
//   Norwood). Every match record already stores hLogo/aLogo, so club identity
//   is already in data.json and needs no re-crawl of match data.
//   discoverOrganisation(code) then returns the official name and confirms
//   type === "CLUB".
//
// Probe result, EFNL 2026: 113 distinct club ids across 456 teams, 8 teams
// without any logo, and 10 of 10 sampled ids resolved as CLUB.
//
// discoverTeams(filter:{seasonID, organisationID}) is deliberately NOT used.
// It only returns teams registered under that season, so a club from another
// league fielding a team in an EFNL grade comes back empty — which is correct
// behaviour for that call and useless for identifying clubs.
//
// OUTPUT (merged into data.json, plus a clubs.json cache)
//   clubs:    { "6d405ccb": { name, type } }
//   teamClub: { "EFNL 2026|Norwood Purple|U12": "6d405ccb" }
//
// Teams are keyed compName|teamName|age, matching rebuildRoster exactly.
// Age is load-bearing, not decoration. PlayHQ routinely registers a senior and
// a junior club as separate organisations — Templestowe is 225d5de5 "Templestowe
// (Eastern Football Netball League)" and 2545b284 "Templestowe Junior Football
// Club" — and cleanTeam strips the age suffix, so both arrive as plain
// "Templestowe". Without age in the key they collapse into one entry and the
// majority vote silently assigns every senior team to the junior club.
// The same applies within a club: "Norwood U12 Purple" and "Norwood U14 Purple"
// both clean to "Norwood Purple" and are different teams.
//
// Exits 0 when data.json changed, 2 when nothing changed, 1 on fatal error —
// the same contract as fetch-results.js, so the workflow decides on committing.
//
// Usage:
//   node scripts/build-club-index.js
//   node scripts/build-club-index.js --comp="EFNL 2026"
//   node scripts/build-club-index.js --refresh      (re-resolve every club)

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT        = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH   = path.join(ROOT, 'data.json');
const CLUBS_PATH  = path.join(ROOT, 'clubs.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '250', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

// Cooldown pacing. probe-club-index.js saw "There was an error. Please try
// again later." from PlayHQ after a run of calls, so this paces deliberately.
const COOLDOWN_EVERY   = 40;
const COOLDOWN_SECONDS = 20;

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { comp: null, refresh: false };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--comp':    opts.comp    = val.trim() || null; break;
      case '--refresh': opts.refresh = true; break;
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

// ─── Query ────────────────────────────────────────────────────────────────────
// Argument name and shape copied from the live playhq.com call, not written
// from scratch.

const Q_ORG = `
query discoverOrganisation($organisationCode: String!) {
  discoverOrganisation(code: $organisationCode) {
    id
    type
    name
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The first 8 hex characters of the Cloudinary UUID are the public
// organisation code. Verified against Norwood's club logo and the team logos
// of Blackburn, Donvale and the EFNL league organisation.
function clubIdFromLogo(url) {
  const m = String(url || '').match(/\/production\/[a-z]+\/([0-9a-f]{8})-[0-9a-f-]+\//i);
  return m ? m[1].toLowerCase() : '';
}

function readJson(p, label, fallback) {
  if (!fs.existsSync(p)) {
    if (fallback !== undefined) return fallback;
    console.error(`${label} not found at ${p}`);
    process.exit(1);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (fallback !== undefined) { console.warn(`Could not parse ${label} — treating as empty`); return fallback; }
    console.error(`Could not parse ${label}: ${e.message}`);
    process.exit(1);
  }
}

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };

// ─── Club resolution ──────────────────────────────────────────────────────────

async function resolveClub(id) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    let res;
    try {
      res = await gqlPost(Q_ORG, { organisationCode: id });
      await sleep(FETCH_DELAY);
    } catch (e) {
      if (attempt === 4) return { error: e.message };
      continue;
    }
    if (res?.errors?.length) {
      const msg = res.errors.map(e => e.message).join('; ');
      if (attempt === 4) return { error: msg };
      continue;
    }
    const o = res?.data?.discoverOrganisation;
    if (!o) return { missing: true };
    return { id: o.id || id, type: o.type || '', name: o.name || '' };
  }
  return { error: 'exhausted' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('build-club-index.js');
  console.log(`Options: ${JSON.stringify(OPTS)}`);

  readJson(CONFIG_PATH, 'config.json'); // presence check only
  const data  = readJson(DATA_PATH, 'data.json');
  const cache = readJson(CLUBS_PATH, 'clubs.json', {});
  console.log(`Loaded data.json: ${(data.matches || []).length} match record(s)`);
  console.log(`Loaded clubs.json cache: ${Object.keys(cache).length} club(s)`);

  // ── Scan match records for club evidence ──
  // A team can appear in many records. Count the club id seen per team rather
  // than trusting the first, so a single odd logo cannot decide the answer.
  const votes    = new Map(); // "comp|team|age" -> Map(clubId -> count)
  const noLogo   = new Set(); // "comp|team|age" with no logo on any record
  const withLogo = new Set();

  for (const m of (data.matches || [])) {
    if (m.isBye || m.isPartial) continue;
    const comp = m.compName || '';
    if (OPTS.comp && !comp.toLowerCase().includes(OPTS.comp.toLowerCase())) continue;
    for (const [name, logo, prov] of [
      [m.home, m.hLogo, m.provisional && !m.hLogo],
      [m.away, m.aLogo, m.provisional && !m.aLogo],
    ]) {
      if (!name || name.startsWith('__')) continue;
      // A provisional placeholder such as "Winner Game 1" is not a team and
      // must never become a club member.
      if (prov) continue;
      const key = `${comp}|${name}|${m.age || ''}`;
      const id  = clubIdFromLogo(logo);
      if (!id) { noLogo.add(key); continue; }
      withLogo.add(key);
      if (!votes.has(key)) votes.set(key, new Map());
      const v = votes.get(key);
      v.set(id, (v.get(id) || 0) + 1);
    }
  }
  for (const k of [...noLogo]) if (withLogo.has(k)) noLogo.delete(k);

  // Resolve each team to a single club id, reporting any disagreement rather
  // than silently picking one.
  const teamClub = {};
  const conflicts = [];
  for (const [key, v] of votes) {
    const ranked = [...v.entries()].sort((a, b) => b[1] - a[1]);
    teamClub[key] = ranked[0][0];
    if (ranked.length > 1) conflicts.push({ key, ranked });
  }

  const clubIds = new Set(Object.values(teamClub));
  console.log(`\n${Object.keys(teamClub).length} team(s) mapped to ${clubIds.size} club id(s).`);
  console.log(`${noLogo.size} team(s) have no logo on any record and cannot be attributed.`);
  if (noLogo.size) {
    console.log(`  ${[...noLogo].slice(0, 12).join('\n  ')}`);
    if (noLogo.size > 12) console.log(`  ... and ${noLogo.size - 12} more`);
  }
  if (conflicts.length) {
    console.log(`\n*** ${conflicts.length} team(s) had logos pointing at more than one club:`);
    for (const c of conflicts.slice(0, 10)) {
      console.log(`  ${pad(c.key, 44)} ${c.ranked.map(([id, n]) => `${id}x${n}`).join('  ')}`);
    }
    console.log('  Highest count wins. Investigate any that look wrong.');
  }

  // ── Resolve unknown club ids ──
  const toResolve = [...clubIds].filter(id => OPTS.refresh || !cache[id]).sort();
  console.log(`\n${toResolve.length} club id(s) to resolve (${clubIds.size - toResolve.length} already cached).`);

  if (toResolve.length) await getSession();

  let resolved = 0, failed = 0, notClub = 0;
  let idx = 0;
  for (const id of toResolve) {
    idx++;
    if (idx > 1 && (idx - 1) % COOLDOWN_EVERY === 0) {
      console.log(`  [cooldown ${COOLDOWN_SECONDS}s after ${idx - 1} lookups]`);
      await sleep(COOLDOWN_SECONDS * 1000);
    }
    const r = await resolveClub(id);
    if (r.error)   { console.log(`  ${pad(id, 10)} FAILED: ${r.error.slice(0, 90)}`); failed++; continue; }
    if (r.missing) { console.log(`  ${pad(id, 10)} no organisation returned`); failed++; continue; }
    cache[id] = { name: r.name, type: r.type };
    if (r.type !== 'CLUB') notClub++;
    resolved++;
    console.log(`  ${pad(id, 10)} ${pad(r.type, 8)} ${r.name}`);
  }
  console.log(`\nResolved ${resolved}, failed ${failed}.`);
  if (notClub) {
    console.log(`${notClub} organisation(s) are not type CLUB — usually the league itself.`);
    console.log('They are kept in the cache so they are not re-fetched, but the dashboard');
    console.log('should only group on entries whose type is CLUB.');
  }

  // ── Build the clubs map actually referenced by teamClub ──
  const clubs = {};
  for (const id of clubIds) if (cache[id]) clubs[id] = cache[id];
  const unresolved = [...clubIds].filter(id => !cache[id]);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} club id(s) still unresolved — teams keep their id but have no name.`);
  }

  // ── Write ──
  const before = JSON.stringify({ clubs: data.clubs || {}, teamClub: data.teamClub || {} });
  // A --comp run must not delete mappings for other competitions.
  const mergedTeamClub = OPTS.comp ? { ...(data.teamClub || {}), ...teamClub } : teamClub;
  const mergedClubs    = { ...(data.clubs || {}), ...clubs };
  const after = JSON.stringify({ clubs: mergedClubs, teamClub: mergedTeamClub });

  fs.writeFileSync(CLUBS_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`\nWrote clubs.json (${Object.keys(cache).length} club(s) cached)`);

  if (before === after) {
    console.log('Club index unchanged — skipping data.json write and commit.');
    process.exit(2);
  }

  data.clubs    = mergedClubs;
  data.teamClub = mergedTeamClub;
  data.lastClubIndex = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Wrote data.json — ${Object.keys(mergedClubs).length} club(s), ${Object.keys(mergedTeamClub).length} team mapping(s)`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
