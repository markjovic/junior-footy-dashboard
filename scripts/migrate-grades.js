#!/usr/bin/env node
// scripts/migrate-grades.js — Fix age/rawGrade and compName on existing matches
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH   = path.resolve(__dirname, '..', 'data.json');
const GRADES_PATH = path.resolve(__dirname, '..', 'grades.json');

const data   = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));

// Build lookup: compName by season/grade context
// grades.json has { id, name, ageName, genderName, seasonID, compName, compLogoUrl }
const compByGradeId = new Map();
grades.forEach(g => compByGradeId.set(g.id, g.compName));

// Same parseGradeName as fetch-results.js
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
  const rawGrade = dm ? dm[1].replace(/Premier Division/i,'Premier') : lm ? lm[1].toUpperCase() : '';
  if (ageName?.match(/^U\d/i)) {
    const nameAgeMatch = n.match(/^U(\d+(?:\.\d+)?)/i);
    const resolvedAge = (nameAgeMatch && nameAgeMatch[0] !== ageName) ? nameAgeMatch[0].toUpperCase() : ageName;
    const s = (genderName && !['Men','Mixed','Boys'].includes(genderName)) ? ' ' + genderName : '';
    return { age: resolvedAge + s, rawGrade };
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

// Build grade-level age/rawGrade/compName lookup from grades.json
// Key: old "age|rawGrade" → { newAge, newRawGrade, compName }
const REMAPS = {
  'Deakin Uni Senior Women Premier Division': { age: 'Senior Women', rawGrade: 'Premier'    },
  'Deakin Uni Women Division 1':             { age: 'Senior Women', rawGrade: 'Division 1' },
  'Deakin Uni Women Division 2':             { age: 'Senior Women', rawGrade: 'Division 2' },
  'Deakin Uni Women Division 3':             { age: 'Senior Women', rawGrade: 'Division 3' },
  'Deakin Uni Women Division 4':             { age: 'Senior Women', rawGrade: 'Division 4' },
  'Deakin Uni Women Division 5':             { age: 'Senior Women', rawGrade: 'Division 5' },
  'Premier Eastland Senior Men':             { age: 'Senior Men',   rawGrade: 'Premier'    },
  'Division 1 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 1' },
  'Division 2 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 2' },
  'Division 3 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 3' },
  'Division 4 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 4' },
  'Premier Reserve Men':                     { age: 'Reserve Men',  rawGrade: 'Premier'    },
  'Division 1 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 1' },
  'Division 2 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 2' },
  'Division 3 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 3' },
  'Division 4 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 4' },
  'Veterans Mens':                           { age: 'Veterans',     rawGrade: 'Men'        },
  'Veterans Women':                          { age: 'Veterans',     rawGrade: 'Women'      },
};

// Build comp lookup from grades.json: what compName does each age|rawGrade belong to?
// This uses the NEW parsed values to map back to compName
const gradeCompMap = new Map(); // "compName|age|rawGrade" → compName (for validation)
const ageGradeToComp = new Map(); // "age|rawGrade" → Set of compNames
grades.forEach(g => {
  const { age, rawGrade } = parseGradeName(g.name, g.ageName || '', g.genderName || '');
  const key = `${age}|${rawGrade}`;
  if (!ageGradeToComp.has(key)) ageGradeToComp.set(key, new Set());
  ageGradeToComp.get(key).add(g.compName);
});

const OLD_AGE_STRINGS = new Set([...Object.keys(REMAPS), 'U17']);

// First pass: keep all correctly-named matches
const byId = new Map();
data.matches.forEach(m => {
  if (!OLD_AGE_STRINGS.has(m.age)) byId.set(m.id, m);
});

