#!/usr/bin/env node
// scripts/probe-team-club.js
//
// READ-ONLY PROBE. Writes nothing, commits nothing, pushes nothing.
//
// Answers: does PlayHQ expose a first-class club on a team, and if so does it
// group colour variants and merged teams correctly?
//
// This matters because the dashboard currently has no club concept at all in
// match records, and fetch-stats.js derives one from team-name heuristics
// (toClubName, normaliseClub, and a CLUB_STRIP regex that hardcodes nicknames
// such as "eagles", "magpies", "tigers"). Name-derived clubs break on merged
// teams, on colour variants, and on any club whose team name differs from the
// club name. If DiscoverTeam carries a club id, every match record can store it
// and the guessing stops.
//
// Three stages, each independent so a failure in one still yields the others:
//   1. Introspection of DiscoverTeam / ProvisionalTeam / the team union.
//   2. A trial discoverFixtureByRound that asks for club{id name} on the
//      DiscoverTeam spread. If the field does not exist the GraphQL error
//      usually names the valid alternatives, which is itself the answer.
//   3. A real sample: team name -> club id/name across grades, highlighting
//      cases where different team names share one club id.
//
// Usage:
//   node scripts/probe-team-club.js
//   node scripts/probe-team-club.js --grade=<gradeID>
//   node scripts/probe-team-club.js --comp="EFNL 2026" --limit=6

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT        = path.join(__dirname, '..');
const GRADES_PATH = path.join(ROOT, 'grades.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '250', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { comp: null, gradeId: null, limit: 6 };
  const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--comp':  opts.comp    = val.trim() || null; break;
      case '--grade': opts.gradeId = val.trim() || null; break;
      case '--limit': opts.limit   = Math.max(1, intOr(val, 6)); break;
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
        if (res.statusCode !== 200)
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
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

const Q_INTROSPECT = `
query IntrospectType($name: String!) {
  __type(name: $name) {
    name
    kind
    fields {
      name
      type { name kind ofType { name kind } }
    }
    possibleTypes { name kind }
  }
}`;

const Q_GRADE_ROUNDS = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    rounds { id name number current isFinalsRound }
  }
}`;

// The DiscoverTeam spread asks for club{id name}. If the field does not exist
// the server returns a GraphQL error rather than data, which is the answer.
const Q_FIXTURE_CLUB = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home {
        ... on DiscoverTeam { id name club { id name } }
        ... on ProvisionalTeam { name }
      }
      away {
        ... on DiscoverTeam { id name club { id name } }
        ... on ProvisionalTeam { name }
      }
    }
  }
}`;

// Fallback used if club is rejected — proves the round itself has games, so a
// failure above can be attributed to the field rather than to the round.
const Q_FIXTURE_PLAIN = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home { ... on DiscoverTeam { id name } }
      away { ... on DiscoverTeam { id name } }
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
const typeName = t => t?.name || t?.ofType?.name || t?.kind || '?';

function loadGrades() {
  if (!fs.existsSync(GRADES_PATH)) {
    console.error(`grades.json not found at ${GRADES_PATH}`);
    process.exit(1);
  }
  try { return JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
  catch (e) { console.error(`Could not parse grades.json: ${e.message}`); process.exit(1); }
}

// ─── Stage 1: introspection ───────────────────────────────────────────────────

async function introspect(name) {
  console.log(`\n--- ${name} ---`);
  let res;
  try {
    res = await gqlPost(Q_INTROSPECT, { name });
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`  request failed: ${e.message}`);
    return null;
  }
  if (res?.errors?.length) {
    console.log(`  introspection rejected: ${res.errors.map(e => e.message).join('; ')}`);
    return null;
  }
  const t = res?.data?.__type;
  if (!t) { console.log('  type not found (introspection may be disabled)'); return null; }

  console.log(`  kind: ${t.kind}`);
  if (t.possibleTypes?.length) {
    console.log(`  possible types: ${t.possibleTypes.map(p => p.name).join(', ')}`);
  }
  if (t.fields?.length) {
    console.log('  fields:');
    for (const f of t.fields) console.log(`    ${pad(f.name, 22)} ${typeName(f.type)}`);
    const club = t.fields.find(f => /club/i.test(f.name));
    console.log(club
      ? `  >>> CLUB FIELD PRESENT: ${club.name} : ${typeName(club.type)}`
      : '  >>> no club-like field on this type');
  }
  return t;
}

// ─── Stage 3: real club values ────────────────────────────────────────────────

