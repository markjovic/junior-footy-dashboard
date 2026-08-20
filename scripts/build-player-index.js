#!/usr/bin/env node
// scripts/build-player-index.js
//
// Builds data/player-index.json — the cross-season player search index.
// docs/cross_season_search_design.md.
//
// WHY THIS EXISTS
// Player search covers only the selected season, because the player files are
// 82.66 MB (78% of all stored bytes) and are deferred past first paint. Loading
// all eighteen to widen the search would undo the per-season split. This index is
// 6.34 MB raw and about 1.1 MB gzipped, which is what a reader pays.
//
// SHAPE — dictionary-encoded, and the encoding is the whole point.
// One row per PERSON, never one per person-season:
//
//   people: [ [uuid, name, [[seasonIdx, teamIdx, ageIdx, gradeIdx], ...]], ... ]
//
// Team, age and grade ride on every season entry so a result row is identifiable
// at a glance — two players called Jack Smith show different teams. Written as
// plain strings that costs 13.29 MB, because 7,670 team names repeat across
// 160,172 person-seasons. Through dictionaries it costs 6.34 MB. Measured
// 2026-08-20 against the real population figures.
//
// ⚠️ ONE SEASON AT A TIME. store.load(null, { players: true }) would hold all
// eighteen player files in memory at once — 82.66 MB of JSON parsed into objects
// is several times that live, on a runner with no guarantees. Each season is read,
// folded into the index, and released.
//
// ⚠️ A PERSON IN TWO GRADES IN ONE SEASON IS ONE SEASON ENTRY. fetch-stats.js
// stores one record per GRADE, so 19,571 records are a second or later grade
// within a season the person already appears in. Folding on `uuid|seasonId` is
// what makes "seasons each" mean seasons — the same distinction audit section 8
// got wrong until 2026-08-16.
//
// USAGE
//   node scripts/build-player-index.js            # writes data/player-index.json
//   node scripts/build-player-index.js --dry-run  # reports, writes nothing
//
// Exit codes: 0 = built (or dry run). 1 = fatal.

'use strict';

const VERSION = 'build-player-index v2 2026-08-20 skip-stub-manifest-entries';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'player-index.json');

