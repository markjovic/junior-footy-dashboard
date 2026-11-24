#!/usr/bin/env node
// scripts/build-transfers.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'build-transfers v10 2026-11-24 grade-stats-and-last-season';

//
// Builds data/transfers.json: every player who has changed club, from two
// sources. READ-ONLY against PlayHQ — no session, no API call. The only thing it
// writes is its own file.
//
// ⚠️ TWO KINDS OF TRANSFER, AND THE SECOND NEEDS NO FETCH AT ALL.
//
//   between-season  a registration whose season STARTS AFTER the player's
//                   current season ENDS. From registrations.json.gz, which the
//                   walk fills in. Only as complete as the walk is.
//
//   in-season       a player with games for TWO DIFFERENT CLUBS inside one
//                   season. Computed from the per-game lines and the match
//                   records already committed, for every season we hold. This
//                   half is historical and complete on the day it first runs.
//
// ⚠️ ITS OWN FILE, ITS OWN WRITER. data/transfers.json is written here and
// nowhere else. It does NOT go through store.save, which writes whole season
// files and would need every other writer re-read first.
//
// ⚠️ TWO CLUBS IS NOT ALWAYS A TRANSFER. Three cases that are not, and how each
// is handled:
//   the same club spelled two ways  -> compared by club ID, never by name
//   two teams of the same club      -> same ID, so not a move
//   a fill-in or a permit           -> see below. Game count alone does not
//                                      separate these, so the dates do it.
//
// ⚠️ GAME COUNT DOES NOT SEPARATE A FILL-IN FROM A MOVE. Measured 2026-11-20 over
// 889 moves: the distribution of games at the smaller club decays smoothly —
// 342 at one game, 152 at two, 106, 97, 72, 54 — with NO gap anywhere. Any
// threshold on it is arbitrary, and 494 of 889 landed on the wrong side of an
// arbitrary line.
//
// The DATES separate them, and they were already being collected:
//
//   a real move   every game at the old club comes BEFORE every game at the new
//                 one. The spells do not overlap.
//   a fill-in     the spells INTERLEAVE — a game for another club in the middle
//                 of a season, then back again.
//
// `overlap` is the number of days the two spells share. Zero means a clean
// switch; anything above zero means the player was turning out for both, which
// is a permit, not a transfer. The game count is kept as a second opinion and
// both are in the output.
//
// ⚠️ IT ALSO WRITES data/rosters.json.gz. season -> club -> team -> players,
// merged from the games already read here and from the tracked registrations
// the walk files. Registration and game rosters MERGE rather than replace, so
// a player who has signed but not yet played stays visible; where both place
// the same player in one season, the GAME wins, which is how a mid-season move
// surfaces without anyone asking PlayHQ a second question.
//
// ⚠️ ROSTERS COVER THE CURRENT AND THE NEXT SEASON, NOT ALL OF HISTORY.
// v6 harvested a played row from whatever season the in-season loop happened
// to be reading, which was all 22. Measured on the first real run,
// 2026-11-24: 160,920 played rows, 5,142 KB gzipped and 13,880 KB plain —
// a 5 MB download before the reader sees a single name, re-committed on every
// walk. Historical played-season rosters were explicitly out of scope for v1;
// they were in the file by accident, not by design. v7 keeps, per competition,
// the LATEST season that has actually been played plus every season that has
// not been played yet, which is the scope that was agreed.
//
// Env: TR_MIN_GAMES (default 3), TR_OUT (data/transfers.json),
//      TR_ROSTERS_OUT (data/rosters.json.gz), TR_DRY (print only, write
//      nothing), TR_ROSTER_ALL (true = every season, for a one-off history
//      build; it is not what the page wants).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');


const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const OUT_PATH = path.join(ROOT, process.env.TR_OUT || 'data/transfers.json');
// ⚠️ GZIP, like registrations and for the same reason. Once most of the cohort
// holds a next-season registration this is the better part of 2 MB plain, and
// it is committed on every walk. The page decompresses it with
// DecompressionStream exactly as it already does for registrations. Cost: it is
// not readable in the GitHub web UI — the run log prints the counts.
const ROSTERS_PATH = path.join(ROOT, process.env.TR_ROSTERS_OUT || 'data/rosters.json.gz');
const MIN_GAMES = Math.max(1, Number(process.env.TR_MIN_GAMES || 3));
const ROSTER_ALL = /^(1|true|yes)$/i.test(process.env.TR_ROSTER_ALL || '');
const DRY = /^(1|true|yes)$/i.test(process.env.TR_DRY || '');

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
const splitSeason = (s) => {
  const str = String(s || '').trim();
  const m = str.match(/^(.*?)\s*\b(20\d\d)\b\s*$/);
  return m ? { comp: m[1].trim(), year: m[2] } : { comp: str, year: '' };
};

// ⚠️ NEVER new Date(string). Split and use Date.UTC.
function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
}

