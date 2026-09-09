#!/usr/bin/env node
// scripts/top-stats.js
//
// READ-ONLY report of records across every stored season: biggest winning
// margin, most points and most goals in a single quarter, most goals by a player
// in a season, most goals by a player across all seasons. Prints tables to the
// log; writes nothing, calls nothing.
//
// What the data can and cannot answer (measured 2026-09-09 against the stored
// shapes): match records carry team scores (hScore/aScore, hG/hB, aG/aB) and
// per-quarter points hQ/aQ with goals-and-behinds hQGB/aQGB — so team records
// are exact. Player records in <season>-players.json are SEASON TOTALS per
// person per age group (gp, goals); no per-game player line is stored anywhere.
// "Most goals by a player in one game" is therefore NOT answerable here and the
// report says so instead of guessing.
//
// A quarter array may hold nulls (a partial breakdown is kept, not discarded);
// null quarters are skipped, never treated as zero. Scheduled records and byes
// are excluded from everything.
//
// Env: TOP (rows per table, default 10). COMP ("EFNL 2026") restricts to one
// competition; AGE ("U12") restricts to one age group — both optional.

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');

const VERSION = 'top-stats v3 2026-09-09 grades-on-players';
const TOP = Math.max(1, Math.min(100, Number(process.env.TOP || 10)));
const COMP = (process.env.COMP || '').trim();
const AGE = (process.env.AGE || '').trim();

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const rpad = (s, n) => String(s ?? '').padStart(n);

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function main() {
  log(`=== ${VERSION} ===`);
  log('READ-ONLY — no writes, no PlayHQ calls.');
  if (COMP) log(`filter: competition "${COMP}"`);
  if (AGE) log(`filter: age "${AGE}"`);

  const core = readJson(store.CORE_PATH);
  const manifest = (core.manifest || []).filter(m => m.seasonId && m.compName);
  const files = fs.readdirSync(store.SEASONS_DIR);

  // ── Load ───────────────────────────────────────────────────────────────────
  const matches = [];
  const playerRows = [];      // { uuid, name, compName, team, age, goals, gp }
  let seasonsRead = 0;
  for (const m of manifest) {
    if (COMP && m.compName !== COMP) continue;
    const coreFile = `${m.seasonId}-core.json`;
    const playersFile = `${m.seasonId}-players.json`;
    if (files.includes(coreFile)) {
      seasonsRead++;
      for (const x of readJson(path.join(store.SEASONS_DIR, coreFile)).matches || []) {
        if (x.scheduled || x.isBye || x.hScore == null || x.aScore == null) continue;
        if (AGE && x.age !== AGE) continue;
        matches.push(x);
      }
    }
    if (files.includes(playersFile)) {
      for (const p of readJson(path.join(store.SEASONS_DIR, playersFile)).players || []) {
        if (!p.uuid) continue;
        if (AGE && p.age !== AGE) continue;
        playerRows.push({ uuid: p.uuid, name: p.name, compName: p.compName || m.compName, team: p.team, age: p.age,
          grade: p.rawGrade || '', goals: Number(p.goals) || 0, gp: Number(p.gp) || 0 });
      }
    }
  }
  log(`seasons read: ${seasonsRead}; matches with a result: ${matches.length}; player-season rows: ${playerRows.length}\n`);
  if (!matches.length && !playerRows.length) { log('Nothing matched the filters.'); process.exit(2); }

  const where = (x) => `${x.compName} · ${x.age} ${x.rawGrade || ''} · R${x.round} · ${x.date || ''}`;

  // ── 1. Biggest winning margin ─────────────────────────────────────────────
  log(`1  BIGGEST WINNING MARGIN (top ${TOP})`);
  log('─'.repeat(110));
  const margins = matches.map(x => {
    const diff = x.hScore - x.aScore;
    const win = diff >= 0 ? x.home : x.away, lose = diff >= 0 ? x.away : x.home;
    const ws = Math.max(x.hScore, x.aScore), ls = Math.min(x.hScore, x.aScore);
    const wg = diff >= 0 ? x.hG : x.aG, wb = diff >= 0 ? x.hB : x.aB;
    return { margin: Math.abs(diff), win, lose, ws, ls, wg, wb, x };
  }).sort((a, b) => b.margin - a.margin).slice(0, TOP);
  for (const r of margins) {
    log(`  ${rpad(r.margin, 4)}  ${pad(r.win, 28)} ${rpad(r.ws, 3)}${r.wg != null ? ` (${r.wg}.${r.wb})` : ''}  def  ${pad(r.lose, 28)} ${rpad(r.ls, 3)}   ${where(r.x)}`);
  }

  // ── 2 & 3. Most points / most goals in a quarter ───────────────────────────
  // A team whose whole game was entered in one quarter — [0,0,0,205] — is a data
  // entry habit, not a record. Measured 2026-09-09 on EFNL 2026: 261 team-quarter
  // arrays hold the full score in a single quarter, most of them honestly (a team
  // that kicked 1.0 scored its six points in one quarter). The dishonest ones are
  // the big totals with three RECORDED zeros around them; those are set aside and
  // counted, not ranked.
  const WHOLE_GAME_MIN = 40;
  const quarters = [];
  let setAside = 0;
  for (const x of matches) {
    for (const side of ['h', 'a']) {
      const q = x[`${side}Q`];
      if (!Array.isArray(q)) continue;
      const total = x[`${side}Score`];
      // Whole game in one quarter, whether the other three are recorded zeros
      // ([0,0,0,205]) or absent ([null,null,null,216] — Mount Eliza SEJ 2022 R2,
      // the first full run's "record"). Either way one quarter holds the total.
      const nonZero = q.filter(v => v != null && v !== 0);
      const wholeGameInOne = total >= WHOLE_GAME_MIN && nonZero.length === 1 && nonZero[0] === total;
      // Quarters that cannot be true: one bigger than the final score, or four that
      // do not add up to it. Measured 2026-09-09: Bulleen Templestowe R5 stored
      // [null,null,null,205] against a full-time 181.
      const known = q.filter(v => v != null);
      const inconsistent = known.some(v => v > total) || (known.length === q.length && known.reduce((a, b) => a + b, 0) !== total);
      if (wholeGameInOne || inconsistent) { setAside++; continue; }
      const gb = x[`${side}QGB`];
      for (let i = 0; i < q.length; i++) {
        if (q[i] == null) continue;                       // partial breakdown: skip, never zero
        const g = Array.isArray(gb) && Array.isArray(gb[i]) ? gb[i][0] : null;
        const b = Array.isArray(gb) && Array.isArray(gb[i]) ? gb[i][1] : null;
        quarters.push({ pts: q[i], g, b, qn: i + 1, team: side === 'h' ? x.home : x.away, opp: side === 'h' ? x.away : x.home, x });
      }
    }
  }
  const withQ = matches.filter(x => Array.isArray(x.hQ) || Array.isArray(x.aQ)).length;
  log(`\n2  MOST POINTS IN A QUARTER (top ${TOP}) — from ${withQ} of ${matches.length} matches that carry a quarter breakdown` +
      (setAside ? `; ${setAside} team-quarter set(s) set aside — whole game in one quarter, a quarter above the final score, or four quarters that do not add up` : ''));
  log('─'.repeat(110));
  for (const r of quarters.slice().sort((a, b) => b.pts - a.pts).slice(0, TOP)) {
    log(`  ${rpad(r.pts, 4)}${r.g != null ? ` (${r.g}.${r.b})` : '      '}  Q${r.qn}  ${pad(r.team, 28)} v ${pad(r.opp, 28)}   ${where(r.x)}`);
  }
  const withGB = quarters.filter(r => r.g != null);
  log(`\n3  MOST GOALS IN A QUARTER (top ${TOP}) — from ${withGB.length} quarters that carry goals and behinds`);
  log('─'.repeat(110));
  for (const r of withGB.sort((a, b) => b.g - a.g || b.pts - a.pts).slice(0, TOP)) {
    log(`  ${rpad(r.g, 3)} goals (${r.pts} pts)  Q${r.qn}  ${pad(r.team, 28)} v ${pad(r.opp, 28)}   ${where(r.x)}`);
  }

  // ── 4. Most goals by a player in a season ──────────────────────────────────
  // Rows are per person per age group with disjoint appearances (measured: 1,100
  // people with two rows in WFNL 2026, zero overlapping grades), so a season
  // total is the sum of a person's rows in that season.
  const bySeason = new Map();
  for (const r of playerRows) {
    const k = `${r.uuid}|${r.compName}`;
    const cur = bySeason.get(k) || { uuid: r.uuid, name: r.name, compName: r.compName, teams: new Set(), ages: new Set(), where: [], goals: 0, gp: 0 };
    cur.goals += r.goals; cur.gp += r.gp; cur.teams.add(r.team); cur.ages.add(r.age);
    // One "age grade (team) goals" per row, so a person who turned out in two
    // grades in one season shows both and can be looked up in either.
    const grade = r.grade && r.grade !== r.age ? ' ' + r.grade : '';   // seniors repeat the age as the grade
    cur.where.push(`${r.age}${grade} (${r.team}) ${r.goals}`);
    bySeason.set(k, cur);
  }
  log(`\n4  MOST GOALS BY A PLAYER IN ONE SEASON (top ${TOP})`);
  log('─'.repeat(110));
  for (const r of [...bySeason.values()].sort((a, b) => b.goals - a.goals).slice(0, TOP)) {
    log(`  ${rpad(r.goals, 4)}  ${pad(r.name, 26)} ${r.compName}  ${r.gp} games, ${(r.goals / Math.max(1, r.gp)).toFixed(1)}/game  —  ${r.where.join('; ')}`);
  }

  // ── 5. Most goals by a player, all seasons ─────────────────────────────────
  const career = new Map();
  for (const r of bySeason.values()) {
    const cur = career.get(r.uuid) || { uuid: r.uuid, name: r.name, goals: 0, gp: 0, seasons: [] };
    cur.goals += r.goals; cur.gp += r.gp; cur.seasons.push(`${r.compName} ${r.where.join('; ')}`);
    career.set(r.uuid, cur);
  }
  log(`\n5  MOST GOALS BY A PLAYER ACROSS ALL STORED SEASONS (top ${TOP})`);
  log('─'.repeat(110));
  for (const r of [...career.values()].sort((a, b) => b.goals - a.goals).slice(0, TOP)) {
    // Sort by the year at the end of the competition name, so two competitions in
    // one year sit together and the list reads chronologically.
    const yearOf = (l) => (l.match(/\b(\d{4})\b/) || ['', ''])[1];
    const bySeasonYear = (a, b) => yearOf(a).localeCompare(yearOf(b)) || a.localeCompare(b);
    log(`  ${rpad(r.goals, 4)}  ${pad(r.name, 26)} ${r.gp} games over ${r.seasons.length} season(s)`);
    for (const line of r.seasons.sort(bySeasonYear)) log(`          ${line}`);
  }

  log(`\n6  MOST GOALS BY A PLAYER IN ONE GAME`);
  log('─'.repeat(110));
  log('  NOT AVAILABLE from stored data. Player statistics are stored as season totals per');
  log('  person per age group; no per-game player line is kept. PlayHQ exposes it per game');
  log('  (gameStatistics), so it could be fetched, but it is one call per game.');

  log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main();
