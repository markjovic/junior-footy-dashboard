#!/usr/bin/env node
// scripts/migrate-grades.js — Direct age/rawGrade remapping for existing matches
// Run via workflow with run_migration=yes, or: node scripts/migrate-grades.js

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.resolve(__dirname, '..', 'data.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

// Direct lookup: old age string (as stored in data.json) → new { age, rawGrade }
// Built from inspecting actual data.json age values vs desired values
const REMAPS = {
  // Senior Women (old: full Deakin-prefixed name, rawGrade '')
  'Deakin Uni Senior Women Premier Division': { age: 'Senior Women', rawGrade: 'Premier'    },
  'Deakin Uni Women Division 1':             { age: 'Senior Women', rawGrade: 'Division 1' },
  'Deakin Uni Women Division 2':             { age: 'Senior Women', rawGrade: 'Division 2' },
  'Deakin Uni Women Division 3':             { age: 'Senior Women', rawGrade: 'Division 3' },
  'Deakin Uni Women Division 4':             { age: 'Senior Women', rawGrade: 'Division 4' },
  'Deakin Uni Women Division 5':             { age: 'Senior Women', rawGrade: 'Division 5' },
  // Senior Men (old: full name as age, rawGrade '')
  'Premier Eastland Senior Men':             { age: 'Senior Men',   rawGrade: 'Premier'    },
  'Division 1 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 1' },
  'Division 2 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 2' },
  'Division 3 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 3' },
  'Division 4 Eastland Senior Men':          { age: 'Senior Men',   rawGrade: 'Division 4' },
  // Reserve Men
  'Premier Reserve Men':                     { age: 'Reserve Men',  rawGrade: 'Premier'    },
  'Division 1 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 1' },
  'Division 2 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 2' },
  'Division 3 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 3' },
  'Division 4 Reserve Men':                  { age: 'Reserve Men',  rawGrade: 'Division 4' },
  // Veterans (old: no space, no rawGrade)
  'Veterans Mens':                           { age: 'Veterans',     rawGrade: 'Men'        },
  'Veterans Women':                          { age: 'Veterans',     rawGrade: 'Women'      },
};

// Migrate matches
let migrated = 0;
const byId = new Map();

data.matches.forEach(m => {
  const remap = REMAPS[m.age];
  if (remap) {
    m.age      = remap.age;
    m.rawGrade = remap.rawGrade;
    m.id = `${m.age}|${m.rawGrade}|${m.round}|${[m.home, m.away].sort().join('|')}`;
    migrated++;
  }
  byId.set(m.id, m);
});

console.log(`Migrated ${migrated} match(es)`);

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
