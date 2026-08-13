#!/usr/bin/env node
// scripts/rebuild-grade-meta.js
//
// Regenerates gradeMeta for every stored season from data/grades.json.
// season_selection_design.md §1.4 and §4 step 1.
//
// OFFLINE. It calls nothing — every grade name it needs is already in
// grades.json, and buildGradeMeta is exported from the results engine.
//
// WHY IT EXISTS
// fetch-results.js only regenerates gradeMeta for the seasons in config.json,
// which is the five current ones. The thirteen archived seasons still carry
// pre-2026-08-12 entries: keyed on rawGrade, with no label and no gradeId. An
// archived ladder would group correctly, because match records carry grade ids,
// but its tabs would read "1debae74" instead of "A" — gLabel() finds nothing and
// falls back to the key.
//
// Env:
//   REBUILD_ORG=<code>     8-character organisation code, or "all". Required.
//   REBUILD_DRY_RUN        "false" to write. Anything else is a dry run.
//
// Exit codes: 0 = changed, commit. 2 = no change, skip commit. 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { buildGradeMeta, ENGINE_VERSION } = require('./lib/results-engine');

const VERSION = 'rebuild-grade-meta v1 2026-08-12';
const ROOT = path.resolve(__dirname, '..');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');
const ORG = (process.env.REBUILD_ORG || '').trim();
const DRY = process.env.REBUILD_DRY_RUN !== 'false';

function fail(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }

function rebuildOrg(org, grades, core) {
  const forOrg = (core.manifest || []).filter(m => m.org === org && m.compName);
  if (!forOrg.length) { console.log(`  ${org}: no seasons with a compName — skipped`); return false; }

  const scope = forOrg.map(m => m.compName);
  const scopeSet = new Set(scope);
  const orgGrades = grades.filter(g => scopeSet.has(g.compName));

  console.log(`\n${'='.repeat(60)}\n${org} — ${scope.length} season(s), ${orgGrades.length} grade(s) in grades.json\n${'='.repeat(60)}`);
  if (!orgGrades.length) {
    console.log(`  no grades in grades.json for this organisation — nothing to rebuild`);
    return false;
  }

  const data = store.load(scope);
  // Canonical, key-sorted. A plain JSON.stringify compares key ORDER too, and
  // { ...kept, ...fresh } produces a different order from the file it was read
  // from — so identical content read as changed and the script rewrote every
  // file on every run.
  const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
  const before = canon(data.gradeMeta);

  // Only the competitions grades.json actually covers are replaced. A season
  // with no grades in the file keeps whatever it has: regenerating from an
  // incomplete source would silently delete its metadata, and an absent season
  // is indistinguishable from an empty one at this point.
  const covered = new Set(orgGrades.map(g => g.compName));
  const uncovered = scope.filter(c => !covered.has(c));
  if (uncovered.length) {
    console.log(`  no grades in grades.json for: ${uncovered.join(', ')} — their existing gradeMeta is kept`);
  }

  const kept = {};
  for (const [k, v] of Object.entries(data.gradeMeta || {})) {
    const comp = k.slice(0, k.indexOf('|'));
    if (!covered.has(comp)) kept[k] = v;
  }
  const fresh = buildGradeMeta(orgGrades);
  data.gradeMeta = { ...kept, ...fresh };

  // Report what actually changed, per season, rather than one total.
  const countBy = (obj, pred) => Object.entries(obj).filter(([, v]) => pred(v)).length;
  console.log(`  gradeMeta entries: ${Object.keys(data.gradeMeta).length} ` +
    `(${countBy(data.gradeMeta, v => v && v.gradeId)} keyed by grade id, ` +
    `${countBy(data.gradeMeta, v => v && v.label)} with a display label)`);
  for (const c of scope) {
    const n = Object.keys(fresh).filter(k => k.startsWith(c + '|')).length;
    const labelled = Object.entries(fresh).filter(([k, v]) => k.startsWith(c + '|') && v.label).length;
    if (n) console.log(`    ${c.padEnd(14)} ${String(n).padStart(4)} entries, ${labelled} labelled`);
  }

  if (canon(data.gradeMeta) === before) { console.log(`  unchanged`); return false; }

  if (DRY) { console.log(`  DRY RUN — not written`); return false; }
  store.report(store.save(data, scope), `rebuild ${org}`);
  return true;
}

function main() {
  console.log(`=== ${VERSION} (engine ${ENGINE_VERSION}) ===`);
  console.log(DRY ? 'DRY RUN — nothing will be written.' : '*** WRITING ***');

  const ALL = ORG.toLowerCase() === 'all';
  if (!ALL && !/^[0-9a-f]{8}$/i.test(ORG)) {
    fail(`REBUILD_ORG must be an 8-character organisation code or "all", got "${ORG}".`);
  }
  if (!fs.existsSync(GRADES_PATH)) fail('data/grades.json not found — it is the only source here.');

  let grades;
  try { grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
  catch (e) { fail(`could not parse grades.json: ${e.message}`); }
  if (!Array.isArray(grades) || !grades.length) fail('grades.json is empty.');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const orgs = ALL
    ? [...new Set((core.manifest || []).filter(m => m.compName).map(m => m.org))].sort()
    : [ORG];
  if (!orgs.length) fail('no organisations in the manifest have a compName.');
  console.log(`${grades.length} grade(s) in grades.json, ${orgs.length} organisation(s)`);

  let changed = false;
  for (const o of orgs) {
    // Each organisation gets its own scoped load and save, so one cannot reach
    // another's files and a failure part-way leaves the earlier ones written.
    if (rebuildOrg(o, grades, core)) changed = true;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(DRY
    ? `${VERSION}: dry run complete, nothing written. Set REBUILD_DRY_RUN=false to apply.`
    : `${VERSION}: ${changed ? 'written' : 'nothing changed'}.`);
  process.exit(changed ? 0 : 2);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
