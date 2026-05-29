// ═══════════════════════════════════════════════════════════════════
// STATS FETCH — scripts/fetch-stats.js
//
// Drop into scripts/ alongside fetch-results.js.
// Call fetchAllStats(grades, data, seasonIDs) after the match fetch
// loop, before writing data.json.
//
//   grades    — array from grades.json
//   data      — data object being built (mutated in place)
//   seasonIDs — Set of season IDs for the current fetch
//               e.g. new Set(['2dcbf383', '2170ac5a'])
// ═══════════════════════════════════════════════════════════════════

const GRAPHQL_URL = 'https://api.playhq.com/graphql';
const GRAPHQL_HEADERS = {
  'Content-Type': 'application/json',
  'tenant': 'afl',
  'origin': 'https://www.playhq.com',
};

// ── Queries ──────────────────────────────────────────────────────────

const GRADE_STATS_QUERY = `
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

const PROFILE_STATS_QUERY = `
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
function clubName(teamName) {
  let n = teamName.replace(/\s+U\d+\s*/g, ' ').replace(/\s+$/, '').trim();
  for (const c of COLOUR_WORDS) {
    n = n.replace(new RegExp(`\\s+${c}\\s*$`, 'i'), '').trim();
  }
  return n;
}

// Extract GP and goals from a statistics array (order not guaranteed)
function parseStats(statistics) {
  let gp = 0, goals = 0;
  for (const s of (statistics || [])) {
    if (s.details.value === 'APPEARANCE') gp = s.count;
    else if (s.details.value === 'GOAL_COUNT') goals = s.count;
  }
  return { gp, goals };
}

// Parse rawGrade from a grade name string e.g. "U12 - B" → "B"
function rawGradeFromGradeName(gradeName) {
  const m = gradeName.match(/[-–]\s*([A-Z0-9][A-Z0-9\s]*)$/i);
  if (m) return m[1].trim();
  return gradeName.trim();
}

// Convert ageName + genderName + gradeName → age string used in data.json
// Must mirror parseGradeName() in fetch-results.js exactly
function resolveAge(ageName, genderName, gradeName) {
  const name = gradeName || '';
  if (ageName === 'Master' || /Veterans/i.test(name)) return 'Veterans';
  if (ageName === 'Senior') {
    if (/Reserve/i.test(name))  return 'Reserve Men';
    if (/U19\.5/i.test(name))   return 'U19.5';
    if (/Women/i.test(name) || genderName === 'Women') return 'Senior Women';
    return 'Senior Men';
  }
  const uMatch = ageName.match(/^U(\d+)$/);
  if (uMatch) {
    const base = `U${uMatch[1]}`;
    if (/U17\.5/i.test(name)) return 'U17.5';
    if (genderName === 'Girls') return `${base} Girls`;
    return base;
  }
  return ageName;
}

async function gqlFetch(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json.data;
}

// ── Phase 1: fetch all grade stats pages ─────────────────────────────

async function fetchGradeStats(grade) {
  const appearances = [];
  let page = 1, totalPages = 1;

  do {
    let data;
    try {
      data = await gqlFetch(GRADE_STATS_QUERY, { gradeID: grade.id, filter: { page } });
    } catch (e) {
      console.warn(`  Stats fetch failed: ${grade.name} page ${page}: ${e.message}`);
      break;
    }
    const gps = data.gradePlayerStatistics;
    totalPages = gps.meta.totalPages;

    for (const r of gps.results) {
      const { gp, goals } = parseStats(r.statistics);
      appearances.push({
        uuid:       r.profile.id,
        firstName:  r.profile.firstName,
        lastName:   r.profile.lastName,
        teamRaw:    r.team.name,
        gradeID:    grade.id,
        gradeName:  grade.name,
        rawGrade:   rawGradeFromGradeName(grade.name),
        ageName:    grade.ageName,
        genderName: grade.genderName,
        compName:   grade.compName,
        seasonID:   grade.seasonID,
        gp,
        goals,
      });
    }
    console.log(`  ${grade.name} p${page}/${totalPages} — ${gps.results.length} players`);
    page++;
    if (page <= totalPages) await sleep(100);
  } while (page <= totalPages);

  return appearances;
}

