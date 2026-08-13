// scripts/report-field-usage.js
//
// Answers one question mechanically: WHO USES THIS FIELD?
//
// WHY THIS EXISTS
// On 2026-08-11 hLogo and aLogo were removed from match records after checking
// that index.html rendered crests from teamLogos instead. That check was correct
// and the conclusion was still wrong: build-club-index.js derived every club
// identity by scanning hLogo/aLogo on match records, so removing them would have
// silently emptied teamClub on its next full run. The dependency was written
// down in two design documents and in that file's own header, and was still
// missed, because the check was aimed at one consumer instead of all of them.
//
// A hand-maintained list of consumers fails the same way. This scans the real
// files and reports references per field per file, so "is anything else using
// this?" is answered by execution rather than by memory.
//
// READ-ONLY. Writes a report to the repo root, commits nothing, and changes no
// data. Run it BEFORE removing or renaming any stored field.
//
// Deliberately conservative: it reports a REFERENCE, not a read or a write. It
// cannot tell `m.hLogo` being written from `m.hLogo` being read, and pretending
// otherwise would produce confident wrong answers. A field referenced in a file
// you were about to break is the signal; go and read that file.
//
// v2 (2026-08-13). The SOURCES list had eight entries and the repo had more than
// twice that many files touching stored data, so the tool built to prevent the
// hLogo incident was itself blind to most of the places the next one could
// happen. Six writers and readers were added, gradeId and the per-season file
// structure are now tracked, and the output carries a version line. What changed
// and why is recorded against each list below.

'use strict';

const fs = require('fs');
const path = require('path');

// Printed first. Without it a stale cached copy in an Actions log and a real
// failure look identical, and that costs a wasted run.
const VERSION = 'report-field-usage v2 2026-08-13 sources-completed';

const ROOT = path.join(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'field-usage-report.json');

// Every file that produces or consumes stored data. Missing one from this list
// is the failure mode this tool exists to prevent, so an absent file is
// reported loudly rather than skipped quietly.
//
// ADDED 2026-08-13, and why each one belongs here:
//   lib/store.js          decides which key lives in which file. Every stored
//                         field name appears in CORE_KEYS, ARRAY_KEYS,
//                         PREFIX_KEYS or TIMESTAMP_KEYS. Nothing has a stronger
//                         claim to being scanned, and it was absent.
//   lib/results-engine.js builds every match record. The field names originate
//                         here.
//   backfill.js           a writer. It writes results and ladders for retired
//                         seasons through the same engine, and was absent.
//   migrate-grade-ids.js  rewrites stored match ids and reads gradeId.
//   rebuild-grade-meta.js rewrites gradeMeta for every stored season.
//   split-by-season.js    the 2026-08-12 migration. Still present, still
//                         reads every key it moved.
//   audit-data.js         reads almost every stored field to report on it. A
//                         removal that breaks the audit breaks the check you
//                         run after a removal.
//   report-grade-collisions.js  reads age and rawGrade specifically.
//
// DELIBERATELY ABSENT:
//   cleanup-obsolete.js   removed by repo-tidy on 2026-08-13. Adding a file on
//                         its way out would make this print MISSING SOURCES on
//                         every run, which trains you to ignore that block —
//                         and that block is the whole safety mechanism.
//   lib/playhq.js         session and transport only. It carries no stored
//                         field names.
//   repo-audit.js, repo-tidy.js  inventory the repo, not the data.
const SOURCES = [
  // Shared libraries — where stored field names are defined and produced.
  'scripts/lib/store.js',
  'scripts/lib/results-engine.js',
  // Writers.
  'scripts/fetch-results.js',
  'scripts/fetch-fixtures.js',
  'scripts/fetch-stats.js',
  'scripts/backfill.js',
  'scripts/build-club-index.js',
  'scripts/discover-seasons.js',
  'scripts/discover-orgs.js',
  'scripts/migrate-grade-ids.js',
  'scripts/rebuild-grade-meta.js',
  'scripts/split-by-season.js',
  // Read-only consumers that would break silently.
  'scripts/audit-data.js',
  'scripts/report-grade-collisions.js',
  'scripts/probe-team-join.js',
  // The dashboard and the discovery page.
  'index.html',
  'org-discovery.html',
];

