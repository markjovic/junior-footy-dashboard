#!/usr/bin/env node
// scripts/fetch-results.js
//
// 1. Reads config.json for competition season IDs
// 2. Calls gradeListDiscoverSeason to discover all grades (diffs against grades.json cache)
// 3. For each grade, fetches new rounds only via gradeRounds + discoverFixtureByRound
// 4. Rebuilds roster from match history (current grade = last grade a team appeared in)
// 5. Merges everything into data.json and exits 0 (changes) or 2 (no changes)

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT         = path.resolve(__dirname, '..');
const CONFIG_PATH  = path.join(ROOT, 'config.json');
const GRADES_PATH  = path.join(ROOT, 'grades.json');
const DATA_PATH    = path.join(ROOT, 'data.json');

// ─── Config ───────────────────────────────────────────────────────────────────

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '150', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'Mozilla/5.0 (compatible; EFNL-dashboard-bot/1.0)';

// ─── Date helper ─────────────────────────────────────────────────────────────

function todayAEST() {
  const now = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const Q_GRADE_LIST = `
query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition {
      organisation {
        name
        logo {
          sizes {
            url
            dimensions { width height }
          }
        }
      }
    }
    grades {
      id
      name
    }
  }
}`;

const Q_GRADE_ROUNDS = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    rounds {
      id
      name
      number
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
        ... on DiscoverTeam {
          id
          name
          logo { sizes { url dimensions { width height } } }
        }
      }
      away {
        ... on DiscoverTeam {
          id
          name
          logo { sizes { url dimensions { width height } } }
        }
      }
      result {
        home {
          statistics { count type { value } }
        }
        away {
          statistics { count type { value } }
        }
      }
      status { value }
      date
      allocation {
        court {
          venue {
            name
            suburb
            state
            latitude
            longitude
          }
        }
      }
    }
  }
}`;

// ─── HTTP / GraphQL ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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

// ─── Name helpers ─────────────────────────────────────────────────────────────

// Derive { age, rawGrade } from a PlayHQ grade name e.g. "U12 Girls B"
function parseGradeName(name) {
  // Strip leading asterisk e.g. "* Premier - ..."
  let n = name.replace(/^\*\s*/, '').trim();
  // Strip sponsor prefix only when followed by a U-age group
  // e.g. "Deakin Uni - U16 Girls - A" → "U16 Girls - A"
  n = n.replace(/^.+?-\s*(?=U\d)/i, '');
  // Replace remaining " - " separators with spaces
  n = n.replace(/\s+-\s+/g, ' ').trim();
  // Strip "(Grading)" suffix
  if (/\(Grading\)/i.test(n)) return { age: n.replace(/\s*\(Grading\)/i, '').trim(), rawGrade: 'Grading' };
  // Match junior grades: "U12 B", "U12 Girls B", "U17.5 C", "U13 D1", "U18 Girls A/B"
  const m = n.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*(?:\/[A-D]\d*)?)$/i);
  if (m) return { age: m[1].trim(), rawGrade: m[2].toUpperCase() };
  // Senior/Women/Veterans — preserve full name as age, no grade
  return { age: n, rawGrade: '' };
}

// Strip age suffix and trailing colour word from team names e.g. "Norwood U12" → "Norwood"
function cleanTeam(name) {
  // Strip age group suffix only — preserve colour words (Purple, Gold etc.)
  // so that "Norwood Purple" and "Norwood Gold" remain distinct team identities.
  // Colour stripping only happens in getCrestImg for logo lookup purposes.
  return name.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/,'').trim();
}

function getStat(stats, type) {
  const s = (stats || []).find(s => s.type.value === type);
  return s ? s.count : 0;
}

function getLogoUrl(logo) {
  if (!logo?.sizes?.length) return '';
  return (logo.sizes.find(s => s.dimensions?.width === 64) || logo.sizes[0]).url;
}

// ─── Grade discovery ──────────────────────────────────────────────────────────

async function discoverGrades(competitions) {
  // Load cached grade list
  let cached = [];
  if (fs.existsSync(GRADES_PATH)) {
    try { cached = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
    catch (e) { console.warn('Could not parse grades.json — treating as empty'); }
  }
  const cachedById = new Map(cached.map(g => [g.id, g]));

  const allGrades = [];
  let gradeChanges = false;

  for (const comp of competitions) {
    console.log(`\nDiscovering grades for: ${comp.name} (seasonID: ${comp.seasonID})`);

    let res;
    try {
      res = await gqlPost(Q_GRADE_LIST, { id: comp.seasonID });
      await sleep(FETCH_DELAY);
    } catch (e) {
      console.error(`  gradeListDiscoverSeason failed: ${e.message}`);
      continue;
    }

    const allGradesRaw = res?.data?.discoverSeason?.grades || [];
    console.log(`  Found ${allGradesRaw.length} grade(s) from PlayHQ`);

    // Filter grades using excludeGrades list from config only.
    // Each entry is matched as a case-insensitive substring against the grade name.
    const excludeList = (comp.excludeGrades || []).map(e => e.toLowerCase());

    const grades = excludeList.length ? allGradesRaw.filter(g => {
      if (excludeList.some(ex => g.name.toLowerCase().includes(ex))) {
        console.log(`  ~ EXCLUDED (config): ${g.name}`);
        return false;
      }
      return true;
    }) : allGradesRaw;
    console.log(`  ${grades.length} grade(s) after filtering`);

    // Diff against cache
    const liveIds = new Set(grades.map(g => g.id));
    const cachedIds = new Set([...cachedById.keys()].filter(id =>
      cached.find(g => g.id === id)?.seasonID === comp.seasonID
    ));

    // Extract competition logo (largest available size)
    const orgLogo = res?.data?.discoverSeason?.competition?.organisation?.logo?.sizes || [];
    const compLogoUrl = orgLogo.length
      ? (orgLogo.find(s => s.dimensions?.width === 128) || orgLogo[orgLogo.length - 1]).url
      : '';

    grades.forEach(g => {
      const prev = cachedById.get(g.id);
      if (!prev) {
        console.log(`  + NEW grade: ${g.name} (${g.id})`);
        gradeChanges = true;
      } else if (prev.name !== g.name) {
        console.log(`  ~ RENAMED: "${prev.name}" → "${g.name}" (${g.id})`);
        gradeChanges = true;
      }
      allGrades.push({ id: g.id, name: g.name, seasonID: comp.seasonID, compName: comp.name, compLogoUrl });
    });

    // Log removals
    cachedIds.forEach(id => {
      if (!liveIds.has(id)) {
        const prev = cachedById.get(id);
        console.log(`  - REMOVED grade: ${prev?.name} (${id})`);
        gradeChanges = true;
      }
    });
  }

  // Update grades.json cache if anything changed
  if (gradeChanges || allGrades.length !== cached.length) {
    fs.writeFileSync(GRADES_PATH, JSON.stringify(allGrades, null, 2), 'utf8');
    console.log(`\nUpdated grades.json (${allGrades.length} grade(s))`);
  } else {
    console.log(`\nGrades unchanged (${allGrades.length} grade(s))`);
  }

  return allGrades;
}

// ─── Per-grade results fetcher ────────────────────────────────────────────────

async function fetchGrade(grade, knownRounds, byId) {
  const { id, name } = grade;
  const { age, rawGrade } = parseGradeName(name);
  const today = todayAEST();
  const highestKnown = knownRounds.get(`${age}|${rawGrade}`) || 0;

  console.log(`\n  [${name}] — known up to R${highestKnown}`);
  try {

  // Get round list for this grade
  let roundList;
  try {
    const res = await gqlPost(Q_GRADE_ROUNDS, { gradeID: id });
    roundList = res?.data?.discoverGrade?.rounds;
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`    gradeRounds error: ${e.message}`);
    return [];
  }

  if (!roundList?.length) {
    console.log(`    no rounds returned`);
    return [];
  }

  const allMatches = [];

  for (const round of roundList) {
    const { id: roundID, number, provisionalDates, isFinalsRound, current } = round;

    // Skip already-stored rounds
    if (number <= highestKnown) {
      console.log(`    R${number} ... already stored`);
      continue;
    }

    // Primary future-round detection: use PlayHQ's own `current` flag.
    // If a round is marked current, it's either in progress or the next to be played.
    // Rounds AFTER the current round haven't been played — skip them.
    // We still fetch the current round itself since it may have finals.
    //
    // Fallback: if no round is marked current (e.g. season not started),
    // use provisionalDates but only trust dates > 90 days away to avoid
    // PlayHQ data entry errors (wrong dates on regular rounds).
    const roundIndex = roundList.indexOf(round);
    const currentRoundIndex = roundList.findIndex(r => r.current);
    if (currentRoundIndex !== -1 && roundIndex > currentRoundIndex) {
      console.log(`    R${number} ... beyond current round — stopping`);
      break;
    }
    if (currentRoundIndex === -1) {
      // No current round flagged — fall back to provisional dates
      const dates = (provisionalDates || []).map(d => {
        const dt = new Date(d);
        return isNaN(dt) ? d : dt.toISOString().slice(0, 10);
      });
      const earliest = dates.length ? dates.slice().sort()[0] : null;
      if (earliest) {
        const daysAhead = (new Date(earliest) - new Date(today)) / (1000 * 60 * 60 * 24);
        if (daysAhead > 90) {
          console.log(`    R${number} ... future (${earliest}, ${Math.round(daysAhead)} days away) — stopping`);
          break;
        }
      }
    }

    // Skip fixture fetch if this round is already stored as a bye sentinel
    const byeKey = `${age}|${rawGrade}|${number}|__bye__`;
    if (byId.has(byeKey)) {
      // Already know it's a bye — push sentinel and continue without API call
      allMatches.push(byId.get(byeKey));
      continue;
    }

    process.stdout.write(`    R${number}${isFinalsRound ? ' [Finals]' : ''} ... `);

    let fixtureRes;
    let fetchAttempts = 0;
    while (fetchAttempts < 2) {
      try {
        fixtureRes = await gqlPost(Q_FIXTURE, { roundID });
        await sleep(FETCH_DELAY);
        break;
      } catch (e) {
        fetchAttempts++;
        if (fetchAttempts >= 2) {
          console.log(`API error after ${fetchAttempts} attempts: ${e.message} — skipping round`);
          fixtureRes = null;
        } else {
          console.log(`API error (attempt ${fetchAttempts}): ${e.message} — retrying in 5s`);
          await sleep(5000);
        }
      }
    }
    if (!fixtureRes) continue; // skip this round, don't break — try next round

    const games = fixtureRes?.data?.discoverFixtureByRound?.games || [];
    const finalGames = games.filter(g => g.status?.value === 'FINAL');

    if (games.length === 0) {
      // No games — bye round. Push a sentinel so knownRounds advances past it.
      console.log(`bye — continuing`);
      allMatches.push({ id: `${age}|${rawGrade}|${number}|__bye__`,
        age, rawGrade, round: number,
        home: '__bye__', away: '__bye__',
        hScore:0, hG:0, hB:0, aScore:0, aG:0, aB:0,
        venue:'', venueUrl:'', hLogo:'', aLogo:'', date:'', isBye: true });
      continue;
    }

    if (finalGames.length === 0) {
      // Games scheduled but none final — not played yet, stop
      console.log(`scheduled, not yet played — stopping`);
      break;
    }

    const matches = [];
    for (const game of finalGames) {
      const homeName = cleanTeam(game.home?.name || '');
      const awayName = cleanTeam(game.away?.name || '');
      if (!homeName || !awayName) continue;

      const hStats = game.result?.home?.statistics || [];
      const aStats = game.result?.away?.statistics || [];
      const hG     = getStat(hStats, 'TOTAL_GOALS');
      const hB     = getStat(hStats, 'TOTAL_BEHINDS');
      const hScore = getStat(hStats, 'TOTAL_SCORE');
      const aG     = getStat(aStats, 'TOTAL_GOALS');
      const aB     = getStat(aStats, 'TOTAL_BEHINDS');
      const aScore = getStat(aStats, 'TOTAL_SCORE');

      const venue    = game.allocation?.court?.venue?.name    || '';
      const vSuburb  = game.allocation?.court?.venue?.suburb  || '';
      const vLat     = game.allocation?.court?.venue?.latitude  || '';
      const vLng     = game.allocation?.court?.venue?.longitude || '';
      const venueUrl = vLat && vLng ? `https://maps.google.com/?q=${vLat},${vLng}` : '';

      // Dedup key — same as dashboard
      const matchId = `${age}|${rawGrade}|${number}|${[homeName, awayName].sort().join('|')}`;

      matches.push({
        id: matchId, age, rawGrade, round: number,
        home: homeName, away: awayName,
        hScore, hG, hB,
        aScore, aG, aB,
        venue, vSuburb, venueUrl,
        hLogo: getLogoUrl(game.home?.logo),
        aLogo: getLogoUrl(game.away?.logo),
        date: game.date || '',
      });
    }

    console.log(`${matches.length} result(s)`);
    allMatches.push(...matches);
  }

  return allMatches;
  } catch (e) {
    console.error(`  FATAL ERROR in [${name}]: ${e.message}`);
    return allMatches;
  }
}

