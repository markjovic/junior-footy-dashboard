#!/usr/bin/env node
// scripts/migrate-grades.js — One-off migration to fix age/rawGrade on existing matches
// Run via workflow with run_migration=yes input, or: node scripts/migrate-grades.js

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH   = path.resolve(__dirname, '..', 'data.json');
const GRADES_PATH = path.resolve(__dirname, '..', 'grades.json');

const data   = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));

// ── Same parseGradeName as fetch-results.js ───────────────────────────────────
function parseGradeName(name, ageName, genderName) {
  let n = name.replace(/^\*\s*/, '').trim();
  n = n.replace(/\s+-\s+/g, ' ').trim();
  if (/\(Grading\)/i.test(n)) {
    let l = (ageName?.match(/^U\d/i))
      ? ageName + (genderName && !['Men','Mixed','Boys'].includes(genderName) ? ' ' + genderName : '')
      : n.replace(/\s*\(Grading\)/i, '').trim();
    return { age: l, rawGrade: 'Grading' };
  }
  const dm = n.match(/\b(Premier(?:\s+Division)?|Division \d+)\b/i);
  const lm = n.match(/\b([A-D]\d*(?:\/[A-D]\d*)?)\s*$/i);
  const rawGrade = dm ? dm[1].replace(/Premier Division/i, 'Premier') : lm ? lm[1].toUpperCase() : '';
  if (ageName?.match(/^U\d/i)) {
    const s = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    return { age: ageName + s, rawGrade };
  }
  if (ageName === 'Senior' || ageName === 'Open' || ageName?.match(/^Masters?/i) || !ageName) {
    if (/Veterans/i.test(n) || ageName?.match(/^Masters?/i)) {
      const vG = /Women/i.test(n) ? 'Women' : /Men/i.test(n) ? 'Men' : genderName === 'Women' ? 'Women' : 'Men';
      return { age: 'Veterans', rawGrade: vG };
    }
    if (/U19\.5/i.test(n)) return { age: 'U19.5', rawGrade };
    if (/Reserves?/i.test(n)) return { age: 'Reserve ' + (genderName || 'Men'), rawGrade };
    if (genderName === 'Women' || /Women/i.test(n)) return { age: 'Senior Women', rawGrade };
    if (/Senior/i.test(n)) return { age: 'Senior ' + (genderName || 'Men'), rawGrade };
    const ca = n.replace(/\s*(Premier|Division \d+).*$/i, '').trim();
    return { age: ca || n, rawGrade };
  }
  if (ageName) return { age: ageName + (genderName ? ' ' + genderName : ''), rawGrade };
  n = n.replace(/^.+?(?=U\d)/i, '').trim();
  const j = n.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*(?:\/[A-D]\d*)?)$/i);
  if (j) return { age: j[1].trim(), rawGrade: j[2].toUpperCase() };
  return { age: n, rawGrade };
}

// ── Build correct age/rawGrade for every grade ID ────────────────────────────
// Key: gradeID → { age, rawGrade }
// This is authoritative — derived from the grade name + structured API fields
const gradeCorrections = new Map();
grades.forEach(g => {
  const { age, rawGrade } = parseGradeName(g.name, g.ageName || '', g.genderName || '');
  gradeCorrections.set(g.id, { age, rawGrade, name: g.name });
});

console.log(`Loaded ${gradeCorrections.size} grades from grades.json`);

// ── Find the grade ID for each match by matching age+rawGrade to grade list ──
// Matches don't store gradeID directly, so we need to find which grade they
// belong to by matching their current age/rawGrade against what each grade
// SHOULD produce under the new parsing.

// Build reverse lookup: old "age|rawGrade" → correct { age, rawGrade }
// by also running old-style parsing (no structured fields) on each grade name
const oldToNew = new Map();
grades.forEach(g => {
  const oldParsed = parseGradeName(g.name, '', '');  // old style: no structured fields
  const newParsed = parseGradeName(g.name, g.ageName || '', g.genderName || '');
  const oldKey = `${oldParsed.age}|${oldParsed.rawGrade}`;
  const newKey = `${newParsed.age}|${newParsed.rawGrade}`;
  if (oldKey !== newKey) {
    oldToNew.set(oldKey, newParsed);
    console.log(`  Remap: "${oldKey}" → "${newKey}"`);
  }
});

// Also handle the specific case of U19.5 matches stored with rawGrade ""
// These came from old parsing before structured fields existed
// The grades.json has entries like "Premier U19.5", "Division 1 U19.5" etc.
// Old parsing gave age="U19.5", rawGrade="" for ALL of them (couldn't distinguish)
// We can't recover which division they belonged to from the match data alone.
// Best we can do: if a team appears in a specific division in a later round,
// use that division for all their earlier rounds too.
// But that's complex — for now, just flag them.

console.log(`\n${oldToNew.size} grade remapping(s) found`);

// ── Migrate matches ───────────────────────────────────────────────────────────
let migrated = 0;
const byId = new Map();

data.matches.forEach(m => {
  const key = `${m.age}|${m.rawGrade}`;
  const remap = oldToNew.get(key);
  if (remap) {
    m.age      = remap.age;
    m.rawGrade = remap.rawGrade;
    m.id = `${m.age}|${m.rawGrade}|${m.round}|${[m.home, m.away].sort().join('|')}`;
    migrated++;
  }
  byId.set(m.id, m);
});

console.log(`Migrated ${migrated} match(es)`);

// ── Check for unresolvable U19.5 matches ─────────────────────────────────────
const u195empty = Array.from(byId.values()).filter(m => m.age === 'U19.5' && m.rawGrade === '' && !m.isBye);
if (u195empty.length > 0) {
  console.log(`\nWARNING: ${u195empty.length} U19.5 match(es) still have empty rawGrade`);
  console.log('These cannot be automatically migrated — they need to be re-fetched.');
  console.log('Removing them from data.json so the next fetch will re-fetch them.');
  u195empty.forEach(m => byId.delete(m.id));
  console.log(`Removed ${u195empty.length} unresolvable match(es)`);
}

// Also remove bye sentinels for U19.5 with empty rawGrade so those rounds get re-fetched
const u195byes = Array.from(byId.values()).filter(m => m.age === 'U19.5' && m.rawGrade === '' && m.isBye);
u195byes.forEach(m => byId.delete(m.id));
if (u195byes.length) console.log(`Removed ${u195byes.length} U19.5 bye sentinel(s)`);

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
data.matches = allValues.sort((a,b) => a.round - b.round);
data.roster  = roster;
data.lastUpdated = new Date().toISOString();

// Reset lastRound for U19.5 so it re-fetches
if (data.lastRound) {
  Object.keys(data.lastRound).filter(k => k.startsWith('U19.5|')).forEach(k => {
    console.log(`Resetting lastRound for ${k}`);
    delete data.lastRound[k];
  });
}

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
const realMatches = allValues.filter(m => !m.isBye).length;
console.log(`\nWrote data.json (${realMatches} real matches, ${Object.keys(roster).length} roster entries)`);
