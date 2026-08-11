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

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'field-usage-report.json');

// Every file that produces or consumes stored data. Missing one from this list
// is the failure mode this tool exists to prevent, so an absent file is
// reported loudly rather than skipped quietly.
const SOURCES = [
  'scripts/fetch-results.js',
  'scripts/fetch-fixtures.js',
  'scripts/fetch-stats.js',
  'scripts/build-club-index.js',
  'scripts/discover-seasons.js',
  'scripts/discover-orgs.js',
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
  ],
  'player record': [
    'uuid', 'firstName', 'lastName', 'teamRaw', 'gradeID', 'gradeName',
    'gp', 'goals', 'bestPlayer', 'transferred', 'appearances',
  ],
  'grades.json / manifest': [
    'seasonID', 'seasonId', 'ageName', 'genderName', 'manifest',
    'organisations', 'organisationCodes', 'excludeGrades', 'vip', 'phases',
  ],
};

// Writers, for the cross-writer check. A field a writer produces and ANOTHER
// writer consumes is the dangerous shape: changing it breaks a file that is not
// the one being edited and not the dashboard either.
const WRITERS = new Set([
  'scripts/fetch-results.js',
  'scripts/fetch-fixtures.js',
  'scripts/fetch-stats.js',
  'scripts/build-club-index.js',
  'scripts/discover-seasons.js',
  'scripts/discover-orgs.js',
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

  const report = { generatedAt: new Date().toISOString(), missing, fields: {} };
  const crossWriter = [];
  const singleUse = [];

  for (const [group, fields] of Object.entries(FIELDS)) {
    console.log(`\n=== ${group} ===`);
    console.log(`  ${pad('field', 18)}${present.map((f) => padL(short(f), 17)).join('')}`);
    for (const field of fields) {
      const counts = {};
      for (const f of present) counts[f] = countRefs(contents[f], field);
      const users = present.filter((f) => counts[f] > 0);
      if (!users.length) continue;

      report.fields[`${group}.${field}`] = { counts, users };

      const writerUsers = users.filter((f) => WRITERS.has(f));
      if (writerUsers.length > 1) crossWriter.push({ field, group, writers: writerUsers.map(short) });
      if (users.length === 1) singleUse.push({ field, group, only: short(users[0]) });

      console.log(
        `  ${pad(field, 18)}` +
        present.map((f) => padL(counts[f] || '·', 17)).join('')
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
  for (const c of singleUse) console.log(`  ${pad(c.field, 18)} only ${c.only}`);

  report.crossWriter = crossWriter;
  report.singleUse = singleUse;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nWrote ${REPORT_PATH}`);
  console.log('\nThis reports REFERENCES, not reads or writes. It cannot tell them apart.');
  console.log('Treat a non-zero cell as "go and read that file", not as a verdict.');
}

main();
