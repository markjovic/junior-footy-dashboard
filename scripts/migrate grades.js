#!/usr/bin/env node
// scripts/migrate-grades.js
// One-off migration: re-maps age/rawGrade on existing matches using the
// updated parseGradeName logic, and rebuilds match IDs and roster.
// Run once after deploying the updated fetch-results.js.
// Usage: node scripts/migrate-grades.js

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH   = path.resolve(__dirname, '..', 'data.json');
const GRADES_PATH = path.resolve(__dirname, '..', 'grades.json');

// ── Same parseGradeName as fetch-results.js ───────────────────────────────────
function parseGradeName(name, ageName, genderName) {
  let n = name.replace(/^\*\s*/, '').trim();
  n = n.replace(/\s+-\s+/g, ' ').trim();

  if (/\(Grading\)/i.test(n)) {
    let ageLabel = (ageName?.match(/^U\d/i))
      ? ageName + (genderName && !['Men','Mixed','Boys'].includes(genderName) ? ' ' + genderName : '')
      : n.replace(/\s*\(Grading\)/i, '').trim();
    return { age: ageLabel, rawGrade: 'Grading' };
  }

  const divMatch    = n.match(/\b(Premier(?:\s+Division)?|Division \d+)\b/i);
  const letterMatch = n.match(/\b([A-D]\d*(?:\/[A-D]\d*)?)\s*$/i);
  const rawGrade = divMatch
    ? divMatch[1].replace(/Premier Division/i, 'Premier')
    : letterMatch ? letterMatch[1].toUpperCase() : '';

  if (ageName?.match(/^U\d/i)) {
    const genderSuffix = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    return { age: ageName + genderSuffix, rawGrade };
  }

  if (ageName === 'Senior' || ageName === 'Open' || ageName?.match(/^Masters?/i) || !ageName) {
    if (/Veterans/i.test(n) || ageName?.match(/^Masters?/i)) {
      const vGender = /Women/i.test(n) ? 'Women'
        : /Men/i.test(n) ? 'Men'
        : genderName === 'Women' ? 'Women' : 'Men';
      return { age: 'Veterans', rawGrade: vGender };
    }
    if (/U19\.5/i.test(n)) return { age: 'U19.5', rawGrade };
    if (/Reserves?/i.test(n)) return { age: 'Reserve ' + (genderName || 'Men'), rawGrade };
    if (genderName === 'Women' || /Women/i.test(n)) return { age: 'Senior Women', rawGrade };
    return { age: 'Senior ' + (genderName || 'Men'), rawGrade };
  }

  if (ageName) return { age: ageName + (genderName ? ' ' + genderName : ''), rawGrade };
  n = n.replace(/^.+?(?=U\d)/i, '').trim();
  const junior = n.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*(?:\/[A-D]\d*)?)$/i);
  if (junior) return { age: junior[1].trim(), rawGrade: junior[2].toUpperCase() };
  return { age: n, rawGrade };
}

// ── Load files ────────────────────────────────────────────────────────────────
const data   = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));

// Build a lookup from old age|rawGrade → new age|rawGrade using grades.json
// grades.json now has ageName and genderName from the last discovery run
const gradeMap = new Map();
grades.forEach(g => {
  const { age: newAge, rawGrade: newRawGrade } = parseGradeName(g.name, g.ageName || '', g.genderName || '');
  // Old parsing was parseGradeName(name) with no structured fields
  const { age: oldAge, rawGrade: oldRawGrade } = parseGradeName(g.name, '', '');
  if (oldAge !== newAge || oldRawGrade !== newRawGrade) {
    gradeMap.set(`${oldAge}|${oldRawGrade}`, { newAge, newRawGrade });
  }
});

console.log(`Grade remappings: ${gradeMap.size}`);
gradeMap.forEach((v, k) => console.log(`  ${k} → ${v.newAge}|${v.newRawGrade}`));

// ── Migrate matches ───────────────────────────────────────────────────────────
let migrated = 0;
const byId = new Map();

data.matches.forEach(m => {
  const key = `${m.age}|${m.rawGrade}`;
  const remap = gradeMap.get(key);
  if (remap) {
    m.age      = remap.newAge;
    m.rawGrade = remap.newRawGrade;
    // Rebuild dedup ID with new age/rawGrade
    m.id = `${m.age}|${m.rawGrade}|${m.round}|${[m.home, m.away].sort().join('|')}`;
    migrated++;
  }
  byId.set(m.id, m);
});

console.log(`\nMigrated ${migrated} match(es)`);

// ── Rebuild roster ────────────────────────────────────────────────────────────
const latest = new Map();
Array.from(byId.values()).filter(m => !m.isBye).forEach(m => {
  for (const name of [m.home, m.away]) {
    const k = `${name}|${m.age}`;
    const prev = latest.get(k);
    if (!prev || m.round > prev.round) latest.set(k, { grade: m.rawGrade, age: m.age, round: m.round });
  }
});
const roster = {};
latest.forEach(({ grade, age }, key) => { roster[key] = { grade, age }; });

// ── Write ─────────────────────────────────────────────────────────────────────
const allValues = Array.from(byId.values());
const allMatches = allValues
  .filter(m => !m.isBye)
  .sort((a,b) => a.age.localeCompare(b.age) || a.rawGrade.localeCompare(b.rawGrade) || a.round - b.round);
const allWithByes = allValues.sort((a,b) => a.round - b.round);

data.matches = allWithByes;
data.roster  = roster;
data.lastUpdated = new Date().toISOString();

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
console.log(`Wrote data.json (${allMatches.length} matches, ${Object.keys(roster).length} roster entries)`);
