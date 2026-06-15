// ═══════════════════════════════════════════════════════════════════
// scripts/fetch-stats.js
//
// Called from fetch-results.js after the match fetch loop.
// Uses the same gqlPost / sleep helpers passed in from fetch-results.js
// so there's one HTTP stack, one set of headers, one rate-limit policy.
//
// fetchAllStats(grades, data, seasonIDs, gqlPost, sleep)
//   grades    — array from grades.json
//   data      — the merged data object (mutated: sets data.players)
//   seasonIDs — Set of current season IDs e.g. Set(['2dcbf383','2170ac5a'])
//   gqlPost   — the gqlPost(query, variables) function from fetch-results.js
//   sleep     — the sleep(ms) function from fetch-results.js
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── Queries ──────────────────────────────────────────────────────────

const Q_GRADE_STATS = `
query publicGradeStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      profile { id firstName lastName }
      team { name }
      statistics {
        count
        details { value }
      }
    }
  }
}`;

const Q_PROFILE_STATS = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id }
        club { id name }
        totalStatistics {
          count
          details { value }
        }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          totalStatistics {
            count
            details { value }
          }
        }
      }
    }
  }
  publicProfile(profileID: $profileID) {
    id
    firstName
    lastName
  }
}`;

// ── Helpers ──────────────────────────────────────────────────────────

const COLOUR_WORDS = ['Purple','Gold','Blue','Red','Green','White','Black',
                      'Silver','Navy','Yellow','Orange','Teal'];

// Strip age suffix and trailing colour words to get bare club name
function toClubName(teamName) {
  let n = teamName.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/, '').trim();
  for (const c of COLOUR_WORDS) {
    n = n.replace(new RegExp(`\\s+${c}\\s*$`, 'i'), '').trim();
  }
  // Strip trailing team number (e.g. "Mixed 1", "Mixed 2", "Boys 1")
  n = n.replace(/\s+\d+$/, '').trim();
  // Strip trailing single word that looks like a surname/coach name (Title Case, no spaces)
  // Only if the remaining name is still meaningful (2+ words)
  // e.g. "St Bernards Mixed Davey" → "St Bernards Mixed"
  // but NOT "Langwarrin" → "Langwarrin" (single word, don't strip)
  const parts = n.split(/\s+/);
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    // Strip if last word is Title Case and not a known structural word
    const structural = new Set(['Mixed','Boys','Girls','Men','Women','Juniors','Junior','FC','JFC','AFC']);
    if (/^[A-Z][a-z]+$/.test(last) && !structural.has(last)) {
      n = parts.slice(0, -1).join(' ').trim();
    }
  }
  return n;
}

// Normalise a club name for fuzzy matching between profile API and grade stats API.
// Profile returns "Berwick Football Club (EFNL)", grade stats returns "Berwick U18".
// We strip org suffixes, common words, and lowercase for comparison.
const CLUB_STRIP = /\s*\([^)]+\)\s*$|\s+(football\s+club|fc|juniors?|junior\s+fc|netball|afc|sc|ftc|fnc|fnl|afl|district|districts?|eagles?|hawks?|magpies?|tigers?|lions?|bears?|sharks?|demons?|saints?|power|centrals?|rovers?|united|city|athletic|association|inc\.?)\s*$/gi;

function normaliseClub(name) {
  if (!name) return '';
  let n = name.replace(/\s*\([^)]+\)\s*$/, '').trim(); // strip org suffix
  // Strip age suffix if present
  n = n.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').trim();
  // Strip colour words
  for (const c of COLOUR_WORDS) {
    n = n.replace(new RegExp(`\\s+${c}\\s*$`, 'i'), '').trim();
  }
  // Strip common club name suffixes iteratively
  let prev;
  do {
    prev = n;
    n = n.replace(/\s+(football\s+club|junior\s+football\s+club|junior\s+fc|football\s+netball\s+club|fc|juniors?|afc|inc\.?)\s*$/i, '').trim();
  } while (n !== prev);
  return n.toLowerCase().trim();
}

// Extract GP and goals from a statistics array (order not guaranteed by API)
function parseStats(statistics) {
  let gp = 0, goals = 0, bestPlayer = 0;
  for (const s of (statistics || [])) {
    if (s.details.value === 'APPEARANCE')  gp         = s.count;
    if (s.details.value === 'GOAL_COUNT')  goals      = s.count;
    if (s.details.value === 'BEST_PLAYER') bestPlayer = s.count;
  }
  return { gp, goals, bestPlayer };
}

// Parse rawGrade from a grade name string e.g. "U12 - B" → "B"
// Mirrors rawGrade extraction in parseGradeName() in fetch-results.js
function toRawGrade(gradeName) {
  // Standard EFNL format: "U12 - B" or "Division 1 - Senior Men"
  const m = gradeName.match(/[-–]\s*([A-Z0-9][A-Z0-9\s]*)$/i);
  if (m) return m[1].trim();
  // WFNL sponsor-prefix format: "Western Bulldogs U12 Girls Division 1"
  // Extract trailing "Division N" or single letter/number grade
  const div = gradeName.match(/\b(Division\s+\d+|Premier|[A-D]\d?)\s*$/i);
  if (div) return div[1].trim();
  // Single-division comps (e.g. "St Vincent's... Senior Women", "Thirds") — rawGrade is ""
  // These match match records which also store rawGrade as "" for single-div
  return '';
}

// Derive age string from PlayHQ structured fields
// Must mirror parseGradeName() in fetch-results.js exactly
function toAge(ageName, genderName, gradeName) {
  const n = gradeName || '';
  if (ageName === 'Master' || /Veterans/i.test(n)) return 'Veterans';
  if (ageName === 'Senior' || ageName === 'Open') {
    if (/Reserve/i.test(n))                             return 'Reserve Men';
    if (/U19\.5/i.test(n))                              return 'U19.5';
    if (genderName === 'Women' || /Women/i.test(n))     return 'Senior Women';
    if (/Senior/i.test(n))                              return 'Senior Men';
    // Thirds / other open-age — preserve cleaned name
    return n.replace(/\s*(Premier|Division \d+).*$/i, '').trim() || ageName;
  }
  const uMatch = ageName?.match(/^U(\d+)$/);
  if (uMatch) {
    if (/U17\.5/i.test(n)) return 'U17.5';
    const base = `U${uMatch[1]}`;
    if (genderName === 'Girls') return `${base} Girls`;
    return base;
  }
  return ageName || gradeName;
}

const GRADE_ORDER = ['Premier','Division 1','Division 2','Division 3','Division 4',
                     'Division 5','A','B','C','D','D1','D2','D3','D4','Men','Women','Grading'];

// ── Phase 1: fetch all pages of grade stats ───────────────────────────────────

async function fetchGradeStats(grade, gqlPost, sleep) {
  const appearances = [];
  let page = 1, totalPages = 1;

  do {
    let res;
    const MAX_RETRIES = 4;
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        res = await gqlPost(
          Q_GRADE_STATS,
          {
            gradeID: grade.id,
            filter: {
              sort: [{ column: 'GOAL_COUNT', direction: 'DESC' }],
              pagination: { page, limit: 50 },
            },
          },
          'publicGradeStatistics'
        );
        await sleep(300);
        lastError = null;
        break; // success
      } catch (e) {
        lastError = e;
        if (attempt < MAX_RETRIES) {
          console.warn(`  RETRY ${grade.name} p${page} (attempt ${attempt}): ${e.message}`);
          await sleep(2000 * attempt); // 2s, 4s, 6s backoff
        }
      }
    }
    if (lastError) {
      console.warn(`  FAIL ${grade.name} p${page} after ${MAX_RETRIES} attempts: ${lastError.message}`);
      break;
    }

    const gps = res?.data?.gradePlayerStatistics;
    if (!gps) {
      if (res?.errors?.length) {
        console.warn(`  ERROR ${grade.name} p${page}: ${res.errors.map(e=>e.message).join('; ')}`);
      } else {
        console.warn(`  EMPTY ${grade.name} p${page} — no gradePlayerStatistics in response`);
      }
      break;
    }
    totalPages = gps.meta.totalPages;

    for (const r of gps.results) {
      if (!r.profile) continue;  // private profile — no UUID available, skip
      const { gp, goals, bestPlayer } = parseStats(r.statistics);
      appearances.push({
        uuid:       r.profile.id,
        firstName:  r.profile.firstName,
        lastName:   r.profile.lastName,
        teamRaw:    r.team.name,                   // e.g. "Norwood U12 Purple"
        gradeID:    grade.id,
        gradeName:  grade.name,                    // e.g. "U12 - B"
        rawGrade:   toRawGrade(grade.name),        // e.g. "B"
        ageName:    grade.ageName,
        genderName: grade.genderName,
        compName:   grade.compName,
        seasonID:   grade.seasonID,
        age:        toAge(grade.ageName, grade.genderName, grade.name),
        gp,
        goals,
        bestPlayer,
      });
    }

    console.log(`  Stats: ${grade.name} p${page}/${totalPages} (${gps.results.length} players)`);
    page++;
    if (page <= totalPages) await sleep(300);
  } while (page <= totalPages);

  return appearances;
}

// ── Phase 2: fetch profile for a multi-club player ────────────────────────────
// Returns the stripped current club name for the most recent season that
// matches one of our configured season IDs, or null on failure.

async function fetchCurrentClub(uuid, seasonIDs, gqlPost, sleep) {
  let res;
  try {
    res = await gqlPost(Q_PROFILE_STATS, { profileID: uuid }, 'publicProfileStatistics');
    await sleep(150);
  } catch (e) {
    console.warn(`  Profile: ${uuid} failed: ${e.message}`);
    return null;
  }

  const seasons = res?.data?.publicProfileStatistics?.seasonStatistics || [];

  // seasonStatistics is ordered newest season first.
  // Within each season, statistics (registrations) are ordered most-recent club first.
  for (const seasonBlock of seasons) {
    const ours = (seasonBlock.statistics || []).filter(r => seasonIDs.has(r.season?.id));
    if (!ours.length) continue;
    // First registration = most recent club this season
    const clubFullName = ours[0].club?.name || '';
    // Strip org suffix: "East Ringwood (Eastern Football Netball League)" → "East Ringwood"
    return clubFullName.replace(/\s*\([^)]+\)\s*$/, '').trim();
  }

  console.warn(`  Profile: no matching season for ${uuid}. Available: ${seasons.map(s=>s.name).join(',')}`);

  return null;
}

// ── Phase 3: resolve a bucket into one canonical player record ────────────────

function resolveAppearances(appearances, currentClubName) {
  // Group by toClubName (strips age, colours, trailing numbers, coach surnames)
  // so same-club multi-team players (e.g. "St Bernards Mixed Davey" + "St Bernards Mixed Hardwick")
  // are NOT flagged as transfers. Use normaliseClub for profile-lookup matching only.
  const byClub = {};
  const normToDisplay = {}; // club name → display name
  for (const a of appearances) {
    const clubKey = toClubName(a.teamRaw);
    if (!byClub[clubKey]) byClub[clubKey] = [];
    byClub[clubKey].push(a);
    normToDisplay[clubKey] = clubKey;
  }
  const clubs = Object.keys(byClub); // display names
  const transferred = Object.keys(byClub).length > 1;

  // Pick which club's entries to sum
  let canonicalEntries;
  if (!transferred) {
    canonicalEntries = appearances;
  } else if (currentClubName) {
    // Normalise the profile club name and find matching bucket
    const normCurrent = normaliseClub(currentClubName);
    const normKeys = Object.keys(byClub);
    // Try exact match on toClubName keys, then normalised prefix/word-token overlap
    const profileWords = normCurrent.split(/\s+/).filter(w => w.length > 3);
    const matchKey = normKeys.find(k => normaliseClub(k) === normCurrent)
                  || normKeys.find(k => normaliseClub(k).startsWith(normCurrent) || normCurrent.startsWith(normaliseClub(k)))
                  || normKeys.find(k => profileWords.some(w => normaliseClub(k).includes(w)));
    if (matchKey) {
      canonicalEntries = byClub[matchKey];
    } else {
      // No match (likely acronym club name e.g. YSE, HCFC) — fall back to most GP
      canonicalEntries = normKeys
        .map(k => ({ key: k, entries: byClub[k], gp: byClub[k].reduce((s,e) => s+e.gp, 0) }))
        .sort((a, b) => b.gp - a.gp)[0].entries;
    }
  } else {
    // No profile data — fall back to club with most GP
    const normKeys = Object.keys(byClub);
    canonicalEntries = normKeys
      .map(k => ({ key: k, entries: byClub[k], gp: byClub[k].reduce((s,e) => s+e.gp, 0) }))
      .sort((a, b) => b.gp - a.gp)[0].entries;
    console.warn(`  Fallback GP heuristic used for ${appearances[0].uuid}`);
  }

  // Both GP and goals sum across ALL clubs — all games and goals count for the leaderboard
  // Only the team attribution (which team they show under) follows the newest club rule
  const totalGoals = appearances.reduce((s, e) => s + e.goals, 0);
  const totalGP    = appearances.reduce((s, e) => s + e.gp, 0);

  // Primary entry = most GP in canonical club; tiebreak = highest grade
  const primary = canonicalEntries.slice().sort((a, b) => {
    if (b.gp !== a.gp) return b.gp - a.gp;
    return GRADE_ORDER.indexOf(a.rawGrade) - GRADE_ORDER.indexOf(b.rawGrade);
  })[0];

  return { primary, totalGoals, totalGP, transferred, clubs, canonicalEntries };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function fetchAllStats(grades, data, seasonIDs, gqlPost, sleep) {
  console.log(`\n── Fetching player statistics (${grades.length} grades) ──`);

  // Phase 1: grade stats — all pages, all grades
  const allAppearances = [];
  let statsGradeIdx = 0;
  for (const grade of grades) {
    statsGradeIdx++;
    console.log(`  [${statsGradeIdx}/${grades.length}] ${grade.compName} — ${grade.name}`);
    if (statsGradeIdx > 1 && (statsGradeIdx - 1) % 25 === 0) {
      console.log('  [cooldown 5s]');
      await sleep(2000);
    }
    const rows = await fetchGradeStats(grade, gqlPost, sleep);
    allAppearances.push(...rows);
  }
  console.log(`  Raw appearance records: ${allAppearances.length}`);

  // Bucket by uuid|age|compName
  // Each bucket = all grade-page entries for one player in one age group in one competition
  const buckets = {};
  for (const a of allAppearances) {
    const key = `${a.uuid}|${a.age}|${a.compName}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(a);
  }

  // Identify which UUIDs appear under multiple clubs in any bucket
  const multiClubUUIDs = new Set();
  for (const entries of Object.values(buckets)) {
    const clubs = new Set(entries.map(e => toClubName(e.teamRaw)));
    if (clubs.size > 1) multiClubUUIDs.add(entries[0].uuid);
  }
  console.log(`  Multi-club players requiring profile lookup: ${multiClubUUIDs.size}`);

  // Phase 2: profile lookups — only for multi-club players
  const currentClubMap = {};  // uuid → stripped current club name
  for (const uuid of multiClubUUIDs) {
    console.log(`  Profile lookup: ${uuid}`);
    const club = await fetchCurrentClub(uuid, seasonIDs, gqlPost, sleep);
    if (club) currentClubMap[uuid] = club;
  }

  // Phase 3: resolve every bucket
  const players = [];
  for (const [, appearances] of Object.entries(buckets)) {
    const uuid = appearances[0].uuid;
    const { primary, totalGoals, totalGP, transferred, clubs, canonicalEntries } =
      resolveAppearances(appearances, currentClubMap[uuid] || null);
    const totalBP = canonicalEntries.reduce((s, e) => s + (e.bestPlayer || 0), 0);

    if (transferred) {
      console.log(`  XFER ${primary.firstName} ${primary.lastName}: GP=${totalGP} G=${totalGoals} clubs=[${clubs.join(',')}] canonical=${toClubName(primary.teamRaw)}`);
    }
    players.push({
      uuid,
      name:       `${primary.firstName} ${primary.lastName}`.trim(),
      firstName:  primary.firstName,
      lastName:   primary.lastName,
      team:       toClubName(primary.teamRaw),  // bare club name e.g. "East Ringwood"
      teamRaw:    primary.teamRaw,              // full name e.g. "East Ringwood U12"
      rawGrade:   primary.rawGrade,             // primary grade e.g. "C"
      age:        primary.age,                  // e.g. "U12"
      compName:   primary.compName,
      gradeID:    primary.gradeID,
      gradeName:  primary.gradeName,
      gp:         totalGP,
      goals:      totalGoals,
      bestPlayer: totalBP,
      transferred,
      clubs,
      // Per-grade breakdown — for team roster and transfer history features
      appearances: appearances.map(a => ({
        gradeID:   a.gradeID,
        gradeName: a.gradeName,
        rawGrade:  a.rawGrade,
        teamRaw:   a.teamRaw,
        team:      toClubName(a.teamRaw),
        gp:         a.gp,
        goals:      a.goals,
        bestPlayer: a.bestPlayer || 0,
      })),
    });
  }

  console.log(`  Resolved: ${players.length} players ` +
    `(${players.filter(p=>p.transferred).length} transferred, ` +
    `${players.filter(p=>p.goals>0).length} with goals)`);

  data.players = players;
}

