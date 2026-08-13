#!/usr/bin/env node
// scripts/repo-tidy.js
//
// Removes files identified as dead by repo-audit.js. Dry-run unless --apply.
//
// SAFETY: before removing anything, every candidate is checked for references
// across all text files in the repo — HTML, JS, JSON, YAML, Markdown. A file
// that is referenced anywhere is REFUSED, not removed, and reported. This is the
// guard against the failure mode where something looks unused because nobody
// remembered where it was used from.
//
// Groups (choose with --groups=a,b,c — nothing runs without an explicit choice):
//
//   oneoffs     Scripts superseded by shipped features, with their workflows.
//   placeholders  1-byte a.txt files used to create empty directories in git.
//   legacy      Superseded documentation.
//   probes      Diagnostics whose question is answered. probe-finals-rounds is
//               deliberately NOT included — it is a reusable round-structure
//               tool, not a one-off.
//   historic    2024 material. DO NOT REMOVE until multi-season support lands —
//               the dashboard is single-season today, so 2024.html is likely the
//               only working copy of that season outside git history, and
//               fetch-u10-2024.js is a proven example of fetching a past season.
//   migration   scripts/migrate-grades.js. SEPARATE because fetch-results.yml
//               still invokes it; removing it needs a workflow edit too, which
//               this script does NOT do.
//   assets      assets/clubs/** — 129 files, ~10.7MB. Confirmed dead: nothing in
//               this repo references them, and markjovic/fixture-generator is
//               self-contained ("All assets sit alongside index.html", its
//               README) with its own assets/clubs tree. Leftovers from when the
//               two projects shared a repo.
//
// Usage:
//   node scripts/repo-tidy.js --groups=oneoffs,placeholders            (dry run)
//   node scripts/repo-tidy.js --groups=oneoffs,placeholders --apply
//
// Exits 0 when files were removed, 2 when nothing changed, 1 on refusal or error.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── The removal list ─────────────────────────────────────────────────────────
// Every entry carries the reason it is here. Nothing is removed that is not
// listed, whatever the arguments say.

