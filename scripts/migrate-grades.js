#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.resolve(__dirname, '..', 'data.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

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
  // Also clean up any duplicate old-style entries that survived previous migrations
  'Division 1 U19.5':                        { age: 'U19.5',        rawGrade: 'Division 1' },
  'Division 2 U19.5':                        { age: 'U19.5',        rawGrade: 'Division 2' },
  'Division 3 U19.5':                        { age: 'U19.5',        rawGrade: 'Division 3' },
  'Division 4 U19.5':                        { age: 'U19.5',        rawGrade: 'Division 4' },
  'Premier U19.5':                           { age: 'U19.5',        rawGrade: 'Premier'    },
  // U17 → U17.5 (PlayHQ age field returns U17 but grade name has U17.5)
  'U17':                                     { age: 'U17.5',        rawGrade: null         }, // null = keep existing rawGrade
};

// Old age strings to completely remove (duplicates of newly-named records)
const OLD_AGE_STRINGS = new Set(Object.keys(REMAPS));

// First pass: collect all correctly-named matches (non-old-style)
const byId = new Map();

// Add all non-old-style matches first
data.matches.forEach(m => {
  if (!OLD_AGE_STRINGS.has(m.age)) {
    byId.set(m.id, m);
  }
});

// Second pass: remap old-style matches, only add if no new-style version exists
let migrated = 0;
let skipped = 0;
data.matches.forEach(m => {
  const remap = REMAPS[m.age];
  if (!remap) return;

  const newAge      = remap.age;
  const newRawGrade = remap.rawGrade !== null ? remap.rawGrade : m.rawGrade;
  const newId = `${newAge}|${newRawGrade}|${m.round}|${[m.home, m.away].sort().join('|')}`;

  if (byId.has(newId)) {
    // New-style version already exists — skip old duplicate
    skipped++;
  } else {
    // No new version — remap this record
    m.age      = newAge;
    m.rawGrade = newRawGrade;
    m.id       = newId;
    byId.set(newId, m);
    migrated++;
  }
});

console.log(`Migrated: ${migrated}, Skipped (already have new version): ${skipped}`);
console.log(`Total matches: ${Array.from(byId.values()).filter(m=>!m.isBye).length} real + ${Array.from(byId.values()).filter(m=>m.isBye).length} bye sentinels`);

// Rebuild roster
const latest = new Map();
Array.from(byId.values()).filter(m => !m.isBye).forEach(m => {
  for (const name of [m.home, m.away]) {
    const k = `${name}|${m.age}`;
    const prev = latest.get(k);
    if (!prev || m.round > prev.round) {
      latest.set(k, { grade: m.rawGrade, age: m.age, round: m.round });
    }
  }
});
const roster = {};
latest.forEach(({ grade, age }, key) => { roster[key] = { grade, age }; });

// Rebuild lastRound
const lastRound = {};
Array.from(byId.values()).forEach(m => {
  const key = `${m.age}|${m.rawGrade}`;
  if (!lastRound[key] || m.round > lastRound[key]) lastRound[key] = m.round;
});

data.matches = Array.from(byId.values());
data.roster  = roster;
data.lastRound = lastRound;
data.lastUpdated = new Date().toISOString();

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
const real = data.matches.filter(m => !m.isBye).length;
console.log(`Wrote data.json (${real} real matches, ${Object.keys(roster).length} roster entries)`);