module.exports = { fetchAllStats };

// ── Standalone entry point (called directly by the workflow) ─────────────────
// When run as `node scripts/fetch-stats.js`, loads grades.json and data.json,
// runs the full stats fetch, writes lastStatsFetch, and saves data.json back.

if (require.main === module) {
  'use strict';
  const fs   = require('fs');
  const path = require('path');
  const https = require('https');

  const ROOT        = path.resolve(__dirname, '..');
  const GRADES_PATH = path.join(ROOT, 'grades.json');
  const DATA_PATH   = path.join(ROOT, 'data.json');
  const API_URL     = 'https://api.playhq.com/graphql';
  const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';
  const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '200', 10);

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
          'request-id':     require('crypto').randomUUID(),
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

  let SESSION_COOKIE = '';

  async function getSession() {
    const body = JSON.stringify({
      operationName: 'TenantConfig',
      variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }',
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 2000));
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
            'request-id':     require('crypto').randomUUID(),
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

  async function main() {
    await getSession();
    if (!fs.existsSync(GRADES_PATH)) {
      console.error('grades.json not found — run fetch-results.js first');
      process.exit(1);
    }
    const allGrades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));
    // VIP_ONLY: filter grades to VIP competitions only
    const vipOnly = process.env.VIP_ONLY === 'true';
    let vipComps = new Set();
    if (vipOnly && fs.existsSync(path.join(ROOT, 'config.json'))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
      vipComps = new Set((cfg.competitions||[]).filter(c=>c.vip).map(c=>c.name));
    }
    const grades = vipOnly
      ? allGrades.filter(g => vipComps.has(g.compName))
      : allGrades;
    console.log(`Fetching stats for ${vipOnly ? 'VIP' : 'ALL'} comps: ${[...new Set(grades.map(g=>g.compName))].join(', ')} (${grades.length} grades)`);

    let data = { matches: [], players: [], roster: {}, gotwFlags: {} };
    if (fs.existsSync(DATA_PATH)) {
      try { data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
      catch (e) { console.warn('Could not parse data.json — starting fresh'); }
    }

    const seasonIDs = new Set(grades.map(g => g.seasonID).filter(Boolean));
    await fetchAllStats(grades, data, seasonIDs, gqlPost, sleep);

    data.lastStatsFetch = new Date().toISOString();

    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
    console.log('Wrote data.json');
    process.exit(0);
  }

  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
