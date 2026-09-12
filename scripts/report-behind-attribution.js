#!/usr/bin/env node
// scripts/report-behind-attribution.js
//
// READ-ONLY. No PlayHQ call, no write, no commit. Reads the committed lines
// files and the stored match records and answers one question:
//
//   WHERE ARE BEHINDS ACTUALLY CREDITED TO A PLAYER, RATHER THAN TO THE TEAM?
//
// per_game_stats_design.md proposes deriving a player's behinds by summing
// `1_POINT_SCORE` across their stored game lines. That is free — the data is
// already here — but it is a systematic UNDERCOUNT wherever the scorer credited
// behinds to the team, and a card showing "12 behinds" when the player kicked 20
// is worse than a card showing none, because nothing signals the gap.
//
// Measured on the 2026 fetch: 76,423 player rows carried a goal figure and only
// 27,005 carried a behind figure. The hypothesis to test is that attribution is
// far better in senior and older-age grades than in juniors — in which case the
// figure is worth showing where it is reliable and worth suppressing where it is
// not, rather than shown or hidden everywhere.
//
// ⚠️ THE DENOMINATOR IS THE POINT. "How many players have a behind figure" is not
// the question — most players kick none, so a zero is correct for them. The
// question is what share of the behinds a TEAM kicked were attributed to named
// players. That needs the team's own total, which comes from the stored match
// record (`hB`/`aB`), not from the lines file.
//
// Run: node scripts/report-behind-attribution.js
// Env: RBA_COMP (one competition), RBA_YEAR (one year).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const VERSION = 'report-behind-attribution v1 2026-09-12';

const ROOT = path.resolve(__dirname, '..');
const COMP = (process.env.RBA_COMP || '').trim();
const YEAR = (process.env.RBA_YEAR || '').trim();
const yearOf = (c) => (String(c || '').match(/\b(\d{4})\b/) || [])[1] || '';
const log = (...a) => console.log(...a);

function loadLines(sid) {
  const p = path.join(store.SEASONS_DIR, `${sid}-lines.json.gz`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }
  catch (e) { console.error(`  could not read ${path.basename(p)}: ${e.message}`); return null; }
}

