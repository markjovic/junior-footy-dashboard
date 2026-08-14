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
// v2 (2026-08-13) ALSO measures what the collisions cost on screen.
//
// A collision merges two grades onto one key. Since the grade identity migration
// that no longer merges LADDERS — those group by gradeId — but it does still
// break attribution, and the cost is invisible. index.html's precomputeMatches()
// sets `_valid = (hg === ag)` where each side's grade comes from the ROSTER, and
// every ladder, scorer list and grade tab filters on it. A record whose two sides
// resolve to different grades is discarded with no error and no count.
//
// Measured in SEJ 2026 U10 by scripts/probe-concurrent-comps.js: 42 of 212
// records, 20% of one age group, never reach the screen. That probe covers ONE
// age group in ONE season. This reports it for all eighteen, so an attribution
// change is designed against numbers rather than against four predictions.
//
// grade_attribution_split_design.md §2.2 and §6 step 2.
//
// Env:
//   COLLISION_COMP=<compName>   report one season only, e.g. "EFNL 2025".
//   COLLISION_QUIET=true        summary table only, no per-key detail.
//   COLLISION_SKIP_RECORDS=true skip the v2 record pass (grades.json only).
//
// Run: node scripts/report-grade-collisions.js

'use strict';

const fs = require('fs');
const path = require('path');
const { parseGradeName } = require('./lib/results-engine');
const store = require('./lib/store');

const VERSION = 'report-grade-collisions v2 2026-08-13 dropped-records';
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