async function sampleGrade(grade, clubByTeam, teamsByClub) {
  const label = `${grade.compName || '?'} — ${grade.name || '?'}`;
  let rres;
  try {
    rres = await gqlPost(Q_GRADE_ROUNDS, { gradeID: grade.id });
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`  ${label}: rounds failed — ${e.message}`);
    return { ok: false, reason: e.message };
  }
  const rounds = rres?.data?.discoverGrade?.rounds || [];
  if (!rounds.length) { console.log(`  ${label}: no rounds`); return { ok: false, reason: 'no rounds' }; }

  // Prefer the current round; otherwise the first.
  const round = rounds.find(r => r.current) || rounds[0];

  let fres;
  try {
    fres = await gqlPost(Q_FIXTURE_CLUB, { roundID: round.id });
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`  ${label}: fixture failed — ${e.message}`);
    return { ok: false, reason: e.message };
  }
  if (fres?.errors?.length) {
    return { ok: false, reason: fres.errors.map(e => e.message).join('; '), gqlError: true };
  }

  const games = fres?.data?.discoverFixtureByRound?.games || [];
  let seen = 0;
  for (const g of games) {
    for (const side of [g.home, g.away]) {
      if (!side?.id) continue; // ProvisionalTeam — no club
      seen++;
      const clubId   = side.club?.id   || '';
      const clubName = side.club?.name || '';
      clubByTeam.set(side.name, { clubId, clubName });
      if (clubId) {
        if (!teamsByClub.has(clubId)) teamsByClub.set(clubId, { name: clubName, teams: new Set() });
        teamsByClub.get(clubId).teams.add(side.name);
      }
    }
  }
  console.log(`  ${label}: ${seen} team appearance(s) from ${round.name || 'round'}`);
  return { ok: true };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('probe-team-club.js — READ-ONLY. Nothing is written or committed.');
  console.log(`Options: ${JSON.stringify(OPTS)}`);
  await getSession();

  // ── Stage 1 ──
  console.log('\n' + '='.repeat(78));
  console.log('STAGE 1 — INTROSPECTION');
  console.log('='.repeat(78));
  const discover = await introspect('DiscoverTeam');
  await introspect('ProvisionalTeam');
  if (!discover) {
    console.log('\nIntrospection unavailable — stage 2 decides it instead.');
  }

  // ── Stage 2 ──
  console.log('\n' + '='.repeat(78));
  console.log('STAGE 2 — TRIAL QUERY (does club{id name} resolve on DiscoverTeam?)');
  console.log('='.repeat(78));

  const allGrades = loadGrades();
  let grades = allGrades;
  if (OPTS.gradeId) {
    grades = allGrades.filter(g => g.id === OPTS.gradeId);
    if (!grades.length) grades = [{ id: OPTS.gradeId, name: '(not in grades.json)', compName: '(unknown)' }];
  } else if (OPTS.comp) {
    const needle = OPTS.comp.toLowerCase();
    grades = allGrades.filter(g => (g.compName || '').toLowerCase().includes(needle));
  }
  grades = grades.slice(0, OPTS.limit);
  if (!grades.length) { console.log('No grades selected — check --comp/--grade.'); return; }

  const clubByTeam  = new Map(); // team name -> { clubId, clubName }
  const teamsByClub = new Map(); // club id  -> { name, teams:Set }

  let clubSupported = null;
  const first = await sampleGrade(grades[0], clubByTeam, teamsByClub);
  if (first.gqlError) {
    clubSupported = false;
    console.log(`\n>>> club{id name} REJECTED on DiscoverTeam.`);
    console.log(`    GraphQL said: ${first.reason}`);
    console.log('    (GraphQL usually lists valid field names in "Did you mean" — read it above.)');
    // Confirm the round itself is fine, so the failure is attributable.
    try {
      const rres = await gqlPost(Q_GRADE_ROUNDS, { gradeID: grades[0].id });
      await sleep(FETCH_DELAY);
      const rounds = rres?.data?.discoverGrade?.rounds || [];
      const round  = rounds.find(r => r.current) || rounds[0];
      if (round) {
        const plain = await gqlPost(Q_FIXTURE_PLAIN, { roundID: round.id });
        await sleep(FETCH_DELAY);
        const n = plain?.data?.discoverFixtureByRound?.games?.length || 0;
        console.log(`    Control: the same round returns ${n} game(s) without club, so the`);
        console.log(`    rejection is the field, not the round.`);
      }
    } catch (e) {
      console.log(`    Control query failed too: ${e.message}`);
    }
  } else if (first.ok) {
    clubSupported = true;
    console.log('\n>>> club{id name} ACCEPTED on DiscoverTeam.');
  }

  // ── Stage 3 ──
  if (clubSupported) {
    console.log('\n' + '='.repeat(78));
    console.log('STAGE 3 — REAL CLUB VALUES');
    console.log('='.repeat(78));
    for (const g of grades.slice(1)) await sampleGrade(g, clubByTeam, teamsByClub);

    console.log(`\n${pad('team name', 38)} ${pad('club name', 34)} club id`);
    [...clubByTeam.keys()].sort().forEach(t => {
      const c = clubByTeam.get(t);
      console.log(`${pad(t, 38)} ${pad(c.clubName || '(none)', 34)} ${c.clubId || '(none)'}`);
    });

    const populated = [...clubByTeam.values()].filter(c => c.clubId).length;
    console.log(`\n${populated} of ${clubByTeam.size} team(s) carry a club id.`);

    // The payoff: different team names sharing one club id.
    const grouped = [...teamsByClub.entries()].filter(([, v]) => v.teams.size > 1);
    if (grouped.length) {
      console.log('\nClubs fielding more than one team in the sampled grades:');
      for (const [id, v] of grouped) {
        console.log(`  ${pad(v.name, 34)} ${id}`);
        [...v.teams].sort().forEach(t => console.log(`      ${t}`));
      }
      console.log('\nIf colour variants or renamed teams appear together above, the club id');
      console.log('groups them correctly and no name-based heuristic is needed.');
    } else {
      console.log('\nNo club in this sample fielded more than one team — widen --limit or');
      console.log('pick a grade known to contain colour variants to see the grouping.');
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('CONCLUSION');
  console.log('='.repeat(78));
  if (clubSupported === true) {
    console.log('DiscoverTeam exposes a club. Match records can store a real club id and');
    console.log('the by-club view (and eventually fetch-stats.js) can stop deriving clubs');
    console.log('from team names.');
  } else if (clubSupported === false) {
    console.log('DiscoverTeam does NOT expose a club. The club must come from another call');
    console.log('— publicProfileStatistics carries club{id name} per player registration —');
    console.log('or the by-club view needs a different grouping key. Do not fall back to');
    console.log('name-stripping without deciding that deliberately.');
  } else {
    console.log('Inconclusive — no grade could be sampled. Check the failures above.');
  }
  console.log('\nProbe complete. Nothing was written.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
