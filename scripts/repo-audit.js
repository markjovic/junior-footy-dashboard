#!/usr/bin/env node
// scripts/repo-audit.js
//
// READ-ONLY. Writes nothing, commits nothing, pushes nothing.
//
// Answers "which files can be deleted" with evidence rather than memory:
//
//   1. Inventory — every tracked file with size and last-commit date.
//   2. Duplicate basenames — the same filename in two places, one of which is
//      almost certainly dead. This repo has fetch-fixtures.js in the root while
//      fetch-results.yml runs scripts/fetch-fixtures.js.
//   3. Identical content — two paths with the same hash, regardless of name.
//   4. Orphan scripts — scripts/*.js referenced by no workflow.
//   5. Broken references — workflows invoking a script that does not exist.
//   6. Divergent duplicates — same basename, DIFFERENT content. The dangerous
//      case: editing the wrong copy looks like it worked.
//
// Nothing is deleted. The output is a list to decide from.

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Files above this are listed separately — they dominate clone time.
const LARGE_BYTES = 1024 * 1024;

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
const lpad = (s, n) => { const t = String(s); return t.length >= n ? t : ' '.repeat(n - t.length) + t; };
const kb = b => b < 1024 ? `${b}B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)}K` : `${(b / 1048576).toFixed(1)}M`;