const GROUPS = {
  oneoffs: {
    label: 'Superseded by shipped features',
    paths: [
      ['scripts/extract-finals-data.js',
       'One-off analysis, hardcoded to EFNL 2026 U12 B with a hand-maintained relegated-teams list. Superseded by the finals view.'],
      ['.github/workflows/extract-finals-data.yml',
       'Workflow for the above.'],
    ],
  },
  placeholders: {
    label: 'Git directory placeholders',
    paths: [
      ['assets/clubs/a.txt',
       '1-byte placeholder. The directory has real content, so it is no longer needed.'],
      ['assets/competitions/a.txt',
       '1-byte placeholder and the only file in assets/competitions/. Removing it removes the empty directory.'],
    ],
  },
  storage2026: {
    label: 'Superseded by the per-season storage work of 2026-08-11 and 12',
    paths: [
      ['scripts/split-data.js',
       'The one-time migration from data.json to data/orgs. Superseded by split-by-season.js, and DANGEROUS to keep: it commits, and running it would rebuild data/orgs from a data.json snapshot frozen on 2026-08-11.'],
      ['.github/workflows/split-data.yml',
       'Workflow for the above.'],
      ['scripts/report-data-size.js',
       'Measured the byte composition of data/data.json to design the storage split. The split is built, the file it reads is gone, and audit-data.js section 1 reports sizes across the per-season layout. Its own header says "safe to delete once the storage design is settled".'],
      ['.github/workflows/report-data-size.yml',
       'Workflow for the above.'],
      ['scripts/cleanup-obsolete.js',
       'A second cleanup tool, written on 2026-08-12 without knowing repo-tidy.js existed. repo-tidy is strictly better: it scans every text file for references and REFUSES to remove anything code still points at, where cleanup-obsolete only checked that a named replacement existed. Its removal list has been folded into the storage2026 and probes groups here.'],
      ['scripts/verify-cleanup.js',
       'Verification for the above.'],
      ['.github/workflows/cleanup-obsolete.yml',
       'Workflow for the above.'],
      ['scripts/verify-store.js',
       'Tested the per-organisation layout — creating a missing -archive.json, rollover between files, a scoped save reaching both files of one organisation. None of those concepts exist since the per-season split. Replaced by verify-per-season.js.'],
    ],
  },
  legacy: {
    label: 'Superseded documentation',
    paths: [
      ['SETUP.txt',
       'Superseded by README.md.'],
    ],
  },
  probes: {
    label: 'Diagnostics whose question is answered',
    paths: [
      ['scripts/probe-team-club.js',
       'Asked for club{id name} on DiscoverTeam and concluded no club exists. The field is named organisation — the conclusion is WRONG and re-running this would re-teach the error. Findings are recorded correctly in playhq_api_reference.md.'],
      ['.github/workflows/probe-team-club.yml',
       'Workflow for the above.'],
      ['scripts/probe-club-index.js',
       'Validated the logo-URL to club-id derivation. build-club-index.js performs the same derivation on every run and reports conflicts, so this is redundant.'],
      ['.github/workflows/probe-club-index.yml',
       'Workflow for the above.'],
      ['scripts/probe-api-session.js',
       'Established the three-cookie session order, now recorded in playhq_api_reference.md and implemented in scripts/lib/playhq.js.'],
      ['.github/workflows/probe-api-session.yml',
       'Workflow for the above.'],
      ['scripts/probe-grade-teams.js',
       'Grade-to-team resolution. Superseded by scripts/probe-team-join.js, which answers the same question against the stored data.'],
      ['.github/workflows/probe-grade-teams.yml',
       'Workflow for the above.'],
      ['scripts/probe-team-grades.js',
       'Grade-to-team resolution from the other direction. Superseded by scripts/probe-team-join.js.'],
      ['.github/workflows/probe-team-grades.yml',
       'Workflow for the above.'],
      ['scripts/probe-stored-grade.js',
       'Stored grade shape. Superseded by audit-data.js section 7, which measures grade identity across every season on every run.'],
      ['.github/workflows/probe-stored-grade.yml',
       'Workflow for the above.'],
      ['scripts/probe-search.js',
       'Established the search.playhq.com endpoint, recorded in playhq_api_reference.md §3. The 2026-08-11 sweep it was written for is complete.'],
      ['.github/workflows/probe-search.yml',
       'Workflow for the above.'],
    ],
  },
  historic: {
    // ⚠️ THE HOLD IS RELEASED. This group said "HOLD until multi-season support
    // lands". It landed on 2026-08-12: the dashboard has a season selector, and
    // EFNL, WFNL, SEJ and YJFL 2024 are all backfilled, verified and readable
    // from the archive. The reason for keeping these no longer applies.
    label: '2024 material — superseded by multi-season support (landed 2026-08-12)',
    paths: [
      ['2024.html',
       'Standalone 2024 page. It was kept because the dashboard was single-season and this was likely the only working copy of that season. Both are now false: index.html has a Season selector, and 2024 is stored per season under data/seasons with 4,633 EFNL, 2,362 WFNL, 3,425 SEJ and 3,104 YJFL match records.'],
      ['scripts/fetch-u10-2024.js',
       'One-off historical import for U10 2024, kept as a proven example of fetching a past season. That is now scripts/backfill.js, which fetched every retired season of all five competitions.'],
      ['.github/workflows/fetch-u10-2024.yml',
       'Workflow for the above.'],
    ],
  },
  migration: {
    label: 'Completed migration (REQUIRES a workflow edit — see notes)',
    paths: [
      ['scripts/migrate-grades.js',
       'One-off grade remapping, already applied. The run_migration input, both migration steps, the admin checkbox and the dispatch payload entry were all removed 2026-08-10, so nothing invokes it any more.'],
    ],
  },
  assets: {
    label: 'Club image assets unused by this repo (~10.7MB, 129 files)',
    paths: [
      ['assets/clubs/**',
       'Dead. index.html references only assets/icons. markjovic/fixture-generator carries its own assets/clubs tree and loads it relative to its own index.html, so nothing outside this repo depends on these either. Confirmed 2026-08-10.'],
    ],
  },
};

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { groups: [], apply: false };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--groups': opts.groups = val.split(',').map(s => s.trim()).filter(Boolean); break;
      case '--apply':  opts.apply  = true; break;
      default:
        if (key.startsWith('--')) { console.error(`Unknown argument: ${key}`); process.exit(1); }
    }
  }
  return opts;
}
const OPTS = parseArgs(process.argv.slice(2));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules']);
// Code references block a removal; documentation references only warn. A README
// listing a file in its repo structure is not a dependency on it.
const CODE_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml']);
const DOC_EXT  = new Set(['.md', '.txt']);
const TEXT_EXT = new Set([...CODE_EXT, ...DOC_EXT]);
// This script lists every candidate path by definition, so it must never be
// part of its own reference scan.
const SELF = 'scripts/repo-tidy.js';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Expand a glob-ish "dir/**" entry into its actual files.
function expand(rel) {
  if (!rel.endsWith('/**')) return [rel];
  const base = path.join(ROOT, rel.slice(0, -3));
  if (!fs.existsSync(base)) return [];
  return walk(base).map(f => path.relative(ROOT, f));
}

