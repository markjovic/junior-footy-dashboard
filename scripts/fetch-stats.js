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
// Mirrors clubName logic used in the dashboard
function toClubName(teamName) {
  let n = teamName.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/, '').trim();
  for (const c of COLOUR_WORDS) {
    n = n.replace(new RegExp(`\\s+${c}\\s*$`, 'i'), '').trim();
  }
  return n;
}

// Extract GP and goals from a statistics array (order not guaranteed by API)
function parseStats(statistics) {
  let gp = 0, goals = 0;
  for (const s of (statistics || [])) {
    if (s.details.value === 'APPEARANCE')  gp    = s.count;
    if (s.details.value === 'GOAL_COUNT')  goals = s.count;
  }
  return { gp, goals };
}

// Parse rawGrade from a grade name string e.g. "U12 - B" → "B"
// Mirrors rawGrade extraction in parseGradeName() in fetch-results.js
function toRawGrade(gradeName) {
  const m = gradeName.match(/[-–]\s*([A-Z0-9][A-Z0-9\s]*)$/i);
  if (m) return m[1].trim();
  return gradeName.trim();
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
      await sleep(120);
    } catch (e) {
      console.warn(`  FAIL ${grade.name} p${page}: ${e.message}`);
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
      const { gp, goals } = parseStats(r.statistics);
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
      });
    }

    console.log(`  Stats: ${grade.name} p${page}/${totalPages} (${gps.results.length} players)`);
    page++;
    if (page <= totalPages) await sleep(120);
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

  return null;
}

// ── Phase 3: resolve a bucket into one canonical player record ────────────────

function resolveAppearances(appearances, currentClubName) {
  // Group grade-page entries by bare club name
  const byClub = {};
  for (const a of appearances) {
    const club = toClubName(a.teamRaw);
    if (!byClub[club]) byClub[club] = [];
    byClub[club].push(a);
  }
  const clubs = Object.keys(byClub);
  const transferred = clubs.length > 1;

  // Pick which club's entries to sum
  let canonicalEntries;
  if (!transferred) {
    canonicalEntries = appearances;
  } else if (currentClubName && byClub[currentClubName]) {
    canonicalEntries = byClub[currentClubName];
  } else {
    // Profile lookup failed — fall back to club with most GP
    canonicalEntries = clubs
      .map(c => ({ club: c, entries: byClub[c], gp: byClub[c].reduce((s,e) => s+e.gp, 0) }))
      .sort((a, b) => b.gp - a.gp)[0].entries;
    console.warn(`  Fallback GP heuristic used for ${appearances[0].uuid}`);
  }

  const totalGoals = canonicalEntries.reduce((s, e) => s + e.goals, 0);
  const totalGP    = canonicalEntries.reduce((s, e) => s + e.gp,    0);

  // Primary entry = most GP in canonical club; tiebreak = highest grade
  const primary = canonicalEntries.slice().sort((a, b) => {
    if (b.gp !== a.gp) return b.gp - a.gp;
    return GRADE_ORDER.indexOf(a.rawGrade) - GRADE_ORDER.indexOf(b.rawGrade);
  })[0];

  return { primary, totalGoals, totalGP, transferred, clubs };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function fetchAllStats(grades, data, seasonIDs, gqlPost, sleep) {
  console.log(`\n── Fetching player statistics (${grades.length} grades) ──`);

  // Phase 1: grade stats — all pages, all grades
  const allAppearances = [];
  for (const grade of grades) {
    console.log(`  ${grade.compName} — ${grade.name}`);
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
    const { primary, totalGoals, totalGP, transferred, clubs } =
      resolveAppearances(appearances, currentClubMap[uuid] || null);

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
      transferred,
      clubs,
      // Per-grade breakdown — for team roster and transfer history features
      appearances: appearances.map(a => ({
        gradeID:   a.gradeID,
        gradeName: a.gradeName,
        rawGrade:  a.rawGrade,
        teamRaw:   a.teamRaw,
        team:      toClubName(a.teamRaw),
        gp:        a.gp,
        goals:     a.goals,
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
  const USER_AGENT  = 'Mozilla/5.0 (compatible; EFNL-dashboard-bot/1.0)';
  const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '150', 10);

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

  async function main() {
    if (!fs.existsSync(GRADES_PATH)) {
      console.error('grades.json not found — run fetch-results.js first');
      process.exit(1);
    }
    const grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));

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
