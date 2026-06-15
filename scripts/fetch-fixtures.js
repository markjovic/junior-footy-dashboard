#!/usr/bin/env node
// scripts/fetch-fixtures.js
//
// Fetches future scheduled fixtures (unplayed games) from PlayHQ and stores
// them in data.json as scheduled records. Runs separately from fetch-results.js.
// Scheduled records are used for finals scenario analysis and fixture display.
// They are overwritten by fetch-results.js when actual scores come in.
//
// Scheduled record format matches fetch-results.js match records, with:
//   scheduled: true
//   hScore: null, aScore: null (no scores yet)
//
'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT        = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const GRADES_PATH = path.join(ROOT, 'grades.json');
const DATA_PATH   = path.join(ROOT, 'data.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '200', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let SESSION_COOKIE = '';

// ─── HTTP ─────────────────────────────────────────────────────────────────────
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
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
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

// ─── Session cookie ───────────────────────────────────────────────────────────
async function getSession() {
  const body = JSON.stringify({
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  });
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await sleep(attempt * 2000);
    const raw = await new Promise((resolve) => {
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
      }, res => {
        resolve(res.headers['set-cookie']?.join(';') || '');
        res.resume();
      });
      req.on('error', () => resolve(''));
      req.write(body);
      req.end();
    });
    const m = raw.match(/phq_session=([^;]+)/);
    if (m) {
      SESSION_COOKIE = `phq_session=${m[1]}`;
      console.log('Session cookie obtained');
      return;
    }
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
    rounds {
      id
      name
      number
      current
      isFinalsRound
      provisionalDates
    }
  }
}`;

const Q_FIXTURE = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home { ... on DiscoverTeam { id name logo { sizes { url dimensions { width height } } } } }
      away { ... on DiscoverTeam { id name logo { sizes { url dimensions { width height } } } } }
      status { value }
      date
      allocation { time court { venue { name suburb latitude longitude } } }
    }
  }
}`;

// ─── Helpers (mirrors fetch-results.js) ──────────────────────────────────────
function getLogoUrl(logo) {
  if (!logo?.sizes?.length) return '';
  const target = logo.sizes.find(s => s.dimensions?.width === 96) || logo.sizes[logo.sizes.length - 1];
  return target?.url || '';
}

function cleanTeam(name, gradeAge) {
  if (!name) return '';
  if (gradeAge) {
    const ageNum = gradeAge.match(/^(U\d+(?:\.\d+)?)/i)?.[1];
    if (ageNum) {
      return name.replace(new RegExp('\\s+' + ageNum.replace('.', '\\.') + '\\b\\s*', 'gi'), ' ').replace(/\s+$/, '').trim();
    }
  }
  return name.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/, '').trim();
}