// Grouped only for readability of the output. Add a field here the moment it is
// introduced — a field absent from this list is invisible to the report, which
// is exactly the blind spot that caused the incident above.
const FIELDS = {
  'data.json top level': [
    'matches', 'players', 'roster', 'gradeMeta', 'teamLogos', 'teamOrg',
    'compLogos', 'lastRound', 'clubs', 'teamClub', 'gotwFlags',
    'lastUpdated', 'lastResultsFetch', 'lastStatsFetch', 'lastFixtureFetch',
    'lastClubIndex', 'exportedAt',
  ],
  'match record': [
    'id', 'age', 'rawGrade', 'round', 'compName', 'home', 'away',
    'hScore', 'hG', 'hB', 'aScore', 'aG', 'aB',
    'venue', 'vSuburb', 'venueUrl', 'hLogo', 'aLogo', 'date', 'time',
    'isBye', 'isPartial', 'isFinals', 'finalsAbbrev', 'finalsName',
    'scheduled', 'provisional',
    // ADDED 2026-08-13. PlayHQ's own grade UUID, carried on every match record
    // and the third segment of every match id since the grade identity
    // migration. It was the single most consequential untracked field in the
    // repo: ladders group by it and 99.91% of stored records now key on it.
    'gradeId',
  ],
  'player record': [
    'uuid', 'firstName', 'lastName', 'teamRaw', 'gradeID', 'gradeName',
    'gp', 'goals', 'bestPlayer', 'transferred', 'appearances',
  ],
  'grades.json / manifest': [
    'seasonID', 'seasonId', 'ageName', 'genderName', 'manifest',
    'organisations', 'organisationCodes', 'excludeGrades', 'vip', 'phases',
    // ADDED 2026-08-13. Manifest entry fields the dashboard's season selector
    // reads directly — the year and competition lists are built from these and
    // not from loaded records.
    'status', 'startDate', 'endDate',
  ],
  // ADDED 2026-08-13 as a group. The per-season layout introduced a file
  // structure of its own on 2026-08-12, and none of it was tracked. A rename
  // inside store.js's payload shape breaks every reader of those files, and
  // nothing here would have said so.
  'per-season file structure': [
    'seasonFiles',      // core.json index of season files, written by store
    'orgFiles',         // the previous layout's index; store deletes it
    'meta',             // per-season file header
    'generatedAt',      // excluded from store's changed-file comparison
    'players_n',        // phases counter
    'comps',            // compNames placed in a season file
    'org',              // organisation code on a season file's meta
    'count',            // player file meta
    // The non-enumerable markers load() leaves on its return value. __hadPlayers
    // being dropped by a spread operator is what wrote empty player files over
    // five seasons on 2026-08-12. A marker that costs 179,624 records when it
    // goes missing is worth being able to grep for.
    '__hadPlayers', '__core', '__scope', '__filesRead',
  ],
};

// Writers, for the cross-writer check. A field a writer produces and ANOTHER
// writer consumes is the dangerous shape: changing it breaks a file that is not
// the one being edited and not the dashboard either.
//
// The shared libraries are NOT in this set even though store.js is what
// physically writes the files. Every writer goes through them, so including
// them would put lib/store.js in almost every cross-writer finding and drown
// the signal the check exists to produce. A library is a different relationship
// from two writers that happen to share a field.
const WRITERS = new Set([
  'scripts/fetch-results.js',
  'scripts/fetch-fixtures.js',
  'scripts/fetch-stats.js',
  'scripts/backfill.js',
  'scripts/build-club-index.js',
  'scripts/discover-seasons.js',
  'scripts/discover-orgs.js',
  'scripts/migrate-grade-ids.js',
  'scripts/rebuild-grade-meta.js',
  'scripts/split-by-season.js',
]);