// ── Phase 2: fetch profile for multi-club players ─────────────────────
//
// publicProfileStatistics returns seasonStatistics ordered newest-first
// within each season's statistics array. The first club entry for the
// current season is the player's most recent (current) club.

async function fetchCurrentClub(uuid, seasonIDs) {
  let data;
  try {
    data = await gqlFetch(PROFILE_STATS_QUERY, { id: uuid });
  } catch (e) {
    console.warn(`  Profile fetch failed for ${uuid}: ${e.message}`);
    return null;
  }

  const seasons = data.publicProfileStatistics?.seasonStatistics || [];

  // Find the most recent season that matches one of our configured season IDs
  for (const seasonBlock of seasons) {
    const registrations = seasonBlock.statistics || [];
    // Filter to registrations in our seasons
    const ours = registrations.filter(r => seasonIDs.has(r.season?.id));
    if (!ours.length) continue;

    // The first registration in the array is the most recent club
    const current = ours[0];
    const { gp, goals } = parseStats(current.totalStatistics);

    // Also collect per-team breakdowns for the roster feature
    const teamBreakdowns = (current.teamStatistics || []).map(ts => {
      const { gp: tgp, goals: tgoals } = parseStats(ts.totalStatistics);
      return { teamRaw: ts.team.name, gp: tgp, goals: tgoals };
    });

    return {
      clubID:   current.club.id,
      clubName: current.club.name,  // e.g. "East Ringwood (Eastern Football Netball League)"
      gp,
      goals,
      teamBreakdowns,
    };
  }

  return null;
}

// ── Phase 3: resolve each uuid|age|compName bucket ───────────────────

const GRADE_ORDER = ['Premier','Division 1','Division 2','Division 3','Division 4',
                     'Division 5','A','B','C','D','D1','D2','D3','D4','Men','Women','Grading'];

