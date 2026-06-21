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
      age { name value }
      gender { name value }
    }
  }
}`;

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

function gqlPost(query, variables, operationName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(operationName
      ? { operationName, query, variables }
      : { query, variables });
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
function parseGradeName(name, ageName, genderName) {
  // Uses structured API fields (ageName, genderName) combined with name-based
  // disambiguation where the API is too coarse (e.g. "Senior" covers
  // Senior Men, Reserves, U19.5, Veterans).

  // Clean: strip leading asterisk, normalise " - " to " "
  let n = name.replace(/^\*\s*/, '').trim();
  n = n.replace(/\s+-\s+/g, ' ').trim();

  // Parenthetical division number: "U12 Mixed (1)", "U13 Mastercraft Construction Mixed (2)"
  // Must be checked before grading detection.
  const parenDivMatch = n.match(/\((\d+)\)\s*$/);
  if (parenDivMatch) {
    const divNum = parenDivMatch[1];
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName))
      ? ' ' + genderName : '';
    if (ageName?.match(/^U\d/i)) {
      const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
      const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName)
        ? nameAgeMatch[0].toUpperCase() : ageName;
      return { age: resolvedAge + genderSuffix, rawGrade: divNum };
    }
    // Non-U age e.g. "Youth Boys (1)" where ageName=U18
    return { age: (ageName || 'Unknown') + genderSuffix, rawGrade: divNum };
  }

  // Grading rounds — "U12 Mixed Grading" (no parens) or "(Grading)" suffix
  if (/\bGrading\b/i.test(n)) {
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName))
      ? ' ' + genderName : '';
    let ageLabel;
    if (ageName?.match(/^U\d/i)) {
      // Check name for .5 suffix (e.g. "U17.5 Boys GRADING" where ageName="U17")
      const halfAgeMatch = n.match(/^U(\d+\.5)/i);
      const resolvedAge = halfAgeMatch ? halfAgeMatch[0].toUpperCase() : ageName;
      ageLabel = resolvedAge + genderSuffix;
    } else {
      ageLabel = n.replace(/\s*\bGrading\b.*$/i, '').trim();
    }
    return { age: ageLabel, rawGrade: 'Grading' };
  }

  // Extract rawGrade from name: look for Premier, Division N, letter grade, Reserves
  const divMatch   = n.match(/\b(Premier(?:\s+Division)?|Division \d+)\b/i);
  const letterMatch = n.match(/\b([A-D]\d*(?:\/[A-D]\d*)?)\s*$/i);
  const rawGrade = divMatch
    ? divMatch[1].replace(/Premier Division/i, 'Premier')
    : letterMatch ? letterMatch[1].toUpperCase() : '';

  // Junior age groups: ageName starts with U (U12, U16, U18 etc.)
  if (ageName?.match(/^U\d/i)) {
    // Prefer age from grade name when more specific than ageName
    // e.g. PlayHQ returns ageName="U17" for U17.5 competitions
    const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
    const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName)
      ? nameAgeMatch[0].toUpperCase()
      : ageName;
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName))
      ? ' ' + genderName : '';
    // If rawGrade is still empty, check for a trailing colour/division word
    // e.g. SEJ "U11 Mixed Blue" → rawGrade "Blue", "U12 Mixed Red" → "Red"
    let resolvedRawGrade = rawGrade;
    if (!resolvedRawGrade) {
      const colourMatch = n.match(/\b(Blue|Red|Green|Gold|White|Black|Yellow|Purple|Orange|Navy|Silver|Teal|Grey|Gray|Maroon|Pink)\s*$/i);
      if (colourMatch) resolvedRawGrade = colourMatch[1];
    }
    return { age: resolvedAge + genderSuffix, rawGrade: resolvedRawGrade };
  }

  // Senior/Open: use name to distinguish Senior Men / Reserves / U19.5 / Veterans
  if (ageName === 'Senior' || ageName === 'Open' || ageName?.match(/^Masters?/i) || !ageName) {
    // Veterans / Masters — name contains Veterans or ageName starts with Master
    if (/Veterans/i.test(n) || ageName?.match(/^Masters?/i)) {
      const vGender = /Women/i.test(n) ? 'Women'
        : /Men/i.test(n) ? 'Men'
        : genderName === 'Women' ? 'Women' : 'Men';
      return { age: 'Veterans', rawGrade: vGender };
    }
    // U19.5
    if (/U19\.5/i.test(n)) return { age: 'U19.5', rawGrade };
    // Reserves / Reserve
    if (/Reserves?/i.test(n)) return { age: 'Reserve ' + (genderName || 'Men'), rawGrade };
    // Senior Women / Women divisions
    if (genderName === 'Women' || /Women/i.test(n)) return { age: 'Senior Women', rawGrade };
    // Only map to 'Senior Men' if name contains 'Senior', else preserve cleaned name (e.g. 'Thirds')
    if (/Senior/i.test(n)) return { age: 'Senior ' + (genderName || 'Men'), rawGrade };
    const cleanedAge = n.replace(/\s*(Premier|Division \d+).*$/i, '').trim();
    return { age: cleanedAge || n, rawGrade };
  }

  // Other structured age (e.g. "Junior", "Intermediate")
  if (ageName) {
    return { age: ageName + (genderName ? ' ' + genderName : ''), rawGrade };
  }

  // Pure fallback: strip sponsor prefix before U-age, try letter grade pattern
  n = n.replace(/^.+?(?=U\d)/i, '').trim();
  const junior = n.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*(?:\/[A-D]\d*)?)$/i);
  if (junior) return { age: junior[1].trim(), rawGrade: junior[2].toUpperCase() };
  return { age: n, rawGrade };
}

// Strip age suffix and trailing colour word from team names e.g. "Norwood U12" → "Norwood"
function cleanTeam(name, gradeAge) {
  // Strip only the grade's own age suffix from the team name.
  // PlayHQ appends the competition age to team names (e.g. "Officer JFC U14 Girls Blue")
  // but we must only strip the matching age — "Officer JFC U13 Girls" playing in a
  // U14 Girls grade should remain "Officer JFC U13 Girls" to stay distinct.
  // If gradeAge is provided, strip only that specific age token.
  // If not provided, strip any U-age suffix (legacy fallback).
  if (gradeAge) {
    // Extract just the U-number part e.g. "U14" from "U14 Girls" or "U17.5"
    const ageNum = gradeAge.match(/^(U\d+(?:\.\d+)?)/i)?.[1];
    if (ageNum) {
      return name.replace(new RegExp('\\s+' + ageNum.replace('.','\\.')  + '\\b\\s*', 'gi'), ' ').replace(/\s+$/,'').trim();
    }
  }
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

    // Filter grades using excludeGrades list from config.
    // Each entry is matched as a case-insensitive substring against the normalised grade name.
    const excludeList = (comp.excludeGrades || []).map(e => e.toLowerCase());
    const grades = excludeList.length ? allGradesRaw.filter(g => {
      const normName = g.name.toLowerCase().replace(/\bu0*(\d+)/g, 'u$1');
      if (excludeList.some(ex => normName.includes(ex))) {
        console.log(`  ~ EXCLUDED (config): ${g.name}`);
        return false;
      }
      return true;
    }) : allGradesRaw;
    if (excludeList.length) console.log(`  ${grades.length} grade(s) after filtering`);

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
      allGrades.push({
        id: g.id,
        name: g.name,
        ageName: g.age?.name || '',      // e.g. "Senior", "U12", "U16"
        genderName: g.gender?.name || '', // e.g. "Men", "Women", "Girls", "Mixed"
        seasonID: comp.seasonID,
        compName: comp.name,
        compLogoUrl,
      });
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
  const { id, name, ageName = '', genderName = '' } = grade;
  const { age, rawGrade } = parseGradeName(name, ageName, genderName);
  const today = todayAEST();
  const highestKnown = knownRounds.get(`${grade.compName}|${age}|${rawGrade}`) || 0;

  console.log(`  known up to R${highestKnown}`);
  try {

  // Get round list for this grade
  let roundList;
  let gradeDates = [];
  try {
    const res = await gqlPost(Q_GRADE_ROUNDS, { gradeID: id });
    const gradeData = res?.data?.discoverGrade;
    roundList = gradeData?.rounds;
    gradeDates = gradeData?.dates || []; // e.g. ["2026-04","2026-05","2026-08"]
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`    gradeRounds error: ${e.message}`);
    return [];
  }

  if (!roundList?.length) {
    console.log(`    no rounds returned`);
    return [];
  }

  // If grade-level dates are available and all are in the past,
  // the season is over — skip entirely
  if (gradeDates.length) {
    const latestMonth = gradeDates.slice().sort().pop(); // e.g. "2026-08"
    const latestDate = latestMonth + '-31'; // end of that month
    if (latestDate < today) {
      console.log(`    season ended (last month: ${latestMonth}) — skipping`);
      return [];
    }
  }

  const allMatches = [];

  // If the grade's first round number is > 1 (e.g. started at R5 after grading),
  // fill R1 through firstRound-1 with bye sentinels so knownRounds advances correctly
  // and we don't retry non-existent early rounds on every run.
  const firstRoundNumber = parseInt(roundList[0]?.number, 10) || 1;
  if (firstRoundNumber > 1 && highestKnown < firstRoundNumber - 1) {
    for (let r = Math.max(1, highestKnown + 1); r < firstRoundNumber; r++) {
      const byeKey = `${grade.compName}|${age}|${rawGrade}|${r}|__bye__`;
      if (!byId.has(byeKey)) {
        console.log(`    R${r} ... implied bye (grade starts at R${firstRoundNumber})`);
        allMatches.push({ id: byeKey, age, rawGrade, round: r, compName: grade.compName,
          home: '__bye__', away: '__bye__',
          hScore:0, hG:0, hB:0, aScore:0, aG:0, aB:0,
          venue:'', venueUrl:'', hLogo:'', aLogo:'', date:'', isBye: true });
      }
    }
  }

  for (const round of roundList) {
    const { id: roundID, provisionalDates, isFinalsRound, current } = round;
    const number = parseInt(round.number, 10) || 0;

    // Skip already-stored rounds — but always re-fetch the highest known round
    // in case it was partial, or results were amended after storage.
    if (number < highestKnown) {
      console.log(`    R${number} ... already stored`);
      continue;
    }
    if (number === highestKnown) {
      console.log(`    R${number} ... re-checking latest stored round`);
      // fall through to fetch
    }

    // Future-round detection strategy:
    // 1. If ANY round in this grade is marked current, trust that entirely.
    //    Rounds after current haven't been played. Rounds before current have.
    //    provisionalDates is ignored — it contains data entry errors in PlayHQ
    //    (e.g. Premier Reserve Men R1 shows 2026-11-04 instead of 2026-04-11).
    // 2. If NO round is marked current (season not started or finished),
    //    fall back to provisionalDates but only stop if > 90 days away.
    const currentRoundIndex = roundList.findIndex(r => r.current);
    if (currentRoundIndex !== -1) {
      // A current round exists — use it as the cutoff
      const roundIndex = roundList.indexOf(round);
      if (roundIndex > currentRoundIndex) {
        console.log(`    R${number} ... beyond current round — stopping`);
        break;
      }
      // Rounds up to and including current are fetched (may have finals)
    } else {
      // No current round flagged — use grade-level dates to check if season has started.
      // provisionalDates on individual rounds is unreliable (data entry errors in PlayHQ).
      // If the grade's first active month is still in the future, stop here.
      if (gradeDates.length) {
        const earliestMonth = gradeDates.slice().sort()[0]; // e.g. "2026-04"
        if (earliestMonth > today.slice(0, 7)) {
          console.log(`    R${number} ... season not started yet (starts ${earliestMonth}) — stopping`);
          break;
        }
      } else {
        // No grade dates — last resort: provisionalDates > 90 days
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
    }

    // Skip fixture fetch if this round is already stored as a bye sentinel
    const byeKey = `${grade.compName}|${age}|${rawGrade}|${number}|__bye__`;
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
      allMatches.push({ id: `${grade.compName}|${age}|${rawGrade}|${number}|__bye__`,
        age, rawGrade, round: number, compName: grade.compName,
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
      const homeName = cleanTeam(game.home?.name || '', age);
      const awayName = cleanTeam(game.away?.name || '', age);
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
      const matchId = `${grade.compName}|${age}|${rawGrade}|${number}|${[homeName, awayName].sort().join('|')}`;

      matches.push({
        id: matchId, age, rawGrade, round: number,
        compName: grade.compName,
        home: homeName, away: awayName,
        hScore, hG, hB,
        aScore, aG, aB,
        venue, vSuburb, venueUrl,
        hLogo: getLogoUrl(game.home?.logo),
        aLogo: getLogoUrl(game.away?.logo),
        date: game.date || '',
      });
    }

    const isPartial = finalGames.length < games.length;
    if (isPartial) {
      console.log(`${matches.length} result(s) (PARTIAL — ${games.length - finalGames.length} game(s) not yet final)`);
      // Store a partial sentinel so this round is re-fetched next run
      allMatches.push({
        id: `${grade.compName}|${age}|${rawGrade}|${number}|__partial__`,
        age, rawGrade, round: number, compName: grade.compName,
        home: '__partial__', away: '__partial__',
        hScore:0, hG:0, hB:0, aScore:0, aG:0, aB:0,
        venue:'', venueUrl:'', hLogo:'', aLogo:'', date:'', isPartial: true,
      });
    } else {
      console.log(`${matches.length} result(s)`);
    }
    allMatches.push(...matches);
  }

  // Post-loop: if a partial round exists but any later round has complete results,
  // the partial will never be completed (forfeit, error etc.) — remove its sentinel.
  const completeRounds = new Set(
    allMatches.filter(m => !m.isPartial && !m.isBye && m.compName === grade.compName && m.age === age && m.rawGrade === rawGrade)
      .map(m => m.round)
  );
  const maxCompleteRound = completeRounds.size ? Math.max(...completeRounds) : 0;
  const stalledPartials = allMatches.filter(m =>
    m.isPartial && m.round < maxCompleteRound
  );
  if (stalledPartials.length) {
    stalledPartials.forEach(m => {
      console.log(`    R${m.round} partial promoted to complete (later rounds up to R${maxCompleteRound} are complete)`);
    });
    const stalledRounds = new Set(stalledPartials.map(m => m.round));
    return allMatches.filter(m => !(m.isPartial && stalledRounds.has(m.round)));
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
      { name: m.home, grade: m.rawGrade, age: m.age, round: m.round, compName: m.compName || '' },
      { name: m.away, grade: m.rawGrade, age: m.age, round: m.round, compName: m.compName || '' },
    ].forEach(({ name, grade, age, round, compName }) => {
      const key = `${compName}|${name}|${age}`;
      const prev = latest.get(key);
      if (!prev || round > prev.round) {
        latest.set(key, { grade, age, round, compName });
      } else if (round === prev.round && grade !== prev.grade) {
        // Same team, same age, same round, different grades
        // Prefer non-empty grade, then alphabetically earlier (A < B < C < D)
        const winner = (!prev.grade && grade) ? grade
          : (prev.grade && !grade) ? prev.grade
          : [prev.grade, grade].sort()[0];
        console.warn(`  WARNING: ${name} (${age}) in both grade ${prev.grade} and ${grade} in R${round} — keeping ${winner}`);
        latest.set(key, { ...prev, grade: winner, compName });
      }
    });
  });

  // Return roster keyed by "teamName|age": { grade, age }
  // Dashboard currentGrade() must look up by this same key
  const roster = {};
  latest.forEach(({ grade, age, compName }, key) => {
    roster[key] = { grade, age, compName };
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
  const allCompetitions = config.competitions || [];
  if (!allCompetitions.length) {
    console.error('No competitions defined in config.json');
    process.exit(1);
  }
  // VIP_ONLY env var: only fetch VIP competitions (set by workflow for most runs)
  const vipOnly = process.env.VIP_ONLY === 'true';
  const competitions = vipOnly
    ? allCompetitions.filter(c => c.vip)
    : allCompetitions;
  console.log(`Fetching ${vipOnly ? 'VIP' : 'ALL'} competitions: ${competitions.map(c=>c.name).join(', ')}`);


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

  // Build a map of which rounds exist per grade, and which are partial
  const roundsByGrade = new Map();
  const partialRounds = new Map(); // key → Set of partial round numbers
  (existing.matches || []).forEach(m => {
    byId.set(m.id, m);
    // Scheduled (fixture-only) records must not affect highestKnown —
    // they have no scores and would cause fetch-results to skip real rounds
    if (m.scheduled) return;
    // Key by compName|age|rawGrade to keep competitions separate
    const key = `${m.compName || ''}|${m.age}|${m.rawGrade}`;
    if (!roundsByGrade.has(key)) roundsByGrade.set(key, new Set());
    roundsByGrade.get(key).add(m.round);
    // Track partial rounds — these must be re-fetched even if within consecutive count
    if (m.isPartial) {
      if (!partialRounds.has(key)) partialRounds.set(key, new Set());
      partialRounds.get(key).add(m.round);
    }
  });

  // knownRounds = highest *consecutive* round from R1 with no gaps,
  // excluding partial rounds (they need re-fetching).
  roundsByGrade.forEach((rounds, key) => {
    const partial = partialRounds.get(key) || new Set();
    let consecutive = 0;
    for (let r = 1; rounds.has(r) && !partial.has(r); r++) consecutive = r;
    knownRounds.set(key, consecutive);
  });

  // 5. Fetch new results for each grade
  let newCount = 0;
  let updatedCount = 0;
  let fetchError = null;
  let resultsGradeIdx = 0;

  for (const grade of grades) {
    resultsGradeIdx++;
    console.log(`\n[${resultsGradeIdx}/${grades.length}] ${grade.compName} — ${grade.name}`);
    const matches = await fetchGrade(grade, knownRounds, byId);

    for (const m of matches) {
      // Remove partial sentinel for this round when we have fresh results
      if (m.isPartial) {
        // This IS a new partial sentinel — store it (will overwrite old one by id)
      } else {
        // Remove any existing partial sentinel for this round/grade
        const partialKey = `${m.compName}|${m.age}|${m.rawGrade}|${m.round}|__partial__`;
        byId.delete(partialKey);
      }
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
    .filter(m => !m.isBye && !m.isPartial)
    .sort((a, b) => a.age.localeCompare(b.age)
                 || a.rawGrade.localeCompare(b.rawGrade)
                 || a.round - b.round);

  // Include bye sentinels in round tracking but not in output.
  // Exclude scheduled records entirely — fetch-fixtures.js owns them.
  // They will be re-added on the next fetch-fixtures run.
  const allWithByes = allValues
    .filter(m => !m.scheduled)
    .sort((a,b) => a.round - b.round);

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
    matches: allWithByes,
    roster,
    lastRound,
    teamLogos,
    compLogos,
    lastUpdated: new Date().toISOString(),
    lastResultsFetch: new Date().toISOString(),
    // Preserve lastStatsFetch from existing data — only fetch-stats.js updates it
    lastStatsFetch: existing.lastStatsFetch || null,
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