// Second pass: remap old-style matches
let migrated = 0, skipped = 0;
data.matches.forEach(m => {
  const remap = REMAPS[m.age];
  if (!remap) return;
  const newAge = remap.age;
  const newRawGrade = remap.rawGrade;
  const newId = `${m.compName || 'EFNL 2026'}|${newAge}|${newRawGrade}|${m.round}|${[m.home, m.away].sort().join('|')}`;
  if (byId.has(newId)) { skipped++; return; }
  m.age = newAge; m.rawGrade = newRawGrade;
  m.compName = m.compName || 'EFNL 2026';
  m.id = newId;
  byId.set(newId, m);
  migrated++;
});

console.log(`Migrated: ${migrated}, Skipped (already have new version): ${skipped}`);

// Third pass: fix compName on all matches
// Matches whose IDs don't start with a comp prefix need compName assigned
// Use the grades.json compName where unambiguous, otherwise use EFNL 2026
let compFixed = 0;
const byIdFinal = new Map();
Array.from(byId.values()).forEach(m => {
  // Fix incorrect compName: if a match's age|rawGrade only belongs to one competition, use that
  const ageKey = `${m.age}|${m.rawGrade}`;
  const possibleComps = ageGradeToComp.get(ageKey);

  if (possibleComps && possibleComps.size === 1) {
    const correctComp = [...possibleComps][0];
    if (m.compName !== correctComp) {
      m.compName = correctComp;
      const teams = [m.home, m.away].sort().join('|');
      m.id = `${correctComp}|${m.age}|${m.rawGrade}|${m.round}|${teams}`;
      compFixed++;
    }
  } else if (!m.compName) {
    // Ambiguous or missing — use sentinel so it doesn't pollute a real competition
    m.compName = 'Unknown';
    const teams = [m.home, m.away].sort().join('|');
    m.id = `EFNL 2026|${m.age}|${m.rawGrade}|${m.round}|${teams}`;
    compFixed++;
  }

  byIdFinal.set(m.id, m);
});

console.log(`compName fixed on: ${compFixed} match(es)`);
console.log(`Total: ${Array.from(byIdFinal.values()).filter(m=>!m.isBye).length} real + ${Array.from(byIdFinal.values()).filter(m=>m.isBye).length} bye sentinels`);

// Rebuild roster with compName key
const latest = new Map();
Array.from(byIdFinal.values()).filter(m => !m.isBye).forEach(m => {
  for (const name of [m.home, m.away]) {
    const k = `${m.compName}|${name}|${m.age}`;
    const prev = latest.get(k);
    if (!prev || m.round > prev.round) latest.set(k, { grade: m.rawGrade, age: m.age, compName: m.compName, round: m.round });
  }
});
const roster = {};
latest.forEach(({ grade, age, compName }, key) => { roster[key] = { grade, age, compName }; });

// Rebuild lastRound with compName prefix
const lastRound = {};
Array.from(byIdFinal.values()).forEach(m => {
  const key = `${m.compName}|${m.age}|${m.rawGrade}`;
  if (!lastRound[key] || m.round > lastRound[key]) lastRound[key] = m.round;
});

// ── YJFL purge: delete all YJFL 2026 matches and reset lastRound ────────────
// fetch-results.js parseGradeName previously gave rawGrade:"" to all YJFL
// divisions, causing them to share a knownRounds key and skip grading rounds.
// Deleting and re-fetching is the clean fix — other comps are untouched.
let yjflDeleted = 0;
Array.from(byIdFinal.keys()).forEach(id => {
  if (byIdFinal.get(id).compName === 'YJFL 2026') {
    byIdFinal.delete(id);
    yjflDeleted++;
  }
});
Object.keys(lastRound).forEach(k => {
  if (k.startsWith('YJFL 2026|')) delete lastRound[k];
});
console.log(`YJFL purge: deleted ${yjflDeleted} match(es), reset lastRound for YJFL 2026`);

data.matches = Array.from(byIdFinal.values());
data.roster  = roster;
data.lastRound = lastRound;
data.lastUpdated = new Date().toISOString();

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
const real = data.matches.filter(m => !m.isBye).length;
console.log(`Wrote data.json (${real} real matches, ${Object.keys(roster).length} roster entries)`);