// ⚠️ THE AGE ON A NEXT-SEASON REGISTRATION ROW WAS A YEAR OUT OF DATE. It came
// from playerInfo, which is the player's age in the season they last PLAYED —
// so a 2027 registration showed U12 for a child who will be U13. The team name
// PlayHQ assigned carries the real one ("Balwyn U13 Blue"), and that is the age
// the reader wants, so it is parsed from there and the stale value is used only
// when the name has no age in it.
function ageFromTeam(team) {
  const m = /\bU(\d{1,2})(?:\.\d+)?\b/i.exec(String(team || ''));
  return m ? `U${m[1]}` : '';
}
// Sort key for an age group. "U9" must come before "U10"; a plain string sort
// puts it after, which is how a roster list ends up reading U10, U11, U9.
function ageRank(a) {
  const m = /^U(\d{1,2})/i.exec(String(a || ''));
  return m ? Number(m[1]) : 999;      // anything unparsed sorts last, not first
}

// Whether a season has been PLAYED, asked without reading the file. A season
// with no per-game lines has no games in it — which is the normal state of a
// season whose registrations are open and whose first bounce is in April.
function hasLines(sid) {
  return fs.existsSync(path.join(store.SEASONS_DIR, `${sid}-lines.json.gz`));
}

function loadLines(sid) {
  const p = path.join(store.SEASONS_DIR, `${sid}-lines.json.gz`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }
  catch (e) { console.error(`  ⚠️ ${path.basename(p)}: ${e.message}`); return null; }
}

