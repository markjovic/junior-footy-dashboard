#!/usr/bin/env node
// scripts/probe-concurrent-comps.js
//
// Answers ONE question before D1 is designed: how does PlayHQ actually represent
// two competitions running in the same age group?
//
// SEJ 2026 U10 has a main competition and a Lightning Premiership. The dashboard
// shows one ladder per grade and a team can only be on one, so the Lightning
// Premiership grades do not appear. Three options are recorded in
// OUTSTANDING_TASKS.md D1 — separate labelled ladders, a note, or a tab — and
// none of them can be chosen without knowing what the second competition IS.
//
// The options differ depending on the answer:
//   * If it is a SEPARATE PlayHQ competition with its own season, it needs its
//     own config.json entry and its own compName, and D1 is a configuration
//     question rather than a dashboard one.
//   * If it is EXTRA GRADES inside the same season, it is a dashboard question,
//     and whether a ladder is even meaningful depends on the round structure.
//   * If it is a SHORT-FORM series — three rounds, no home-and-away — a ladder
//     may be the wrong thing to show at all.
//
// READ ONLY. Calls PlayHQ and reads data/, writes nothing, commits nothing.
//
// Env:
//   PROBE_ORG      8-character organisation code. Default 1cf85e52 (SEJ).
//   PROBE_SEASON   season id. Default 4dfaaab5 (SEJ 2026).
//   PROBE_AGE      age token to focus on, matched case-insensitively against the
//                  grade name. Default U10. Set to "" for every age.
//
// Exit: 0 the probe ran and reported, 1 it could not reach the data.
//
// Run: node scripts/probe-concurrent-comps.js

'use strict';

const fs = require('fs');
const path = require('path');
const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');
// The engine's own parser. Reproducing it here is how the first team-join probe
// went wrong — its age regex only recognised U-ages and every senior grade keyed
// as an empty string.
const { parseGradeName } = require('./lib/results-engine');

const VERSION = 'probe-concurrent-comps v1 2026-08-13';
const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');

const ORG    = (process.env.PROBE_ORG    || '1cf85e52').trim();
const SEASON = (process.env.PROBE_SEASON || '4dfaaab5').trim();
const AGE    = (process.env.PROBE_AGE === undefined ? 'U10' : process.env.PROBE_AGE).trim();

const log = (m) => console.log(m);

// ── Queries, copied verbatim from code that has run ──────────────────────────
// discoverCompetitions: docs/playhq_api_reference.md, verified 2026-08-11 across
// all 1,175 AFL associations. organisationID is the 8-CHARACTER CODE, not the
// UUID, despite being declared ID!, and `seasons` takes it as a required
// argument of its own. Omitting either is the mistake that produced the
// retracted "does not work from a guest session" note.
const Q_COMPETITIONS = `
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons(organisationID: $organisationID) {
      id name startDate endDate status { name value }
    }
    organisation { id name }
  }
}`;

// Copied from scripts/lib/results-engine.js Q_GRADE_LIST.
const Q_GRADE_LIST = `
query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition { id name organisation { id name } }
    grades {
      id
      name
      age { name value }
      gender { name value }
    }
  }
}`;

