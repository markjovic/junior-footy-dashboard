// scripts/verify-cleanup.js
//
// Verifies scripts/cleanup-obsolete.js by EXECUTING it against fixtures.
//
// A script that deletes files gets checked harder than one that writes them.
// What is under test is mostly what it REFUSES to do: delete something whose
// replacement is missing, delete a rollback path without being asked, or delete
// anything at all on a dry run.
//
// It builds every fixture in a temp directory. The repository is never touched.
//
// Run: node scripts/verify-cleanup.js     Exit 0 all passed, 1 any failed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'verify-cleanup v1 2026-08-12';
console.log(`=== ${VERSION} ===`);

const SCRIPT = path.join(__dirname, 'cleanup-obsolete.js');
if (!fs.existsSync(SCRIPT)) { console.error('FATAL: scripts/cleanup-obsolete.js not found.'); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-verify-'));
fs.mkdirSync(path.join(TMP, 'scripts'), { recursive: true });
fs.copyFileSync(SCRIPT, path.join(TMP, 'scripts', 'cleanup-obsolete.js'));

const touch = (rel, body) => {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body || 'x');
};
const there = (rel) => fs.existsSync(path.join(TMP, rel));

// A tree with everything present: the obsolete files AND their replacements.
function fullTree(opts) {
  opts = opts || {};
  for (const d of ['scripts', '.github', 'data']) {
    fs.rmSync(path.join(TMP, d), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(TMP, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(TMP, 'scripts', 'cleanup-obsolete.js'));

  // Obsolete
  touch('scripts/split-data.js');
  touch('.github/workflows/split-data.yml');
  touch('scripts/report-data-size.js');
  touch('.github/workflows/report-data-size.yml');
  touch('scripts/verify-store.js');
  // Rollback paths
  touch('data/data.json', '{}');
  touch('data/orgs/383836bb-current.json', '{}');
  touch('data/orgs/383836bb-archive.json', '{}');
  // Replacements — omit one to test the guard
  if (opts.omit !== 'split-by-season') touch('scripts/split-by-season.js');
  if (opts.omit !== 'audit-data') touch('scripts/audit-data.js');
  if (opts.omit !== 'verify-per-season') touch('scripts/verify-per-season.js');
  touch('data/core.json', '{}');
  touch('data/seasons/2dcbf383-core.json', '{}');
}

function run(env) {
  const r = spawnSync(process.execPath, ['scripts/cleanup-obsolete.js'],
    { cwd: TMP, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let pass = 0, fail = 0, LAST = null, dumped = false;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); return; }
  fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  if (!dumped && LAST) { dumped = true; console.log('\n--- output ---');
    for (const l of LAST.out.split('\n').slice(-25)) console.log(`  | ${l}`);
    console.log('--- end ---\n'); }
}

// ── 1. Dry run ───────────────────────────────────────────────────────────────
console.log('\n1  A dry run deletes nothing');
fullTree();
LAST = run({});
ok('exit 2', LAST.code === 2, `exit ${LAST.code}`);
ok('everything is still there',
  there('scripts/split-data.js') && there('scripts/report-data-size.js') &&
  there('scripts/verify-store.js'));
ok('it lists what it would remove', /split-data\.js/.test(LAST.out));
ok('and says WHY for each', /Superseded, and DANGEROUS to keep/.test(LAST.out));

// ── 2. The removal ───────────────────────────────────────────────────────────
console.log('\n2  Applying it removes exactly the listed files');
LAST = run({ CLEANUP_DRY_RUN: 'false' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('the obsolete migration is gone', !there('scripts/split-data.js'));
ok('and its workflow', !there('.github/workflows/split-data.yml'));
ok('the obsolete size report is gone', !there('scripts/report-data-size.js'));
ok('the retired verification is gone', !there('scripts/verify-store.js'));

// The point of the guard: nothing else went with them.
ok('the replacements are untouched',
  there('scripts/split-by-season.js') && there('scripts/audit-data.js') &&
  there('scripts/verify-per-season.js'));
ok('and the ROLLBACK paths are untouched — they were not asked for',
  there('data/data.json') && there('data/orgs/383836bb-archive.json'),
  'data/orgs restored 179,624 player records on 2026-08-12');

// ── 3. Idempotency ───────────────────────────────────────────────────────────
console.log('\n3  Re-running finds nothing to do');
LAST = run({ CLEANUP_DRY_RUN: 'false' });
ok('exit 2', LAST.code === 2, `exit ${LAST.code}`);
ok('and says so', /Already gone|Nothing to remove/.test(LAST.out));

// ── 4. The guard ─────────────────────────────────────────────────────────────
// A missing replacement means something went wrong earlier. Removing the old
// file then leaves a gap rather than tidying one up.
console.log('\n4  A missing replacement REFUSES the removal');
fullTree({ omit: 'split-by-season' });
LAST = run({ CLEANUP_DRY_RUN: 'false' });
ok('it refuses', /REFUSED/.test(LAST.out));
ok('and names what is missing', /split-by-season\.js is not on disk/.test(LAST.out));
ok('the file it could not verify is STILL THERE', there('scripts/split-data.js'));
ok('while the ones it could verify were removed',
  !there('scripts/report-data-size.js') && !there('scripts/verify-store.js'),
  'one missing replacement does not block the rest');

// ── 5. Rollback data is opt-in ───────────────────────────────────────────────
console.log('\n5  The rollback paths need asking for');
fullTree();
LAST = run({ CLEANUP_DRY_RUN: 'false', CLEANUP_ROLLBACK_DATA: 'true' });
ok('exit 0', LAST.code === 0, `exit ${LAST.code}`);
ok('data/data.json removed', !there('data/data.json'));
ok('data/orgs removed entirely, directory and contents',
  !there('data/orgs') && !there('data/orgs/383836bb-archive.json'));
ok('but data/seasons survives — that is the live layout',
  there('data/seasons/2dcbf383-core.json'));
ok('and core.json survives', there('data/core.json'));

// Could that have failed? Without the replacement, the rollback is refused too.
fullTree();
fs.rmSync(path.join(TMP, 'data', 'seasons'), { recursive: true, force: true });
LAST = run({ CLEANUP_DRY_RUN: 'false', CLEANUP_ROLLBACK_DATA: 'true' });
ok('with no data/seasons, data/orgs is REFUSED',
  there('data/orgs/383836bb-archive.json') && /REFUSED/.test(LAST.out),
  'deleting the rollback with no new layout would lose everything');

// ── 6. It cannot touch anything not on the list ──────────────────────────────
console.log('\n6  Nothing outside the list is at risk');
fullTree();
touch('scripts/fetch-results.js');
touch('scripts/lib/store.js');
touch('index.html');
touch('data/grades.json', '[]');
LAST = run({ CLEANUP_DRY_RUN: 'false', CLEANUP_ROLLBACK_DATA: 'true' });
ok('a live writer is untouched', there('scripts/fetch-results.js'));
ok('the storage layer is untouched', there('scripts/lib/store.js'));
ok('the dashboard is untouched', there('index.html'));
ok('grades.json is untouched — still read by four scripts', there('data/grades.json'));

// ── 7. The inventory reports what the list does not cover ───────────────────
// "Three files to remove" was an answer from what I had seen, not from what is
// in the repository. The inventory names everything so the next decision comes
// from the tree rather than from memory — and it must never turn a report into
// a removal.
console.log('\n7  The inventory names what nobody has decided about');
fullTree();
touch('scripts/some-forgotten-thing.js');
touch('.github/workflows/orphaned.yml', 'run: node scripts/deleted-long-ago.js');
touch('.github/workflows/badpath.yml', 'run: |\n  git add data.json\n');
LAST = run({});
ok('an unknown script is reported', /UNACCOUNTED FOR/.test(LAST.out) &&
  /some-forgotten-thing\.js/.test(LAST.out));
ok('a workflow running a missing script is reported',
  /run a script that does not exist/.test(LAST.out) && /orphaned\.yml/.test(LAST.out));
ok('a workflow with the root-level pathspec is reported',
  /ROOT-LEVEL data file/.test(LAST.out) && /badpath\.yml/.test(LAST.out),
  'the exit 128 that broke build-club-index');

// The important part: reporting is not removing.
LAST = run({ CLEANUP_DRY_RUN: 'false' });
ok('the unknown script is NOT deleted', there('scripts/some-forgotten-thing.js'),
  'the inventory decides what to REPORT, never what to remove');
ok('nor the orphaned workflow', there('.github/workflows/orphaned.yml'));
ok('nor the one with the bad pathspec', there('.github/workflows/badpath.yml'));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${VERSION}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