function resolveAppearances(appearances, currentClubID) {
  // Group raw grade-page entries by club ID — but we don't have club IDs from
  // the grade stats API, only team names. We use clubName() to strip to bare
  // club name as a proxy for grouping.
  const byClub = {};
  for (const a of appearances) {
    const club = clubName(a.teamRaw);
    if (!byClub[club]) byClub[club] = [];
    byClub[club].push(a);
  }

  const clubs = Object.keys(byClub);
  const transferred = clubs.length > 1;

  let canonicalEntries;

  if (!transferred) {
    // Single club — use all entries
    canonicalEntries = appearances;
  } else if (currentClubID) {
    // Multi-club — we have the authoritative current club from the profile.
    // Match it against our club groups by comparing stripped club name to
    // the club name from the profile (which includes the org suffix).
    // e.g. "East Ringwood (Eastern Football Netball League)" → "East Ringwood"
    const currentClubStripped = currentClubID; // we'll pass pre-stripped name
    canonicalEntries = byClub[currentClubStripped] || appearances;
  } else {
    // Profile fetch failed — fall back to club with most GP as best guess
    let bestClub = clubs[0], bestGP = 0;
    for (const [club, entries] of Object.entries(byClub)) {
      const totalGP = entries.reduce((s, e) => s + e.gp, 0);
      if (totalGP > bestGP) { bestGP = totalGP; bestClub = club; }
    }
    canonicalEntries = byClub[bestClub];
  }

  // Sum goals and GP across all grade entries for the canonical club
  const totalGoals = canonicalEntries.reduce((s, e) => s + e.goals, 0);
  const totalGP    = canonicalEntries.reduce((s, e) => s + e.gp, 0);

  // Primary entry = highest GP within the canonical club; tiebreak = highest grade
  const primary = canonicalEntries.slice().sort((a, b) => {
    if (b.gp !== a.gp) return b.gp - a.gp;
    return GRADE_ORDER.indexOf(a.rawGrade) - GRADE_ORDER.indexOf(b.rawGrade);
  })[0];

  return {
    primary,
    totalGoals,
    totalGP,
    transferred,
    clubs,
    canonicalClub: clubName(primary.teamRaw),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main export ───────────────────────────────────────────────────────

async function fetchAllStats(grades, data, seasonIDs) {
  console.log(`\nFetching player statistics for ${grades.length} grades…`);

  // ── Phase 1: collect all raw grade-page appearances ──
  const allAppearances = [];
  for (const grade of grades) {
    console.log(`Grade stats: ${grade.compName} — ${grade.name}`);
    const appearances = await fetchGradeStats(grade);
    for (const a of appearances) {
      a.age = resolveAge(a.ageName, a.genderName, a.gradeName);
    }
    allAppearances.push(...appearances);
    await sleep(120);
  }
  console.log(`\nRaw appearance records: ${allAppearances.length}`);

  // ── Phase 2: bucket by uuid|age|compName, identify multi-club players ──
  const buckets = {};
  for (const a of allAppearances) {
    const key = `${a.uuid}|${a.age}|${a.compName}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(a);
  }

  // Find UUIDs that appear under multiple clubs within a bucket
  const multiClubBuckets = {};
  for (const [key, entries] of Object.entries(buckets)) {
    const clubs = new Set(entries.map(e => clubName(e.teamRaw)));
    if (clubs.size > 1) {
      const uuid = entries[0].uuid;
      if (!multiClubBuckets[uuid]) multiClubBuckets[uuid] = [];
      multiClubBuckets[uuid].push({ key, entries, clubs: [...clubs] });
    }
  }

  const multiClubUUIDs = Object.keys(multiClubBuckets);
  console.log(`\nMulti-club players requiring profile lookup: ${multiClubUUIDs.length}`);

  // ── Phase 3: fetch profiles for multi-club players ──
  // currentClubMap: uuid → stripped current club name
  const currentClubMap = {};
  for (const uuid of multiClubUUIDs) {
    console.log(`  Profile: ${uuid}`);
    const profile = await fetchCurrentClub(uuid, seasonIDs);
    if (profile) {
      // Strip the org suffix from the club name: "East Ringwood (Eastern...)" → "East Ringwood"
      const strippedClub = profile.clubName.replace(/\s*\([^)]+\)\s*$/, '').trim();
      currentClubMap[uuid] = strippedClub;
    }
    await sleep(150);
  }

  // ── Phase 4: resolve all buckets into canonical player records ──
  const players = [];

  for (const [key, appearances] of Object.entries(buckets)) {
    const uuid = appearances[0].uuid;
    const currentClubStripped = currentClubMap[uuid] || null;

    const { primary, totalGoals, totalGP, transferred, clubs, canonicalClub } =
      resolveAppearances(appearances, currentClubStripped);

    players.push({
      uuid,
      name:       `${primary.firstName} ${primary.lastName}`.trim(),
      firstName:  primary.firstName,
      lastName:   primary.lastName,
      team:       canonicalClub,            // bare club name e.g. "East Ringwood"
      teamRaw:    primary.teamRaw,          // full team name e.g. "East Ringwood U12"
      rawGrade:   primary.rawGrade,         // primary grade e.g. "C"
      age:        primary.age,              // e.g. "U12"
      compName:   primary.compName,
      gradeID:    primary.gradeID,
      gradeName:  primary.gradeName,
      gp:         totalGP,
      goals:      totalGoals,
      transferred,
      clubs,                                // all clubs played for (for XFER badge)
      // Per-grade breakdown — for team roster and transfer history features
      appearances: appearances.map(a => ({
        gradeID:   a.gradeID,
        gradeName: a.gradeName,
        rawGrade:  a.rawGrade,
        teamRaw:   a.teamRaw,
        team:      clubName(a.teamRaw),
        gp:        a.gp,
        goals:     a.goals,
      })),
    });
  }

  console.log(`Resolved ${players.length} canonical player records`);
  console.log(`  Transferred: ${players.filter(p => p.transferred).length}`);
  console.log(`  With goals:  ${players.filter(p => p.goals > 0).length}`);

  data.players = players;
}

module.exports = { fetchAllStats };