// Copied from scripts/lib/results-engine.js Q_GRADE_ROUNDS.
const Q_GRADE_ROUNDS = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    dates
    rounds {
      id
      name
      abbreviatedName
      number
      current
      isFinalsRound
      provisionalDates
    }
  }
}`;

// Copied from scripts/probe-team-join.js, which ran 2026-08-12.
const Q_TEAMS = `
query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id name
    grade { id name }
    organisation { id name }
  }
}`;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

async function ask(query, vars, opName) {
  const r = await gqlPost(query, vars, opName);
  if (r && r.errors && r.errors.length) {
    for (const e of r.errors) log(`    API error: ${e.message}`);
  }
  return r && r.data;
}

async function main() {
  log(`=== ${VERSION} ===`);
  log(`organisation ${ORG}, season ${SEASON}, age filter ${AGE || '(all ages)'}`);

  const core = readJson(CORE_PATH);
  if (!core || !Array.isArray(core.manifest)) {
    console.error('FATAL: data/core.json has no manifest.');
    process.exit(1);
  }
  const entry = core.manifest.find(m => m.seasonId === SEASON);
  log(`manifest: ${entry ? `${entry.compName} (${entry.status})` : 'season NOT in the manifest'}`);

  await refreshSession();

  // ── 1. Is the second competition a separate PlayHQ COMPETITION? ────────────
  // This is the question that decides whether D1 is a config change or a
  // dashboard change, so it is asked first.
  log(`\n${'='.repeat(70)}\n1  Competitions and seasons for organisation ${ORG}\n${'='.repeat(70)}`);
  let comps = [];
  try {
    const d = await ask(Q_COMPETITIONS, { organisationID: ORG }, 'discoverCompetitions');
    comps = (d && d.discoverCompetitions) || [];
  } catch (e) {
    console.error(`  FATAL: discoverCompetitions failed: ${e.message}`);
    process.exit(1);
  }
  log(`${comps.length} competition(s)`);
  for (const c of comps) {
    log(`\n  ${c.name}  (${c.id})`);
    for (const s of (c.seasons || [])) {
      const mark = s.id === SEASON ? '  <-- the configured season' : '';
      log(`    ${String(s.name).padEnd(8)} ${s.id}  ${String((s.status || {}).value || '').padEnd(10)}` +
        ` ${s.startDate} .. ${s.endDate}${mark}`);
    }
  }
  if (comps.length > 1) {
    log(`\n  >> MORE THAN ONE COMPETITION. If the second age-group competition is one`);
    log(`     of these, it has its own season id and needs its own config.json entry`);
    log(`     and compName — D1 is then a configuration question, not a ladder one.`);
  } else {
    log(`\n  >> ONE COMPETITION. Any second age-group competition must therefore be`);
    log(`     extra GRADES inside this season, which section 2 lists.`);
  }
  await sleep(500);

  // ── 2. Every grade in the season, and which fall in the target age ─────────
  log(`\n${'='.repeat(70)}\n2  Grades in season ${SEASON}\n${'='.repeat(70)}`);
  let grades = [];
  let seasonMeta = null;
  try {
    const d = await ask(Q_GRADE_LIST, { id: SEASON }, 'gradeListDiscoverSeason');
    seasonMeta = d && d.discoverSeason;
    grades = (seasonMeta && seasonMeta.grades) || [];
  } catch (e) {
    console.error(`  FATAL: gradeListDiscoverSeason failed: ${e.message}`);
    process.exit(1);
  }
  if (seasonMeta && seasonMeta.competition) {
    log(`season "${seasonMeta.name}" belongs to competition ` +
      `"${seasonMeta.competition.name}" (${seasonMeta.competition.id})`);
  }
  log(`${grades.length} grade(s) in the season`);

  // Matched on the NAME, not on the parsed age, because the parse is what is
  // under suspicion: two grades that both parse to "U10" with an empty rawGrade
  // is one of the shapes this probe is looking for.
  const inAge = AGE
    ? grades.filter(g => new RegExp(`\\b${AGE}\\b`, 'i').test(g.name) ||
                         new RegExp(`^${AGE}$`, 'i').test((g.age || {}).name || ''))
    : grades;
  log(`${inAge.length} grade(s) matching "${AGE || 'all'}"\n`);

  const parsed = new Map();   // gradeId -> { age, rawGrade }
  const wName = Math.max(20, ...inAge.map(g => g.name.length)) + 2;
  log('  ' + 'grade name'.padEnd(wName) + 'id'.padEnd(10) +
      'age'.padEnd(10) + 'gender'.padEnd(9) + 'parsed age'.padEnd(14) + 'rawGrade');
  for (const g of inAge) {
    const p = parseGradeName(g.name, (g.age || {}).name || '', (g.gender || {}).name || '');
    parsed.set(g.id, p);
    log('  ' + g.name.padEnd(wName) + String(g.id).padEnd(10) +
      String((g.age || {}).name || '').padEnd(10) +
      String((g.gender || {}).name || '').padEnd(9) +
      String(p.age).padEnd(14) + JSON.stringify(p.rawGrade));
  }

  // Grades that collapse to one age|rawGrade key are the ones that cannot be
  // told apart by anything except the grade id.
  const byKey = new Map();
  for (const g of inAge) {
    const p = parsed.get(g.id);
    const k = `${p.age}|${p.rawGrade}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(g);
  }
  const collapsed = [...byKey].filter(([, v]) => v.length > 1);
  if (collapsed.length) {
    log(`\n  ${collapsed.length} age|rawGrade key(s) hold more than one grade:`);
    for (const [k, v] of collapsed) {
      log(`    "${k}" -> ${v.map(g => `${g.id} "${g.name}"`).join('  |  ')}`);
    }
  } else {
    log(`\n  every grade in this age has a distinct age|rawGrade key`);
  }

  // ── 3. Round structure per grade — is a ladder even meaningful? ────────────
  // A grade with three rounds and no home-and-away is not a league table.
  log(`\n${'='.repeat(70)}\n3  Round structure per grade\n${'='.repeat(70)}`);
  const rounds = new Map();   // gradeId -> { ha, finals, names, dates }
  for (const g of inAge) {
    let gd = null;
    try {
      const d = await ask(Q_GRADE_ROUNDS, { gradeID: g.id }, 'gradeRounds');
      gd = d && d.discoverGrade;
    } catch (e) {
      log(`  ${g.name}: gradeRounds failed — ${e.message}`);
      await sleep(400);
      continue;
    }
    const rs = (gd && gd.rounds) || [];
    const ha = rs.filter(r => r.isFinalsRound !== true);
    const fin = rs.filter(r => r.isFinalsRound === true);
    rounds.set(g.id, { ha: ha.length, finals: fin.length, dates: (gd && gd.dates) || [] });
    log(`\n  ${g.name}  (${g.id})`);
    log(`    ${rs.length} round(s): ${ha.length} home-and-away, ${fin.length} finals`);
    log(`    months: ${((gd && gd.dates) || []).join(', ') || '(none)'}`);
    const label = (r) => r.isFinalsRound === true
      ? `${r.abbreviatedName || '?'}` : `R${r.number}`;
    log(`    sequence: ${rs.map(label).join(' ')}`);
    await sleep(400);
  }

  // ── 4. Teams: is a team in more than one grade in this age? ────────────────
  // The six roster warnings in the 2026-08-13 results run say yes. This
  // establishes it from the registry rather than from stored records.
  log(`\n${'='.repeat(70)}\n4  Teams appearing in more than one grade in this age\n${'='.repeat(70)}`);
  let teams = [];
  try {
    const d = await ask(Q_TEAMS, { seasonId: SEASON }, 'discoverTeamsBySeason');
    teams = (d && d.discoverTeams) || [];
  } catch (e) {
    log(`  discoverTeams failed: ${e.message}`);
  }
  const inAgeIds = new Set(inAge.map(g => g.id));
  const relevant = teams.filter(t => t.grade && inAgeIds.has(t.grade.id));
  log(`registry: ${teams.length} team(s) in the season, ${relevant.length} in this age`);

  // Keyed on the CLUB plus the bare team name, because PlayHQ registers the same
  // side separately in each grade and the ids differ.
  const byTeam = new Map();
  for (const t of relevant) {
    const k = `${(t.organisation || {}).id || '?'}|${t.name}`;
    if (!byTeam.has(k)) byTeam.set(k, []);
    byTeam.get(k).push(t);
  }
  const multi = [...byTeam].filter(([, v]) => new Set(v.map(t => t.grade.id)).size > 1);
  log(`${multi.length} team(s) registered in more than one grade in this age\n`);
  for (const [k, v] of multi.slice(0, 25)) {
    log(`  ${k.split('|')[1]}`);
    for (const t of v) log(`      ${t.grade.id}  ${t.grade.name}`);
  }
  if (multi.length > 25) log(`  ... ${multi.length - 25} more`);

  if (!multi.length && relevant.length) {
    log(`  >> No team is in two grades. The two competitions are then disjoint sets`);
    log(`     of teams, and separate ladders would not double-count anyone.`);
  } else if (multi.length) {
    log(`\n  >> Teams ARE in two grades. Any answer to D1 has to say which ladder a`);
    log(`     shared team counts towards, or show it on both deliberately.`);
  }

  logSummary('probe-concurrent-comps');
  log(`\n${VERSION}: done. Nothing was written.`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
