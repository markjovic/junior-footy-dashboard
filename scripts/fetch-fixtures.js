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

const ROOT        = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');
const DATA_PATH   = path.join(ROOT, 'data', 'data.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '200', 10);

// ─── HTTP / GraphQL ───────────────────────────────────────────────────────────
// Session and transport come from the shared module, so all four writers behave
// identically. The local copies removed here captured only phq_session — not
// phq_tier or phq_sub, which playhq_api_reference.md requires in that order —
// never refreshed inside a run longer than the 30-40 minute cookie life, and
// could not tell a CloudFront WAF block from an expired session.

const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');
const store = require('./lib/store');


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

// Bump on every change. Printed at the top of every run so a stale copy in an
// Actions log is distinguishable from a real failure.
const VERSION = 'fetch-fixtures v4 2026-08-12 skip-players-on-load';

async function main() {
  console.log(`=== ${VERSION} ===`);
  ensureDataDir();
  await refreshSession();

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

  // Scoped to the competitions these grades belong to. The scheduled-record
  // purge below is therefore bounded to the organisations this run covers —
  // the other files are never opened.
  const storeScope = [...new Set(grades.map(g => g.compName).filter(Boolean))];
  let data;
  try {
    // Fixtures never touch player records. See results-engine.js.
    data = store.load(storeScope, { players: false });
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }

  // Build the existing match index. Scheduled records for the competitions this
  // run covers are purged and rewritten, because their ids embed the age string
  // and that can change.
  //
  // ⚠️ Scheduled records for competitions this run does NOT cover are RETAINED.
  // Purging all of them and re-adding only the ones fetched meant a VIP_ONLY run
  // deleted every other competition's fixtures until the next all-competition
  // run replaced them. EFNL is the only vip:true competition, so that was most
  // runs. This is the same defect fetch-results.js already fixes for grades.json
  // and gradeMeta, and fetch-stats.js for players — anything derived from a
  // filtered grade list must merge per competition rather than replace.
  const coveredComps = new Set(grades.map(g => g.compName));
  const keptScheduled = data.matches.filter(m => m.scheduled && !coveredComps.has(m.compName));
  const byId = new Map(
    data.matches
      .filter(m => !m.scheduled || !coveredComps.has(m.compName))
      .map(m => [m.id, m])
  );
  console.log(
    `Purged scheduled records for [${[...coveredComps].join(', ')}]. ` +
    `${byId.size - keptScheduled.length} real matches and ` +
    `${keptScheduled.length} scheduled record(s) from other competitions retained.`
  );

  // Compared against the final state to decide the exit code. Sorted by id
  // because byId's insertion order is not stable across runs and an ordering
  // difference is not a change.
  const canonical = arr =>
    JSON.stringify([...arr].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  const matchesBefore = canonical(data.matches);
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
          .filter(m => !m.scheduled && !m.isFinals && m.compName === grade.compName && m.age === age &&
                       ((m.gradeId || m.rawGrade) === grade.id || (!m.gradeId && m.rawGrade === rawGrade)))
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

        // The third segment is the GRADE ID, matching results-engine.js v5 and
        // every record migrate-grade-ids.js rewrote on 2026-08-12. A scheduled
        // record is overwritten by a played one, so the two must build the same
        // id or a fixture and its result become two records instead of one.
        const matchId = `${grade.compName}|${age}|${grade.id}|${rToken}|${[homeName, awayName].sort().join('|')}`;
        if (byId.has(matchId) && !byId.get(matchId).scheduled) continue;

        const vLat = game.allocation?.court?.venue?.latitude || '';
        const vLng = game.allocation?.court?.venue?.longitude || '';
        records.push({
          // gradeId is PlayHQ's own grade identity. rawGrade cannot carry it:
          // 62 keys across the stored seasons have two or more grades reducing
          // to one age|rawGrade. Captured here so scheduled records match what
          // results-engine.js v3 writes for played ones — a scheduled record is
          // overwritten by a played one and the two must agree on their fields.
          // Written and not yet read. grade_identity_migration.md step 4.
          id: matchId, age, rawGrade, gradeId: grade.id, round: number,
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
  store.report(store.save(data, storeScope), 'fetch-fixtures');
  console.log(`\nFixtures: ${newCount} new scheduled records written`);
  console.log('Wrote data.json');
  logSummary('fetch-fixtures');

  // Exit codes now match the other three writers: 0 = changed, 2 = no change,
  // 1 = fatal. Previously main() simply returned, so every run exited 0 and the
  // workflow always reached its commit step.
  if (canonical(data.matches) === matchesBefore) {
    console.log('No fixture changes — skipping commit');
    process.exit(2);
  }
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