function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log(`fill-in line: a club with fewer than ${MIN_GAMES} game(s) is flagged, not dropped.`);
  if (DRY) log('DRY RUN — nothing will be written.\n'); else log('');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  if (!manifest.length) die('no seasons in the manifest.');
  const teamClub = core.teamClub || {};
  const clubs = core.clubs || {};
  const byId = new Map(manifest.map(m => [m.seasonId, m]));
  const clubLabel = (id) => (clubs[id] && (clubs[id].name || clubs[id])) || id || '(club unknown)';

  // ── Club resolution ────────────────────────────────────────────────────────
  // ⚠️ teamClub IS KEYED comp|team|age (results-engine.js). If that key does not
  // resolve, EVERY in-season figure below is zero and looks like "no transfers
  // happened". The miss rate is counted and reported loudly for exactly that
  // reason — a silent zero here is the worst possible outcome.
  let lookupHit = 0, lookupMiss = 0;
  const missExamples = [];
  function clubOf(comp, team, age) {
    if (!team) return null;
    for (const k of [`${comp}|${team}|${age}`, `${comp}|${team}|`, `${comp}|${team}`]) {
      if (teamClub[k]) { lookupHit++; return teamClub[k]; }
    }
    lookupMiss++;
    if (missExamples.length < 5) missExamples.push(`${comp}|${team}|${age}`);
    return null;
  }

  // ── In-season ──────────────────────────────────────────────────────────────
  const inSeason = [];
  // ⚠️ CAPTURED AS THE SEASONS ARE READ. A lead needs the player's age and team,
  // and those live in the per-season player files that this loop already opens.
  // Reaching for a `prev` map copied from report-transfers.js is what broke the
  // first version — the name existed there, not here.
  const playerInfo = new Map();   // uuid -> { age, team }

  // ── Rosters ─────────────────────────────────────────────────────────────────
  // season -> club -> team -> [{ u, n, a, s }]; s is 'p' played or 'r'
  // registered. `rosters.md` in the design: the registration roster is NOT
  // replaced when games start — the two MERGE, so a player who signed but has
  // not played yet stays visible instead of vanishing until round one.
  //
  // ⚠️ GAME-DERIVED WINS PLACEMENT. "Who they turned out for" beats "who they
  // signed with", so a mid-season move surfaces from the games by itself. The
  // conflict is resolved per (season, player): once a played row exists for
  // someone in a season, a registered row for that season is dropped rather
  // than listing them at two clubs.
  const rosters = new Map();          // sid -> Map(clubId -> Map(teamKey -> Map(uuid -> row)))
  const placed = new Set();           // `${sid}|${uuid}` already placed by a GAME
  const TEAM_NONE = '';               // the club's unassigned list
  let rosterPlayed = 0, rosterRegistered = 0, rosterConflicts = 0, rosterOutOfScope = 0;

  // ── WHICH SEASONS GET A ROSTER ────────────────────────────────────────────
  // Per competition: the latest season that has been PLAYED, plus every
  // non-retired season that has not been played yet. In November that is the
  // 2026 season just finished and the 2027 season taking registrations — the
  // two a reader can do anything with. Returns null when the gate is off.
  // ⚠️ `retired` DOES NOT MEAN THE SEASON WAS NEVER PLAYED. v7 skipped every
  // retired season and shipped a rosters file with ZERO played rows: 161,147
  // skipped, all 18 played seasons gone, 3 of 21 kept. `retired` means the
  // season is no longer walked or fetched, which is true of every season that
  // has finished — it says nothing about whether games happened in it. The
  // continuity half of this file is precisely the season that WAS played, so
  // the flag is now consulted only where it means something: a future season
  // belonging to an organisation we have stopped following.
  //
  // The per-competition choice is PRINTED below rather than assumed. v7 looked
  // correct in its own summary line while being completely wrong about what it
  // had chosen, and a scope rule that cannot be checked from the log is a rule
  // that fails silently.
  function pickRosterSeasons() {
    if (ROSTER_ALL) return null;
    const keep = new Set();
    const latestPlayed = new Map();   // competition, no year -> manifest entry
    const withLines = [];
    let retiredFuture = 0;
    // startDate, then compName, then seasonId — so the choice is the same on
    // every run whatever order the manifest happens to be in.
    const rank = (x) => `${x.startDate || ''}|${x.compName || ''}|${x.seasonId}`;
    for (const m of manifest) {
      if (!hasLines(m.seasonId)) {
        // Not played yet. THIS is where retirement means something: a dead
        // organisation's future season is not a roster anyone wants.
        if (m.retired) { retiredFuture++; continue; }
        keep.add(m.seasonId);
        continue;
      }
      withLines.push(m);
      const comp = splitSeason(m.compName).comp;
      const cur = latestPlayed.get(comp);
      if (!cur || rank(m) > rank(cur)) latestPlayed.set(comp, m);
    }
    for (const m of latestPlayed.values()) keep.add(m.seasonId);
    return { keep, latestPlayed, withLines, retiredFuture };
  }
  const rosterScope = pickRosterSeasons();
  const rosterSeasons = rosterScope ? rosterScope.keep : null;

  const teamAges = new Map();         // `${sid}|${club}|${team}` -> Map(age -> n)
  const teamGrades = new Map();       // `${sid}|${club}|${team}` -> grade label
  // ⚠️ THE PLAYER'S LAST PLAYED SEASON, chosen by DATE and not by whichever
  // season the manifest loop reached first. A next-season registration row is
  // nearly useless without it — "who is this child" is answered by where they
  // played last year, how many games and how many goals.
  const lastPlayed = new Map();       // uuid -> { y, comp, club, team, age, gp, goals }
  function rosterAdd(sid, club, team, uuid, name, age, source, stats) {
    if (!sid || !club || !uuid) return;
    // Before placed.add, so a season outside the scope leaves no trace at all
    // rather than a conflict marker nothing will ever read. It cannot suppress
    // another season's registration either way — `placed` is keyed by season
    // as well as player — but dead state in a Set that decides what is dropped
    // is not worth leaving behind.
    if (rosterSeasons && !rosterSeasons.has(sid)) { rosterOutOfScope++; return; }
    const key = `${sid}|${uuid}`;
    if (source === 'played') placed.add(key);
    else if (placed.has(key)) { rosterConflicts++; return; }

    if (!rosters.has(sid)) rosters.set(sid, new Map());
    const byClub = rosters.get(sid);
    if (!byClub.has(club)) byClub.set(club, new Map());
    const byTeam = byClub.get(club);
    const tk = team || TEAM_NONE;
    if (!byTeam.has(tk)) byTeam.set(tk, new Map());
    const byUuid = byTeam.get(tk);
    // The team name beats the carried-over age for a registration; for a
    // played row the carried age IS that season's, so it wins.
    const rowAge = source === 'played' ? (age || ageFromTeam(team))
                                       : (ageFromTeam(team) || age || '');
    if (byUuid.has(uuid)) return;
    const row = { u: uuid, n: name || null, a: rowAge, s: source === 'played' ? 'p' : 'r' };
    // Omitted rather than written as 0/null when unknown: 40,000 rows carrying
    // four empty fields is a quarter of the file saying nothing.
    if (stats && stats.gp) row.gp = stats.gp;
    if (stats && stats.goals) row.gl = stats.goals;
    if (source !== 'played') {
      const lp = lastPlayed.get(uuid);
      if (lp) {
        row.p = { y: lp.comp, c: lp.club || '', t: lp.team || '' };
        if (lp.gp) row.p.gp = lp.gp;
        if (lp.goals) row.p.gl = lp.goals;
      }
    }
    byUuid.set(uuid, row);
    if (tk !== TEAM_NONE && rowAge) {
      const ak = `${sid}|${club}|${tk}`;
      if (!teamAges.has(ak)) teamAges.set(ak, new Map());
      const tally = teamAges.get(ak);
      tally.set(rowAge, (tally.get(rowAge) || 0) + 1);
    }
    if (source === 'played') rosterPlayed++; else rosterRegistered++;
  }
  const gamesHistogram = new Map();   // games at the smaller club -> count
  const overlapHistogram = new Map(); // clean | interleaved | undated -> count
  let seasonsWithLines = 0, seasonsWithout = [];

  for (const m of manifest) {
    const f = loadLines(m.seasonId);
    if (!f) { seasonsWithout.push(m.compName); continue; }
    seasonsWithLines++;

    let md = new Map(), players = new Map(), roster = {};
    try {
      const d = store.load([m.compName], { players: true });
      roster = d.roster || {};
      for (const r of (d.matches || [])) if (r.gameId) md.set(r.gameId, r);
      for (const p of (d.players || [])) {
        if (!p || !p.uuid) continue;
        // ⚠️ ONE RECORD PER GRADE. A child in two teams has two records, so
        // games and goals are SUMMED; taking the first record understates
        // anyone who played up an age, which is exactly the player a roster
        // reader is curious about.
        let agg = players.get(p.uuid);
        if (!agg) { agg = { name: p.name, age: p.age, gp: 0, goals: 0, team: '', bestGp: -1 }; players.set(p.uuid, agg); }
        agg.gp += (p.gp || 0);
        agg.goals += (p.goals || 0);
        // The team they played MOST for, not the first one listed.
        if ((p.gp || 0) > agg.bestGp) {
          agg.bestGp = p.gp || 0;
          agg.team = p.teamRaw || p.team || '';
          agg.club = p.team || '';
          if (p.age) agg.age = p.age;
        }
        if (!playerInfo.has(p.uuid)) {
          playerInfo.set(p.uuid, { age: p.age || '', team: p.teamRaw || p.team || '' });
        }
      }
      // ⚠️ LATEST YEAR FIRST, THEN MOST GAMES — not latest startDate. A player
      // in two competitions in the SAME year was decided by whichever league
      // happened to open its season later in the calendar, which is arbitrary
      // and picked the wrong club for anyone whose second competition was a
      // handful of games. The year comes from the season NAME; a season's
      // startDate precedes the year in its name and must never yield one.
      const y = yearOf(m.compName);
      for (const [u, agg] of players) {
        const prev = lastPlayed.get(u);
        if (!prev || y > prev.y || (y === prev.y && agg.gp > prev.gp)) {
          lastPlayed.set(u, { y, comp: m.compName, club: agg.club || '', team: agg.team || '',
                              age: agg.age || '', gp: agg.gp, goals: agg.goals });
        }
      }
    } catch (e) { console.error(`  ⚠️ ${m.compName}: ${e.message}`); continue; }

    // ⚠️ GRADE IS STORED, AND NOT ON THE PLAYER. `roster` is keyed
    // comp|team|age — the same key shape clubOf uses — and holds
    // { grade, age, compName, gradeId? }. It is the league's grade for that
    // team in that season, which is what "show me every team in this grade"
    // needs; the team NAME ("Heathmont U12 Girls") is not a grade.
    const gradeOf = (comp, team, age) => {
      if (!team) return '';
      for (const k of [`${comp}|${team}|${age}`, `${comp}|${team}|`, `${comp}|${team}`]) {
        const r = roster[k];
        if (r && r.grade) return String(r.grade);
      }
      return '';
    };

    const uuidAt = (i) => { const pp = (f.players || [])[i]; return (pp && pp[0]) || null; };
    const nameAt = (i) => { const pp = (f.players || [])[i]; return (pp && pp[1]) || null; };

    // uuid -> Map(clubId -> { games, first, last, team })
    const seen = new Map();
    for (const gid of Object.keys(f.games || {})) {
      const g = f.games[gid];
      if (!g || g.n) continue;
      const rec = md.get(gid) || {};
      const day = dayNum(rec.date);
      for (const [side, teamName] of [['h', rec.home], ['a', rec.away]]) {
        const club = clubOf(m.compName, teamName, rec.age);
        if (!club) continue;
        for (const row of (g[side] || [])) {
          const u = uuidAt(row[0]);
          if (!u) continue;
          if (!seen.has(u)) seen.set(u, new Map());
          const cm = seen.get(u);
          let e = cm.get(club);
          if (!e) { e = { games: 0, first: day, last: day, team: teamName, age: rec.age || '' }; cm.set(club, e); }
          e.games++;
          if (day !== null) {
            if (e.first === null || day < e.first) e.first = day;
            if (e.last === null || day > e.last) e.last = day;
          }
        }
      }
    }

    // ── Rosters, the PLAYED half ───────────────────────────────────────────
    // ⚠️ THIS IS `seen` BEFORE IT IS FILTERED TO TRANSFERS. The loop below
    // keeps only players with two or more clubs; a roster wants every player
    // at every club, so it is harvested here rather than recomputed.
    //
    // Only players whose team resolved to a club appear — the same
    // comp|team|age lookup, and the same miss count reported above. A roster
    // built on a 20% miss rate would be quietly short of a fifth of its
    // players, which is why that figure is printed loudly.
    for (const [u, cm] of seen) {
      for (const [club, e] of cm) {
        const agg = players.get(u) || {};
        rosterAdd(m.seasonId, club, e.team || null, u,
          agg.name || null, agg.age || '', 'played', { gp: agg.gp, goals: agg.goals });
        if (e.team) {
          const gk = `${m.seasonId}|${club}|${e.team}`;
          if (!teamGrades.has(gk)) {
            const g = gradeOf(m.compName, e.team, e.age || agg.age || '');
            if (g) teamGrades.set(gk, g);
          }
        }
      }
    }

    for (const [u, cm] of seen) {
      if (cm.size < 2) continue;
      // Order by when they first appeared, so "from" and "to" are the real
      // direction rather than whatever order the games were iterated in.
      const order = [...cm.entries()].sort((a, b) =>
        (a[1].first === null ? Infinity : a[1].first) - (b[1].first === null ? Infinity : b[1].first));
      const info = players.get(u) || {};
      const sm = splitSeason(m.compName);
      for (let i = 1; i < order.length; i++) {
        const [fromId, fromE] = order[i - 1], [toId, toE] = order[i];
        const smaller = Math.min(fromE.games, toE.games);
        gamesHistogram.set(smaller, (gamesHistogram.get(smaller) || 0) + 1);
        // Days the two spells share. null when either side has no dated game —
        // unknown, which is not the same as zero and must not be read as one.
        // ⚠️ THE SIGN IS THE SIGNAL, NOT THE MAGNITUDE. A `Math.max(0, …)` here
        // read a ONE-DAY intersection as zero and called a permit a clean switch:
        // a single Vermont game sitting in the middle of a Norwood season gives
        // min(last) - max(first) === 0, which is an overlap of one day, not none.
        // Negative means the spells do not meet at all; 0 or more means they do.
        let overlap = null;
        if (fromE.first !== null && fromE.last !== null && toE.first !== null && toE.last !== null) {
          overlap = Math.min(fromE.last, toE.last) - Math.max(fromE.first, toE.first);
        }
        const verdict = overlap === null ? 'undated' : (overlap >= 0 ? 'interleaved' : 'clean');
        overlapHistogram.set(verdict, (overlapHistogram.get(verdict) || 0) + 1);
        inSeason.push({
          kind: 'in-season',
          uuid: u, name: info.name || nameAt(0) || '(unnamed)', age: info.age || '',
          comp: sm.comp, year: sm.year, seasonId: m.seasonId,
          fromClub: fromId, fromClubName: clubLabel(fromId), fromTeam: fromE.team, fromGames: fromE.games,
          toClub: toId, toClubName: clubLabel(toId), toTeam: toE.team, toGames: toE.games,
          // Present on every row so the two kinds share one shape; an in-season
          // move has no destination SEASON, it is the same one.
          toComp: '', toYear: '',
          orgKind: '', fromComp: sm.comp, fromYear: sm.year,
          overlapDays: overlap,
          // ⚠️ THE DATES DECIDE, the game count only reinforces. An undated pair
          // falls back to the count, which is the best available and is marked as
          // such by overlapDays being null.
          possibleFillIn: overlap === null ? smaller < MIN_GAMES : overlap >= 0,
          fewGames: smaller < MIN_GAMES,
        });
      }
    }
  }

  log('── in-season ──');
  log(`  seasons with per-game lines : ${seasonsWithLines}`);
  if (seasonsWithout.length) {
    log(`  seasons WITHOUT lines       : ${seasonsWithout.length} — no in-season move can be seen in them:`);
    for (const c of seasonsWithout) log(`      ${c}`);
  }
  log(`  club lookups                : ${lookupHit} resolved, ${lookupMiss} unresolved`);
  const missRate = lookupHit + lookupMiss ? lookupMiss / (lookupHit + lookupMiss) : 0;
  if (missRate > 0.2) {
    log('  ⚠️ MORE THAN A FIFTH OF TEAMS DID NOT RESOLVE TO A CLUB. Every in-season');
    log('     figure below is therefore a FLOOR and may be near-meaningless. The key');
    log('     is comp|team|age; these are the ones that missed:');
    for (const k of missExamples) log(`       ${k}`);
    log('     Fix the key before trusting any number here.');
  }
  log(`  moves found                 : ${inSeason.length}` +
    ` (${inSeason.filter(x => x.possibleFillIn).length} flagged as a possible fill-in)`);

  if (overlapHistogram.size) {
    const c = overlapHistogram.get('clean') || 0, i = overlapHistogram.get('interleaved') || 0,
      u = overlapHistogram.get('undated') || 0;
    log('\n  by whether the two spells OVERLAP — this is what decides a fill-in:');
    log(`    clean switch (old club finished before the new one started) : ${c}`);
    log(`    interleaved  (turning out for both — a permit, not a move)  : ${i}`);
    log(`    undated      (fell back to the game count)                  : ${u}`);
  }

  if (gamesHistogram.size) {
    log('\n  games at the SMALLER of the two clubs — choose the fill-in line here:');
    for (const k of [...gamesHistogram.keys()].sort((a, b) => a - b)) {
      const n = gamesHistogram.get(k);
      log(`    ${String(k).padStart(3)} game(s): ${String(n).padStart(5)}  ${'#'.repeat(Math.min(60, n))}`);
    }
    log(`  TR_MIN_GAMES is ${MIN_GAMES}; it now only decides UNDATED pairs — the`);
    log('  dates decide the rest. Kept in the output as `fewGames` either way.');
  }

  // ── Between-season ─────────────────────────────────────────────────────────
  const between = [];
  let walked = 0, notWalked = 0, staleCheck = 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const nextStamps = manifest.filter(m => yearOf(m.compName) === latest)
    .map(m => m.stateAt).filter(Boolean).sort();
  const cutoff = nextStamps.length ? nextStamps[0] : null;

  if (!fs.existsSync(REG_PATH)) {
    log('\n── between-season ──');
    log('  data/registrations.json.gz does not exist — walk-registrations has never run.');
    log('  The in-season half above stands on its own; this half is simply absent.');
  } else {
    const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
    const people = reg.players || {};
    for (const [uuid, r] of Object.entries(people)) {
      if (!r.at) { notWalked++; continue; }
      // ⚠️ CHECKED BEFORE THE NEXT SEASON EXISTED IS NOT "NO REGISTRATION". Until
      // discovery recorded the next seasons, a real registration was filed as
      // `other`. Those players are unknown, not negative.
      if (cutoff && r.at < cutoff) { staleCheck++; continue; }
      walked++;
      const from = r.from || {};
      for (const t of (r.tracked || [])) {
        // ⚠️ THE ROSTER TAKES EVERY TRACKED REGISTRATION, the transfer list only
        // the ones that CHANGE CLUB. A player re-signing with their own club is
        // not a transfer and is skipped below — but they are still on that
        // club's roster, and leaving them off would make every roster look like
        // a list of departures.
        rosterAdd(t.seasonId, t.club, t.team || null, uuid,
          r.name || null, (playerInfo.get(uuid) || {}).age || '', 'registered');
        if (!t.club || !from.club || t.club === from.club) continue;
        const fs2 = splitSeason(from.compName);
        const ts = splitSeason((byId.get(t.seasonId) || {}).compName || t.compName || '');
        between.push({
          // ⚠️ AGE AND TEAM COME FROM THE SEASON FILES, not from the registration.
          // A between-season row carried age:'' and fromTeam:'' — so grouping or
          // filtering by grade silently dropped every one of them, which looks
          // like "there are no U12 transfers" rather than "this row has no age".
          kind: 'between', uuid, name: r.name,
          age: (playerInfo.get(uuid) || {}).age || '',
          comp: fs2.comp, year: fs2.year, seasonId: from.seasonId,
          fromClub: from.club, fromClubName: from.clubName || clubLabel(from.club),
          fromTeam: (playerInfo.get(uuid) || {}).team || '', fromGames: null,
          toClub: t.club, toClubName: t.clubName || clubLabel(t.club),
          toTeam: t.team || '', toGames: null,
          toComp: ts.comp, toYear: ts.year,
          // ⚠️ PRESENT AND null, NOT ABSENT. Every row carries every field, so a
          // reader never sees `undefined` from half the file — adding nulls to an
          // array once blanked the whole page because one reader destructured
          // every element.
          overlapDays: null, fewGames: false,
          possibleFillIn: false,
          orgKind: '', fromComp: fs2.comp, fromYear: fs2.year,
        });
      }
    }
    log('\n── between-season ──');
    log(`  judged : ${walked}`);
    log(`  checked before the ${latest} seasons were known : ${staleCheck}`);
    log(`  never checked                                   : ${notWalked}`);
    log(`  moves found : ${between.length}`);
    if (staleCheck + notWalked > 0) {
      log(`  ⚠️ ${staleCheck + notWalked} player(s) are UNKNOWN, not "stayed". This count is a FLOOR`);
      log('     until the walk reaches them.');
    }
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  // ── Leads ──────────────────────────────────────────────────────────────────
  // ⚠️ ONLY WHERE WE HOLD NOTHING. A lastOrg naming a club that is already in
  // `tracked` restates a registration we found by the normal route; emitting it
  // would double-count the same move under two kinds.
  const leads = [];
  let leadsSkippedKnown = 0, leadsSkippedEvent = 0, leadsUnknownOrg = 0;
  let orgs = {};
  const ORG_PATH = path.join(ROOT, 'data', 'organisations.json');
  if (fs.existsSync(ORG_PATH)) {
    try { orgs = (JSON.parse(fs.readFileSync(ORG_PATH, 'utf8')).organisations) || {}; }
    catch (e) { console.error(`  ⚠️ organisations.json unreadable: ${e.message}`); }
  }
  if (fs.existsSync(REG_PATH)) {
    const reg2 = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
    for (const [uuid, r] of Object.entries(reg2.players || {})) {
      const lo = r.lastOrg;
      const from = r.from || {};
      if (!r.at || !lo || !lo.id || !from.club || lo.id === from.club) continue;
      if ((r.tracked || []).length) { leadsSkippedKnown++; continue; }
      const kind = (orgs[lo.id] && orgs[lo.id].kind) || 'unknown';
      // ⚠️ A CARNIVAL IS NOT A MOVE. An organisation that runs Nines and nothing
      // else is a second registration alongside a normal season.
      if (kind === 'event') { leadsSkippedEvent++; continue; }
      if (kind === 'unknown') leadsUnknownOrg++;
      const f = splitSeason(from.compName);
      leads.push({
        kind: 'lead',
        uuid, name: r.name, age: (playerInfo.get(uuid) || {}).age || '',
        // ⚠️ NO SEASON AND NO YEAR, deliberately. A lead cannot be placed in time
        // and the view must not be able to imply otherwise.
        comp: '', year: '', seasonId: from.seasonId,
        fromClub: from.club, fromClubName: from.clubName || clubLabel(from.club),
        fromTeam: (playerInfo.get(uuid) || {}).team || '', fromGames: null,
        toClub: lo.id, toClubName: lo.name || clubLabel(lo.id),
        toTeam: '', toGames: null,
        toComp: (orgs[lo.id] && orgs[lo.id].competitions && orgs[lo.id].competitions[0]
          && orgs[lo.id].competitions[0].name) || '', toYear: '',
        orgKind: kind, fromComp: f.comp, fromYear: f.year,
        overlapDays: null, fewGames: false, possibleFillIn: false,
      });
    }
  }
  log('\n── leads ──');
  log(`  the club PlayHQ now lists them at, where we hold nothing : ${leads.length}`);
  log(`    of those, the organisation is not profiled yet         : ${leadsUnknownOrg}`);
  log(`  skipped, already covered by a tracked registration       : ${leadsSkippedKnown}`);
  log(`  skipped, destination runs carnivals rather than a season : ${leadsSkippedEvent}`);
  log('  ⚠️ NOT TRANSFERS. No season, no date — they say only that PlayHQ now');
  log('     lists the player somewhere else, and are never counted as moves.');

  const out = {
    version: 1,
    builtAt: new Date().toISOString(),
    minGames: MIN_GAMES,
    coverage: {
      seasonsWithLines, seasonsWithoutLines: seasonsWithout,
      clubLookupsResolved: lookupHit, clubLookupsUnresolved: lookupMiss,
      betweenJudged: walked, betweenUnknown: staleCheck + notWalked,
    },
    transfers: [...inSeason, ...between, ...leads],
  };
  out.coverage.leads = leads.length;
  out.coverage.leadsUnknownOrg = leadsUnknownOrg;
  log(`\n  total rows: ${out.transfers.length} (${inSeason.length} in-season, ` +
    `${between.length} between-season, ${leads.length} lead)`);

  // ── Rosters: serialise and report ──────────────────────────────────────────
  const rosterOut = { version: 1, builtAt: out.builtAt, seasons: {} };
  let rClubs = 0, rTeams = 0, rUnassigned = 0;
  for (const [sid, byClub] of rosters) {
    const m = byId.get(sid) || {};
    const season = { compName: m.compName || null, startDate: m.startDate || null, endDate: m.endDate || null, clubs: {} };
    for (const [club, byTeam] of byClub) {
      rClubs++;
      const c = { name: clubLabel(club), teams: {}, teamAge: {}, teamGrade: {}, unassigned: [] };
      for (const [team, byUuid] of byTeam) {
        // ⚠️ SORTED, so the committed file does not churn. An unsorted Map
        // iteration reorders rows whenever the input order shifts, and every
        // nightly commit would then be a whole-file diff of nothing.
        //
        // ⚠️ CASE-INSENSITIVELY. The stored names are whatever PlayHQ holds —
        // "BEN JONES" beside "ava smith" — and a plain localeCompare put every
        // upper-case name in a block of its own ahead of the rest, which on
        // screen reads as a list that is not sorted at all.
        const rows = [...byUuid.values()].sort((a, b) =>
          String(a.n || '').toLowerCase().localeCompare(String(b.n || '').toLowerCase()) ||
          a.u.localeCompare(b.u));
        if (team === TEAM_NONE) { c.unassigned = rows; rUnassigned += rows.length; }
        else {
          c.teams[team] = rows;
          // The age the team's own players agree on, most common wins. Stored
          // per team so the page can order by age without parsing names, and
          // so a team whose name omits the age still sorts with its peers.
          const tally = teamAges.get(`${sid}|${club}|${team}`);
          let best = '', bestN = 0;
          if (tally) for (const [a, nn] of tally) if (nn > bestN) { bestN = nn; best = a; }
          if (best) c.teamAge[team] = best;
          const g = teamGrades.get(`${sid}|${club}|${team}`);
          if (g) c.teamGrade[team] = g;
          rTeams++;
        }
      }
      season.clubs[club] = c;
    }
    rosterOut.seasons[sid] = season;
  }

  log('\n── rosters ──');
  if (rosterScope) {
    const { latestPlayed, withLines, retiredFuture } = rosterScope;
    const chosen = new Set([...latestPlayed.values()].map(m => m.seasonId));
    log('  scope: the latest PLAYED season per competition, plus every season not');
    log(`         played yet — ${rosterSeasons.size} of ${manifest.length} season(s).`);
    log('  seasons WITH per-game lines, and which one each competition chose:');
    withLines.slice().sort((a, b) => String(a.compName).localeCompare(String(b.compName)))
      .forEach(m => log(`      ${chosen.has(m.seasonId) ? '->' : '  '} ` +
        `${pad(m.compName, 14)} ${pad(m.startDate || '(no start date)', 12)}` +
        `${m.retired ? '  retired' : ''}`));
    const future = [...rosterSeasons].filter(sid => !chosen.has(sid))
      .map(sid => (byId.get(sid) || {}).compName).filter(Boolean).sort();
    log(`  seasons not played yet, kept in full : ${future.length}` +
      (future.length ? ` — ${future.join(', ')}` : ''));
    if (retiredFuture) log(`  not-yet-played seasons dropped as retired : ${retiredFuture}`);
    log(`  rows skipped as out of scope : ${rosterOutOfScope}` +
      (rosterOutOfScope ? '  (set TR_ROSTER_ALL=true for every season)' : ''));
    // ⚠️ THE FAILURE v7 SHIPPED, NAMED — and tested against the OUTCOME, not
    // against the scope rule. `!latestPlayed.size` could never be true once
    // the rule was fixed, so it would have been an unreachable branch
    // pretending to be a safety net. No played row in the finished file is
    // the symptom that matters, and it catches a collapsed scope rule and a
    // total comp|team|age lookup failure alike.
    if (withLines.length && !rosterPlayed) {
      log(`  ⚠️ ${withLines.length} SEASON(S) HAVE PER-GAME LINES AND NOT ONE PLAYED ROW`);
      log('     REACHED THE FILE. Every roster below is registrations only and the');
      log('     continuity half is missing. This is a fault, not a quiet season.');
    }
  } else {
    log('  ⚠️ TR_ROSTER_ALL IS SET — every season in the manifest. This is a');
    log('     one-off history build and is far larger than the page wants.');
  }
  log(`  seasons ${rosters.size}, clubs ${rClubs}, teams ${rTeams}`);
  log(`  players: ${rosterPlayed} from games (source p), ${rosterRegistered} from registrations (source r)`);
  log(`  registered with no team assigned yet : ${rUnassigned}`);
  log(`  registrations dropped because a GAME already placed that player : ${rosterConflicts}`);
  log('  ⚠️ THE TWO HALVES MERGE, they do not replace. A player who signed but has');
  log('     not played yet stays visible as `r`; once they play they become `p`.');
  log('     Where both exist for one season the GAME decides which club they are at.');
  let agedTeams = 0, unagedTeams = 0;
  for (const se of Object.values(rosterOut.seasons))
    for (const c of Object.values(se.clubs))
      for (const t of Object.keys(c.teams)) (c.teamAge[t] ? agedTeams++ : unagedTeams++);
  log(`  teams with an age : ${agedTeams}; without : ${unagedTeams}` +
    (unagedTeams ? '  (they sort last rather than first)' : ''));
  let gradedTeams = 0, ungradedTeams = 0; const gradeSeasons = new Set();
  for (const [sid, se] of Object.entries(rosterOut.seasons))
    for (const c of Object.values(se.clubs))
      for (const t of Object.keys(c.teams)) {
        if (c.teamGrade[t]) { gradedTeams++; gradeSeasons.add(se.compName || sid); }
        else ungradedTeams++;
      }
  log(`  teams with a grade : ${gradedTeams}; without : ${ungradedTeams}`);
  log(`  seasons that have grades : ${[...gradeSeasons].sort().join(', ') || '(none)'}`);
  log('  ⚠️ A SEASON WITH NO GAMES HAS NO GRADE. Grade comes from the stored');
  log('     `roster` map, which the results engine writes per played team.');
  log('     publicProfileTeams carries none, so a 2027 registration has an age');
  log('     and no grade until the league grades its teams.');
  if (!rosters.size) {
    log('  ⚠️ NO ROSTERS AT ALL. Either no season has per-game lines and no player');
    log('     holds a tracked registration, or the comp|team|age lookup is missing.');
  }

  if (DRY) { log('  DRY RUN — not written.'); process.exit(0); }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const kb = Math.round(fs.statSync(OUT_PATH).size / 1024);
  log(`  Wrote ${path.relative(ROOT, OUT_PATH)} (${kb} KB)`);

  const rosterJson = JSON.stringify(rosterOut);
  const rosterGz = zlib.gzipSync(Buffer.from(rosterJson, 'utf8'), { level: 9 });
  fs.writeFileSync(ROSTERS_PATH, rosterGz);
  log(`  Wrote ${path.relative(ROOT, ROSTERS_PATH)} ` +
    `(${Math.round(rosterGz.length / 1024)} KB gzipped, ${Math.round(rosterJson.length / 1024)} KB plain)`);
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
