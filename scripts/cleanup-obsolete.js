#!/usr/bin/env node
// scripts/cleanup-obsolete.js
//
// Removes files superseded by the 2026-08-11 and 2026-08-12 storage work.
//
// EVERY ENTRY IS LISTED EXPLICITLY, WITH A REASON AND A REPLACEMENT.
// There is no glob and no pattern. A cleanup that can match a file nobody
// thought about is a cleanup that will eventually delete something needed, and
// this repository has already lost data twice in one day.
//
// THE GUARD: nothing is removed unless its stated replacement EXISTS on disk.
// Deleting split-data.js is only safe because split-by-season.js is there; if a
// commit went astray and the replacement is missing, the removal is refused and
// reported rather than leaving a gap.
//
// It does not use git. It deletes files and the workflow commits the result, so
// a mistake is recoverable from git history like any other commit.
//
// Env:
//   CLEANUP_DRY_RUN        "false" to delete. Anything else lists and stops.
//   CLEANUP_ROLLBACK_DATA  "true" to also remove data/orgs and data/data.json —
//                          the rollback paths from the two storage migrations.
//                          Separate because they are the recovery route, and
//                          data/orgs restored 179,624 player records on
//                          2026-08-12. Only after a full weekend of scheduled
//                          runs on the per-season layout.
//
// Exit codes: 0 = something removed, 2 = nothing to do or dry run, 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'cleanup-obsolete v2 2026-08-12 inventory';
const ROOT = path.resolve(__dirname, '..');
const DRY = process.env.CLEANUP_DRY_RUN !== 'false';
const ROLLBACK = process.env.CLEANUP_ROLLBACK_DATA === 'true';

// ── The list ────────────────────────────────────────────────────────────────
// requires: the replacement that must exist before this is removed. A file with
// no replacement is one whose purpose has gone away entirely, and says so.
const ITEMS = [
  {
    path: 'scripts/split-data.js',
    why: 'the one-time migration from data.json to data/orgs. Superseded, and ' +
         'DANGEROUS to keep: it commits, and running it would rebuild data/orgs ' +
         'from a data.json snapshot frozen on 2026-08-11.',
    requires: 'scripts/split-by-season.js',
  },
  {
    path: '.github/workflows/split-data.yml',
    why: 'the workflow for the above.',
    requires: 'scripts/split-by-season.js',
  },
  {
    path: 'scripts/report-data-size.js',
    why: 'measured the byte composition of data/data.json to design the storage ' +
         'split. The split is built, the file it reads is gone, and audit-data.js ' +
         'section 1 reports sizes across the per-season layout. Its own header ' +
         'says "safe to delete once the storage design is settled".',
    requires: 'scripts/audit-data.js',
  },
  {
    path: '.github/workflows/report-data-size.yml',
    why: 'the workflow for the above.',
    requires: 'scripts/audit-data.js',
  },
  {
    path: 'scripts/verify-store.js',
    why: 'tested the per-organisation layout — creating a missing -archive.json, ' +
         'rollover between files, a scoped save reaching both files of one ' +
         'organisation. None of those concepts exist any more.',
    requires: 'scripts/verify-per-season.js',
  },
];

// Held back behind CLEANUP_ROLLBACK_DATA.
const ROLLBACK_ITEMS = [
  {
    path: 'data/data.json',
    why: 'the rollback path from the 2026-08-11 per-organisation split. Nothing ' +
         'has read or written it since.',
    requires: 'data/core.json',
    dir: false,
  },
  {
    path: 'data/orgs',
    why: 'the rollback path from the 2026-08-12 per-season split — and it earned ' +
         'its keep, restoring 179,624 player records that day. Roughly 105 MB.',
    requires: 'data/seasons',
    dir: true,
  },
];

// Files known to be in use, so the inventory below can name what is not. A file
// missing from this list is reported as UNACCOUNTED FOR rather than deleted —
// the list decides what gets *reported*, never what gets removed.
const IN_USE = new Set([
  // Storage and transport
  'scripts/lib/store.js', 'scripts/lib/playhq.js', 'scripts/lib/results-engine.js',
  // Writers
  'scripts/fetch-results.js', 'scripts/fetch-fixtures.js', 'scripts/fetch-stats.js',
  'scripts/backfill.js', 'scripts/build-club-index.js',
  'scripts/discover-seasons.js', 'scripts/discover-orgs.js',
  // One-off but still meaningful
  'scripts/migrate-grade-ids.js', 'scripts/rebuild-grade-meta.js',
  'scripts/split-by-season.js', 'scripts/cleanup-obsolete.js',
  // Diagnostics
  'scripts/audit-data.js', 'scripts/report-field-usage.js',
  'scripts/report-grade-collisions.js',
  'scripts/probe-search.js', 'scripts/probe-team-join.js',
  // Verification
  'scripts/verify-per-season.js', 'scripts/verify-backfill.js',
  'scripts/verify-discover-seasons.js', 'scripts/verify-migrate-grade-ids.js',
  'scripts/verify-dashboard-grades.js', 'scripts/verify-rebuild-grade-meta.js',
  'scripts/verify-audit.js', 'scripts/verify-cleanup.js',
]);

function fail(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

function sizeOf(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const f of fs.readdirSync(p)) {
    const full = path.join(p, f);
    total += fs.statSync(full).isDirectory() ? sizeOf(full) : fs.statSync(full).size;
  }
  return total;
}

