#!/usr/bin/env node
// scripts/build-transfers.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'build-transfers v6 2026-11-24 rosters';

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
// Env: TR_MIN_GAMES (default 3), TR_OUT (data/transfers.json),
//      TR_ROSTERS_OUT (data/rosters.json.gz), TR_DRY (print only, write
//      nothing).

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
  let rosterPlayed = 0, rosterRegistered = 0, rosterConflicts = 0;

  function rosterAdd(sid, club, team, uuid, name, age, source) {
    if (!sid || !club || !uuid) return;
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
    if (byUuid.has(uuid)) return;
    byUuid.set(uuid, { u: uuid, n: name || null, a: age || '', s: source === 'played' ? 'p' : 'r' });
    if (source === 'played') rosterPlayed++; else rosterRegistered++;
  }
  const gamesHistogram = new Map();   // games at the smaller club -> count
  const overlapHistogram = new Map(); // clean | interleaved | undated -> count
  let seasonsWithLines = 0, seasonsWithout = [];

  for (const m of manifest) {
    const f = loadLines(m.seasonId);
    if (!f) { seasonsWithout.push(m.compName); continue; }
    seasonsWithLines++;

    let md = new Map(), players = new Map();
    try {
      const d = store.load([m.compName], { players: true });
      for (const r of (d.matches || [])) if (r.gameId) md.set(r.gameId, r);
      for (const p of (d.players || [])) {
        if (!p || !p.uuid) continue;
        if (!players.has(p.uuid)) players.set(p.uuid, { name: p.name, age: p.age });
        if (!playerInfo.has(p.uuid)) {
          playerInfo.set(p.uuid, { age: p.age || '', team: p.teamRaw || p.team || '' });
        }
      }
    } catch (e) { console.error(`  ⚠️ ${m.compName}: ${e.message}`); continue; }

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
          if (!e) { e = { games: 0, first: day, last: day, team: teamName }; cm.set(club, e); }
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
        rosterAdd(m.seasonId, club, e.team || null, u,
          (players.get(u) || {}).name || null, (players.get(u) || {}).age || '', 'played');
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
      const c = { name: clubLabel(club), teams: {}, unassigned: [] };
      for (const [team, byUuid] of byTeam) {
        // ⚠️ SORTED, so the committed file does not churn. An unsorted Map
        // iteration reorders rows whenever the input order shifts, and every
        // nightly commit would then be a whole-file diff of nothing.
        const rows = [...byUuid.values()].sort((a, b) => String(a.n || '').localeCompare(String(b.n || '')) || a.u.localeCompare(b.u));
        if (team === TEAM_NONE) { c.unassigned = rows; rUnassigned += rows.length; }
        else { c.teams[team] = rows; rTeams++; }
      }
      season.clubs[club] = c;
    }
    rosterOut.seasons[sid] = season;
  }

  log('\n── rosters ──');
  log(`  seasons ${rosters.size}, clubs ${rClubs}, teams ${rTeams}`);
  log(`  players: ${rosterPlayed} from games (source p), ${rosterRegistered} from registrations (source r)`);
  log(`  registered with no team assigned yet : ${rUnassigned}`);
  log(`  registrations dropped because a GAME already placed that player : ${rosterConflicts}`);
  log('  ⚠️ THE TWO HALVES MERGE, they do not replace. A player who signed but has');
  log('     not played yet stays visible as `r`; once they play they become `p`.');
  log('     Where both exist for one season the GAME decides which club they are at.');
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
