#!/usr/bin/env node
// scripts/build-career-tops.js
//
// Builds data/leaderboard/ from the per-player career files —
// career_leaderboards_design.md.
//
//   node scripts/build-career-tops.js            # build
//   node scripts/build-career-tops.js --dry-run  # report, write nothing
//
// READS players/**  (70,922 files written by fetch-career-stats.js)
// WRITES data/leaderboard/all-time.json
//        data/leaderboard/comp/<leagueId>.json   one per tracked competition
//
// ⚠️ A BROWSER CANNOT DO THIS. 70,922 files is not a fetch a page can make, so
// the ranking happens here and the page reads one ~20 KB file.
//
// NO HEAP, NO PROGRESS FILE, NO RESUME, NO SCOPED MODE. At 70,922 players an
// in-memory sort is nothing, and the sibling project's worst leaderboard bug — a
// scoped run writing career totals for seasons it never scanned — cannot exist
// if there is no scoped mode. Everything is rebuilt every run and git decides
// whether there is a commit.
//
// Offline: no PlayHQ calls, no session. It ranks what is already on disk.
//
// Env: TOPS_N (15) — entries stored per category; the view shows ten.
//      TOPS_MIN_GP (20) — floor for the rate category.
//
// Exit codes: 0 = built (or dry run). 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'build-career-tops v2 2026-09-11 no-dedupe';

const ROOT = path.resolve(__dirname, '..');
const PLAYERS = path.join(ROOT, 'players');
const OUT_DIR = path.join(ROOT, 'data', 'leaderboard');
const OUT_COMP = path.join(OUT_DIR, 'comp');

const N = Math.max(1, Number(process.env.TOPS_N || 15));
const MIN_GP = Math.max(1, Number(process.env.TOPS_MIN_GP || 20));
const DRY = process.argv.slice(2).includes('--dry-run') || process.env.TOPS_DRY_RUN === 'true';

const log = (...a) => console.log(...a);

// ── Categories ───────────────────────────────────────────────────────────────
// `dir` is the sort direction: 'desc' everywhere except the earliest season,
// where the smallest year wins. A category with no `dir` would silently rank
// 2005 last, which is the one result a reader would notice and not believe.
const CATEGORIES = [
  { key: 'goals',        label: 'Most career goals',        dir: 'desc' },
  { key: 'games',        label: 'Most career games',        dir: 'desc' },
  { key: 'best',         label: 'Most best-player awards',  dir: 'desc' },
  { key: 'goalsPerGame', label: 'Goals per game',           dir: 'desc', minGp: true },
  { key: 'gameGoals',    label: 'Most goals in one game',   dir: 'desc' },
  { key: 'seasonGoals',  label: 'Most goals in one season', dir: 'desc' },
  { key: 'seasons',      label: 'Most seasons played',      dir: 'desc' },
  { key: 'leagues',      label: 'Most leagues played in',   dir: 'desc', allTimeOnly: true },
  { key: 'earliest',     label: 'Longest history',          dir: 'asc' },
];