function main() {
  const dry = process.argv.slice(2).includes('--dry-run') ||
              process.env.INDEX_DRY_RUN === 'true';

  console.log(`=== ${VERSION} ===`);
  console.log(`Mode: ${dry ? 'DRY RUN — nothing will be written' : 'building'}`);

  // The manifest, read straight from core.json. `store.load([], …)` with an empty
  // scope returns no manifest, and `store.load(null, …)` would pull 22 MB of match
  // records this never looks at — the manifest is the only thing needed here.
  let manifest;
  try {
    manifest = (JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8')).manifest || []).slice();
  } catch (e) {
    console.error(`Could not read the manifest from core.json: ${e.message}`);
    process.exit(1);
  }
  if (!manifest.length) {
    console.error('No manifest in core.json. Run discover-seasons first.');
    process.exit(1);
  }

  // NEWEST FIRST. The season order in the file IS the order the dashboard shows a
  // person's seasons in, and design §10.3 says current season first then
  // backwards. Sorting here means the reader does not re-sort 70,000 rows.
  //
  // Sorted on the YEAR IN compName, not on startDate: a 2026 season starts in
  // October 2025, so a date sort silently interleaves the years.
  // ⚠️ SKIP MANIFEST ENTRIES THAT ARE NOT SEASONS.
  //
  // core.json's manifest carries an entry per organisation, and the twelve in
  // organisationCodes[] that have never been migrated to the full shape have no
  // compName and no seasonId. Measured 2026-08-20: 65 entries, 18 real seasons,
  // 47 stubs — each one was being loaded, logged as `null 0 record(s)`, and
  // interned into the season dictionary as an empty string.
  //
  // Harmless to the output, but 47 wasted loads and 47 dead dictionary slots, and
  // a log that reads as though something is broken.
  const before = manifest.length;
  manifest = manifest.filter(m => m && m.seasonId && m.compName);
  if (manifest.length !== before) {
    const n = before - manifest.length;
    console.log(`  (${n} manifest ${n === 1 ? 'entry has' : 'entries have'} no seasonId or ` +
      `compName and ${n === 1 ? 'is' : 'are'} not a season — skipped)`);
  }
  if (!manifest.length) {
    console.error('No usable seasons in the manifest.');
    process.exit(1);
  }

  const yearOf = (c) => Number((String(c || '').match(/\b(\d{4})\b/) || [])[1] || 0);
  manifest.sort((a, b) => yearOf(b.compName) - yearOf(a.compName) ||
                          String(a.compName).localeCompare(String(b.compName)));

  // Dictionaries. Insertion-ordered, and the index into each is what a row stores.
  const seasons = [], teams = [], ages = [], grades = [];
  const sIdx = new Map(), tIdx = new Map(), aIdx = new Map(), gIdx = new Map();
  const intern = (val, list, map) => {
    const v = val == null ? '' : String(val);
    if (!map.has(v)) { map.set(v, list.length); list.push(v); }
    return map.get(v);
  };

  // uuid -> { name, seen: Map(seasonIdx -> [tIdx, aIdx, gIdx]) }
  // A Map keyed on the season index is what folds two grades in one season into
  // one entry, and it keeps the FIRST record seen for that season.
  const people = new Map();

  let recordsRead = 0, withoutUuid = 0, seasonsRead = 0, dupWithinSeason = 0;

  for (const m of manifest) {
    // One season's players, then released. store.load with a scope of this
    // season's compName reads only its two files.
    let data;
    try {
      data = store.load([m.compName], { players: true });
    } catch (e) {
      console.error(`  ${m.compName}: load failed — ${e.message}`);
      process.exit(1);
    }
    const players = data.players || [];
    seasonsRead++;

    const si = intern(m.seasonId, seasons, sIdx);
    let added = 0;

    for (const p of players) {
      recordsRead++;
      if (!p.uuid) { withoutUuid++; continue; }

      let person = people.get(p.uuid);
      if (!person) {
        person = { name: p.name || '', seen: new Map() };
        people.set(p.uuid, person);
      }
      // Keep the longest name seen. Records carry the same person under slightly
      // different spellings across seasons, and the fuller one is the more useful
      // thing to search against.
      if ((p.name || '').length > person.name.length) person.name = p.name;

      if (person.seen.has(si)) { dupWithinSeason++; continue; }
      person.seen.set(si, [
        intern(p.teamRaw || p.team, teams, tIdx),
        intern(p.age, ages, aIdx),
        intern(p.rawGrade, grades, gIdx),
      ]);
      added++;
    }

    console.log(`  ${String(m.compName).padEnd(12)} ${String(players.length).padStart(6)} record(s), ` +
      `${String(added).padStart(6)} person-season(s) added`);

    // Release before the next season. Without this the loop holds every season it
    // has read, which is the thing this design avoids.
    data.players = null;
    data = null;
  }

  const rows = [];
  for (const [uuid, person] of people) {
    // Season entries newest-first, matching the manifest order the dictionary was
    // built in — a smaller season index IS a more recent season.
    const entries = [...person.seen.entries()].sort((a, b) => a[0] - b[0]);
    rows.push([uuid, person.name, entries.map(([si, rest]) => [si, ...rest])]);
  }
  // People alphabetically, so the file is diffable between weekly runs. Without a
  // stable order every rebuild rewrites the whole file and the commit says nothing.
  rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])) ||
                      String(a[0]).localeCompare(String(b[0])));

  const payload = {
    meta: {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      people: rows.length,
      personSeasons: rows.reduce((n, r) => n + r[2].length, 0),
      seasons: seasons.length,
    },
    seasons, teams, ages, grades,
    people: rows,
  };

  const json = JSON.stringify(payload);
  const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

  console.log(`\n── Index ──`);
  console.log(`  people         ${rows.length}`);
  console.log(`  person-seasons ${payload.meta.personSeasons}`);
  console.log(`  records read   ${recordsRead} across ${seasonsRead} season(s)`);
  console.log(`  ${dupWithinSeason} record(s) were a second grade within a season already seen`);
  if (withoutUuid) console.log(`  ⚠️  ${withoutUuid} record(s) had no uuid and are NOT in the index`);
  console.log(`  dictionaries   ${seasons.length} season(s), ${teams.length} team(s), ` +
    `${ages.length} age(s), ${grades.length} grade(s)`);
  console.log(`  size           ${mb(json.length)} raw`);
  try {
    const gz = require('zlib').gzipSync(Buffer.from(json)).length;
    console.log(`                 ${mb(gz)} gzipped — what a reader actually downloads`);
  } catch (e) { /* zlib is standard; if it is missing the raw figure still stands */ }

  // The invariant the whole design rests on. If a person ever appears twice, the
  // index is one row per person-season and both the size and the search are wrong.
  const ids = new Set(rows.map(r => r[0]));
  if (ids.size !== rows.length) {
    console.error(`\nABORT: ${rows.length} rows but only ${ids.size} distinct uuids — ` +
      `the index is not one row per person. Nothing written.`);
    process.exit(1);
  }

  if (dry) {
    console.log('\nDRY RUN — nothing written.');
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }

  // WRITE ONLY IF THE DATA CHANGED, ignoring generatedAt.
  //
  // This runs weekly whether or not anything moved, and a timestamp alone would
  // make every run commit a 6 MB file whose content is identical — the history
  // then says nothing and every diff is noise. store.js takes the same line for
  // season files, and the index should not be the exception.
  //
  // The comparison strips generatedAt from BOTH sides rather than from the new one
  // only, because an older file may not carry the field at all.
  const stripTime = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    if (c.meta) { delete c.meta.generatedAt; delete c.meta.version; }
    return JSON.stringify(c);
  };
  let unchanged = false;
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    unchanged = stripTime(prev) === stripTime(payload);
  } catch (e) { /* no previous file, or unreadable — write it */ }

  if (unchanged) {
    console.log(`\n${path.relative(ROOT, OUT)} is unchanged — not rewritten.`);
    console.log(`=== ${VERSION} complete ===`);
    process.exit(0);
  }

  fs.writeFileSync(OUT, json, 'utf8');
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
  console.log(`=== ${VERSION} complete ===`);
}

try {
  main();
} catch (e) {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
}
