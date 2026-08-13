#!/usr/bin/env node
// scripts/probe-concurrent-comps.js
//
// Establishes, for ONE age group in ONE season, everything PlayHQ holds and
// everything we have stored, so the SEJ U10 case can be designed against
// measurement rather than inference.
//
// WHAT v1 GOT WRONG, and why v2 exists.
// v1 asked four narrow questions and each answer was individually true and
// collectively misleading:
//   * It reported "0 teams in more than one grade" and that was correct — but it
//     only tested for a team in two GRADES. SEJ 2026 U10 Girls has the same side
//     registered TWICE IN ONE GRADE under two team ids (8e1bd901 for R1-R9,
//     6efcb2b7 for R11-R14), which that test cannot see.
//   * It reported the Lightning Premiership as "1 home-and-away round + 1 GF"
//     and concluded a ladder was meaningless. In fact that one round holds three
//     games per team played on a single day — a round robin — so a ladder is
//     entirely meaningful. PlayHQ's own LP ladder shows P=3.
//   * It printed round LABELS rather than raw fields, so it could not show that
//     round 10 of the season-long grade holds a single PENDING placeholder
//     ("Dummy U10 Girls 1 v Dummy U10 Girls 2", venue TBC) standing in for the
//     week the round robin replaced.
//
// THAT PLACEHOLDER IS A LIVE DEFECT, which is the main thing v2 is for.
// fetchGrade() walks rounds in order and breaks on the first round that has
// games but none FINAL — "scheduled, not yet played — stopping". A permanent
// PENDING placeholder at R10 therefore stops the walk forever, and R11-R14 are
// never fetched even though PlayHQ has the results. The dashboard grade tab
// showing "R9" is that, visible.
//
// So this probe reports, per grade in the age group:
//   1  competitions and seasons for the organisation
//   2  every grade, with parsed age/rawGrade and collapsing keys
//   3  every round, RAW: number, name, abbreviatedName, isFinalsRound, current
//   4  every team from the registry, grouped by grade, with duplicate names
//      within one grade called out
//   5  every game in every round: teams with ids, status, date — and any round
//      that has games but none FINAL, which is where the walk would stop
//   6  what is STORED for the same grades, so the gap is a number not a guess
//
// READ ONLY. Calls PlayHQ and reads data/, writes nothing, commits nothing.
//
// Env:
//   PROBE_ORG      8-character organisation code. Default 1cf85e52 (SEJ).
//   PROBE_SEASON   season id. Default 4dfaaab5 (SEJ 2026).
//   PROBE_AGE      age token matched against the grade name. Default U10.
//                  Set to "" for every age — expensive, see below.
//   PROBE_MAX_CALLS  cap on fixture calls, default 120. Section 5 costs one call
//                  per round per grade; the default age is about 60.
//
// Exit: 0 the probe ran, 1 it could not reach the data.
//
// Run: node scripts/probe-concurrent-comps.js

'use strict';

const fs = require('fs');
const path = require('path');
const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');
// The engine's OWN queries and parser. Not copied: a second copy of a query
// drifts, and the working practice is explicit that queries come from something
// continuously exercised. Q_FIXTURE and Q_GRADE_ROUNDS are exported for exactly
// this reason.
const {
  parseGradeName, cleanTeam, Q_GRADE_ROUNDS, Q_FIXTURE, roundToken,
} = require('./lib/results-engine');
const store = require('./lib/store');

const VERSION = 'probe-concurrent-comps v2 2026-08-13 full-dump';
const ROOT = path.resolve(__dirname, '..');

const ORG    = (process.env.PROBE_ORG    || '1cf85e52').trim();
const SEASON = (process.env.PROBE_SEASON || '4dfaaab5').trim();
const AGE    = (process.env.PROBE_AGE === undefined ? 'U10' : process.env.PROBE_AGE).trim();
const MAX_CALLS = parseInt(process.env.PROBE_MAX_CALLS || '120', 10);

const log = (m) => console.log(m);

// discoverCompetitions: docs/playhq_api_reference.md, verified 2026-08-11 across
// all 1,175 AFL associations. organisationID is the 8-CHARACTER CODE, not the
// UUID, despite being declared ID!, and `seasons` takes it as its own required
// argument. Omitting either is the mistake behind the retracted "does not work
// from a guest session" note.
const Q_COMPETITIONS = `
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons(organisationID: $organisationID) {
      id name startDate endDate status { name value }
    }
  }
}`;