function parseGradeName(name, ageName, genderName) {
  const n = name.replace(/^[*\s]+/, '').trim();
  const parenDivMatch = n.match(/\((\d+)\)\s*$/);
  if (parenDivMatch) {
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    return { age: (ageName || '').toUpperCase() + genderSuffix, rawGrade: parenDivMatch[1] };
  }
  if (/\bGrading\b/i.test(n)) {
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    const halfAgeMatch = n.match(/^(U\d+\.5)/i);
    const resolvedAge = halfAgeMatch ? halfAgeMatch[0].toUpperCase() : ageName;
    return { age: (resolvedAge || '') + genderSuffix, rawGrade: 'Grading' };
  }
  const premDiv = n.match(/\b(Premier|Division\s+\d+)\b/i);
  if (premDiv) {
    let rawGrade = premDiv[1].replace(/\s+/, ' ');
    rawGrade = rawGrade.charAt(0).toUpperCase() + rawGrade.slice(1);
    if (ageName === 'Senior' || ageName === 'Open' || ageName === 'Master') {
      const subtitle = n.replace(/^[^-–]*[-–]\s*/, '').trim();
      return { age: subtitle || ageName, rawGrade };
    }
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    return { age: (ageName || '').toUpperCase() + genderSuffix, rawGrade };
  }
  const letterGrade = n.match(/\b([A-D]\d?)\s*$/);
  if (letterGrade) {
    if (ageName === 'Senior' || ageName === 'Open' || ageName === 'Master') {
      const subtitle = n.replace(/^[^-–]*[-–]\s*/, '').trim();
      return { age: subtitle || ageName, rawGrade: letterGrade[1] };
    }
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    return { age: (ageName || '').toUpperCase() + genderSuffix, rawGrade: letterGrade[1] };
  }
  if (ageName?.match(/^U\d/i)) {
    const nameAgeMatch = n.match(/^(U\d+(?:\.\d+)?)/i);
    const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName) ? nameAgeMatch[0].toUpperCase() : ageName;
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    let resolvedRawGrade = '';
    const colourMatch = n.match(/\b(Blue|Red|Green|Gold|White|Black|Yellow|Purple|Orange|Navy|Silver|Teal|Grey|Gray|Maroon|Pink)\s*$/i);
    if (colourMatch) resolvedRawGrade = colourMatch[1];
    return { age: resolvedAge + genderSuffix, rawGrade: resolvedRawGrade };
  }
  return { age: ageName || name, rawGrade: '' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await getSession();

  // Read grades from cache — no discovery, that's fetch-results.js's job
  if (!fs.existsSync(GRADES_PATH)) {
    console.error('grades.json not found — run fetch-results.js first');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const allGrades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));

  const vipOnly = process.env.VIP_ONLY === 'true';
  let vipComps = new Set();
  if (vipOnly) {
    vipComps = new Set((config.competitions || []).filter(c => c.vip).map(c => c.name));
  }
  const grades = vipOnly ? allGrades.filter(g => vipComps.has(g.compName)) : allGrades;

  console.log(`Fetching fixtures for ${vipOnly ? 'VIP' : 'ALL'} comps (${grades.length} grades)`);

  let data = { matches: [], players: [], roster: {}, gotwFlags: {} };
  if (fs.existsSync(DATA_PATH)) {
    try { data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
    catch (e) { console.warn('Could not parse data.json'); }
  }

  // Build existing match index
  const byId = new Map(data.matches.map(m => [m.id, m]));
  const today = new Date().toISOString().slice(0, 10);

  // Build grade→age lookup from existing match records
  // Key: gradeID stored in match id (compName|age|rawGrade prefix) — use compName+rawGrade
  // This ensures scheduled records use the same age string as fetch-results.js
  const gradeAgeMap = {};      // "compName|rawGrade" → age
  const gradeAgeMapFull = {};  // "compName|age|rawGrade" → age (for exact match)
  for (const m of data.matches || []) {
    if (!m.scheduled && m.rawGrade !== undefined) {
      const fullKey = `${m.compName}|${m.age}|${m.rawGrade}`;
      const shortKey = `${m.compName}|${m.rawGrade}`;
      if (!gradeAgeMapFull[fullKey]) gradeAgeMapFull[fullKey] = m.age;
      // Only store short key if rawGrade is unique within the comp
      // (colour grades like Blue/Red may appear in multiple age groups)
      if (!gradeAgeMap[shortKey]) gradeAgeMap[shortKey] = m.age;
      else if (gradeAgeMap[shortKey] !== m.age) gradeAgeMap[shortKey] = null; // ambiguous
    }
  }

  let newCount = 0;
  let gradeIdx = 0;

  for (const grade of grades) {
    gradeIdx++;
    console.log(`\n[${gradeIdx}/${grades.length}] ${grade.compName} — ${grade.name}`);

    if (gradeIdx > 1 && (gradeIdx - 1) % 25 === 0) {
      console.log('  [cooldown 2s]');
      await sleep(2000);
    }

    let roundsRes;
    try {
      roundsRes = await gqlPost(Q_GRADE_ROUNDS, { gradeID: grade.id });
      await sleep(FETCH_DELAY);
    } catch (e) {
      console.log(`  gradeRounds error: ${e.message}`);
      continue;
    }

    const roundList = roundsRes?.data?.discoverGrade?.rounds || [];
    if (!roundList.length) { console.log('  no rounds'); continue; }

    const parsed = parseGradeName(grade.name, grade.ageName, grade.genderName);
    const rawGrade = parsed.rawGrade;
    // Try to resolve age from existing match records to match fetch-results.js output
    const shortKey = `${grade.compName}|${rawGrade}`;
    const shortAge = gradeAgeMap[shortKey]; // null if ambiguous, undefined if missing
    const age = (shortAge != null && shortAge !== undefined) ? shortAge : parsed.age;
    const currentRoundIndex = roundList.findIndex(r => r.current);

    // Only fetch rounds AFTER the current round
    const futureRounds = currentRoundIndex !== -1
      ? roundList.slice(currentRoundIndex + 1)
      : [];

    if (!futureRounds.length) {
      console.log('  no future rounds');
      continue;
    }

    console.log(`  ${futureRounds.length} future round(s) to fetch`);

    for (const round of futureRounds) {
      const number = parseInt(round.number, 10) || 0;

      let fixtureRes;
      try {
        fixtureRes = await gqlPost(Q_FIXTURE, { roundID: round.id });
        await sleep(FETCH_DELAY);
      } catch (e) {
        console.log(`  R${number} error: ${e.message}`);
        continue;
      }

      const games = fixtureRes?.data?.discoverFixtureByRound?.games || [];
      if (!games.length) { console.log(`  R${number} ... bye`); continue; }

      let roundNew = 0;
      for (const game of games) {
        if (game.status?.value === 'FINAL') continue; // already scored — skip, fetch-results handles it

        const homeName = cleanTeam(game.home?.name || '', age);
        const awayName = cleanTeam(game.away?.name || '', age);
        if (!homeName || !awayName) continue;

        const matchId = `${grade.compName}|${age}|${rawGrade}|${number}|${[homeName, awayName].sort().join('|')}`;

        // Don't overwrite a completed result
        if (byId.has(matchId) && !byId.get(matchId).scheduled) continue;

        const venue    = game.allocation?.court?.venue?.name    || '';
        const vSuburb  = game.allocation?.court?.venue?.suburb  || '';
        const vLat     = game.allocation?.court?.venue?.latitude  || '';
        const vLng     = game.allocation?.court?.venue?.longitude || '';
        const venueUrl = vLat && vLng ? `https://maps.google.com/?q=${vLat},${vLng}` : '';

        byId.set(matchId, {
          id: matchId, age, rawGrade, round: number,
          compName: grade.compName,
          home: homeName, away: awayName,
          hScore: null, hG: null, hB: null,
          aScore: null, aG: null, aB: null,
          venue, vSuburb, venueUrl,
          hLogo: getLogoUrl(game.home?.logo),
          aLogo: getLogoUrl(game.away?.logo),
          date: game.date || '',
          time: game.allocation?.time || '',
          scheduled: true,
        });
        roundNew++;
        newCount++;
      }
      console.log(`  R${number} ... ${roundNew} fixture(s) stored`);
    }
  }

  // Write back — preserve all existing matches, add/update scheduled ones
  data.matches = [...byId.values()];
  data.lastFixtureFetch = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\nFixtures: ${newCount} new scheduled records written`);
  console.log('Wrote data.json');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
