#!/usr/bin/env node
// scripts/build-transfers.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'build-transfers v24 2026-11-26 sample-wording';

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
// Career totals, one small file per player, written by fetch-career-stats.js.
const PLAYERS_DIR = path.join(ROOT, 'players');
const careerPath = (uuid) => path.join(PLAYERS_DIR, String(uuid).slice(0, 2), `${uuid}.json`);
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const OUT_PATH = path.join(ROOT, process.env.TR_OUT || 'data/transfers.json');
// ⚠️ GZIP, like registrations and for the same reason. Once most of the cohort
// holds a next-season registration this is the better part of 2 MB plain, and
// it is committed on every walk. The page decompresses it with
// DecompressionStream exactly as it already does for registrations. Cost: it is
// not readable in the GitHub web UI — the run log prints the counts.
// ⚠️ ONE FILE PER SEASON, NOT ONE FILE. docs/rosters_storage_design.md.
// The single data/rosters.json.gz was 1,612 KB gzipped and was rewritten every
// night — gzip cannot be delta-compressed by git, so one changed byte stores
// the whole blob again, about 590 MB of history a year. The played half is
// STATIC once a season finishes; only the season taking registrations changes.
// Split per season, a normal night rewrites the ~100 KB 2027 files and nothing
// else, and the page downloads one season instead of eight.
const ROSTERS_DIR = path.join(ROOT, process.env.TR_ROSTERS_DIR || 'data/rosters');
// The season team registry — scripts/fetch-teams.js, docs/team_registry_design.md.
// ⚠️ ITS ABSENCE IS NOT AN ERROR. This script predates it and must keep working
// without it; a season with no registry file simply contributes no empty teams.
const TEAMS_DIR = path.join(ROOT, process.env.TR_TEAMS_DIR || 'data/season-teams');
const ROSTERS_INDEX = path.join(ROSTERS_DIR, 'index.json');
// The file the split replaces. Removed once, on the first v13 run.
const ROSTERS_LEGACY = path.join(ROOT, 'data/rosters.json.gz');
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
  // ⚠️ SAME LOOKUP, NO COUNTERS. The hit/miss figures above are the alarm for a
  // broken teamClub key and are quoted as a coverage rate; 40,000 extra calls
  // from the roster side would dilute that rate and hide a real miss.
  function clubOfQuiet(comp, team, age) {
    if (!team) return null;
    for (const k of [`${comp}|${team}|${age}`, `${comp}|${team}|`, `${comp}|${team}`]) {
      if (teamClub[k]) return teamClub[k];
    }
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

  // ── Empty teams ──────────────────────────────────────────────────────────
  // ⚠️ A TEAM WITH NO PLAYERS IS INVISIBLE TO EVERYTHING ELSE HERE. Both halves
  // above start from a PERSON — a game line or a registration — so a team the
  // club has created and not yet filled cannot appear. discoverTeams lists it
  // and cannot return its members, which is why the registry exists.
  // Measured on SEJ 2027, 2026-11-25: 117 teams against 59 with a player.
  let emptyAdded = 0, emptySeasons = 0, registryMissing = [];
  const matchReport = [];   // per season: how well the two name sets agree
  // ⚠️ v15 ADDED 3,073 "EMPTY" TEAMS ACROSS EIGHT SEASONS, FIVE OF WHICH HAVE
  // BEEN FULLY PLAYED. A played season cannot have two thousand teams with
  // nobody in them — every team that played has players. The registry holds
  // PlayHQ's team name (`Norwood U8 Purple`, `Berwick Springs JFC U08 Mixed
  // Blue`); the roster holds the MATCH name from rec.home. They largely do not
  // agree, so almost every real team got a phantom duplicate beside it. Teams
  // went 1,343 to 4,418.
  //
  // This is the same trap written up in refresh-team-logos one day earlier —
  // "keying off the API name would add keys nothing looks up" — and then walked
  // straight into here.
  //
  // ⚠️ SO EMPTY TEAMS ARE ADDED ONLY FOR A SEASON THAT HAS NOT BEEN PLAYED.
  // There, the roster's team names come from REGISTRATIONS, which carry
  // PlayHQ's own name, so the two sets are directly comparable — and an empty
  // team is a real thing rather than a naming artefact. For a played season an
  // unmatched registry team is evidence of a name mismatch, not of an empty
  // team, so it is COUNTED AND REPORTED rather than written.
  //
  // Matching on the team ID is the real fix and it is already designed:
  // team_registry_design.md §3.1, capture hTeamId/aTeamId on match records,
  // build order step 4. Until that exists this stays conservative.
  // ⚠️ A CLUB KNOWN ONLY FROM THE REGISTRY HAS NO ENTRY IN core.json's `clubs`,
  // so clubLabel() returns the raw 8-character id and the roster heading reads
  // "clubC". That is precisely the club this feature exists to surface — one
  // with teams and nobody in them yet — so the registry's own orgName is kept
  // as a fallback. PlayHQ appends the home association, "Norwood (Eastern
  // Football Netball League)", which the README warns is NOT the competition
  // the team plays in; it is stripped for display rather than stored.
  const regClubName = new Map();      // org -> name from the registry
  function addEmptyTeams(sid, played) {
    const f = path.join(TEAMS_DIR, `${sid}.json`);
    if (!fs.existsSync(f)) { registryMissing.push(sid); return; }
    let reg;
    try { reg = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.error(`  ⚠️ ${path.basename(f)}: ${e.message}`); return; }
    const byClub = rosters.get(sid);
    let added = 0, matched = 0, unmatched = 0;
    const sample = [];
    for (const t of Object.values(reg.teams || {})) {
      if (!t || !t.name || !t.org) continue;
      // ⚠️ ONLY WHERE NOBODY IS ALREADY PLACED. A team that has players is the
      // roster's own; the registry must never overwrite it, and must never add
      // a second entry under the same name.
      if (byClub && byClub.has(t.org) && byClub.get(t.org).has(t.name)) { matched++; continue; }
      unmatched++;
      if (sample.length < 4) {
        const have = byClub && byClub.has(t.org) ? [...byClub.get(t.org).keys()].slice(0, 2) : [];
        sample.push(`${t.name}  (club holds: ${have.length ? have.join(', ') : 'nothing'})`);
      }
      // ⚠️ A PLAYED SEASON GETS NOTHING. See the note above: there, unmatched
      // means the names disagree, not that the team is empty.
      if (played) continue;
      if (!rosters.has(sid)) rosters.set(sid, new Map());
      const cm = rosters.get(sid);
      if (!cm.has(t.org)) cm.set(t.org, new Map());
      const bt = cm.get(t.org);
      if (bt.has(t.name)) continue;
      bt.set(t.name, new Map());        // an empty player map — the point of it
      // The registry's own age and grade, which are better than anything
      // derivable here: a team with no players has no player ages to read.
      const ak = `${sid}|${t.org}|${t.name}`;
      const age = t.age || ageFromTeam(t.name);
      if (t.orgName && !regClubName.has(t.org)) {
        regClubName.set(t.org, String(t.orgName).replace(/\s*\([^)]*\)\s*$/, '').trim());
      }
      if (age) teamAges.set(ak, new Map([[age, 1]]));
      if (t.grade) teamGrades.set(ak, t.grade);
      added++;
    }
    if (added) { emptyAdded += added; emptySeasons++; }
    matchReport.push({ sid, played, total: Object.keys(reg.teams || {}).length,
      matched, unmatched, added, sample });
    return added;
  }

  const teamAges = new Map();         // `${sid}|${club}|${team}` -> Map(age -> n)
  const teamGrades = new Map();       // `${sid}|${club}|${team}` -> grade label
  // ⚠️ KEYED BY AGE AS WELL, AND THAT IS THE WHOLE POINT. `teamGrades` above is
  // keyed by team NAME only, and a club fields one "Montrose Blue" at six age
  // groups — so that map holds one grade for six different sides and can be
  // attributed to none of them. The dashboard read from it and correctly
  // refused on nearly every junior team, which looked like missing data.
  //
  // This index is keyed `${compName}|${team}|${age}`, the way the stored
  // `roster` map is already keyed, so the grade that lands on a row is the one
  // the league gave THAT side.
  const gradeIdx = new Map();         // `${compName}|${team}|${age}` -> grade
  // ⚠️ THE AGELESS KEYS ARE A FALLBACK FOR A ROW WITH NO AGE, never for one
  // that has an age and misses. Falling through on a miss would hand back the
  // ambiguous grade this index exists to avoid.
  const gradeFor = (compName, team, age) => {
    if (!compName || !team) return '';
    if (age) return gradeIdx.get(`${compName}|${team}|${age}`) || '';
    return gradeIdx.get(`${compName}|${team}|`) ||
           gradeIdx.get(`${compName}|${team}`) || '';
  };
  // ⚠️ THE PLAYER'S LAST PLAYED SEASON, chosen by DATE and not by whichever
  // season the manifest loop reached first. A next-season registration row is
  // nearly useless without it — "who is this child" is answered by where they
  // played last year, how many games and how many goals.
  const lastPlayed = new Map();       // uuid -> { y, comp, club, team, age, gp, goals }
  // One accessor so no caller has to remember the fallback. Always an object,
  // so a missing player yields empty strings rather than a throw.
  const lp = (uuid) => {
    const x = lastPlayed.get(uuid);
    const f = playerInfo.get(uuid) || {};
    return { age: (x && x.age) || f.age || '', team: (x && x.team) || f.team || '',
             gp: (x && x.gp) || 0, comp: (x && x.comp) || '' };
  };
  // ⚠️ WHICH CLUB WAS THE PLAYER'S OWN — docs/permit_revert_design.md §4.
  //
  // A permit player holds TWO registrations for one season: their home club,
  // and the club whose team they turned out for. Measured 2026-11-26 on the
  // Norwood Gold/Heathmont side: 12 of 24. Until walk v14 the second was
  // discarded and `from.club` was whichever PlayHQ listed last, so twelve
  // Heathmont players were recorded as Norwood's and showed as Norwood
  // departures when their permit ended.
  //
  // ⚠️ IT MATCHES ORGANISATION IDS, NEVER TEAM NAMES. PlayHQ says "Norwood
  // Gold/Heathmont U12"; our stored name is age-stripped to "Norwood
  // Gold/Heathmont". Comparing names failed on all twelve in the probe.
  //
  // Returns { id, name, host, why } — `host` is the club they played FOR when
  // that differs from home, and `why` is one of:
  //   single  one registration; nothing to decide
  //   permit  two, and exactly one is the club whose team they played for
  //   unknown two, and the played club matches neither or both — left alone
  let permitResolved = 0, permitUnknown = 0, permitMulti = 0, permitReturned = 0;
  let permitDuped = 0;
  let regPeople = null;
  const leadKeptSamples = [];
  // ⚠️ DECLARED HERE, FILLED IN THE ROSTER PASS, LOGGED THERE TOO. They were
  // referenced from the permits summary, which runs first — a TDZ crash that
  // `node --check` passes without a word and only running the thing finds.
  let permitRows = 0, permitRowsNoRec = 0;
  // ⚠️ "UNDECIDABLE" WAS ONE COUNTER FOR THREE DIFFERENT FAILURES, and on the
  // first real run it read 127 of 142 with no way to tell which. A single
  // number that cannot be acted on is barely better than no number.
  const permitWhy = { noPlayed: 0, matchedNone: 0, matchedAll: 0 };
  const permitSamples = [];
  let regFileVersion = 0;
  // club name -> players who turned out for its teams on a permit and have
  // gone somewhere other than it. Not transfers; the club lost them anyway.
  const permitAway = new Map();
  const homeOf = (uuid, from, count = true) => {
    const bump = (n) => { if (count) n(); };
    const raw = Array.isArray(from.clubs) ? from.clubs.filter(x => x && x.id) : null;
    // ⚠️ TWO REGISTRATIONS WITH THE SAME CLUB ARE ONE CLUB. A player can hold
    // several registrations with their OWN club inside one season id — the
    // lightning premiership is the common case, and its team name carries
    // " - LP". v20 measured the damage: 125 of 127 "undecidable" players were
    // this, registered=[f9f163a0, f9f163a0]. Removing the played club from a
    // list of two identical ids leaves nothing, and the rule declared a
    // question unanswerable when there was never one to ask.
    //
    // Deduped by id, first occurrence wins — the team differs between them and
    // nothing downstream reads it, so which one survives does not matter.
    const seenIds = new Set();
    const list = raw ? raw.filter(x => !seenIds.has(x.id) && seenIds.add(x.id)) : null;
    if (raw && raw.length > (list ? list.length : 0)) bump(() => permitDuped++);
    const fallback = { id: from.club, name: from.clubName || clubLabel(from.club),
      host: null, why: 'single' };
    if (!list || list.length < 2) return fallback;
    bump(() => permitMulti++);
    const lpRec = lastPlayed.get(uuid) || {};
    const played = lpRec.clubId || null;
    const sample = (why) => {
      if (permitSamples.length < 8) {
        permitSamples.push(`${why}: ${(playerInfo.get(uuid) || {}).name || uuid}` +
          `  played=${played || '(none)'} "${lpRec.team || ''}"` +
          `  registered=[${list.map(x => x.id).join(', ')}]`);
      }
    };
    if (!played) {
      bump(() => { permitUnknown++; permitWhy.noPlayed++; sample('no played club'); });
      return { ...fallback, why: 'unknown' };
    }
    const other = list.filter(x => x.id !== played);
    // Exactly one registration that is NOT the club they played for: that is
    // home. Any other shape is not decidable here and must not be guessed.
    if (other.length === list.length) {
      // The club whose team they played for is not among their registrations
      // at all. Either the ids are from different spaces, or they played for a
      // club they never registered with — which should not happen.
      bump(() => { permitUnknown++; permitWhy.matchedNone++; sample('played club not registered'); });
      return { ...fallback, why: 'unknown' };
    }
    if (other.length !== 1) {
      bump(() => { permitUnknown++; permitWhy.matchedAll++; sample('more than one left over'); });
      return { ...fallback, why: 'unknown' };
    }
    bump(() => permitResolved++);
    return { id: other[0].id, name: other[0].name || clubLabel(other[0].id),
      host: played, why: 'permit' };
  };

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
        if (lp.clubId) row.p.ci = lp.clubId;
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
        // ⚠️ FIRST-WINS OVER MANIFEST ORDER, WHICH IS ARBITRARY. This is kept
        // only as a fallback for a player who has no entry in `lastPlayed`;
        // everything that faces the reader uses lastPlayed instead. A between-
        // season transfer row showed the age from whichever season the loop
        // reached first — often the player's OLDEST — so a child who moved
        // clubs at U13 could be listed as U9.
        if (!playerInfo.has(p.uuid)) {
          playerInfo.set(p.uuid, { age: p.age || '', team: p.teamRaw || p.team || '' });
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

    // Harvested here because `roster` is only in scope inside this loop, while
    // the between-season and lead builders below need the same grades.
    for (const [k, r] of Object.entries(roster)) {
      if (r && r.grade && !gradeIdx.has(k)) gradeIdx.set(k, String(r.grade));
    }

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

    // ── The player's last played season ───────────────────────────────────
    //
    // ⚠️ THE CLUB COMES FROM `seen`, WHICH IS BUILT FROM THE GAMES. v12 and
    // v13 looked it up with clubOfQuiet(compName, teamRaw, age) and that key
    // does not exist: teamClub is keyed on the MATCH team name — the same
    // rec.home/rec.away the loop above resolves 103,406 times with no misses —
    // while teamRaw is the player-record name, which clubs write differently.
    // "Pakenham JFC U13 Boys Maroon" never matched anything. 2,261 of 2,330
    // registrations came out unresolved, and because an unresolved club is
    // indistinguishable from an unchanged one, the page showed almost no
    // transfers in at all. The club id is already in `seen`; nothing needed
    // looking up.
    //
    // ⚠️ LATEST YEAR FIRST, THEN MOST GAMES — not latest startDate. A player in
    // two competitions in the SAME year was decided by whichever league opened
    // later in the calendar, which is arbitrary. The year comes from the season
    // NAME; a season's startDate precedes the year in its name.
    const y = yearOf(m.compName);
    for (const [u, agg] of players) {
      const prev = lastPlayed.get(u);
      if (prev && !(y > prev.y || (y === prev.y && agg.gp > prev.gp))) continue;
      // The club they played MOST games for in this season. A player with an
      // in-season move has two, and the bigger spell is the one that answers
      // "where were they last year".
      let clubId = '', best = -1, teamName = '';
      for (const [club, e] of (seen.get(u) || new Map())) {
        if (e.games > best) { best = e.games; clubId = club; teamName = e.team || ''; }
      }
      // Falls back to the lookup only for someone in the players file with no
      // game in the lines — rare, and better than nothing.
      if (!clubId) clubId = clubOfQuiet(m.compName, agg.team, agg.age) || '';
      lastPlayed.set(u, { y, comp: m.compName,
        club: (clubId && clubLabel(clubId)) || agg.club || '',
        team: teamName || agg.team || '', clubId,
        age: agg.age || '', gp: agg.gp, goals: agg.goals });
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
          // The league's grade for the side they left, in the season they left
          // it. '' when that season holds no grade for it, never a guess.
          fromGrade: gradeFor(m.compName, fromE.team, info.age || ''),
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
    // ⚠️ A FILE OLDER THAN v4 CANNOT SUPPORT THE PERMIT RULE, and must not be
    // read as if every player simply had one registration: an absent
    // `from.clubs` and "one club" are indistinguishable. The version says
    // which, and the log and the page both report it.
    regFileVersion = Number((reg.meta || {}).version || 0);
    // ⚠️ KEPT FOR THE ROSTER PASS BELOW. The rosters are built in the manifest
    // loop, long before this file is read, so the permit counts per squad can
    // only be worked out afterwards — and only if the records are still here.
    regPeople = people;
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
          r.name || null, lp(uuid).age, 'registered');
        if (!t.club || !from.club) continue;
        // ⚠️ AGAINST HOME, NOT AGAINST from.club. A permit player returning to
        // their own club was a "transfer" from the host, which is the defect
        // this version exists to remove.
        const home = homeOf(uuid, from);
        if (t.club === home.id) { permitReturned += (home.why === 'permit') ? 1 : 0; continue; }
        // They have left for somewhere else. If they were on a permit, the
        // HOST club has lost a player from its side without that being a
        // transfer on the host's books — counted for the club heading.
        // ⚠️ ONLY WHEN THE HOST ALSO LOSES THEM. A permit player who signs
        // WITH the club whose team they played for has not left that side —
        // counting them here credited Club A with losing a player it had just
        // gained, which the fixture caught.
        if (home.why === 'permit' && home.host && t.club !== home.host) {
          const hn = clubLabel(home.host);
          permitAway.set(hn, (permitAway.get(hn) || 0) + 1);
        }
        // Same sample as the leads half: a permit player leaving for a third
        // club is attributed to HOME, and if home is the club whose team they
        // played in, the rule has resolved the wrong way round.
        if (home.why === 'permit' && leadKeptSamples.length < 8) {
          leadKeptSamples.push(
            `[between] ${r.name || uuid}  played=${(lastPlayed.get(uuid) || {}).clubId || '(none)'}` +
            ` "${(lastPlayed.get(uuid) || {}).team || ''}"` +
            `  registered=[${(from.clubs || []).map(x => x.id).join(', ')}]` +
            `  home=${home.id}  to=${t.club}`);
        }
        const fs2 = splitSeason(from.compName);
        const ts = splitSeason((byId.get(t.seasonId) || {}).compName || t.compName || '');
        between.push({
          // ⚠️ AGE AND TEAM COME FROM THE SEASON FILES, not from the registration.
          // A between-season row carried age:'' and fromTeam:'' — so grouping or
          // filtering by grade silently dropped every one of them, which looks
          // like "there are no U12 transfers" rather than "this row has no age".
          kind: 'between', uuid, name: r.name,
          // ⚠️ THE AGE AND TEAM OF THE SEASON THEY ACTUALLY LEFT. lastPlayed is
          // chosen by latest year then most games; playerInfo is first-wins over
          // manifest order and is only the fallback.
          age: lp(uuid).age, 
          comp: fs2.comp, year: fs2.year, seasonId: from.seasonId,
          fromClub: home.id, fromClubName: home.name,
          fromTeam: lp(uuid).team, fromGames: lp(uuid).gp || null,
          fromGrade: gradeFor(from.compName, lp(uuid).team, lp(uuid).age),
          // ⚠️ PRESENT ON EVERY ROW, null when not on a permit. A reader must
          // be able to tell "played for their own club" from "played for
          // someone else's team", and an absent field cannot say either.
          permitHost: (home.why === 'permit' && home.host) ? clubLabel(home.host) : null,
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
    // ── permit reverts, docs/permit_revert_design.md ──────────────────────
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
      if (!r.at || !lo || !lo.id || !from.club) continue;
      const home = homeOf(uuid, from);
      if (lo.id === home.id) { permitReturned += (home.why === 'permit') ? 1 : 0; continue; }
      // A permit player whose lead is NOT suppressed is signing somewhere
      // other than their own club — usually with the host whose team they
      // played in, which is a real transfer. Sampled so the rule can be
      // checked against reality; measured 2026-11-26, every sample was this
      // legitimate case and none was a misresolution.
      if (home.why === 'permit' && leadKeptSamples.length < 8) {
        leadKeptSamples.push(
          `[lead] ${r.name || uuid}  played=${(lastPlayed.get(uuid) || {}).clubId || '(none)'}` +
          ` "${(lastPlayed.get(uuid) || {}).team || ''}"` +
          `  registered=[${(from.clubs || []).map(x => x.id).join(', ')}]` +
          `  home=${home.id}  lastOrg=${lo.id}`);
      }
      if (home.why === 'permit' && home.host && lo.id !== home.host) {
        const hn = clubLabel(home.host);
        permitAway.set(hn, (permitAway.get(hn) || 0) + 1);
      }
      if ((r.tracked || []).length) { leadsSkippedKnown++; continue; }
      const kind = (orgs[lo.id] && orgs[lo.id].kind) || 'unknown';
      // ⚠️ A CARNIVAL IS NOT A MOVE. An organisation that runs Nines and nothing
      // else is a second registration alongside a normal season.
      if (kind === 'event') { leadsSkippedEvent++; continue; }
      if (kind === 'unknown') leadsUnknownOrg++;
      const f = splitSeason(from.compName);
      leads.push({
        kind: 'lead',
        uuid, name: r.name, age: lp(uuid).age,
        // ⚠️ NO SEASON AND NO YEAR, deliberately. A lead cannot be placed in time
        // and the view must not be able to imply otherwise.
        comp: '', year: '', seasonId: from.seasonId,
        fromClub: home.id, fromClubName: home.name,
        fromTeam: lp(uuid).team, fromGames: lp(uuid).gp || null,
        fromGrade: gradeFor(from.compName, lp(uuid).team, lp(uuid).age),
        permitHost: (home.why === 'permit' && home.host) ? clubLabel(home.host) : null,
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

  // ── permits, docs/permit_revert_design.md ───────────────────────────────
  // ⚠️ REPORTED AFTER THE LEADS LOOP, AND THAT MATTERS. These counters are
  // incremented by BOTH halves — between-season and leads — and this block
  // used to sit inside the between-season section, so every permit figure in
  // the log was the first half only while the page (out.coverage, below) got
  // the full count. Two numbers for one thing, and the one a human reads was
  // the wrong one.
  log('\n── permits ──');
  if (regFileVersion && regFileVersion < 4) {
    log(`  ⚠️ registrations file is version ${regFileVersion}; from.clubs arrives at`);
    log('     version 4. NO PERMIT CORRECTION HAS BEEN APPLIED — a permit player');
    log('     returning to their home club is still counted as a departure from');
    log('     the club whose team they played for. Run walk-registrations v14+.');
  } else {
    log(`  players holding the SAME club more than once : ${permitDuped}` +
      ' (a lightning premiership or similar, not a permit)');
    log(`  players with two DIFFERENT cohort-season clubs : ${permitMulti}`);
    log(`    home club resolved from the played club    : ${permitResolved}`);
    log(`    UNDECIDABLE, left as they were             : ${permitUnknown}`);
    log(`      no played club on record                 : ${permitWhy.noPlayed}`);
    log(`      played club is not one they registered with : ${permitWhy.matchedNone}`);
    log(`      more than one registration left over     : ${permitWhy.matchedAll}`);
    for (const l of permitSamples) log(`      ${l}`);
    if (permitWhy.matchedNone > permitResolved) {
      log('      ⚠️ THE DOMINANT CAUSE IS A CLUB THEY NEVER REGISTERED WITH.');
      log('         `lastPlayed.clubId` comes from the season files and');
      log('         `from.clubs[].id` from PlayHQ. If these were the same id');
      log('         space this would be rare, so suspect they are not before');
      log('         suspecting the data.');
    }
    log(`  rows suppressed — a permit player going home : ${permitReturned}`);
  if (leadKeptSamples.length) {
    // ⚠️ THIS IS NOT A WARNING, AND v23's WORDING SAID IT WAS. Every sample on
    // the first real run showed home != played — the rule working — but the
    // header invited the reader to treat the list as a fault report. A
    // diagnostic that cries wolf gets ignored the day it matters.
    log('  permit players whose row was KEPT, for inspection. A kept row is');
    log('  correct when `home` differs from `played`: the player was on permit');
    log('  at `played` and is moving from their own club, `home`. ⚠️ ONLY if');
    log('  home EQUALS played has the rule resolved the wrong way round:');
    for (const l of leadKeptSamples) log(`      ${l}`);
  }
    if (permitMulti && !permitResolved) {
      log('  ⚠️ NOT ONE RESOLVED. The rule compares organisation ids:');
      log('     from.clubs[].id against lastPlayed.clubId. A zero here means one');
      log('     side is empty or they are different id spaces — not that permits');
      log('     have stopped existing.');
    }
    if (permitAway.size) {
      log('  permit players who did NOT return, by the club they played for:');
      for (const [k, v] of [...permitAway.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        log(`    ${String(v).padStart(4)}  ${k}`);
      }
    }
  }

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
  // ⚠️ THE VIEW NEEDS THESE TO EXPLAIN ITSELF. Without permitFileVersion it
  // cannot tell "no permits here" from "the data cannot show them".
  out.coverage.permitFileVersion = regFileVersion;
  out.coverage.permitMulti = permitMulti;
  out.coverage.permitResolved = permitResolved;
  out.coverage.permitUnknown = permitUnknown;
  out.coverage.permitWhy = { ...permitWhy };
  out.coverage.permitDuped = permitDuped;
  out.coverage.permitReturned = permitReturned;
  out.permitAway = Object.fromEntries([...permitAway.entries()].sort((a, b) => b[1] - a[1]));
  out.coverage.leadsUnknownOrg = leadsUnknownOrg;
  // ⚠️ MEASURED, NOT ASSERTED. v16 and earlier took the age from playerInfo,
  // which is first-wins over an arbitrary manifest order. This says how many
  // rows the two sources actually disagree on, so the claim that it mattered
  // is a number rather than an argument.
  let ageMoved = 0;
  for (const t of [...between, ...leads]) {
    const was = (playerInfo.get(t.uuid) || {}).age || '';
    if (was && t.age && was !== t.age) ageMoved++;
  }
  {
    const all = [...inSeason, ...between, ...leads];
    const withTeam = all.filter(r => r.fromTeam);
    const withGrade = withTeam.filter(r => r.fromGrade);
    log(`  fromGrade on ${withGrade.length} of ${withTeam.length} row(s) that name a team` +
      ` (${gradeIdx.size} graded team-age key(s) indexed)`);
    // ⚠️ AN EMPTY FIELD LOOKS LIKE "NO GRADES EXIST". Say so loudly instead.
    if (withTeam.length && !withGrade.length) {
      log('  ⚠️ NOT ONE ROW GOT A GRADE. The index is keyed compName|team|age and');
      log('     the rows are looked up the same way — a zero here means the keys');
      log('     disagree, and the dashboard will show no grades at all.');
    }
  }
  log(`\n  total rows: ${out.transfers.length} (${inSeason.length} in-season, ` +
    `${between.length} between-season, ${leads.length} lead)`);
  log(`  age corrected on ${ageMoved} row(s) by taking the LAST PLAYED season ` +
    `rather than the first in manifest order`);

  // ── Rosters: serialise and report ──────────────────────────────────────────
  // ⚠️ VERSION 2 MEANS THE ROWS CARRY gp, gl AND p. Without a version bump a
  // page reading a v1 file says "no previous season held" about every single
  // registration — which is a statement about the player, and false. It was on
  // screen before this line existed. The page now reports the two cases
  // differently, and can only do so because this number moved.
  // ⚠️ AFTER BOTH HALVES AND BEFORE SERIALISATION — and v15 first put this
  // AFTER the serialisation loop below, where it added three teams to a map
  // nothing read again. The log cheerfully said "3 added from the registry"
  // while the written file contained none of them, which is the exact shape of
  // failure this project keeps paying for: a count that reports intent rather
  // than outcome. The "already placed" test needs the finished rosters, so it
  // has to sit between the two.
  for (const sid of (rosterSeasons ? [...rosterSeasons] : [...rosters.keys()])) {
    addEmptyTeams(sid, hasLines(sid));
  }

  const rosterOut = { version: 2, builtAt: out.builtAt, seasons: {} };
  let rClubs = 0, rTeams = 0, rUnassigned = 0;
  for (const [sid, byClub] of rosters) {
    const m = byId.get(sid) || {};
    const season = { compName: m.compName || null, startDate: m.startDate || null, endDate: m.endDate || null, clubs: {} };
    for (const [club, byTeam] of byClub) {
      rClubs++;
      // clubLabel falls back to the id when the club is not in core.json.
      const known = clubLabel(club);
      const c = { name: (known && known !== club) ? known : (regClubName.get(club) || known),
        teams: {}, teamAge: {}, teamGrade: {}, unassigned: [] };
      for (const [team, byUuid] of byTeam) {
        // ⚠️ SORTED, so the committed file does not churn. An unsorted Map
        // iteration reorders rows whenever the input order shifts, and every
        // nightly commit would then be a whole-file diff of nothing.
        //
        // ⚠️ CASE-INSENSITIVELY. The stored names are whatever PlayHQ holds —
        // "BEN JONES" beside "ava smith" — and a plain localeCompare put every
        // upper-case name in a block of its own ahead of the rest, which on
        // screen reads as a list that is not sorted at all.
        // ⚠️ A ZERO-LENGTH TEAM IS KEPT. It is the whole point of the registry
        // merge, and an `if (!rows.length) continue` here would silently undo it.
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

  // ── Permit players inside each squad ───────────────────────────────────────
  //
  // ⚠️ THE ROSTER IS BUILT FROM GAMES, so a permit player is a row at the club
  // whose TEAM they played in, not at the club they are registered to. The
  // dashboard's "1 of 47 left" therefore divided a numerator that excludes
  // permit players by a denominator that includes them — one figure about a
  // club's own players over one about everyone who took the field.
  // docs/permit_revert_design.md §8.
  //
  // ⚠️ NO FIELD IS ADDED TO THE ROSTER ROW. `{u, n, a, s}` is read by the
  // rosters view, the player panel, the cross-season search and the career
  // join; changing it means re-reading all four. These counts go in
  // transfers.json instead, which only the transfers view reads.
  //
  // Keys are ids and labels the view already holds: compName, the club NAME as
  // the roster stores it, then the age, and for a team the stored team name.
  const permitSquadAge = new Map();   // `${compName}|${clubName}|${age}` -> n
  const permitSquadTeam = new Map();  // `${compName}|${clubName}|${team}|${age}` -> n
  if (regPeople) {
    for (const [sid, season] of Object.entries(rosterOut.seasons)) {
      const comp = season.compName || sid;
      for (const [clubId, c] of Object.entries(season.clubs || {})) {
        for (const [team, rows] of Object.entries(c.teams || {})) {
          for (const row of rows) {
            // ⚠️ PLAYED ROWS ONLY. A registration row ('r') is the player's own
            // club by definition — it IS the registration — so it can never be
            // a permit and counting it would subtract a player twice.
            if (!row || row.s !== 'p') continue;
            const rec = regPeople[row.u];
            if (!rec || !rec.from) { permitRowsNoRec++; continue; }
            const home = homeOf(row.u, rec.from, false);
            if (!home.id || home.id === clubId) continue;
            permitRows++;
            const ck = `${comp}|${c.name}|${row.a || ''}`;
            permitSquadAge.set(ck, (permitSquadAge.get(ck) || 0) + 1);
            const tk = `${comp}|${c.name}|${team}|${row.a || ''}`;
            permitSquadTeam.set(tk, (permitSquadTeam.get(tk) || 0) + 1);
          }
        }
      }
    }
  }

  // ── Career totals ─────────────────────────────────────────────────────────
  // ⚠️ READ ONCE PER PERSON, NOT ONCE PER ROW. A player appears in several
  // rows — two clubs in a season, or a played row and a registration — and
  // 40,000 files is already the slowest thing this script does.
  //
  // A missing file is NORMAL, not an error: fetch-career-stats shards its
  // sweep and a new player may not have been reached yet. It is counted and
  // reported rather than logged 4,000 times.
  const careerRows = [];
  const careerWant = new Set();
  for (const se of Object.values(rosterOut.seasons))
    for (const c of Object.values(se.clubs))
      for (const row of [...Object.values(c.teams).flat(), ...c.unassigned]) {
        careerRows.push(row); careerWant.add(row.u);
      }
  const careerBy = new Map();
  let careerRead = 0, careerMissing = 0, careerUnreadable = 0;
  const careerStart = Date.now();
  for (const u of careerWant) {
    const f = careerPath(u);
    if (!fs.existsSync(f)) { careerMissing++; continue; }
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.career) { careerBy.set(u, j.career); careerRead++; }
      else careerMissing++;
    } catch (e) { careerUnreadable++; }
  }
  let careerOn = 0;
  for (const row of careerRows) {
    const c = careerBy.get(row.u);
    if (!c) continue;
    const o = {};
    if (c.gp) o.gp = c.gp;
    if (c.goals) o.gl = c.goals;
    if (Object.keys(o).length) { row.c = o; careerOn++; }
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
  let emptyTeams = 0;
  for (const se of Object.values(rosterOut.seasons))
    for (const c of Object.values(se.clubs))
      for (const t of Object.keys(c.teams)) if (!c.teams[t].length) emptyTeams++;
  log(`  teams with NO player yet : ${emptyTeams}` +
    (emptyAdded ? ` (${emptyAdded} added from the registry across ${emptySeasons} season(s))` : ''));
  if (matchReport.length) {
    log('  registry against the roster, per season — a PLAYED season should match');
    log('  nearly everything; a large unmatched count there is a NAMING problem,');
    log('  not a discovery, and nothing is added for it:');
    for (const r of matchReport.sort((a, b) => Number(b.played) - Number(a.played))) {
      const nm = (byId.get(r.sid) || {}).compName || r.sid;
      const pct = r.total ? Math.round((r.matched / r.total) * 100) : 0;
      log(`    ${pad(nm, 14)} ${r.played ? 'played  ' : 'unplayed'} ` +
        `${String(r.total).padStart(4)} in registry, ${String(r.matched).padStart(4)} matched ` +
        `(${String(pct).padStart(3)}%), ${String(r.unmatched).padStart(4)} not` +
        (r.added ? `, ${r.added} added` : ''));
    }
    const worst = matchReport.filter(r => r.played && r.unmatched > r.matched);
    if (worst.length) {
      log(`  ⚠️ ${worst.length} PLAYED season(s) matched fewer than half. The two name`);
      log('     sets disagree; matching on team id (team_registry_design §3.1,');
      log('     step 4) is the fix. Examples:');
      for (const r of worst.slice(0, 2)) {
        const nm = (byId.get(r.sid) || {}).compName || r.sid;
        r.sample.slice(0, 3).forEach(x => log(`       ${nm}: ${x}`));
      }
    }
  }
  if (registryMissing.length) {
    log(`  ⚠️ no registry file for ${registryMissing.length} season(s) in scope — those`);
    log('     seasons can only show teams that already have a player. Run');
    log('     "Fetch season teams" to fill them in.');
  }
  // ⚠️ ASSIGNED HERE, NOT BESIDE THE OTHER coverage KEYS. `out` is built
  // before the roster pass, so assigning these up there read them before they
  // existed — the same TDZ mistake twice in one change, both found by running
  // it and neither by `node --check`.
  out.coverage.permitRows = permitRows;
  out.coverage.permitRowsNoRec = permitRowsNoRec;
  out.permitSquadAge = Object.fromEntries(permitSquadAge);
  out.permitSquadTeam = Object.fromEntries(permitSquadTeam);
  log(`  roster rows that are a permit player : ${permitRows}` +
    (permitRowsNoRec ? `  (${permitRowsNoRec} played row(s) have no walk record)` : ''));
  log('     Subtracted from the squad size behind "N of M left", so both halves');
  log('     of that fraction describe the same group of players.');
  log(`  teams with an age : ${agedTeams}; without : ${unagedTeams}` +
    (unagedTeams ? '  (they sort last rather than first)' : ''));
  let gradedTeams = 0, ungradedTeams = 0; const gradeSeasons = new Set();
  for (const [sid, se] of Object.entries(rosterOut.seasons))
    for (const c of Object.values(se.clubs))
      for (const t of Object.keys(c.teams)) {
        if (c.teamGrade[t]) { gradedTeams++; gradeSeasons.add(se.compName || sid); }
        else ungradedTeams++;
      }
  // ⚠️ PROVE IT RATHER THAN ASSERT IT. v10 added the previous-season block and
  // printed nothing about it, so a file built before it and a genuine absence
  // looked identical in the log — the one thing a version line exists to stop.
  let regWithPrev = 0, regNoPrev = 0;
  for (const se of Object.values(rosterOut.seasons))
    for (const c of Object.values(se.clubs))
      for (const row of [...Object.values(c.teams).flat(), ...c.unassigned])
        if (row.s === 'r') (row.p ? regWithPrev++ : regNoPrev++);
  log(`  registrations carrying last season : ${regWithPrev} of ${regWithPrev + regNoPrev}`);
  log(`  career totals : ${careerOn} row(s) of ${careerRows.length} from ` +
    `${careerRead} file(s) in ${((Date.now() - careerStart) / 1000).toFixed(1)}s; ` +
    `${careerMissing} player(s) have no career file` +
    (careerUnreadable ? `, ${careerUnreadable} UNREADABLE` : ''));
  if (careerUnreadable) {
    log('  ⚠️ An unreadable career file is a fault, not a gap — a truncated or');
    log('     half-written file reads as "no career" and silently loses a player.');
  }
  // Transfers IN, countable here because the club id is stored.
  //
  // ⚠️ "SAME CLUB" AND "COULD NOT RESOLVE THE CLUB" ARE NOT THE SAME ANSWER,
  // and v12 printed one number that quietly merged them. It reported 2 against
  // 111 between-season moves found in the same run — a figure that cannot both
  // be right, and the log gave no way to tell which. A row whose previous club
  // would not resolve through teamClub has no `ci` at all and was simply not
  // counted, so an unresolved lookup looked exactly like a player staying put.
  let xferIn = 0, xferSame = 0, xferUnresolved = 0;
  const xferSample = [];
  for (const se of Object.values(rosterOut.seasons))
    for (const [cid, c] of Object.entries(se.clubs))
      for (const row of [...Object.values(c.teams).flat(), ...c.unassigned]) {
        if (row.s !== 'r' || !row.p) continue;
        if (!row.p.ci) {
          xferUnresolved++;
          if (xferSample.length < 5) xferSample.push(`${row.n || row.u} — ${row.p.y} ${row.p.t || row.p.c || '(no team)'}`);
        } else if (row.p.ci !== cid) xferIn++;
        else xferSame++;
      }
  log(`  registrations by last club : ${xferIn} DIFFERENT, ${xferSame} same, ` +
    `${xferUnresolved} could not be resolved`);
  if (xferUnresolved) {
    log('  ⚠️ An unresolved previous club is NOT "stayed put" — the page cannot');
    log('     mark it as a transfer in, so it reads as a player who stayed. The');
    log('     comp|team|age key did not resolve for these:');
    xferSample.forEach(x => log(`       ${x}`));
  }
  if (regNoPrev) {
    log(`  ⚠️ ${regNoPrev} registration(s) have NO previous season. Every walked`);
    log('     player comes from a cohort season, so this should be near zero —');
    log('     anything larger means the player files and the walk disagree.');
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

  // ── Rosters: one file per season, written only when the CONTENT changed ───
  //
  // ⚠️ NO TIMESTAMP INSIDE A SEASON FILE. builtAt lives in index.json alone.
  // While it sat in the rosters payload every season file differed from the
  // last run by construction, so "write only if changed" could never fire —
  // the same trap build-player-index documents for generatedAt.
  fs.mkdirSync(ROSTERS_DIR, { recursive: true });
  let wrote = 0, unchanged = 0, gzTotal = 0, plainTotal = 0;
  const indexSeasons = [];
  for (const [sid, se] of Object.entries(rosterOut.seasons)) {
    let players = 0, registered = 0, teams = 0;
    for (const c of Object.values(se.clubs)) {
      teams += Object.keys(c.teams).length;
      for (const row of [...Object.values(c.teams).flat(), ...c.unassigned]) {
        players++; if (row.s === 'r') registered++;
      }
    }
    const payload = JSON.stringify({ version: 2, sid, compName: se.compName,
      startDate: se.startDate, endDate: se.endDate, clubs: se.clubs });
    const f = path.join(ROSTERS_DIR, `${sid}.json.gz`);
    let same = false;
    if (fs.existsSync(f)) {
      // Compare the CONTENT, not the gzip bytes: a gzip of identical input is
      // reproducible here, but relying on that makes the check hostage to a
      // zlib upgrade. Inflate and compare the JSON.
      try { same = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') === payload; }
      catch (e) { same = false; }
    }
    const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 });
    if (same) unchanged++; else { fs.writeFileSync(f, gz); wrote++; }
    gzTotal += gz.length; plainTotal += payload.length;
    indexSeasons.push({ sid, compName: se.compName, startDate: se.startDate,
      endDate: se.endDate, clubs: Object.keys(se.clubs).length, teams, players,
      registered, file: `${sid}.json.gz`, bytes: gz.length });
  }
  // Newest first, so the page does not have to sort before it can draw.
  indexSeasons.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')) ||
    String(a.compName || '').localeCompare(String(b.compName || '')));

  // ⚠️ A SEASON THAT LEFT THE SCOPE MUST LOSE ITS FILE. Otherwise last year's
  // roster is still served long after the index stopped listing it, and the
  // next reader to guess the URL gets data nothing in the repo vouches for.
  let removed = 0;
  const want = new Set(indexSeasons.map(x => x.file));
  for (const f of fs.readdirSync(ROSTERS_DIR)) {
    if (!/\.json\.gz$/.test(f) || want.has(f)) continue;
    fs.unlinkSync(path.join(ROSTERS_DIR, f)); removed++;
  }
  fs.writeFileSync(ROSTERS_INDEX, JSON.stringify({ version: 2, builtAt: out.builtAt,
    seasons: indexSeasons }));
  if (fs.existsSync(ROSTERS_LEGACY)) {
    fs.unlinkSync(ROSTERS_LEGACY);
    log(`  Removed ${path.relative(ROOT, ROSTERS_LEGACY)} — replaced by ${path.relative(ROOT, ROSTERS_DIR)}/`);
  }
  log(`  Wrote ${path.relative(ROOT, ROSTERS_DIR)}/ — ${wrote} season file(s) changed, ` +
    `${unchanged} unchanged${removed ? `, ${removed} removed` : ''}`);
  log(`  total ${Math.round(gzTotal / 1024)} KB gzipped, ${Math.round(plainTotal / 1024)} KB plain ` +
    `across ${indexSeasons.length} file(s); the page loads ONE of them`);
  indexSeasons.forEach(x => log(`      ${pad(x.compName, 14)} ${String(Math.round(x.bytes / 1024)).padStart(5)} KB  ` +
    `${String(x.players).padStart(6)} player(s)${x.registered ? `, ${x.registered} registered` : ''}`));
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