// ─── Roster rebuild ───────────────────────────────────────────────────────────
// Current grade for each team = the grade they appeared in during their
// highest round number across all stored matches.
// If a team appears in two different grades in the same round (shouldn't
// happen but could during a transition), alphabetically earlier grade wins
// and a warning is logged.

function rebuildRoster(matches) {
  // Key by "teamName|age" so clubs with multiple teams in different age groups
  // don't overwrite each other. e.g. "Norwood|U12" and "Norwood|U14" are separate.
  // latest: "teamName|age" → { grade, age, round }
  const latest = new Map();

  matches.forEach(m => {
    [
      { name: m.home, grade: m.rawGrade, age: m.age, round: m.round },
      { name: m.away, grade: m.rawGrade, age: m.age, round: m.round },
    ].forEach(({ name, grade, age, round }) => {
      const key = `${name}|${age}`;
      const prev = latest.get(key);
      if (!prev || round > prev.round) {
        latest.set(key, { grade, age, round });
      } else if (round === prev.round && grade !== prev.grade) {
        // Same team, same age, same round, different grades — take higher grade
        const winner = [prev.grade, grade].sort()[0];
        console.warn(`  WARNING: ${name} (${age}) in both grade ${prev.grade} and ${grade} in R${round} — keeping ${winner}`);
        latest.set(key, { ...prev, grade: winner });
      }
    });
  });

  // Return roster keyed by "teamName|age": { grade, age }
  // Dashboard currentGrade() must look up by this same key
  const roster = {};
  latest.forEach(({ grade, age }, key) => {
    roster[key] = { grade, age };
  });
  return roster;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load config.json
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('config.json not found at', CONFIG_PATH);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const competitions = config.competitions || [];
  if (!competitions.length) {
    console.error('No competitions defined in config.json');
    process.exit(1);
  }

  // 2. Load existing data.json
  let existing = { matches: [], players: [], gotwFlags: {} };
  if (fs.existsSync(DATA_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      console.log(`Loaded data.json: ${(existing.matches || []).length} existing match(es)`);
    } catch (e) {
      console.warn('Could not parse data.json — starting fresh');
    }
  } else {
    console.log('No data.json — will create');
  }

  // 3. Discover grades (diffs against grades.json cache)
  const grades = await discoverGrades(competitions);
  if (!grades.length) {
    console.error('No grades found — aborting');
    process.exit(1);
  }

  // 4. Build dedup map and per-grade highest-known-round map from existing matches
  const byId = new Map();
  const knownRounds = new Map(); // "age|rawGrade" → highest round in data.json

  // Build a map of which rounds exist per grade
  const roundsByGrade = new Map();
  (existing.matches || []).forEach(m => {
    byId.set(m.id, m);
    const key = `${m.age}|${m.rawGrade}`;
    if (!roundsByGrade.has(key)) roundsByGrade.set(key, new Set());
    roundsByGrade.get(key).add(m.round);
  });

  // knownRounds = highest *consecutive* round from R1 with no gaps.
  // Always start counting from R1. If R1 is missing (e.g. 504 error on first run)
  // but R2-R6 are stored, knownRounds stays 0 so R1 is retried next run.
  // Exception: grades that genuinely start later (byes in R1-R4) will have
  // minRound > 1. For those, we treat the gap as intentional (byes) only if
  // the gap is covered by bye rounds — determined at fetch time, not here.
  // Safest approach: always walk from R1, treating missing rounds as gaps.
  roundsByGrade.forEach((rounds, key) => {
    let consecutive = 0;
    for (let r = 1; rounds.has(r); r++) consecutive = r;
    knownRounds.set(key, consecutive);
  });

  // 5. Fetch new results for each grade
  let newCount = 0;
  let updatedCount = 0;
  let fetchError = null;

  for (const grade of grades) {
    const matches = await fetchGrade(grade, knownRounds, byId);

    for (const m of matches) {
      if (byId.has(m.id)) {
        const prev = byId.get(m.id);
        const changed = ['hScore','hG','hB','aScore','aG','aB'].some(k => prev[k] !== m[k]);
        byId.set(m.id, { ...prev, ...m });
        if (changed) updatedCount++;
      } else {
        byId.set(m.id, m);
        newCount++;
      }
    }
  }

  if (fetchError) console.error(`\nFetch loop error: ${fetchError.message}`);
  console.log(`\nMatches: ${newCount} new, ${updatedCount} updated, ${byId.size} total`);

  // 6. Rebuild roster from all match history
  // Separate real matches from bye sentinels
  const allValues = Array.from(byId.values());
  const allMatches = allValues
    .filter(m => !m.isBye)
    .sort((a, b) => a.age.localeCompare(b.age)
                 || a.rawGrade.localeCompare(b.rawGrade)
                 || a.round - b.round);

  // Include bye sentinels in knownRounds calculation but not in output
  const allWithByes = allValues.sort((a,b) => a.round - b.round);

  const roster = rebuildRoster(allMatches);
  console.log(`Roster: ${Object.keys(roster).length} team(s)`);

  // 7. Write data.json — preserve gotwFlags and players, replace matches and roster
  // Build lastRound map: "age|rawGrade" → highest round in data
  const lastRound = {};
  const teamLogos = { ...(existing.teamLogos || {}) };
  // Use allWithByes for round tracking so byes advance lastRound correctly
  allWithByes.forEach(m => {
    const key = `${m.age}|${m.rawGrade}`;
    if (!lastRound[key] || m.round > lastRound[key]) lastRound[key] = m.round;
    if (!m.isBye) {
      if (m.hLogo) teamLogos[m.home] = m.hLogo;
      if (m.aLogo) teamLogos[m.away] = m.aLogo;
    }
  });

  // Build compLogos map: compName → logo URL
  const compLogos = {};
  grades.forEach(g => { if (g.compLogoUrl) compLogos[g.compName] = g.compLogoUrl; });

  const merged = {
    ...existing,
    matches: allMatches,
    roster,
    lastRound,
    teamLogos,
    compLogos,
    lastUpdated: new Date().toISOString(),
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`Wrote data.json`);

  if (newCount === 0 && updatedCount === 0) {
    console.log('No match changes — skipping commit');
    process.exit(2);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
