#!/usr/bin/env node
// scripts/probe-stored-grade.js
//
// READ-ONLY PROBE. Reads data.json only. Writes nothing.
//
// WHY
// probe-grade-teams.js established that EFNL 2026's "Deakin Uni - U18 Girls
// (Grading)" contains 18 EFNL clubs at eastern-suburbs venues. The dashboard's
// ladder for that same grade shows Pearcedale Baxter, Frankston YCW, Fitzroy,
// North Brunswick and Berwick — none of which are in it. So something other than
// that grade's fixtures is stored under that key, and this dumps exactly what.
//
// It reports, for one or more comp|age|grade keys:
//   - every distinct team, with the rounds and date range it appears in
//   - the round and date profile of the key as a whole
//   - which OTHER comp|age|grade keys each of those teams appears under
//   - venue suburbs, which is usually the quickest tell that two competitions
//     have been merged into one key
//
// Team matching is on the EXACT stored name. probe-grade-teams.js used a prefix
// match and got it wrong: cleanTeam turns "Boronia U18 Girls" into
// "Boronia Girls", which does not prefix-match, so it silently reported the
// boys teams' grades instead. Exact matching only, here.
//
// Usage:
//   node scripts/probe-stored-grade.js --comp="EFNL 2026" --age="U18 Girls"
//   node scripts/probe-stored-grade.js --comp="EFNL 2026" --age="U18 Girls" --grade=Grading
//   node scripts/probe-stored-grade.js --team="Pearcedale Baxter Girls"

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'data.json');

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { comp: null, age: null, grade: null, team: null, maxTeams: 60 };
  const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--comp':      opts.comp     = val.trim() || null; break;
      case '--age':       opts.age      = val.trim() || null; break;
      case '--grade':     opts.grade    = val.trim(); break;   // '' is a real grade
      case '--team':      opts.team     = val.trim() || null; break;
      case '--max-teams': opts.maxTeams = Math.max(1, intOr(val, 60)); break;
      default:
        if (key.startsWith('--')) { console.error(`Unknown argument: ${key}`); process.exit(1); }
    }
  }
  return opts;
}
const OPTS = parseArgs(process.argv.slice(2));

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };
const keyOf = m => `${m.compName || ''}|${m.age || ''}|${m.rawGrade || ''}`;

// ─── Load ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(DATA_PATH)) { console.error(`data.json not found at ${DATA_PATH}`); process.exit(1); }
let data;
try { data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
catch (e) { console.error(`Could not parse data.json: ${e.message}`); process.exit(1); }

const matches = (data.matches || []).filter(m => !m.isBye && !m.isPartial);
console.log('probe-stored-grade.js — READ-ONLY. Nothing is written.');
console.log(`Options: ${JSON.stringify(OPTS)}`);
console.log(`${(data.matches || []).length} record(s), ${matches.length} real match(es).\n`);

// Every team's full set of keys, for the cross-reference below.
const teamKeys = new Map(); // "comp|team" -> Set(key)
for (const m of matches) {
  for (const t of [m.home, m.away]) {
    if (!t || t.startsWith('__')) continue;
    const k = `${m.compName}|${t}`;
    if (!teamKeys.has(k)) teamKeys.set(k, new Set());
    teamKeys.get(k).add(keyOf(m));
  }
}

// ─── Team lookup mode ─────────────────────────────────────────────────────────

if (OPTS.team) {
  console.log('='.repeat(78));
  console.log(`TEAM: ${OPTS.team}`);
  console.log('='.repeat(78));
  const hits = matches.filter(m => m.home === OPTS.team || m.away === OPTS.team);
  if (!hits.length) {
    console.log('  Not found. Names are stored age-stripped — "Boronia U18 Girls" is');
    console.log('  stored as "Boronia Girls".');
    process.exit(0);
  }
  const byKey = new Map();
  hits.forEach(m => { const k = keyOf(m); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(m); });
  for (const [k, ms] of [...byKey.entries()].sort()) {
    const rounds = [...new Set(ms.map(m => m.isFinals ? `F:${m.finalsAbbrev}` : m.round))];
    const dates  = ms.map(m => m.date).filter(Boolean).sort();
    console.log(`  ${pad(k, 40)} ${pad(ms.length + ' game(s)', 12)} rounds ${rounds.join(',')}`);
    if (dates.length) console.log(`  ${' '.repeat(40)} ${dates[0]} to ${dates[dates.length - 1]}`);
  }
  process.exit(0);
}

// ─── Key selection ────────────────────────────────────────────────────────────

const keys = [...new Set(matches.map(keyOf))].filter(k => {
  const [c, a, g] = k.split('|');
  if (OPTS.comp  && !c.toLowerCase().includes(OPTS.comp.toLowerCase())) return false;
  if (OPTS.age   && a.toLowerCase() !== OPTS.age.toLowerCase()) return false;
  if (OPTS.grade !== null && g.toLowerCase() !== OPTS.grade.toLowerCase()) return false;
  return true;
}).sort();

if (!keys.length) {
  console.error('No stored keys matched. Check --comp / --age / --grade.');
  process.exit(1);
}

for (const key of keys) {
  const ms = matches.filter(m => keyOf(m) === key);
  console.log('='.repeat(78));
  console.log(`${key}   —   ${ms.length} match(es)`);
  console.log('='.repeat(78));

  const rounds = [...new Set(ms.map(m => m.isFinals ? `F:${m.finalsAbbrev}` : m.round))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const dates  = ms.map(m => m.date).filter(Boolean).sort();
  const months = [...new Set(dates.map(d => d.slice(0, 7)))].sort();
  const venues = [...new Set(ms.map(m => m.vSuburb).filter(Boolean))].sort();

  console.log(`  rounds: ${rounds.join(', ')}`);
  if (dates.length) console.log(`  dates:  ${dates[0]} to ${dates[dates.length - 1]}   months: ${months.join(', ')}`);
  if (venues.length) console.log(`  venues: ${venues.length} suburb(s) — ${venues.slice(0, 18).join(', ')}${venues.length > 18 ? ' …' : ''}`);

  // Teams, with the rounds each played and where else they appear.
  const teams = new Map();
  for (const m of ms) {
    for (const t of [m.home, m.away]) {
      if (!t || t.startsWith('__')) continue;
      if (!teams.has(t)) teams.set(t, []);
      teams.get(t).push(m);
    }
  }
  console.log(`\n  ${teams.size} distinct team(s):\n`);
  console.log(`  ${pad('team', 34)} ${pad('games', 6)} ${pad('rounds', 14)} also appears under`);

  let onlyHere = 0;
  for (const [t, tms] of [...teams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // EXACT name match — no prefix matching. See the header note.
    const others = [...(teamKeys.get(`${key.split('|')[0]}|${t}`) || [])].filter(k => k !== key);
    if (!others.length) onlyHere++;
    const rs = [...new Set(tms.map(m => m.isFinals ? `F:${m.finalsAbbrev}` : m.round))]
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    console.log(`  ${pad(t, 34)} ${pad(tms.length, 6)} ${pad(rs.join(','), 14)} ${others.length ? others.join('  ') : '(nowhere else)'}`);
  }

  console.log(`\n  ${onlyHere} of ${teams.size} team(s) appear under this key and nowhere else in ${key.split('|')[0]}.`);
  if (onlyHere === teams.size && teams.size > 2) {
    console.log('  Every team is exclusive to this key — consistent with a self-contained');
    console.log('  competition rather than a grading pool drawn from the league.');
  }
  console.log('');
}

console.log('='.repeat(78));
console.log(`${keys.length} key(s) reported. Nothing was written.`);
console.log('='.repeat(78));
