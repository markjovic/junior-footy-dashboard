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
query publicProfileStatistics($id: ID!) {
  publicProfileStatistics(id: $id) {
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
          team { id name }
          totalStatistics {
            count
            details { value }
          }
        }
      }
    }
  }
  publicProfile(id: $id) {
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
      res = await gqlPost(Q_GRADE_STATS, { gradeID: grade.id, filter: { page } });
      await sleep(120);
    } catch (e) {
      console.warn(`  Stats: ${grade.name} page ${page} failed: ${e.message}`);
      break;
    }

    const gps = res?.data?.gradePlayerStatistics;
    if (!gps) break;
    totalPages = gps.meta.totalPages;

    for (const r of gps.results) {
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
    res = await gqlPost(Q_PROFILE_STATS, { id: uuid });
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