function countRefs(text, field) {
  // Property access, bracket access, object-literal key, and quoted string.
  // Word boundaries keep `age` from matching inside `gradeAge`.
  const patterns = [
    new RegExp(`\\.${field}\\b`, 'g'),
    new RegExp(`\\[\\s*['"\`]${field}['"\`]\\s*\\]`, 'g'),
    new RegExp(`(^|[{,\\s])${field}\\s*:`, 'gm'),
    new RegExp(`['"\`]${field}['"\`]`, 'g'),
    // Object shorthand — `{ venue, vSuburb, venueUrl }`. Omitting this made
    // vSuburb read as unused in fetch-results.js, which writes it on every match
    // record. For a tool whose whole purpose is catching a missed consumer, a
    // false negative is the one unacceptable result.
    new RegExp(`(^|[{,\\s])${field}\\s*[,}]`, 'gm'),
    // Destructuring on its own line, e.g. `const { logos, teamOrgs } = ...`.
    new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=`, 'g'),
  ];
  let n = 0;
  for (const re of patterns) {
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function main() {
  console.log(`=== ${VERSION} ===`);
  console.log(`Scanning ${SOURCES.length} source file(s).\n`);

  const contents = {};
  const missing = [];
  for (const rel of SOURCES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    contents[rel] = fs.readFileSync(p, 'utf8');
  }

  if (missing.length) {
    console.log('MISSING SOURCES — these were not scanned:');
    for (const m of missing) console.log(`  ${m}`);
    console.log('A file absent from this scan is a blind spot. Add it or explain why not.\n');
  }

  const present = Object.keys(contents);
  const short = (f) => f.replace('scripts/', '').replace('.js', '').replace('.html', '');

  // Columns are numbered rather than named. With eight sources the names fitted;
  // with eighteen a named header is over 300 characters wide and wraps in the
  // Actions log, which makes the matrix unreadable — and an unreadable matrix is
  // one nobody checks. The legend is printed once, immediately above.
  const COL = 5;
  console.log('COLUMNS');
  present.forEach((f, i) => console.log(`  [${i + 1}] ${short(f)}`));

  const header = () =>
    `  ${pad('field', 18)}` + present.map((f, i) => padL(`[${i + 1}]`, COL)).join('');

  const report = { version: VERSION, generatedAt: new Date().toISOString(), missing, fields: {} };
  const crossWriter = [];
  const singleUse = [];
  const unreferenced = [];

  for (const [group, fields] of Object.entries(FIELDS)) {
    console.log(`\n=== ${group} ===`);
    console.log(header());
    for (const field of fields) {
      const counts = {};
      for (const f of present) counts[f] = countRefs(contents[f], field);
      const users = present.filter((f) => counts[f] > 0);
      if (!users.length) { unreferenced.push({ field, group }); continue; }

      report.fields[`${group}.${field}`] = { counts, users };

      const writerUsers = users.filter((f) => WRITERS.has(f));
      if (writerUsers.length > 1) crossWriter.push({ field, group, writers: writerUsers.map(short) });
      if (users.length === 1) singleUse.push({ field, group, only: short(users[0]) });

      console.log(
        `  ${pad(field, 18)}` +
        present.map((f) => padL(counts[f] || '·', COL)).join('')
      );
    }
  }

  // The finding that matters. A field touched by more than one writer cannot be
  // changed by editing one of them.
  console.log('\n=== fields touched by MORE THAN ONE writer ===');
  console.log('Changing one of these in one script breaks the others. Read them all first.');
  if (!crossWriter.length) console.log('  (none)');
  for (const c of crossWriter) {
    console.log(`  ${pad(c.field, 18)} ${c.writers.join(', ')}`);
  }

  console.log('\n=== fields referenced in exactly one file ===');
  console.log('Candidates for removal — but confirm the file list above is complete first.');
  if (!singleUse.length) console.log('  (none)');
  for (const c of singleUse) console.log(`  ${pad(c.field, 18)} only ${c.only}`);

  // A tracked field nothing references is either already gone or misspelled in
  // the FIELDS list above. Both are worth seeing: a misspelling here reads as
  // "nothing uses this field", which is the exact wrong answer to give someone
  // about to delete it.
  console.log('\n=== tracked fields with NO reference anywhere ===');
  console.log('Either already removed, or misspelled in this file. Check before believing it.');
  if (!unreferenced.length) console.log('  (none)');
  for (const c of unreferenced) console.log(`  ${pad(c.field, 18)} (${c.group})`);

  report.crossWriter = crossWriter;
  report.singleUse = singleUse;
  report.unreferenced = unreferenced;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nWrote ${REPORT_PATH}`);
  console.log('\nThis reports REFERENCES, not reads or writes. It cannot tell them apart.');
  console.log('Treat a non-zero cell as "go and read that file", not as a verdict.');
  console.log(`\n${VERSION}: done. Nothing was changed.`);
}

main();