// ─── Inventory ────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function lastCommitDate(rel) {
  try {
    return execSync(`git log -1 --format=%cs -- "${rel}"`, { cwd: ROOT, encoding: 'utf8' }).trim() || '—';
  } catch {
    return '—';
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const files = walk(ROOT).map(full => {
  const rel  = path.relative(ROOT, full);
  const stat = fs.statSync(full);
  const buf  = fs.readFileSync(full);
  return {
    rel,
    base: path.basename(rel),
    dir:  path.dirname(rel),
    size: stat.size,
    hash: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
    text: buf.length < 2_000_000 ? buf.toString('utf8') : '',
  };
}).sort((a, b) => a.rel.localeCompare(b.rel));

console.log('repo-audit.js — READ-ONLY. Nothing is written.\n');

// ── 1. Inventory ──
console.log('='.repeat(78));
console.log('1. INVENTORY');
console.log('='.repeat(78));
console.log(`${pad('path', 46)} ${lpad('size', 7)}  last commit`);
for (const f of files) {
  console.log(`${pad(f.rel, 46)} ${lpad(kb(f.size), 7)}  ${lastCommitDate(f.rel)}`);
}
const total = files.reduce((n, f) => n + f.size, 0);
console.log(`\n${files.length} file(s), ${kb(total)} total.`);

const large = files.filter(f => f.size >= LARGE_BYTES);
if (large.length) {
  console.log(`\nLarge files (>= 1MB) — these dominate checkout time:`);
  for (const f of large) console.log(`  ${pad(f.rel, 46)} ${lpad(kb(f.size), 7)}`);
}

// ── 2 & 6. Duplicate basenames ──
console.log('\n' + '='.repeat(78));
console.log('2. SAME FILENAME IN MORE THAN ONE PLACE');
console.log('='.repeat(78));
const byBase = new Map();
for (const f of files) {
  if (!byBase.has(f.base)) byBase.set(f.base, []);
  byBase.get(f.base).push(f);
}
const dupeNames = [...byBase.entries()].filter(([, v]) => v.length > 1);
if (!dupeNames.length) {
  console.log('  None.');
} else {
  for (const [base, copies] of dupeNames) {
    const identical = copies.every(c => c.hash === copies[0].hash);
    console.log(`\n  ${base}  — ${copies.length} copies, ${identical ? 'IDENTICAL' : '*** DIFFERENT CONTENT ***'}`);
    for (const c of copies) {
      console.log(`      ${pad(c.rel, 44)} ${lpad(kb(c.size), 7)}  ${c.hash}  ${lastCommitDate(c.rel)}`);
    }
    if (!identical) {
      console.log('      Editing the wrong copy will look like it worked. Resolve before touching either.');
    }
  }
}

// ── 3. Identical content under different names ──
console.log('\n' + '='.repeat(78));
console.log('3. IDENTICAL CONTENT UNDER DIFFERENT NAMES');
console.log('='.repeat(78));
const byHash = new Map();
for (const f of files) {
  if (!byHash.has(f.hash)) byHash.set(f.hash, []);
  byHash.get(f.hash).push(f);
}
const dupeContent = [...byHash.values()].filter(v => v.length > 1 && new Set(v.map(x => x.base)).size > 1);
if (!dupeContent.length) console.log('  None.');
else for (const group of dupeContent) {
  console.log(`\n  ${group[0].hash}:`);
  for (const f of group) console.log(`      ${f.rel}`);
}

// ── 4 & 5. Workflow references ──
console.log('\n' + '='.repeat(78));
console.log('4. WORKFLOW REFERENCES');
console.log('='.repeat(78));

const workflows = files.filter(f => f.rel.startsWith('.github/workflows/') && /\.ya?ml$/.test(f.rel));
const scripts   = files.filter(f => /^scripts\/.*\.(js|mjs|cjs)$/.test(f.rel));

// Every "node <path>" invocation across all workflows.
const invoked = new Map(); // script path -> [workflow files]
for (const wf of workflows) {
  const matches = [...wf.text.matchAll(/node\s+(?:--[\w-]+\s+)*([\w./-]+\.(?:js|mjs|cjs))/g)];
  for (const m of matches) {
    const p = m[1].replace(/^\.\//, '');
    if (!invoked.has(p)) invoked.set(p, []);
    if (!invoked.get(p).includes(wf.rel)) invoked.get(p).push(wf.rel);
  }
}

console.log(`\n${workflows.length} workflow(s), ${scripts.length} script(s) in scripts/.\n`);
console.log(`${pad('workflow', 42)} invokes`);
for (const wf of workflows) {
  const calls = [...invoked.entries()].filter(([, v]) => v.includes(wf.rel)).map(([k]) => k);
  console.log(`${pad(wf.rel.replace('.github/workflows/', ''), 42)} ${calls.length ? calls.join(', ') : '(no node invocation found)'}`);
}

console.log('\n--- scripts NOT invoked by any workflow ---');
const orphans = scripts.filter(s => !invoked.has(s.rel));
if (!orphans.length) console.log('  None.');
else for (const s of orphans) {
  console.log(`  ${pad(s.rel, 44)} ${lpad(kb(s.size), 7)}  last commit ${lastCommitDate(s.rel)}`);
}

console.log('\n--- workflow references to files that do NOT exist ---');
const known = new Set(files.map(f => f.rel));
const broken = [...invoked.entries()].filter(([p]) => !known.has(p));
if (!broken.length) console.log('  None.');
else for (const [p, wfs] of broken) {
  console.log(`  *** ${p}  referenced by ${wfs.join(', ')}`);
}

// ── 5b. Root-level scripts, which the house convention says belong in scripts/ ──
console.log('\n--- scripts outside scripts/ ---');
// scripts/ is where GitHub Actions runs things from. Code that lives elsewhere
// on purpose is not stray:
//   sw.js      — service worker, must be served from the site root to control
//                the whole origin scope
//   workers/   — Cloudflare Workers, deployed to Cloudflare rather than run by
//                Actions, so no workflow will ever invoke them
//   assets/    — not code
const stray = files.filter(f => /\.(js|mjs|cjs)$/.test(f.rel) && !f.rel.startsWith('scripts/')
  && !f.rel.startsWith('assets/') && !f.rel.startsWith('workers/') && f.base !== 'sw.js');
if (!stray.length) console.log('  None.');
else for (const f of stray) {
  const alsoInScripts = files.find(x => x.rel === `scripts/${f.base}`);
  console.log(`  ${pad(f.rel, 44)} ${lpad(kb(f.size), 7)}  ` +
    (alsoInScripts
      ? (alsoInScripts.hash === f.hash ? 'duplicate of scripts/ copy (identical)' : '*** also in scripts/ with DIFFERENT content ***')
      : 'no copy in scripts/'));
}

console.log('\n' + '='.repeat(78));
console.log('Audit complete. Nothing was written or deleted.');
console.log('='.repeat(78));