function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: no PlayHQ call, nothing written.\n');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = core.manifest || [];
  const data = store.load(COMP ? [COMP] : null, { players: false });

  // seasonId -> lines file, loaded once
  const files = new Map();
  for (const m of manifest) {
    if (!m.seasonId || (YEAR && yearOf(m.compName) !== YEAR)) continue;
    if (COMP && m.compName !== COMP) continue;
    const f = loadLines(m.seasonId);
    if (f) files.set(m.compName, f);
  }
  if (!files.size) {
    console.error('No lines file found for the requested scope. Has fetch-game-lines run?');
    process.exit(2);
  }
  log(`lines files: ${files.size} (${[...files.keys()].sort().join(', ')})\n`);

  // Per age group and per competition: team goals/behinds from the MATCH record,
  // player goals/behinds from the lines file, counted only for sides that have a
  // player list at all. A side with no list says nothing about attribution — it
  // says the scorer entered nothing, which is a different fact.
  const byAge = new Map(), byComp = new Map();
  const cell = (m, k) => {
    if (!m.has(k)) m.set(k, { sides: 0, tG: 0, pG: 0, tB: 0, pB: 0, sidesWithAnyB: 0 });
    return m.get(k);
  };
  let sidesSeen = 0, sidesNoList = 0, gamesNoLines = 0;

  for (const rec of (data.matches || [])) {
    if (rec.isBye || rec.isPartial || rec.scheduled || rec.live) continue;
    if (!rec.gameId) continue;
    if (YEAR && yearOf(rec.compName) !== YEAR) continue;
    const f = files.get(rec.compName);
    if (!f) continue;
    const g = f.games && f.games[rec.gameId];
    if (!g || g.n) { gamesNoLines++; continue; }

    for (const [key, tG, tB] of [['h', rec.hG, rec.hB], ['a', rec.aG, rec.aB]]) {
      const rows = g[key];
      sidesSeen++;
      if (!rows || !rows.length) { sidesNoList++; continue; }
      // ⚠️ A MISSING TEAM FIGURE IS NOT A ZERO. Skip the side rather than count
      // its players against a denominator of nothing, which would read as 100%.
      if (typeof tG !== 'number' || typeof tB !== 'number') continue;
      const pG = rows.reduce((n, r) => n + (r[1] || 0), 0);
      const pB = rows.reduce((n, r) => n + (r[2] || 0), 0);
      for (const c of [cell(byAge, rec.age || '(none)'), cell(byComp, rec.compName)]) {
        c.sides++; c.tG += tG; c.pG += pG; c.tB += tB; c.pB += pB;
        if (pB > 0) c.sidesWithAnyB++;
      }
    }
  }

  const pct = (a, b) => b > 0 ? (a / b * 100).toFixed(0) + '%' : '—';
  const table = (m, title, sortKey) => {
    log(`\n${title}`);
    log('  ' + 'group'.padEnd(16) + 'sides'.padStart(7) + '  goals attributed'.padStart(18) +
      '  behinds attributed'.padStart(20) + '  sides with any behind'.padStart(24));
    const rows = [...m.entries()].filter(([, v]) => v.sides > 0);
    rows.sort(sortKey);
    for (const [k, v] of rows) {
      log('  ' + String(k).padEnd(16) +
        String(v.sides).padStart(7) +
        `${String(v.pG) + '/' + v.tG} ${pct(v.pG, v.tG)}`.padStart(18) +
        `${String(v.pB) + '/' + v.tB} ${pct(v.pB, v.tB)}`.padStart(20) +
        `${pct(v.sidesWithAnyB, v.sides)}`.padStart(24));
    }
  };

  // Age order: seniors and the oldest juniors first, because the hypothesis under
  // test is that attribution falls with age. Anything unparseable sorts last.
  const ageNum = (a) => {
    const x = /U(\d+)/i.exec(String(a));
    return x ? Number(x[1]) : (/senior|open/i.test(String(a)) ? 99 : -1);
  };
  table(byAge, 'BY AGE GROUP — the hypothesis: attribution is better in older grades',
    (a, b) => ageNum(b[0]) - ageNum(a[0]) || String(a[0]).localeCompare(String(b[0])));
  table(byComp, 'BY COMPETITION', (a, b) => String(a[0]).localeCompare(String(b[0])));

  const all = [...byAge.values()].reduce((t, v) => {
    t.sides += v.sides; t.tG += v.tG; t.pG += v.pG; t.tB += v.tB; t.pB += v.pB;
    t.sidesWithAnyB += v.sidesWithAnyB; return t;
  }, { sides: 0, tG: 0, pG: 0, tB: 0, pB: 0, sidesWithAnyB: 0 });

  log('\n═══ WHAT THIS DECIDES ═══');
  log(`sides with a player list: ${all.sides}; sides with none: ${sidesNoList} of ${sidesSeen}; ` +
    `games with no lines stored: ${gamesNoLines}`);
  log(`goals attributed overall:   ${all.pG} of ${all.tG}  ${pct(all.pG, all.tG)}`);
  log(`behinds attributed overall: ${all.pB} of ${all.tB}  ${pct(all.pB, all.tB)}`);
  log('');
  log('Read the BY AGE table, not this total. If attribution is high in the older');
  log('grades and low in the youngest, a derived behind figure is worth showing where');
  log('it holds and worth suppressing where it does not — a per-grade rule, which the');
  log('stored data supports because the team total is on every match record.');
  log('⚠️ If it is uniformly low, the figure undercounts everywhere and a card showing');
  log('   it would be quietly wrong for everyone, which is the one outcome not worth');
  log('   shipping. The number below each group is what decides that, per group.');
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