function main() {
  console.log(`=== ${VERSION} ===`);
  console.log(DRY ? 'DRY RUN — nothing will be deleted.' : '*** DELETING ***');
  console.log(ROLLBACK
    ? 'CLEANUP_ROLLBACK_DATA is set — the migration rollback paths are included.'
    : 'The migration rollback paths are NOT included. Set CLEANUP_ROLLBACK_DATA=true for those.');

  // ── Inventory ───────────────────────────────────────────────────────────
  // "Three files" was an answer from what I happened to have seen, not from
  // what is there. This lists everything and says which are accounted for, so
  // the next decision is made from the repository rather than from memory.
  console.log(`\n── Inventory ─────────────────────────────────────────────`);
  const removing = new Set(ITEMS.map(i => i.path));
  const scriptsDir = path.join(ROOT, 'scripts');
  const wfDir = path.join(ROOT, '.github', 'workflows');

  const scripts = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js')).map(f => `scripts/${f}`).sort() : [];
  const workflows = fs.existsSync(wfDir)
    ? fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`).sort() : [];

  const unknownScripts = scripts.filter(f => !IN_USE.has(f) && !removing.has(f));
  console.log(`  ${scripts.length} script(s), ${workflows.length} workflow(s)`);
  console.log(`  ${scripts.filter(f => IN_USE.has(f)).length} script(s) accounted for as in use`);
  console.log(`  ${scripts.filter(f => removing.has(f)).length} listed for removal below`);
  if (unknownScripts.length) {
    console.log(`\n  ⚠️  ${unknownScripts.length} script(s) UNACCOUNTED FOR — not known to be in use,`);
    console.log(`     and not on the removal list. Decide on each before it rots:`);
    for (const f of unknownScripts) console.log(`       ${f}`);
  } else {
    console.log(`  every script is either in use or listed for removal`);
  }

  // A workflow whose script is gone can never do anything but fail.
  const orphanWorkflows = [];
  for (const w of workflows) {
    if (removing.has(w)) continue;
    const body = fs.readFileSync(path.join(ROOT, w), 'utf8');
    const refs = [...body.matchAll(/node\s+(scripts\/[\w.-]+\.js)/g)].map(m => m[1]);
    const dead = [...new Set(refs)].filter(r => !fs.existsSync(path.join(ROOT, r)));
    if (dead.length) orphanWorkflows.push({ w, dead });
  }
  if (orphanWorkflows.length) {
    console.log(`\n  ⚠️  ${orphanWorkflows.length} workflow(s) run a script that does not exist:`);
    for (const o of orphanWorkflows) console.log(`       ${o.w} -> ${o.dead.join(', ')}`);
  }

  // A workflow that names a root-level data file fails with exit 128 — those
  // moved into data/ on 2026-08-11 and it has already cost one wasted run.
  const badPathspec = [];
  for (const w of workflows) {
    const body = fs.readFileSync(path.join(ROOT, w), 'utf8');
    if (/git add\s+(?!-A\b)[^\n]*\b(data|grades|clubs)\.json/.test(body)) badPathspec.push(w);
  }
  if (badPathspec.length) {
    console.log(`\n  ⚠️  ${badPathspec.length} workflow(s) name a ROOT-LEVEL data file in git add.`);
    console.log(`     Those moved into data/ on 2026-08-11, so the commit fails with exit 128:`);
    for (const w of badPathspec) console.log(`       ${w}`);
  }

  const all = ITEMS.concat(ROLLBACK ? ROLLBACK_ITEMS : []);
  const toRemove = [];
  const absent = [];
  const refused = [];

  for (const item of all) {
    const p = path.join(ROOT, item.path);
    if (!fs.existsSync(p)) { absent.push(item); continue; }
    // THE GUARD. If the replacement is not here, something went wrong earlier
    // and removing this would leave a gap rather than tidy one up.
    if (item.requires && !fs.existsSync(path.join(ROOT, item.requires))) {
      refused.push({ item, reason: `${item.requires} is not on disk` });
      continue;
    }
    toRemove.push({ item, bytes: sizeOf(p) });
  }

  if (absent.length) {
    console.log(`\nAlready gone, nothing to do:`);
    for (const i of absent) console.log(`  ${i.path}`);
  }

  if (refused.length) {
    console.log(`\n⚠️  REFUSED — the replacement is missing, so this is not a tidy-up:`);
    for (const r of refused) console.log(`  ${r.item.path}\n      ${r.reason}`);
  }

  if (!toRemove.length) {
    console.log(`\nNothing to remove.`);
    if (refused.length) fail(`${refused.length} item(s) refused because a replacement is missing. ` +
      `Commit the replacement first.`);
    process.exit(2);
  }

  console.log(`\n${toRemove.length} item(s) to remove:`);
  let total = 0;
  for (const { item, bytes } of toRemove) {
    total += bytes;
    console.log(`\n  ${item.path}   ${mb(bytes)}`);
    console.log(`      ${item.why}`);
    if (item.requires) console.log(`      replaced by: ${item.requires} ✓`);
  }
  console.log(`\n  total: ${mb(total)}`);

  if (DRY) {
    console.log(`\nDRY RUN — nothing deleted. Set CLEANUP_DRY_RUN=false to apply.`);
    process.exit(2);
  }

  for (const { item } of toRemove) {
    const p = path.join(ROOT, item.path);
    fs.rmSync(p, { recursive: true, force: true });
    if (fs.existsSync(p)) fail(`could not remove ${item.path}`);
    console.log(`  removed ${item.path}`);
  }

  console.log(`\n${VERSION}: ${toRemove.length} item(s) removed, ${mb(total)} reclaimed.`);
  console.log(`Everything here is in git history — a mistake is one revert away.`);
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
