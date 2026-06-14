// scripts/extract-finals-data.js
// Extracts current ladder standings and remaining fixtures for a given grade
// Usage: node scripts/extract-finals-data.js
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

const TARGET_COMP  = 'EFNL 2026';
const TARGET_AGE   = 'U12';
const TARGET_GRADE = 'B';

const matches = data.matches.filter(m =>
  m.compName === TARGET_COMP &&
  m.age      === TARGET_AGE  &&
  m.rawGrade === TARGET_GRADE &&
  !m.isBye && !m.isPartial
);

// Build ladder from completed matches (both teams have scores, status implies final)
const teams = {};
const completed = [];
const scheduled = [];

for (const m of matches) {
  const hasFinalScore = m.hScore !== undefined && m.aScore !== undefined &&
                        !(m.hScore === 0 && m.aScore === 0 && !m.date);
  // Treat as completed if scores differ or it's a non-zero score game
  const isCompleted = m.hScore !== undefined && m.aScore !== undefined &&
                      m.date && m.date < '2026-06-16'; // before today

  for (const t of [m.home, m.away]) {
    if (!teams[t]) teams[t] = { name: t, p: 0, w: 0, d: 0, l: 0, f: 0, a: 0, pts: 0 };
  }

  if (isCompleted) {
    const hWon = m.hScore > m.aScore, aWon = m.aScore > m.hScore;
    teams[m.home].p++; teams[m.home].f += m.hScore; teams[m.home].a += m.aScore;
    teams[m.away].p++; teams[m.away].f += m.aScore; teams[m.away].a += m.hScore;
    if (hWon)      { teams[m.home].w++; teams[m.home].pts += 4; teams[m.away].l++; }
    else if (aWon) { teams[m.away].w++; teams[m.away].pts += 4; teams[m.home].l++; }
    else           { teams[m.home].d++; teams[m.home].pts += 2; teams[m.away].d++; teams[m.away].pts += 2; }
    completed.push(m);
  } else if (m.home && m.away && m.home !== '__bye__') {
    scheduled.push({ round: m.round, home: m.home, away: m.away, date: m.date });
  }
}

// Sort ladder
const ladder = Object.values(teams).sort((a, b) => {
  const aMR = a.w + a.l ? (a.w + a.d * 0.5) / (a.w + a.d + a.l) : 0;
  const bMR = b.w + b.l ? (b.w + b.d * 0.5) / (b.w + b.d + b.l) : 0;
  const aPCT = a.a ? a.f / a.a : 0;
  const bPCT = b.a ? b.f / b.a : 0;
  return b.pts - a.pts || bMR - aMR || bPCT - aPCT;
}).map((t, i) => ({ ...t, pos: i + 1 }));

// Deduplicate scheduled (same match may appear from both perspectives)
const seen = new Set();
const uniqueScheduled = scheduled.filter(m => {
  const key = [m.round, m.home, m.away].sort().join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}).sort((a, b) => a.round - b.round);

console.log('\n=== LADDER ===');
console.log('Pos | Team                          | P  | W  | D  | L  | F    | A    | PTS | MR%');
ladder.forEach(t => {
  const mr = t.w + t.l ? ((t.w + t.d * 0.5) / (t.w + t.d + t.l) * 100).toFixed(1) : '0.0';
  console.log(
    `${String(t.pos).padStart(3)} | ${t.name.padEnd(30)} | ${String(t.p).padStart(2)} | ${String(t.w).padStart(2)} | ${String(t.d).padStart(2)} | ${String(t.l).padStart(2)} | ${String(t.f).padStart(4)} | ${String(t.a).padStart(4)} | ${String(t.pts).padStart(3)} | ${mr}%`
  );
});

console.log(`\n=== REMAINING FIXTURES (${uniqueScheduled.length} matches) ===`);
let lastRound = null;
uniqueScheduled.forEach(m => {
  if (m.round !== lastRound) { console.log(`\nRound ${m.round}:`); lastRound = m.round; }
  console.log(`  ${m.home} vs ${m.away}`);
});

console.log('\n=== JSON OUTPUT ===');
console.log(JSON.stringify({ ladder, remaining: uniqueScheduled }, null, 2));