// ── v2: what the collisions actually cost on screen ─────────────────────────
// Offline. store.load only; no API calls. players:false — 78% of the bytes and
// nothing here reads them.
if (process.env.COLLISION_SKIP_RECORDS !== 'true') {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`Records the dashboard DISCARDS because the two sides resolve to`);
  console.log(`different grades  (grade_attribution_split_design.md §2.2)`);
  console.log(`${'='.repeat(74)}`);

  let data = null;
  try { data = store.load(null, { players: false }); }
  catch (e) { console.error(`  store.load failed: ${e.message}`); }

  if (data) {
    const filesRead = data.__filesRead || [];
    if (!filesRead.length) {
      console.error(`  NO SEASON FILES WERE READ. Expected data/seasons/*-core.json.`);
      console.error(`  This is a missing-file problem, not a season with no records.`);
    } else {
      console.log(`  read ${filesRead.length} season file(s)`);
      const roster = data.roster || {};
      // rosterGrade() from index.html. The SAME expression, deliberately — a
      // reimplementation here is how this measurement would come out wrong.
      const resolve = (comp, name, age, rawGrade) => {
        const e = roster[`${comp}|${name}|${age}`];
        if (!e) return rawGrade;
        return e.gradeId || e.grade || rawGrade;
      };

      // gradeId -> the colliding key it belongs to, so a dropped record can be
      // attributed to a collision rather than merely counted.
      const keyOfGrade = new Map();
      for (const d of detail) {
        for (const g of d.grades) keyOfGrade.set(g.id, `${d.comp}  "${d.key}"`);
      }

      const perComp = new Map();     // comp -> { total, counted, dropped }
      const perKey = new Map();      // colliding key -> dropped count
      const noGrade = new Map();     // comp -> records with no gradeId
      const examples = [];
      for (const m of data.matches || []) {
        if (m.isBye || m.isPartial || m.scheduled) continue;
        const comp = m.compName || '(none)';
        if (ONLY && comp !== ONLY) continue;
        if (!perComp.has(comp)) perComp.set(comp, { total: 0, counted: 0, dropped: 0 });
        const c = perComp.get(comp);
        c.total++;
        if (!m.gradeId) noGrade.set(comp, (noGrade.get(comp) || 0) + 1);
        const hg = resolve(comp, m.home, m.age, m.rawGrade);
        const ag = resolve(comp, m.away, m.age, m.rawGrade);
        if (hg === ag && hg !== undefined && hg !== null && hg !== '') { c.counted++; continue; }
        c.dropped++;
        const ck = keyOfGrade.get(m.gradeId || '');
        if (ck) perKey.set(ck, (perKey.get(ck) || 0) + 1);
        if (examples.length < 12) {
          examples.push(`${comp}  R${m.round}  ${m.home} -> ${hg}  v  ${m.away} -> ${ag}` +
            `   [stored ${m.gradeId || 'NO GRADE ID'}]`);
        }
      }

      const wc = Math.max(14, ...[...perComp.keys()].map(k => k.length)) + 2;
      console.log('\n  ' + 'season'.padEnd(wc) + 'records'.padStart(9) +
        'counted'.padStart(9) + 'dropped'.padStart(9) + 'dropped %'.padStart(11) +
        'colliding keys'.padStart(16));
      console.log('  ' + '-'.repeat(wc + 54));
      const collByComp = new Map(rows.map(r => [r[0], r[2]]));
      let tTot = 0, tDrop = 0;
      for (const [comp, c] of [...perComp].sort()) {
        tTot += c.total; tDrop += c.dropped;
        const pct = c.total ? ((c.dropped / c.total) * 100).toFixed(1) : '0.0';
        console.log('  ' + comp.padEnd(wc) + String(c.total).padStart(9) +
          String(c.counted).padStart(9) + String(c.dropped).padStart(9) +
          `${pct}%`.padStart(11) + String(collByComp.get(comp) ?? '?').padStart(16));
      }
      console.log('  ' + '-'.repeat(wc + 54));
      console.log('  ' + 'TOTAL'.padEnd(wc) + String(tTot).padStart(9) +
        String(tTot - tDrop).padStart(9) + String(tDrop).padStart(9) +
        `${tTot ? ((tDrop / tTot) * 100).toFixed(1) : '0.0'}%`.padStart(11));

      // THE CONTROL. Seasons with no colliding key should drop nothing. A
      // non-zero figure on one of these means the measurement is wrong, not that
      // the season is broken — so it is checked rather than assumed.
      const controls = rows.filter(r => r[2] === 0).map(r => r[0]);
      if (controls.length) {
        console.log(`\n  CONTROL — seasons with no colliding key. Any drop here means this`);
        console.log(`  measurement is wrong, not that the season is:`);
        for (const comp of controls) {
          const c = perComp.get(comp);
          if (!c) { console.log(`    ${comp.padEnd(wc)} no records loaded`); continue; }
          console.log(`    ${comp.padEnd(wc)} ${String(c.dropped).padStart(6)} dropped` +
            (c.dropped ? '   <-- INVESTIGATE' : '   ok'));
        }
      }

      if (perKey.size) {
        console.log(`\n  Dropped records per colliding key, worst first:`);
        for (const [k, n] of [...perKey].sort((a, b) => b[1] - a[1])) {
          console.log(`    ${String(n).padStart(6)}  ${k}`);
        }
      }

      const ng = [...noGrade].filter(([, n]) => n > 0);
      if (ng.length) {
        console.log(`\n  Records with NO gradeId, which resolve through rawGrade only:`);
        for (const [comp, n] of ng.sort((a, b) => b[1] - a[1])) {
          console.log(`    ${String(n).padStart(6)}  ${comp}`);
        }
      }

      if (examples.length) {
        console.log(`\n  Dropped records, examples:`);
        for (const e of examples) console.log(`    ${e}`);
        if (tDrop > examples.length) console.log(`    ... ${tDrop - examples.length} more`);
      }
      console.log(`\n  A dropped record is not a lost record — it is stored and unread.`);
      console.log(`  Nothing here changes any file.`);
    }
  }
}

console.log(`\n${VERSION}: ${totKeys} colliding key(s), ${totShadowed} grade(s) shadowed.`);
// Reporting only. A collision is a known defect, not a reason to fail a job.
process.exit(0);
