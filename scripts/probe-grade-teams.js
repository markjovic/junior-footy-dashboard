#!/usr/bin/env node
// scripts/probe-grade-teams.js
//
// READ-ONLY PROBE. Writes nothing, commits nothing, pushes nothing.
//
// Answers two questions in one run.
//
// 1. WHAT IS IN A GRADE. EFNL 2026's "U18 Girls (Grading)" shows teams from at
//    least four leagues — Pearcedale Baxter and Frankston YCW (Mornington
//    Peninsula), Fitzroy and North Brunswick (northern), Berwick and Narre North
//    (south-east) — while the A/B and C grades in the same age look entirely
//    local. This dumps every team in a grade with its owning organisation, and
//    cross-references data.json to show how many OTHER grades in the same
//    competition each team appears in. A team appearing only here is not a
//    participant in that competition in any ordinary sense.
//
// 2. DOES DiscoverTeam.organisation RESOLVE. playhq_api_reference.md documents
//    `organisation { id name }` on DiscoverTeam but it has never been verified on
//    the afl tenant. An earlier probe asked for `club` — the wrong field name —
//    concluded no club existed, and the club index was built on logo-URL
//    derivation as a result. If organisation resolves and returns the club, both
//    fetchers could capture it directly and build-club-index.js becomes
//    unnecessary.
//
//    The query is attempted WITH organisation first. If GraphQL rejects the
//    field the probe retries without it and reports that, rather than aborting
//    the way probe-team-club.js did.
//
// Usage:
//   node scripts/probe-grade-teams.js --grade=e99a8e35
//   node scripts/probe-grade-teams.js --comp="EFNL 2026" --age="U18 Girls"
//   node scripts/probe-grade-teams.js --comp="EFNL 2026" --age="U18 Girls" --rounds=3

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ROOT        = path.resolve(__dirname, '..');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');
const DATA_PATH   = path.join(ROOT, 'data', 'data.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '250', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { grade: null, comp: null, age: null, rounds: 1 };
  const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--grade':  opts.grade  = val.trim() || null; break;
      case '--comp':   opts.comp   = val.trim() || null; break;
      case '--age':    opts.age    = val.trim() || null; break;
      case '--rounds': opts.rounds = Math.max(1, intOr(val, 1)); break;
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
        // Resolve so the caller can read it and fall back.
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

// ─── Queries ──────────────────────────────────────────────────────────────────

const Q_GRADE_ROUNDS = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    dates
    rounds { id name abbreviatedName number current isFinalsRound }
  }
}`;

// Attempted first. `organisation` is documented on DiscoverTeam but unverified
// on this tenant.
const Q_FIXTURE_ORG = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      status { value }
      home {
        ... on DiscoverTeam { id name organisation { id name } }
        ... on ProvisionalTeam { name }
      }
      away {
        ... on DiscoverTeam { id name organisation { id name } }
        ... on ProvisionalTeam { name }
      }
      allocation { court { venue { name suburb } } }
    }
  }
}`;

// Fallback if organisation is rejected.
const Q_FIXTURE_PLAIN = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      status { value }
      home { ... on DiscoverTeam { id name } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { id name } ... on ProvisionalTeam { name } }
      allocation { court { venue { name suburb } } }
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };

function readJson(p, label, fallback) {
  if (!fs.existsSync(p)) {
    if (fallback !== undefined) { console.warn(`${label} not found — skipping cross-reference`); return fallback; }
    console.error(`${label} not found at ${p}`); process.exit(1);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (fallback !== undefined) { console.warn(`Could not parse ${label}: ${e.message}`); return fallback; }
    console.error(`Could not parse ${label}: ${e.message}`); process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('probe-grade-teams.js — READ-ONLY. Nothing is written.');
  console.log(`Options: ${JSON.stringify(OPTS)}\n`);

  const grades = readJson(GRADES_PATH, 'grades.json');

  // ── Select grades ──
  let selected = [];
  if (OPTS.grade) {
    const g = grades.find(x => x.id === OPTS.grade);
    selected = [g || { id: OPTS.grade, name: '(not in grades.json)', compName: '(unknown)' }];
  } else {
    selected = grades.filter(g =>
      (!OPTS.comp || (g.compName || '').toLowerCase().includes(OPTS.comp.toLowerCase())) &&
      (!OPTS.age  || (g.name     || '').toLowerCase().includes(OPTS.age.toLowerCase())));
  }
  if (!selected.length) {
    console.error('No grades matched. Use --grade=<id>, or --comp and --age.');
    process.exit(1);
  }
  console.log(`${selected.length} grade(s) selected:`);
  selected.forEach(g => console.log(`  ${pad(g.id, 10)} ${pad(g.compName || '?', 12)} ${g.name}`));

  await getSession();

  // ── data.json cross-reference: where else does each team appear? ──
  const data = readJson(DATA_PATH, 'data.json', null);
  const teamGrades = new Map(); // "comp|team" -> Set("age|grade")
  if (data) {
    for (const m of (data.matches || [])) {
      if (m.isBye || m.isPartial) continue;
      for (const t of [m.home, m.away]) {
        if (!t || t.startsWith('__')) continue;
        const k = `${m.compName}|${t}`;
        if (!teamGrades.has(k)) teamGrades.set(k, new Set());
        teamGrades.get(k).add(`${m.age}|${m.rawGrade || ''}`);
      }
    }
    console.log(`\nCross-reference loaded: ${teamGrades.size} team(s) across ${(data.matches || []).length} match records.`);
  }

  let orgSupported = null;

  for (const grade of selected) {
    console.log('\n' + '='.repeat(78));
    console.log(`${grade.compName || '?'} — ${grade.name}   [${grade.id}]`);
    console.log('='.repeat(78));

    let res;
    try {
      res = await gqlPost(Q_GRADE_ROUNDS, { gradeID: grade.id });
      await sleep(FETCH_DELAY);
    } catch (e) { console.log(`  rounds failed: ${e.message}`); continue; }
    if (res?.errors?.length) { console.log(`  GraphQL: ${res.errors.map(e => e.message).join('; ')}`); continue; }

    const gd = res?.data?.discoverGrade;
    const rounds = gd?.rounds || [];
    console.log(`  dates: ${JSON.stringify(gd?.dates)}   rounds: ${rounds.length}`);
    if (!rounds.length) { console.log('  no rounds'); continue; }

    // Sample the earliest rounds — grading pools are usually complete by then.
    const sample = rounds.slice(0, OPTS.rounds);
    const teams  = new Map(); // team id -> { name, orgId, orgName }
    const venues = new Set();

    for (const r of sample) {
      let fx;
      const useOrg = orgSupported !== false;
      try {
        fx = await gqlPost(useOrg ? Q_FIXTURE_ORG : Q_FIXTURE_PLAIN, { roundID: r.id });
        await sleep(FETCH_DELAY);
      } catch (e) { console.log(`    ${r.name}: ${e.message}`); continue; }

      if (fx?.errors?.length && useOrg && /organisation/i.test(JSON.stringify(fx.errors))) {
        console.log(`\n  >>> organisation REJECTED on DiscoverTeam: ${fx.errors.map(e => e.message).join('; ').slice(0, 160)}`);
        orgSupported = false;
        try {
          fx = await gqlPost(Q_FIXTURE_PLAIN, { roundID: r.id });
          await sleep(FETCH_DELAY);
        } catch (e) { console.log(`    retry failed: ${e.message}`); continue; }
      } else if (fx?.errors?.length) {
        console.log(`    ${r.name}: GraphQL ${fx.errors.map(e => e.message).join('; ').slice(0, 140)}`);
        continue;
      } else if (useOrg && orgSupported === null) {
        orgSupported = true;
        console.log('\n  >>> organisation ACCEPTED on DiscoverTeam.');
      }

      const games = fx?.data?.discoverFixtureByRound?.games || [];
      console.log(`  ${pad(r.name, 22)} ${games.length} game(s)`);
      for (const g of games) {
        const v = g.allocation?.court?.venue;
        if (v?.suburb) venues.add(v.suburb);
        for (const side of [g.home, g.away]) {
          if (!side?.id) continue;
          if (!teams.has(side.id)) teams.set(side.id, {
            name: side.name || '', orgId: side.organisation?.id || '', orgName: side.organisation?.name || '',
          });
        }
      }
    }

    // ── Team table ──
    console.log(`\n  ${teams.size} distinct team(s):\n`);
    console.log(`  ${pad('team', 34)} ${pad('organisation', 40)} other grades in ${grade.compName}`);
    let onlyHere = 0;
    const orgs = new Map();
    for (const [, t] of [...teams.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      // Match against the stored, age-stripped name where possible.
      const key = [...teamGrades.keys()].find(k =>
        k.startsWith(`${grade.compName}|`) && t.name.startsWith(k.split('|')[1]));
      const others = key ? [...teamGrades.get(key)] : [];
      if (others.length <= 1) onlyHere++;
      if (t.orgId) orgs.set(t.orgId, t.orgName);
      console.log(`  ${pad(t.name, 34)} ${pad(t.orgName || '(none)', 40)} ${others.length ? others.join(', ') : '(not in data.json)'}`);
    }

    console.log(`\n  ${onlyHere} of ${teams.size} team(s) appear in this grade and nowhere else in ${grade.compName}.`);
    if (orgs.size) console.log(`  ${orgs.size} distinct organisation(s).`);
    if (venues.size) {
      console.log(`  venues span ${venues.size} suburb(s): ${[...venues].sort().slice(0, 14).join(', ')}${venues.size > 14 ? ' …' : ''}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('CONCLUSION');
  console.log('='.repeat(78));
  if (orgSupported === true) {
    console.log('DiscoverTeam.organisation resolves. If the values above are clubs rather');
    console.log('than leagues, both fetchers can capture the club id at fetch time and');
    console.log('build-club-index.js becomes unnecessary. Closes OUTSTANDING_TASKS item 2.');
  } else if (orgSupported === false) {
    console.log('DiscoverTeam.organisation does NOT resolve. The logo-URL derivation in');
    console.log('build-club-index.js remains the only route to a club, and the API');
    console.log('reference needs correcting.');
  }
  console.log('\nA team appearing only in this grade, at venues far from the league\'s');
  console.log('other grounds, is a visiting participant rather than a member club.');
  console.log('\nProbe complete. Nothing was written.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
