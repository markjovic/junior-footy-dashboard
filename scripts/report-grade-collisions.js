#!/usr/bin/env node
// scripts/report-grade-collisions.js
//
// Lists every case where two or more PlayHQ grades collapse onto one
// `age|rawGrade` key. That key is what groups a ladder and what forms part of
// every match id, so a collision merges two competitions into one ladder and
// puts their games in the same id namespace.
//
// READ ONLY. It reads data/grades.json and calls nothing. Every figure comes from
// running the real parseGradeName over the real grade names — not from a sample
// and not from an estimate.
//
// This is the input to any re-key: it names exactly which grades have to move
// and which seasons are unaffected.
//
// Env:
//   COLLISION_COMP=<compName>   report one season only, e.g. "EFNL 2025".
//   COLLISION_QUIET=true        summary table only, no per-key detail.
//
// Run: node scripts/report-grade-collisions.js

'use strict';

const fs = require('fs');
const path = require('path');
const { parseGradeName } = require('./lib/results-engine');

const VERSION = 'report-grade-collisions v1 2026-08-12';
const ROOT = path.resolve(__dirname, '..');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');
const ONLY = (process.env.COLLISION_COMP || '').trim();
const QUIET = process.env.COLLISION_QUIET === 'true';

console.log(`=== ${VERSION} ===`);

if (!fs.existsSync(GRADES_PATH)) {
  console.error('FATAL: data/grades.json not found. Run a results fetch first.');
  process.exit(1);
}
let grades;
try { grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
catch (e) { console.error(`FATAL: could not parse grades.json: ${e.message}`); process.exit(1); }
if (!Array.isArray(grades) || !grades.length) {
  console.error('FATAL: grades.json is empty.');
  process.exit(1);
}
console.log(`${grades.length} grade(s) across ${new Set(grades.map(g => g.seasonID)).size} season(s)\n`);

const bySeason = new Map();
for (const g of grades) {
  if (ONLY && g.compName !== ONLY) continue;
  if (!bySeason.has(g.compName)) bySeason.set(g.compName, []);
  bySeason.get(g.compName).push(g);
}
if (!bySeason.size) {
  console.error(`FATAL: no grades for "${ONLY}". Known: ` +
    [...new Set(grades.map(g => g.compName))].sort().join(', '));
  process.exit(1);
}

const rows = [];
const detail = [];
let totKeys = 0, totInvolved = 0, totShadowed = 0;

for (const [comp, list] of [...bySeason].sort()) {
  const keys = new Map();
  for (const g of list) {
    const { age, rawGrade } = parseGradeName(g.name, g.ageName, g.genderName);
    const k = `${age}|${rawGrade}`;
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push(g);
  }
  const coll = [...keys].filter(([, v]) => v.length > 1);
  const involved = coll.reduce((a, [, v]) => a + v.length, 0);
  // One grade per key keeps the key; the rest are indistinguishable from it.
  const shadowed = coll.reduce((a, [, v]) => a + v.length - 1, 0);
  totKeys += coll.length; totInvolved += involved; totShadowed += shadowed;
  rows.push([comp, list.length, coll.length, involved, shadowed]);
  for (const [k, v] of coll) detail.push({ comp, key: k, grades: v });
}

const w = [14, 8, 16, 18, 12];
const line = (r) => '  ' + r.map((c, i) => String(c).padStart(i === 0 ? -w[0] : w[i]))
  .map((c, i) => i === 0 ? String(r[0]).padEnd(w[0]) : c).join('');
console.log('  ' + 'season'.padEnd(w[0]) + 'grades'.padStart(w[1]) +
  'colliding keys'.padStart(w[2]) + 'grades involved'.padStart(w[3]) + 'shadowed'.padStart(w[4]));
console.log('  ' + '-'.repeat(w.reduce((a, b) => a + Math.abs(b), 0)));
for (const r of rows) console.log(line(r));
console.log('  ' + '-'.repeat(w.reduce((a, b) => a + Math.abs(b), 0)));
console.log(line(['TOTAL', rows.reduce((a, r) => a + r[1], 0), totKeys, totInvolved, totShadowed]));

console.log(`\n"shadowed" is how many grades lose their identity: one grade per key`);
console.log(`keeps it and the rest become indistinguishable from it.`);

if (!QUIET) {
  console.log(`\nEvery colliding key:`);
  for (const d of detail) {
    console.log(`\n  ${d.comp}  "${d.key}"  — ${d.grades.length} grades`);
    for (const g of d.grades) console.log(`      ${g.id}  ${g.name}`);
  }
}

// Seasons with nothing to fix are as useful to know as the ones with something.
const cleanSeasons = rows.filter(r => r[2] === 0).map(r => r[0]);
if (cleanSeasons.length) {
  console.log(`\nSeasons with NO collisions, which a re-key can skip entirely:`);
  console.log(`  ${cleanSeasons.join(', ')}`);
}

console.log(`\n${VERSION}: ${totKeys} colliding key(s), ${totShadowed} grade(s) shadowed.`);
// Reporting only. A collision is a known defect, not a reason to fail a job.
process.exit(0);