// Copied from scripts/lib/results-engine.js Q_GRADE_LIST, which runs every
// weekend. Not exported, so this is the one query duplicated here.
const Q_GRADE_LIST = `
query gradeListDiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id
    name
    competition { id name }
    grades {
      id
      name
      age { name value }
      gender { name value }
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

let calls = 0;
async function ask(query, vars, opName) {
  const r = await gqlPost(query, vars, opName);
  calls++;
  if (r && r.errors && r.errors.length) {
    for (const e of r.errors) log(`    API error: ${e.message}`);
  }
  return r && r.data;
}

const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);

async function main() {
  log(`=== ${VERSION} ===`);
  log(`organisation ${ORG}, season ${SEASON}, age filter ${AGE || '(all ages)'}, ` +
      `fixture call cap ${MAX_CALLS}`);

  let core;
  try { core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8')); }
  catch (e) { console.error(`FATAL: could not read core.json — ${e.message}`); process.exit(1); }
  if (!core || !Array.isArray(core.manifest)) {
    console.error('FATAL: data/core.json has no manifest.');
    process.exit(1);
  }
  const entry = core.manifest.find(m => m.seasonId === SEASON);
  if (!entry) {
    console.error(`FATAL: season ${SEASON} is not in the manifest. Nothing to compare against.`);
    process.exit(1);
  }
  log(`manifest: ${entry.compName} (${entry.status})`);

  await refreshSession();

  // ── 1. Competitions and seasons ────────────────────────────────────────────
  log(`\n${'='.repeat(74)}\n1  Competitions and seasons for ${ORG}\n${'='.repeat(74)}`);
  try {
    const d = await ask(Q_COMPETITIONS, { organisationID: ORG }, 'discoverCompetitions');
    const comps = (d && d.discoverCompetitions) || [];
    log(`${comps.length} competition(s)`);
    for (const c of comps) {
      log(`\n  ${c.name}  (${c.id})`);
      for (const s of (c.seasons || [])) {
        log(`    ${pad(s.name, 8)} ${s.id}  ${pad((s.status || {}).value, 10)} ` +
          `${s.startDate} .. ${s.endDate}${s.id === SEASON ? '  <-- configured' : ''}`);
      }
    }
  } catch (e) {
    console.error(`  FATAL: discoverCompetitions failed: ${e.message}`);
    process.exit(1);
  }
  await sleep(400);

  // ── 2. Grades ──────────────────────────────────────────────────────────────
  log(`\n${'='.repeat(74)}\n2  Grades in season ${SEASON}\n${'='.repeat(74)}`);
  let grades = [];
  try {
    const d = await ask(Q_GRADE_LIST, { id: SEASON }, 'gradeListDiscoverSeason');
    grades = ((d && d.discoverSeason && d.discoverSeason.grades) || []);
  } catch (e) {
    console.error(`  FATAL: gradeListDiscoverSeason failed: ${e.message}`);
    process.exit(1);
  }
  const inAge = AGE
    ? grades.filter(g => new RegExp(`\\b${AGE}\\b`, 'i').test(g.name) ||
                         new RegExp(`^${AGE}$`, 'i').test((g.age || {}).name || ''))
    : grades;
  log(`${grades.length} grade(s) in the season, ${inAge.length} matching "${AGE || 'all'}"\n`);

  const parsed = new Map();
  const wN = Math.max(24, ...inAge.map(g => g.name.length)) + 2;
  log('  ' + pad('grade name', wN) + pad('id', 10) + pad('parsed age', 14) + 'rawGrade');
  for (const g of inAge) {
    const p = parseGradeName(g.name, (g.age || {}).name || '', (g.gender || {}).name || '');
    parsed.set(g.id, p);
    log('  ' + pad(g.name, wN) + pad(g.id, 10) + pad(p.age, 14) + JSON.stringify(p.rawGrade));
  }

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
    for (const [k, v] of collapsed) log(`    "${k}" -> ${v.map(g => `${g.id} "${g.name}"`).join('  |  ')}`);
  }

  // ── 3. Rounds, RAW ─────────────────────────────────────────────────────────
  // v1 printed labels. The raw fields are what fetchGrade() branches on, so they
  // are what has to be read.
  log(`\n${'='.repeat(74)}\n3  Rounds per grade — RAW fields\n${'='.repeat(74)}`);
  const roundsOf = new Map();   // gradeId -> rounds[]
  for (const g of inAge) {
    let gd = null;
    try {
      const d = await ask(Q_GRADE_ROUNDS, { gradeID: g.id }, 'gradeRounds');
      gd = d && d.discoverGrade;
    } catch (e) { log(`  ${g.name}: gradeRounds failed — ${e.message}`); await sleep(400); continue; }
    const rs = (gd && gd.rounds) || [];
    roundsOf.set(g.id, rs);
    log(`\n  ${g.name}  (${g.id})   months: ${((gd && gd.dates) || []).join(', ') || '(none)'}`);
    log('    ' + pad('number', 8) + pad('name', 22) + pad('abbrev', 9) +
        pad('isFinals', 10) + pad('current', 9) + 'token');
    for (const r of rs) {
      const fAbbrev = r.isFinalsRound === true ? (r.abbreviatedName || String(r.number)) : '';
      log('    ' + pad(r.number, 8) + pad(r.name, 22) + pad(r.abbreviatedName, 9) +
        pad(r.isFinalsRound === true, 10) + pad(r.current === true, 9) +
        roundToken(parseInt(r.number, 10) || 0, fAbbrev));
    }
    await sleep(400);
  }

  // ── 4. Teams, grouped by grade, duplicates within a grade called out ───────
  log(`\n${'='.repeat(74)}\n4  Registry teams per grade\n${'='.repeat(74)}`);
  let teams = [];
  try {
    const d = await ask(Q_TEAMS, { seasonId: SEASON }, 'discoverTeamsBySeason');
    teams = (d && d.discoverTeams) || [];
  } catch (e) { log(`  discoverTeams failed: ${e.message}`); }
  const inAgeIds = new Set(inAge.map(g => g.id));
  const relevant = teams.filter(t => t.grade && inAgeIds.has(t.grade.id));
  log(`${teams.length} team(s) in the season, ${relevant.length} in this age`);

  const nameOfGrade = new Map(inAge.map(g => [g.id, g.name]));
  const byGrade = new Map();
  for (const t of relevant) {
    if (!byGrade.has(t.grade.id)) byGrade.set(t.grade.id, []);
    byGrade.get(t.grade.id).push(t);
  }
  // THE CHECK v1 DID NOT MAKE. Two team ids sharing a name inside one grade is
  // how a mid-season re-registration looks, and v1's "more than one grade" test
  // could not see it.
  const dupWithinGrade = [];
  for (const [gid, ts] of byGrade) {
    const p = parsed.get(gid) || { age: '' };
    log(`\n  ${nameOfGrade.get(gid)}  (${gid}) — ${ts.length} team(s)`);
    const seen = new Map();
    for (const t of ts.slice().sort((a, b) => a.name < b.name ? -1 : 1)) {
      const clean = cleanTeam(t.name, p.age);
      log(`    ${pad(t.id, 10)} ${pad(t.name, 40)} clean="${clean}"`);
      if (!seen.has(clean)) seen.set(clean, []);
      seen.get(clean).push(t.id);
    }
    for (const [clean, ids] of seen) {
      if (ids.length > 1) dupWithinGrade.push({ gid, clean, ids });
    }
  }
  if (dupWithinGrade.length) {
    log(`\n  >> ${dupWithinGrade.length} cleaned name(s) held by MORE THAN ONE team id in the`);
    log(`     SAME grade. Every stored key uses the cleaned name, so these are one`);
    log(`     team as far as storage is concerned and two as far as PlayHQ is.`);
    for (const d of dupWithinGrade) {
      log(`     ${pad(nameOfGrade.get(d.gid), 34)} "${d.clean}" -> ${d.ids.join(', ')}`);
    }
  } else {
    log(`\n  no cleaned name is held by two team ids in one grade`);
  }

  // Same cleaned name across DIFFERENT grades in this age.
  const acrossGrades = new Map();
  for (const t of relevant) {
    const p = parsed.get(t.grade.id) || { age: '' };
    const clean = cleanTeam(t.name, p.age);
    if (!acrossGrades.has(clean)) acrossGrades.set(clean, new Set());
    acrossGrades.get(clean).add(t.grade.id);
  }
  const multiGrade = [...acrossGrades].filter(([, s]) => s.size > 1);
  log(`\n  ${multiGrade.length} cleaned name(s) appear in more than one grade in this age`);
  for (const [clean, s] of multiGrade) {
    log(`    "${clean}" -> ${[...s].map(g => nameOfGrade.get(g) || g).join('  |  ')}`);
  }

  // ── 5. Every game in every round ───────────────────────────────────────────
  // The expensive section, and the one that finds the walk-stopping round.
  log(`\n${'='.repeat(74)}\n5  Every game, every round\n${'='.repeat(74)}`);
  const blockers = [];   // rounds with games but none FINAL
  const apiRounds = new Map();   // gradeId -> Set of tokens that have FINAL games
  for (const g of inAge) {
    const rs = roundsOf.get(g.id) || [];
    log(`\n  ${g.name}  (${g.id})`);
    apiRounds.set(g.id, new Set());
    for (const r of rs) {
      if (calls >= MAX_CALLS) { log(`    [call cap ${MAX_CALLS} reached — stopping]`); break; }
      const fAbbrev = r.isFinalsRound === true ? (r.abbreviatedName || String(r.number)) : '';
      const token = roundToken(parseInt(r.number, 10) || 0, fAbbrev);
      let games = [];
      try {
        const d = await ask(Q_FIXTURE, { roundID: r.id }, 'discoverFixtureByRound');
        games = ((d && d.discoverFixtureByRound && d.discoverFixtureByRound.games) || []);
      } catch (e) { log(`    ${pad(token, 6)} fixture failed — ${e.message}`); await sleep(300); continue; }
      const finals = games.filter(x => (x.status || {}).value === 'FINAL');
      if (finals.length) apiRounds.get(g.id).add(token);
      log(`    ${pad(token, 6)} ${pad(r.name, 20)} ${games.length} game(s), ${finals.length} FINAL`);
      for (const x of games) {
        const h = x.home || {}, a = x.away || {};
        log(`        ${pad((x.status || {}).value, 10)} ${pad(x.date, 12)} ` +
          `${pad(h.id, 10)} ${pad(h.name, 32)} v ${pad(a.id, 10)} ${a.name || ''}`);
      }
      // This is the shape that stops fetchGrade's walk dead.
      if (games.length && !finals.length) {
        blockers.push({ grade: g.name, gid: g.id, token, name: r.name,
                        teams: games.map(x => `${(x.home || {}).name} v ${(x.away || {}).name}`) });
      }
      await sleep(300);
    }
  }
  if (blockers.length) {
    log(`\n  >> ${blockers.length} round(s) have games but NONE final. fetchGrade() breaks out`);
    log(`     of the round loop at the first of these, so every later round in that`);
    log(`     grade is never fetched — permanently, if the placeholder never resolves.`);
    for (const b of blockers) {
      log(`     ${pad(b.grade, 34)} ${pad(b.token, 6)} ${b.name}  [${b.teams.join('; ')}]`);
    }
  } else {
    log(`\n  every round with games has at least one FINAL result`);
  }

  // ── 6. Stored against PlayHQ ───────────────────────────────────────────────
  // The gap as a number. Offline: store.load, no further API calls.
  log(`\n${'='.repeat(74)}\n6  Stored rounds against PlayHQ rounds\n${'='.repeat(74)}`);
  let stored = null;
  try { stored = store.load([entry.compName], { players: false }); }
  catch (e) { log(`  store.load failed: ${e.message}`); }
  if (stored) {
    const filesRead = stored.__filesRead || [];
    if (!filesRead.length) {
      log(`  NO SEASON FILE READ for ${entry.compName}. Expected data/seasons/${SEASON}-core.json.`);
    } else {
      log(`  read ${filesRead.join(', ')}`);
      const storedByGrade = new Map();
      for (const m of stored.matches || []) {
        if (m.compName !== entry.compName) continue;
        const gid = m.gradeId || '';
        if (!inAgeIds.has(gid)) continue;
        if (!storedByGrade.has(gid)) storedByGrade.set(gid, new Set());
        const tok = m.isFinals ? `F:${m.finalsAbbrev || m.round}` : String(m.round);
        storedByGrade.get(gid).add(tok);
      }
      log('');
      for (const g of inAge) {
        const api = [...(apiRounds.get(g.id) || [])];
        const have = [...(storedByGrade.get(g.id) || [])];
        const missing = api.filter(t => !have.includes(t));
        log(`  ${g.name}  (${g.id})`);
        log(`    PlayHQ has FINAL results in : ${api.join(' ') || '(none)'}`);
        log(`    stored                      : ${have.join(' ') || '(none)'}`);
        log(`    MISSING FROM STORAGE        : ${missing.join(' ') || '(none)'}` +
          (missing.length ? '   <-- results exist and are not stored' : ''));
      }
    }
  }

  logSummary('probe-concurrent-comps');
  log(`\n${VERSION}: ${calls} API call(s). Nothing was written.`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