// ── Read one player file into a compact summary ──────────────────────────────
// One object per player rather than a heap: 70,922 of these is a few tens of MB
// and an in-memory sort per category is milliseconds.
function summarise(rec, dupes) {
  const seasons = rec && Array.isArray(rec.seasons) ? rec.seasons : null;
  if (!rec || !rec.uuid || !seasons || !seasons.length) return null;

  // ⚠️ TWO ROWS FOR ONE (season, club) ARE BOTH REAL — DO NOT DEDUPE THEM.
  // 11,829 players carry a pair, and the first cut counted one and dropped the
  // other. The evidence they are distinct registrations rather than duplicates:
  // fetch-career-stats.js compares the SUM of a player's registration totals
  // against PlayHQ's own careerStatistics on every run, and shard 00 reported
  // "disagreed for 0 of 272". If the pairs were repeats the sum would have
  // exceeded PlayHQ's total for roughly a sixth of them. They are counted, and
  // the pair count is reported so a change in it is visible.
  const seen = new Set();
  // "Seasons played" counts SEASONS, not registrations — two clubs in one year is
  // one season. build-player-index.js draws the same distinction and records that
  // getting it wrong made "seasons each" mean something else.
  const sids = new Set();
  let goals = 0, games = 0, best = 0, from = null;
  const byLeague = new Map();
  const bySeasonGoals = [];
  const leagues = new Set();
  const sidLeague = new Map();

  for (const s of seasons) {
    const k = `${s.sid || ''}|${s.clubId || ''}`;
    if (seen.has(k)) dupes.push(`${rec.uuid} ${k}`);   // counted, NOT skipped
    seen.add(k);
    if (s.sid) sids.add(s.sid);
    const g = Number(s.goals) || 0, gp = Number(s.gp) || 0, b = Number(s.best) || 0;
    goals += g; games += gp; best += b;
    const y = String(s.year || '');
    if (y && (!from || y < from)) from = y;
    if (s.leagueId) {
      leagues.add(s.leagueId);
      if (s.sid) sidLeague.set(s.sid, s.leagueId);
      const cur = byLeague.get(s.leagueId) ||
        { name: s.league || null, goals: 0, games: 0, best: 0, from: null, seasons: 0, seasonGoals: 0, held: false };
      cur.goals += g; cur.games += gp; cur.best += b; cur.seasons++;
      if (g > cur.seasonGoals) cur.seasonGoals = g;
      if (y && (!cur.from || y < cur.from)) cur.from = y;
      if (s.held) cur.held = true;
      if (!cur.name && s.league) cur.name = s.league;
      byLeague.set(s.leagueId, cur);
    }
    bySeasonGoals.push({ g, year: y, league: s.league || null });
  }

  // The newest row supplies the club and league a row is labelled with — a
  // leaderboard entry should say where someone plays now, not in 2010.
  const newest = seasons.slice().sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')))[0] || {};
  const bestSeason = bySeasonGoals.slice().sort((a, b) => b.g - a.g)[0] || { g: 0 };

  return {
    uuid: rec.uuid, name: rec.name || null,
    club: newest.club || null, league: newest.league || null,
    goals, games, best, from,
    seasonsCount: sids.size, leaguesCount: leagues.size,
    seasonGoals: bestSeason.g, seasonGoalsYear: bestSeason.year, seasonGoalsLeague: bestSeason.league,
    records: rec.records || {}, sidLeague, byLeague,
  };
}

// ── Ranking ──────────────────────────────────────────────────────────────────
function valueFor(cat, p, scope) {
  // scope === null for all-time; otherwise a leagueId and its aggregate.
  const a = scope ? scope.agg : p;
  switch (cat.key) {
    case 'goals':   return a.goals;
    case 'games':   return scope ? a.games : p.games;
    case 'best':    return a.best;
    case 'goalsPerGame': {
      const gp = scope ? a.games : p.games;
      if (gp < MIN_GP) return null;
      return Math.round((a.goals / gp) * 100) / 100;
    }
    case 'gameGoals': {
      const r = gameRecFor(p, scope);
      return r ? r.v : null;
    }
    case 'seasonGoals': return scope ? a.seasonGoals : p.seasonGoals;
    case 'seasons':     return scope ? a.seasons : p.seasonsCount;
    case 'leagues':     return p.leaguesCount;
    case 'earliest': {
      const y = scope ? a.from : p.from;
      return y ? Number(y) : null;
    }
    default: return null;
  }
}

// ⚠️ A PLAYER HAS TWO GAME RECORDS and only one of them may belong to the league
// being ranked. Lewis Stanton's best anywhere is 14 in the NTFL and his best in a
// season we hold is 11 in the WFNL; taking only `goalsAny` left him absent from
// the WFNL board entirely. Pick whichever record's game was played in that
// league, best first.
function gameRecFor(p, scope) {
  const gr = p.records || {};
  const cands = [gr.goalsAny, gr.goalsHeld].filter(r => r && r.v);
  if (!cands.length) return null;
  const inScope = scope ? cands.filter(r => p.sidLeague.get(r.sid) === scope.leagueId) : cands;
  if (!inScope.length) return null;
  return inScope.sort((a, b) => b.v - a.v)[0];
}