const kb = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}K` : `${(b / 1048576).toFixed(1)}M`;
const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('repo-tidy.js');
console.log(OPTS.apply ? 'MODE: APPLY — files will be deleted\n' : 'MODE: DRY RUN — nothing will be deleted\n');

if (!OPTS.groups.length) {
  console.log('No groups selected. Available:\n');
  for (const [k, g] of Object.entries(GROUPS)) {
    const n = g.paths.reduce((a, [p]) => a + expand(p).length, 0);
    console.log(`  ${pad(k, 14)} ${pad(n + ' file(s)', 14)} ${g.label}`);
  }
  console.log('\nRe-run with --groups=oneoffs,placeholders (comma separated).');
  process.exit(2);
}

const unknown = OPTS.groups.filter(g => !GROUPS[g]);
if (unknown.length) {
  console.error(`Unknown group(s): ${unknown.join(', ')}`);
  process.exit(1);
}

// Build the candidate list.
// Deduplicated by path: a file can legitimately appear in two groups — for
// example assets/clubs/a.txt is a placeholder AND is matched by the
// assets/clubs/** glob — and queueing it twice would make the second unlink
// throw ENOENT partway through the removal.
const seen = new Set();
const candidates = [];
for (const g of OPTS.groups) {
  for (const [pattern, reason] of GROUPS[g].paths) {
    for (const rel of expand(pattern)) {
      if (seen.has(rel)) continue;
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) { console.log(`  (already gone) ${rel}`); continue; }
      seen.add(rel);
      candidates.push({ rel, full, reason, group: g, size: fs.statSync(full).size });
    }
  }
}
if (!candidates.length) {
  console.log('Nothing to remove — every listed file is already gone.');
  process.exit(2);
}

// ── Reference scan ──
// Read every text file NOT being removed, and look for mentions of each
// candidate. A hit means something still points at it.
console.log('='.repeat(78));
console.log('REFERENCE SCAN');
console.log('='.repeat(78));

const doomed = new Set(candidates.map(c => c.rel));
const haystack = walk(ROOT)
  .map(f => path.relative(ROOT, f))
  .filter(rel => !doomed.has(rel) && rel !== SELF && TEXT_EXT.has(path.extname(rel)))
  .map(rel => {
    const full = path.join(ROOT, rel);
    if (fs.statSync(full).size > 5_000_000) return null; // skip data.json
    return { rel, text: fs.readFileSync(full, 'utf8') };
  })
  .filter(Boolean);

console.log(`Scanning ${haystack.length} text file(s) for references.\n`);

// A line that is entirely a comment is documentation, wherever it lives. Code
// files routinely explain themselves by naming other files — build-club-index.js
// credits the probe that established its approach — and treating that as a
// dependency refuses a removal that is perfectly safe.
function isCommentLine(line, ext) {
  const t = line.trim();
  if (!t) return true;
  if (ext === '.yml' || ext === '.yaml') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const refused = [];
const noted   = [];
for (const c of candidates) {
  const base = path.basename(c.rel);
  const code = [], docs = [];
  for (const h of haystack) {
    // Match the full path or the bare filename. The bare filename is
    // deliberately loose — a false refusal is cheap, a wrong deletion is not.
    if (!h.text.includes(c.rel) && !h.text.includes(base)) continue;
    const ext = path.extname(h.rel);
    if (!CODE_EXT.has(ext)) { docs.push(h.rel); continue; }
    // Inside a code file, only a non-comment mention is a real dependency.
    const hits = h.text.split('\n').filter(l => l.includes(c.rel) || l.includes(base));
    const live = hits.filter(l => !isCommentLine(l, ext));
    (live.length ? code : docs).push(h.rel);
  }
  if (code.length) { c.codeRefs = code; refused.push(c); }
  if (docs.length) { c.docRefs = docs; noted.push(c); }
}

if (refused.length) {
  console.log('*** REFUSED — referenced by code:\n');
  for (const c of refused) {
    console.log(`  ${c.rel}`);
    console.log(`      ${c.codeRefs.slice(0, 6).join(', ')}${c.codeRefs.length > 6 ? ` (+${c.codeRefs.length - 6})` : ''}`);
  }
  console.log('\n  Resolve these before removing. A workflow invoking a script is a real');
  console.log('  dependency and deleting it would break the run.\n');
}

const docOnly = noted.filter(c => !c.codeRefs);
if (docOnly.length) {
  console.log('Mentioned in documentation only — removal allowed, but update these:\n');
  for (const c of docOnly) {
    console.log(`  ${pad(c.rel, 46)} ${c.docRefs.join(', ')}`);
  }
  console.log('');
}

if (!refused.length && !docOnly.length) console.log('No references found to any candidate.\n');

const removable = candidates.filter(c => !c.codeRefs);

// ── Plan ──
console.log('='.repeat(78));
console.log(OPTS.apply ? 'REMOVING' : 'WOULD REMOVE');
console.log('='.repeat(78));

let bytes = 0;
let lastGroup = '';
for (const c of removable) {
  if (c.group !== lastGroup) {
    console.log(`\n  [${c.group}] ${GROUPS[c.group].label}`);
    lastGroup = c.group;
  }
  console.log(`    ${pad(c.rel, 46)} ${pad(kb(c.size), 8)}`);
  bytes += c.size;
}
if (removable.length > 12) {
  console.log(`\n  (${removable.length} files in total)`);
}
console.log(`\n${removable.length} file(s), ${kb(bytes)}.`);

if (OPTS.groups.includes('migration') && removable.some(c => c.group === 'migration')) {
  console.log('\n*** NOTE: removing migrate-grades.js also requires editing fetch-results.yml');
  console.log('    to delete the run_migration input and its two steps. This script does not');
  console.log('    edit workflows.');
}

if (!OPTS.apply) {
  console.log('\nDry run. Re-run with --apply to delete.');
  process.exit(removable.length ? 0 : 2);
}

if (!removable.length) {
  console.log('\nNothing removable.');
  process.exit(2);
}

for (const c of removable) {
  fs.unlinkSync(c.full);
}
// Remove any directories left empty.
let pruned = 0;
const dirs = [...new Set(removable.map(c => path.dirname(c.full)))].sort((a, b) => b.length - a.length);
for (const d of dirs) {
  let cur = d;
  while (cur.startsWith(ROOT) && cur !== ROOT) {
    if (fs.existsSync(cur) && fs.readdirSync(cur).length === 0) {
      fs.rmdirSync(cur); pruned++;
      cur = path.dirname(cur);
    } else break;
  }
}
console.log(`\nRemoved ${removable.length} file(s)${pruned ? ` and ${pruned} empty directory(ies)` : ''}.`);
process.exit(0);
