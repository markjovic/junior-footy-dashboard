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
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');
const DATA_PATH   = path.join(ROOT, 'data', 'data.json');

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
      abbreviatedName
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
      home {
        ... on DiscoverTeam { id name logo { sizes { url dimensions { width height } } } }
        ... on ProvisionalTeam { name }
      }
      away {
        ... on DiscoverTeam { id name logo { sizes { url dimensions { width height } } } }
        ... on ProvisionalTeam { name }
      }
      status { value }
      date
      allocation { dateTimeList { date time } court { venue { name suburb latitude longitude } } }
    }
  }
}`;

// ─── Round identity (exact copy from fetch-results.js) ───────────────────────
// PlayHQ restarts finals numbering at 1 in every grade, so a Grand Final and
// Round 1 both have number === 1. Home-and-away rounds keep the bare number so
// existing ids are unchanged; finals use the stable abbreviation.
// If these two writers ever disagree about a key, one silently creates
// duplicates of the other's records.
function roundToken(number, finalsAbbrev) {
  return finalsAbbrev ? `F:${finalsAbbrev}` : String(number);
}

// ─── Helpers (exact copy from fetch-results.js) ──────────────────────────────
function parseGradeName(name, ageName, genderName) {
  let n = name.replace(/^\*\s*/, '').trim();
  n = n.replace(/\s+-\s+/g, ' ').trim();
  const parenDivMatch = n.match(/\((\d+)\)\s*$/);
  if (parenDivMatch) {
    const divNum = parenDivMatch[1];
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    if (ageName?.match(/^U\d/i)) {
      const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
      const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName) ? nameAgeMatch[0].toUpperCase() : ageName;
      return { age: resolvedAge + genderSuffix, rawGrade: divNum };
    }
    return { age: (ageName || 'Unknown') + genderSuffix, rawGrade: divNum };
  }
  if (/\bGrading\b/i.test(n)) {
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    let ageLabel;
    if (ageName?.match(/^U\d/i)) {
      const halfAgeMatch = n.match(/^U(\d+\.5)/i);
      const resolvedAge = halfAgeMatch ? halfAgeMatch[0].toUpperCase() : ageName;
      ageLabel = resolvedAge + genderSuffix;
    } else {
      ageLabel = n.replace(/\s*\bGrading\b.*$/i, '').trim();
    }
    return { age: ageLabel, rawGrade: 'Grading' };
  }
  const divMatch    = n.match(/\b(Premier(?:\s+Division)?|Division \d+)\b/i);
  const letterMatch = n.match(/\b([A-D]\d*(?:\/[A-D]\d*)?)\s*$/i);
  const rawGrade = divMatch
    ? divMatch[1].replace(/Premier Division/i, 'Premier')
    : letterMatch ? letterMatch[1].toUpperCase() : '';
  if (ageName?.match(/^U\d/i)) {
    const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
    const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName) ? nameAgeMatch[0].toUpperCase() : ageName;
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    let resolvedRawGrade = rawGrade;
    if (!resolvedRawGrade) {
      const colourMatch = n.match(/\b(Blue|Red|Green|Gold|White|Black|Yellow|Purple|Orange|Navy|Silver|Teal|Grey|Gray|Maroon|Pink)\s*$/i);
      if (colourMatch) resolvedRawGrade = colourMatch[1];
    }
    return { age: resolvedAge + genderSuffix, rawGrade: resolvedRawGrade };
  }
  if (ageName === 'Senior' || ageName === 'Open' || ageName?.match(/^Masters?/i) || !ageName) {
    if (/Veterans/i.test(n) || ageName?.match(/^Masters?/i)) {
      const vGender = /Women/i.test(n) ? 'Women' : /Men/i.test(n) ? 'Men' : genderName === 'Women' ? 'Women' : 'Men';
      return { age: 'Veterans', rawGrade: vGender };
    }
    if (/U19\.5/i.test(n)) return { age: 'U19.5', rawGrade };
    if (/Reserves?/i.test(n)) return { age: 'Reserve ' + (genderName || 'Men'), rawGrade };
    if (genderName === 'Women' || /Women/i.test(n)) return { age: 'Senior Women', rawGrade };
    if (/Senior/i.test(n)) return { age: 'Senior ' + (genderName || 'Men'), rawGrade };
    const cleanedAge = n.replace(/\s*(Premier|Division \d+).*$/i, '').trim();
    return { age: cleanedAge || n, rawGrade };
  }
  if (ageName) return { age: ageName + (genderName ? ' ' + genderName : ''), rawGrade };
  n = n.replace(/^.+?(?=U\d)/i, '').trim();
  const junior = n.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*(?:\/[A-D]\d*)?)$/i);
  if (junior) return { age: junior[1].trim(), rawGrade: junior[2].toUpperCase() };
  return { age: n, rawGrade };
}

function cleanTeam(name, gradeAge) {
  if (gradeAge) {
    const ageNum = gradeAge.match(/^(U\d+(?:\.\d+)?)/i)?.[1];
    if (ageNum) {
      return name.replace(new RegExp('\\s+' + ageNum.replace('.','\\.')  + '\\b\\s*', 'gi'), ' ').replace(/\s+$/,'').trim();
    }
  }
  return name.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/,'').trim();
}

function getLogoUrl(logo) {
  if (!logo?.sizes?.length) return '';
  return (logo.sizes.find(s => s.dimensions?.width === 64) || logo.sizes[0]).url;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
// ─── Main ─────────────────────────────────────────────────────────────────────

// ─── Data directory ───────────────────────────────────────────────────────────
// Machine-written JSON lives in data/. config.json stays at the repo root because
// it is hand-edited configuration, not generated data.
//
// This moves any legacy root-level copies on first run, so the relocation needs
// no manual git operation — Mark has no local git. It no-ops thereafter. If a
// file exists in BOTH places, data/ is authoritative and the root copy is
// deleted, which is what happens on the run after the move.
function ensureDataDir() {
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['data.json', 'grades.json', 'clubs.json']) {
    const legacy = path.join(ROOT, name);
    const target = path.join(dir, name);
    if (!fs.existsSync(legacy)) continue;
    if (fs.existsSync(target)) {
      fs.unlinkSync(legacy);
      console.log(`Removed superseded root copy of ${name}`);
    } else {
      fs.renameSync(legacy, target);
      console.log(`Moved ${name} -> data/${name}`);
    }
  }
}

async function main() {
  ensureDataDir();
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

  // Build existing match index — purge all old scheduled records first
  // (scheduled record IDs include the age string, which may have changed)
  const byId = new Map(data.matches.filter(m => !m.scheduled).map(m => [m.id, m]));
  console.log(`Purged existing scheduled records. ${byId.size} real matches retained.`);
  const today = new Date().toISOString().slice(0, 10);

  let newCount = 0;
  const CONCURRENCY = 10; // parallel grade fetches

  const MAX_RETRIES = 3;

  async function gqlWithRetry(query, variables, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await gqlPost(query, variables);
        await sleep(FETCH_DELAY);
        return res;
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          console.log(`  RETRY ${label} (attempt ${attempt}): ${e.message}`);
          await sleep(1000 * attempt);
        } else {
          console.log(`  FAIL ${label} after ${MAX_RETRIES} attempts: ${e.message}`);
          return null;
        }
      }
    }
  }

  // Process one grade — returns array of scheduled match records
  async function processGrade(grade, idx) {
    console.log(`[${idx}/${grades.length}] ${grade.compName} — ${grade.name}`);

    const roundsRes = await gqlWithRetry(Q_GRADE_ROUNDS, { gradeID: grade.id }, grade.name);
    if (!roundsRes) return [];

    const roundList = roundsRes?.data?.discoverGrade?.rounds || [];
    if (!roundList.length) return [];

    const { age, rawGrade } = parseGradeName(grade.name, grade.ageName, grade.genderName);

    // Find current round boundary: prefer API's current flag, fall back to
    // highest round with completed results already stored in data.json.
    // Without this fallback, a -1 result causes slice(0) = ALL rounds,
    // overwriting completed results with scheduled:true null-score records.
    let currentRoundIndex = roundList.findIndex(r => r.current);
    if (currentRoundIndex === -1) {
      // Home-and-away only. Finals numbers restart at 1, so including them here
      // would compare a Grand Final's "1" against a Round 14 and could match the
      // wrong entry in roundList.
      const storedRounds = new Set(
        (data.matches || [])
          .filter(m => !m.scheduled && !m.isFinals && m.compName === grade.compName && m.age === age && m.rawGrade === rawGrade)
          .map(m => m.round)
      );
      if (storedRounds.size > 0) {
        const highestStored = Math.max(...storedRounds);
        currentRoundIndex = roundList.findIndex(r =>
          r.isFinalsRound !== true && parseInt(r.number, 10) === highestStored);
      }
    }

    const futureRounds = currentRoundIndex !== -1 ? roundList.slice(currentRoundIndex + 1) : [];
    if (!futureRounds.length) return [];

    const records = [];
    for (const round of futureRounds) {
      const number   = parseInt(round.number, 10) || 0;
      const isFinals = round.isFinalsRound === true;
      const fAbbrev  = isFinals ? (round.abbreviatedName || String(number)) : '';
      const fName    = isFinals ? (round.name || '') : '';
      const rToken   = roundToken(number, fAbbrev);
      const rLabel   = isFinals ? (fName || fAbbrev) : `R${number}`;

      const fixtureRes = await gqlWithRetry(Q_FIXTURE, { roundID: round.id }, `${grade.name} ${rLabel}`);
      if (!fixtureRes) continue;

      const games = fixtureRes?.data?.discoverFixtureByRound?.games || [];
      if (!games.length) continue;

      for (const game of games) {
        if (game.status?.value === 'FINAL') continue;

        // A DiscoverTeam carries an id; a ProvisionalTeam does not. Provisional
        // sides are placeholders such as "Winner Game 1" that PlayHQ publishes
        // before a finals fixture's qualifiers are known.
        const homeProv = !game.home?.id && !!game.home?.name;
        const awayProv = !game.away?.id && !!game.away?.name;
        const provisional = homeProv || awayProv;

        // Provisional names are stored verbatim — they are not club names and
        // must not be put through the age-stripping cleaner.
        const homeName = homeProv ? game.home.name.trim() : cleanTeam(game.home?.name || '', age);
        const awayName = awayProv ? game.away.name.trim() : cleanTeam(game.away?.name || '', age);
        if (!homeName || !awayName) continue;

        const matchId = `${grade.compName}|${age}|${rawGrade}|${rToken}|${[homeName, awayName].sort().join('|')}`;
        if (byId.has(matchId) && !byId.get(matchId).scheduled) continue;

        const vLat = game.allocation?.court?.venue?.latitude || '';
        const vLng = game.allocation?.court?.venue?.longitude || '';
        records.push({
          id: matchId, age, rawGrade, round: number,
          ...(isFinals ? { isFinals: true, finalsAbbrev: fAbbrev, finalsName: fName } : {}),
          ...(provisional ? { provisional: true } : {}),
          compName: grade.compName,
          home: homeName, away: awayName,
          hScore: null, hG: null, hB: null,
          aScore: null, aG: null, aB: null,
          venue:    game.allocation?.court?.venue?.name    || '',
          vSuburb:  game.allocation?.court?.venue?.suburb  || '',
          venueUrl: vLat && vLng ? `https://maps.google.com/?q=${vLat},${vLng}` : '',
          hLogo: homeProv ? '' : getLogoUrl(game.home?.logo),
          aLogo: awayProv ? '' : getLogoUrl(game.away?.logo),
          date: game.date || '',
          time: game.allocation?.dateTimeList?.[0]?.time || '',
          scheduled: true,
        });
      }
    }
    console.log(`  [${idx}] ${records.length} fixture(s)`);
    return records;
  }

  // Process in parallel batches
  for (let i = 0; i < grades.length; i += CONCURRENCY) {
    const batch = grades.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((g, j) => processGrade(g, i + j + 1)));
    for (const records of results) {
      for (const r of records) {
        byId.set(r.id, r);
        newCount++;
      }
    }
  }

  // Write back — preserve all existing matches, add/update scheduled ones
  data.matches = [...byId.values()];
  data.lastFixtureFetch = new Date().toISOString();
  // data.json is written MINIFIED. At 53MB pretty-printed it was 98% of the
  // repository, checked out by every workflow run and downloaded by every
  // visitor. All four writers — fetch-results, fetch-fixtures, fetch-stats and
  // build-club-index — must agree, or whichever runs next re-inflates the file
  // and every run produces a whole-file diff.
  fs.writeFileSync(DATA_PATH, JSON.stringify(data), 'utf8');
  console.log(`\nFixtures: ${newCount} new scheduled records written`);
  console.log('Wrote data.json');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