function entryFor(cat, p, v, scope) {
  const e = { uuid: p.uuid, name: p.name, v,
              club: p.club, league: scope ? scope.name : p.league,
              gp: scope ? scope.agg.games : p.games,
              seasons: scope ? scope.agg.seasons : p.seasonsCount };
  if (cat.key === 'gameGoals') {
    const r = gameRecFor(p, scope);
    if (r) { e.gameId = r.gameId || null; e.sid = r.sid || null; }
  }
  if (cat.key === 'seasonGoals') { e.year = p.seasonGoalsYear || null; e.league = p.seasonGoalsLeague || e.league; }
  if (cat.key === 'earliest') e.from = scope ? scope.agg.from : p.from;
  return e;
}

function buildBoards(players, scope) {
  const boards = {};
  for (const cat of CATEGORIES) {
    if (cat.allTimeOnly && scope) continue;
    const rows = [];
    for (const p of players) {
      const sc = scope ? { leagueId: scope.leagueId, name: scope.name, agg: p.byLeague.get(scope.leagueId) } : null;
      if (scope && !sc.agg) continue;
      const v = valueFor(cat, p, sc);
      if (v === null || v === undefined || !v) continue;   // zero is not a record
      rows.push(entryFor(cat, p, v, sc));
    }
    rows.sort((a, b) => cat.dir === 'asc' ? a.v - b.v || String(a.name).localeCompare(String(b.name))
                                          : b.v - a.v || String(a.name).localeCompare(String(b.name)));
    boards[cat.key] = rows.slice(0, N);
  }
  return boards;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  log(`=== ${VERSION} ===`);
  log(`Mode: ${DRY ? 'DRY RUN — nothing will be written' : 'building'}  (top ${N} stored, min ${MIN_GP} games for a rate)`);

  if (!fs.existsSync(PLAYERS)) {
    console.error('FATAL: players/ does not exist. Run Build career stubs and a sweep first.');
    process.exit(1);
  }

  const players = [];
  const dupes = [];
  let files = 0, unreadable = 0, noCareer = 0;
  for (const shard of fs.readdirSync(PLAYERS).sort()) {
    const dir = path.join(PLAYERS, shard);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      files++;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
      catch (e) { unreadable++; continue; }
      const s = summarise(rec, dupes);
      if (!s) { noCareer++; continue; }
      players.push(s);
    }
  }
  log(`files ${files}, ranked ${players.length}, no career yet or a stamped negative ${noCareer}` +
      (unreadable ? `, UNREADABLE ${unreadable}` : ''));
  if (dupes.length) {
    log(`${dupes.length} player(s) hold two rows for one (season, club) — both counted, ` +
        `which matches PlayHQ's own career total. First few:`);
    for (const d of dupes.slice(0, 5)) log('    ' + d);
  }
  if (!players.length) {
    console.error('FATAL: no player carries a career record. Nothing to rank.');
    process.exit(1);
  }

  // ⚠️ THE TRACKED COMPETITIONS ARE DERIVED FROM THE DATA, not from the manifest.
  // A season row's `held` flag was set by the walker against the manifest, so the
  // set of leagueIds appearing on held rows IS this project's competitions — and
  // it needs no manifest field this script has never read.
  const comps = new Map();
  for (const p of players) {
    for (const [id, agg] of p.byLeague) {
      if (!agg.held) continue;
      const cur = comps.get(id) || { leagueId: id, name: agg.name, players: 0 };
      cur.players++;
      if (!cur.name && agg.name) cur.name = agg.name;
      comps.set(id, cur);
    }
  }
  const compList = [...comps.values()].sort((a, b) => b.players - a.players);
  log(`\ncompetitions found on held seasons: ${compList.length}`);
  for (const c of compList) log(`  ${c.leagueId}  ${String(c.players).padStart(6)} player(s)  ${c.name}`);
  if (compList.length !== 5) {
    log(`⚠️ EXPECTED 5. More or fewer means a season is held whose competition is new — not fatal, but look.`);
  }

  const allTime = buildBoards(players, null);
  log(`\n── all-time ──`);
  for (const cat of CATEGORIES) {
    const b = allTime[cat.key] || [];
    const top = b[0];
    log(`  ${String(cat.key).padEnd(13)} ${String(b.length).padStart(3)} entr${b.length === 1 ? 'y' : 'ies'}` +
        (top ? `   leader: ${top.name} ${top.v}${cat.key === 'earliest' ? '' : ''}` : '   (none)'));
  }

  const payload = {
    meta: { version: VERSION, builtAt: new Date().toISOString(), players: players.length,
            n: N, minGp: MIN_GP,
            categories: CATEGORIES.map(c => ({ key: c.key, label: c.label, dir: c.dir })),
            comps: compList.map(c => ({ id: c.leagueId, name: c.name, players: c.players })) },
    boards: allTime,
  };

  const compPayloads = new Map();
  for (const c of compList) {
    const boards = buildBoards(players, { leagueId: c.leagueId, name: c.name });
    compPayloads.set(c.leagueId, {
      meta: { version: VERSION, builtAt: payload.meta.builtAt, leagueId: c.leagueId, name: c.name,
              players: c.players, n: N, minGp: MIN_GP,
              categories: CATEGORIES.filter(x => !x.allTimeOnly).map(x => ({ key: x.key, label: x.label, dir: x.dir })) },
      boards,
    });
    const g = (boards.goals || [])[0];
    log(`  ${String(c.name).padEnd(38)} leader on goals: ${g ? `${g.name} ${g.v}` : '(none)'}`);
  }

  const size = (o) => JSON.stringify(o).length;
  const total = size(payload) + [...compPayloads.values()].reduce((n, o) => n + size(o), 0);
  log(`\nall-time ${(size(payload) / 1024).toFixed(1)} KB, ${compPayloads.size} competition file(s), ${(total / 1024).toFixed(1)} KB total`);

  if (DRY) { log('\nDRY RUN — nothing written.'); process.exit(0); }

  // ⚠️ WRITE ONLY IF THE DATA CHANGED, IGNORING builtAt.
  // The design says "rewrite everything and let git decide whether there is a
  // commit" — which git cannot do while a timestamp moves on every run. Measured:
  // a second run over identical data still produced a two-file diff, so every
  // build would commit noise and the history would say nothing.
  // build-player-index.js takes the same line for the same reason.
  //
  // The comparison strips builtAt and version from BOTH sides, because an older
  // file may not carry the field at all.
  const stripped = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    if (c.meta) { delete c.meta.builtAt; delete c.meta.version; }
    return JSON.stringify(c);
  };
  const writeIfChanged = (file, obj) => {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new file */ }
    if (prev && stripped(prev) === stripped(obj)) return false;
    fs.writeFileSync(file, JSON.stringify(obj));
    return true;
  };
  fs.mkdirSync(OUT_COMP, { recursive: true });
  let written = 0;
  if (writeIfChanged(path.join(OUT_DIR, 'all-time.json'), payload)) written++;
  for (const [id, o] of compPayloads) {
    if (writeIfChanged(path.join(OUT_COMP, `${id}.json`), o)) written++;
  }
  // A competition that disappears would otherwise leave a stale board behind.
  for (const f of fs.readdirSync(OUT_COMP)) {
    const id = f.replace(/\.json$/, '');
    if (f.endsWith('.json') && !compPayloads.has(id)) {
      fs.unlinkSync(path.join(OUT_COMP, f));
      log(`removed stale board ${f}`);
    }
  }
  log(written
    ? `\nWrote ${written} of ${compPayloads.size + 1} board file(s); the rest were unchanged.`
    : `\nEvery board is unchanged — nothing written, so there is nothing to commit.`);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
