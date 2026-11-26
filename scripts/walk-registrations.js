#!/usr/bin/env node
// scripts/walk-registrations.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'walk-registrations v15 2026-11-26 dedupe-own-club';
const FILE_VERSION = 4;

//
// Where is each of our players for NEXT season? One call per person —
// publicProfileTeams(profileID) — swept across the WHOLE cohort every night on
// a pool of independent guest sessions. docs/walk_pool_design.md is the
// approved design; docs/registrations_design.md v2 still governs the cohort
// definition, the "next season" rule and the storage shape.
//
//   cohort   every distinct person in the most recent season of each tracked
//            organisation THAT HAS ACTUALLY BEEN PLAYED, skipping any
//            organisation that is playing right now
//   order    oldest walked first; never-walked ahead of everyone
//   pace     8 sessions, each with a minimum 800ms gap -> about 600/min, so
//            40,382 people take roughly 67 minutes
//
// ⚠️ WHAT CHANGED IN v12, AND WHY THE OLD NUMBERS WERE WRONG.
//
// v11 paced ONE shared session with a token bucket at 110 calls per rolling
// 60s and took about nine hours. Six probe runs on 2026-11-24
// (scripts/probe-rate-sharded.js, one runner, anonymous cookie-no-jwt)
// established that almost everything that pacing was built on was false:
//
//   the limit is the MINIMUM GAP between consecutive requests on ONE session.
//   Blocked at or below 450ms, clean at or above 662ms. Sessions are
//   independent and throughput scales linearly with them: 8 -> 618/min,
//   16 -> 1,451/min.
//
//   NOT per-IP          the same runner took 1,434 ok in one run and 308 in
//                       the next.
//   NOT an aggregate    blocked at 268/min aggregate; clean at 1,451/min.
//   NOT a call budget   the "~250-290 calls then 403" wall does not
//                       reproduce: 261, 302, 308 and 350 calls per session all
//                       clean, and BOTH blocks happened below it, at 154
//                       and 179.
//   NOT a 696-745ms round trip  measured 262-376ms.
//
// ⚠️ A TOKEN BUCKET IS THE WRONG INSTRUMENT AND THAT IS THE WHOLE DEFECT. "110
// per rolling 60s" fires flat out until the allowance empties and then idles,
// so the calls go out spaced at the round trip alone — 262-376ms, squarely in
// the blocked region — and lib/playhq.js absorbed each resulting block with a
// silent 80-second wait. The bucket is gone; lib/playhq.js createPool paces by
// the gap and REPORTS blocks instead of sleeping on them.
//
// ⚠️ THE RE-CHECK MACHINERY IS GONE WITH IT. spreadDays, nextCheck, the
// four-tier dueKey, WALK_IGNORE_NEXT_CHECK, the 7/28-day clocks, the
// `triggered` flag, the club trigger and meta.clubTeams all existed to decide
// WHO to walk when only a seventh of the cohort fitted in a night. Everyone is
// walked every night, so none of them has a job, and the whole thundering-herd
// class of defect goes with them. A FILE_VERSION 3 load strips the dead fields.
//
// ⚠️ C2, THE CAREER REFETCH FLAG, IS BACK. It was lost in an edit somewhere
// between v5 and v11 — no writer set it, while the suite still tested it and
// the workflow still staged players/ for it. See flagCareerRefetch below.
//
// ⚠️ THE CLUB HARVEST STAYS. The club TRIGGER is gone; harvesting `from.club`
// from the player's own cohort-season record is not. core.json's teamClub /
// teamOrg resolve only ~60% of a cohort (measured WFNL 2026: 4,688 of 7,675),
// so the API's own record is the only reliable source.
//
// NOT PLAYING, PER ORGANISATION — see the long note above cohortSeasons. The
// test is games, never PlayHQ's status, because PlayHQ calls a season ACTIVE
// the day registrations open. There is no in-season walk: a mid-season
// transfer is a registration in the SAME season, which the "starts after ours
// ends" rule below discards, so walking a competition mid-season would record
// nothing. build-transfers.js already derives that half from season data at no
// API cost.
//
// ⚠️ THE WORKFLOW HAS NO SEASON GATE ANY MORE. It had one, built on `state`,
// and it carried this same defect: once every competition's next season went
// ACTIVE the job would have stopped running altogether, through the whole
// registration window. One place decides this now, and it is this script,
// which can read the season files. The job starts, exits 2 in seconds when
// nothing qualifies, and commits nothing.
//
// WHICH REGISTRATIONS ARE "NEXT SEASON". A season counts only if it starts
// AFTER THE COHORT SEASON ENDS (startDate > endDate, both from the manifest).
// Measured on the first real run (2026-09-07): a "starts later" rule stored
// 1,187 CONCURRENT seasons, because EFNL 2026 starts 2025-10-01 and a school or
// VAFA season starting April 2026 reads as later. Never year against year: an
// AFL season's startDate precedes the year in its name.
//
// STORAGE. data/registrations.json.gz, written whole by this script and nothing
// else. Not core.json (a walk must never touch the manifest), not a season file
// (never in a results run's checkout).
//
// Exit codes: 0 = changed, commit. 2 = nothing changed. 3 = DEGRADED, the data
// collected is written and committed and then the job fails so GitHub raises
// it. 1 = fatal, nothing written.
//
// Env: WALK_POOL_SIZE (8), WALK_GAP_MS (800), WALK_MAX_CALLS (300),
//      WALK_TIME_BUDGET_MS (110 min), WALK_FRACTION (1 = everyone),
//      WALK_BLOCK_WAIT_MS (80000), WALK_PLAY_WINDOW_DAYS (21),
//      WALK_ANYWAY (walk even an organisation that is playing).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');
const phq = require('./lib/playhq');

const ROOT = path.resolve(__dirname, '..');
// GZIP ONLY (decided 2026-09-07). The plain file was 8.7 MB with 14% of the
// cohort walked and would be committed daily and fetched whole by the browser
// for one player's line. The .gz is ~1.4 MB. Cost: it is not readable in the
// GitHub web UI; the run log prints what you would look for. A leftover plain
// .json from v1-v3 is read once, converted and deleted.
const OUT_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
// ⚠️ C2 WRITES OUTSIDE data/. Career files live at players/<xx>/<uuid>.json and
// the workflow must stage players/ as well as data/ — run #81 committed a
// four-hour walk locally and never pushed it because those writes were
// unstaged and `git pull --rebase` then refused on a dirty tree.
const PLAYERS_DIR = path.join(ROOT, 'players');
const careerPath = (uuid) => path.join(PLAYERS_DIR, String(uuid).slice(0, 2), `${uuid}.json`);
const LEGACY_PATH = path.join(ROOT, 'data', 'registrations.json');

const POOL_SIZE = Math.max(1, Number(process.env.WALK_POOL_SIZE || 8));
const GAP_MS = Math.max(1, Number(process.env.WALK_GAP_MS || 800));
const MAX_CALLS = Math.max(1, Number(process.env.WALK_MAX_CALLS || 300));
const TIME_BUDGET_MS = Number(process.env.WALK_TIME_BUDGET_MS || 110 * 60 * 1000);
// ⚠️ A THROTTLE, NOT A SCHEDULE. There is no stored state behind it: it simply
// takes the first 1/N of the ordered cohort. The remainder are not "due
// tomorrow", they are just older and therefore first next time.
const FRACTION = Math.max(1, Number(process.env.WALK_FRACTION || 1));
// ⚠️ DAYS EITHER SIDE OF TODAY THAT COUNT AS "PLAYING". It must span a finals
// gap and a bye round without a March practice match reading as "the season
// has started". discover-seasons' own backstop calls a season quiet after 14.
const PLAY_WINDOW_DAYS = Math.max(1, Number(process.env.WALK_PLAY_WINDOW_DAYS || 21));
// Walk every tracked organisation whether or not it is playing.
const WALK_ANYWAY = /^(1|true|yes)$/i.test(process.env.WALK_ANYWAY || '');
// ⚠️ EXPOSED SO THE BLOCK PATH CAN BE EXERCISED AT ALL. CloudFront recovery is
// a flat ~80s and that is the right production value, but a guard that has
// never fired is untested, and twenty blocks at 80s each is also 27 minutes a
// degraded run spends waiting. Lower it only to test, or deliberately.
const BLOCK_WAIT_MS = Math.max(1, Number(process.env.WALK_BLOCK_WAIT_MS || 80000));
const RAW_UPCOMING_LIMIT = 10;

// ⚠️ TWO ROOT FIELDS, ONE REQUEST, NO EXTRA CALLS. GraphQL answers both in the
// same round trip, so publicProfile costs NOTHING against the call budget.
//
// ⚠️ WHY publicProfile AT ALL. publicProfileTeams only sees a registration once
// the club has put the player in a TEAM. `lastInteractedOrganisation` names the
// club at the moment of REGISTRATION, months before teams are formed. Measured
// 2026-11-20: it found Jayden May moving Surrey Park -> Forest Hill where the
// teams route had nothing, at about 1 in 115 of the players with nothing on
// record.
//
// ⚠️ IT CARRIES NO DATE. A club with no season attached cannot be placed in
// time, so it is stored as a NOTE and never counted as a registration.
const Q_PROFILE = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    ... on DiscoverTeam {
      id
      name
      season { id name startDate endDate status { value } competition { id name } }
      organisation { id name }
    }
  }
  publicProfile(profileID: $profileID) {
    id
    lastInteractedOrganisation { id name }
  }
}`;

const log = (...a) => console.log(...a);

// ISO timestamps this script wrote itself. Parsed by parts — never new Date(str).
function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(String(iso || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0));
}
const isoAt = (ms) => new Date(ms).toISOString();

// ── Is this organisation playing? ────────────────────────────────────────────
//
// ⚠️ PlayHQ's `ACTIVE` MEANS REGISTRATIONS ARE OPEN, NOT THAT ANYONE IS
// PLAYING. An AFL season "starts" months before its first game — SEJ 2026 runs
// from 2025-11-01, EFNL 2026 from 2025-10-01 — because that is when
// registration opens. discover-seasons maps ACTIVE to state 'active', so
// `state` conflates "registrations just opened, no game until April" with
// "they play every weekend".
//
// ⚠️ THAT CONFLATION FROZE THE WALK AT THE WORST POSSIBLE MOMENT. On
// 2026-11-24 EFNL 2027 was ACTIVE with registrations open and no fixture until
// April; the previous rule read that as in-season and dropped all 15,960 EFNL
// players out of the cohort — during the one window the walk exists to watch.
// The off-season gate in the workflow made the same mistake, and would have
// stopped the job entirely once every competition's 2027 season went ACTIVE.
//
// There is no status to reinterpret: `complete` is finished, `upcoming` is
// PlayHQ's UPCOMING, and `active` is everything else. So ask the games
// instead. Every match in a season core file carries a date, and
// fetch-fixtures rewrites every `scheduled: true` record each run, so their
// presence means PlayHQ still lists future games.
//
// PLAYING = a result dated within the last PLAY_WINDOW_DAYS, or a scheduled
// fixture within the next PLAY_WINDOW_DAYS. Nothing else.

// YYYY-MM-DD arithmetic. Never new Date(str) — split and use Date.UTC.
function addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

const gamesCache = new Map();
// { results, lastResult, nextScheduled } for one season, from its core file.
function seasonGames(seasonId, today) {
  if (gamesCache.has(seasonId)) return gamesCache.get(seasonId);
  const out = { results: 0, lastResult: '', nextScheduled: '', file: false };
  const p = path.join(store.SEASONS_DIR, `${seasonId}-core.json`);
  if (fs.existsSync(p)) {
    out.file = true;
    try {
      const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const m of (Array.isArray(payload.matches) ? payload.matches : [])) {
        if (!m || !m.date) continue;                 // byes and partial records
        if (m.scheduled === true) {
          if (m.date >= today && (!out.nextScheduled || m.date < out.nextScheduled)) out.nextScheduled = m.date;
          continue;
        }
        out.results++;
        if (m.date > out.lastResult) out.lastResult = m.date;
      }
    } catch (e) {
      // ⚠️ AN UNREADABLE FILE MUST NOT READ AS "NOT PLAYING". That would walk a
      // competition mid-season. Treat it as playing and say so.
      out.unreadable = e.message;
    }
  }
  gamesCache.set(seasonId, out);
  return out;
}

// ── Cohort ────────────────────────────────────────────────────────────────────
// Per organisation: the latest season THAT HAS ACTUALLY BEEN PLAYED — a players
// file and at least one dated result — skipping organisations that are playing
// right now.
//
// ⚠️ "HAS A PLAYERS FILE" IS NOT ENOUGH ON ITS OWN. EFNL 2027 has one the
// moment registrations produce teams, and taking it as the cohort season would
// make the cohort the people who have ALREADY registered — excluding exactly
// the players the walk is looking for.
function cohortSeasons(manifest) {
  const today = isoAt(Date.now()).slice(0, 10);
  const from = addDays(today, -PLAY_WINDOW_DAYS);
  const to = addDays(today, PLAY_WINDOW_DAYS);

  const byOrg = new Map();      // org -> { played: entry|null, playing: reason|null }
  for (const m of manifest) {
    if (!m.compName || !m.seasonId || !m.org) continue;
    const g = seasonGames(m.seasonId, today);
    const o = byOrg.get(m.org) || { played: null, playing: null, seen: [] };

    if (g.unreadable) o.playing = o.playing || `${m.compName}: season file unreadable (${g.unreadable}) — assuming in season`;
    else if (g.lastResult && g.lastResult >= from) o.playing = o.playing || `${m.compName}: result ${g.lastResult}, within ${PLAY_WINDOW_DAYS} days`;
    else if (g.nextScheduled && g.nextScheduled <= to) o.playing = o.playing || `${m.compName}: fixture ${g.nextScheduled}, within ${PLAY_WINDOW_DAYS} days`;

    const hasPlayers = fs.existsSync(path.join(store.SEASONS_DIR, `${m.seasonId}-players.json`));
    if (hasPlayers && g.results > 0) {
      if (!o.played || String(m.startDate || '') > String(o.played.startDate || '')) o.played = m;
    }
    o.seen.push({ compName: m.compName, lastResult: g.lastResult, nextScheduled: g.nextScheduled, results: g.results });
    byOrg.set(m.org, o);
  }

  const cohort = [];
  let playing = 0, noPlayed = 0;
  for (const [org, o] of byOrg) {
    if (!o.played) {
      log(`  ${org}: no season with a players file AND a dated result — nothing to walk`);
      noPlayed++;
      continue;
    }
    if (o.playing && !WALK_ANYWAY) {
      log(`  ${String(o.played.compName).padEnd(14)} PLAYING — ${o.playing} — NOT walked`);
      playing++;
      continue;
    }
    const g = seasonGames(o.played.seasonId, today);
    log(`  ${String(o.played.compName).padEnd(14)} cohort ${o.played.seasonId} ` +
      `(${o.played.startDate} to ${o.played.endDate || '?'}), ${g.results} result(s), last ${g.lastResult || 'none'}` +
      (o.playing ? `  [walk_anyway overrode: ${o.playing}]` : ''));
    cohort.push({
      seasonId: o.played.seasonId, compName: o.played.compName, org,
      startDate: o.played.startDate || '', endDate: o.played.endDate || '',
      state: o.played.state,
    });
  }
  return { cohort, playing, noPlayed };
}

// ⚠️ READ BY SEASON ID, NOT BY COMPETITION NAME. v11 called
// store.load([compName]), and store resolves a competition name through
// compIndex, which keeps the LAST manifest entry carrying that name. That is
// not necessarily the cohort season — the one with the greatest startDate that
// has a players file — so the people merged into the file could come from a
// different season than the one whose dates decide what counts as "next". The
// seasonId is already known here; use it.
function playersForSeason(seasonId) {
  const p = path.join(store.SEASONS_DIR, `${seasonId}-players.json`);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j.players) ? j.players : [];
}

function loadRegistrations() {
  let raw = null;
  if (fs.existsSync(OUT_PATH)) raw = zlib.gunzipSync(fs.readFileSync(OUT_PATH)).toString('utf8');
  else if (fs.existsSync(LEGACY_PATH)) {
    raw = fs.readFileSync(LEGACY_PATH, 'utf8');
    log(`reading legacy ${path.relative(ROOT, LEGACY_PATH)} — it will be replaced by the .gz`);
  }
  if (raw === null) return { meta: { version: FILE_VERSION, walkedAt: null, cohortSeasons: [] }, players: {} };

  const r = JSON.parse(raw);
  r.meta = r.meta || { version: 1 };
  r.players = r.players || {};
  const was = r.meta.version || 1;

  // v1 -> v2: the "starts later" rule over-included concurrent seasons, so any
  // record carrying a stored registration is cleared and re-decided.
  if (was < 2) {
    let redo = 0;
    for (const rec of Object.values(r.players)) {
      if ((rec.tracked && rec.tracked.length) || (rec.other && rec.other.length)) {
        rec.tracked = []; rec.other = []; redo++;
      }
    }
    log(`migrated registrations v1 -> v2: ${redo} record(s) with a stored registration cleared for re-decision`);
  }

  // v2 -> v3: the re-check machinery is gone. Strip its fields rather than
  // leaving them to rot — a stale nextCheck that nothing honours is worse than
  // no field at all, because the next reader will believe it.
  if (was < 3) {
    let stripped = 0;
    for (const rec of Object.values(r.players)) {
      if ('nextCheck' in rec) { delete rec.nextCheck; stripped++; }
      if ('triggered' in rec) delete rec.triggered;
    }
    if (r.meta.clubTeams) delete r.meta.clubTeams;
    log(`migrated registrations v${was} -> v3: dropped nextCheck/triggered from ${stripped} record(s) and meta.clubTeams`);
  }
  // v3 -> v4: `from.clubs` arrives. NOTHING IS MIGRATED — the field is
  // additive and is written the first time each player is walked, and the
  // whole cohort is walked nightly, so one run fills it.
  //
  // ⚠️ THE BUMP EXISTS SO A READER CAN TELL "not walked yet" FROM "one club".
  // Without it, a missing `from.clubs` is indistinguishable from a player who
  // genuinely has one registration, and build-transfers would silently apply
  // the permit rule to a file that cannot support it. It checks meta.version.
  if (was < 4) {
    log(`migrated registrations v${was} -> v4: from.clubs will be written as players are walked`);
  }
  r.meta.version = FILE_VERSION;
  return r;
}

// ── C2: flag a career file that has never held a season of ours ──────────────
//
// ⚠️ THIS WAS LOST IN AN EDIT BETWEEN v5 AND v11 AND NOTHING LOOKED WRONG.
// scripts/verify-registrations.js section 10 still tested it, the workflow
// still staged players/ for it, and no writer set the flag. That is the exact
// invisible failure the flag exists to prevent, happening to the flag itself:
// a player whose career file is missing one of our seasons simply waits out
// the 150-day timer while every run stays green.
//
// The walk is the only thing that sees a player's FULL registration list, so
// it is the only thing that can notice a season of ours the career file has
// never held. It sets refetch: true and leaves the rest of the file alone —
// read, modify, write, never rebuild.
//
// ⚠️ rfSeen IS WHAT STOPS AN ENDLESS LOOP. The career sweep clears the flag by
// rebuilding the record without it, and it writes no season row for a
// registration that carries no statistics. Without a memory of what has
// already been asked, the same gap is seen and flagged on EVERY walk, for
// ever. rfSeen records the season ids already raised for that player.
function flagCareerRefetch(uuid, rec, teams, manifestById, tally) {
  // Seasons of OURS this player is registered in, from the API's own answer.
  //
  // ⚠️ UPCOMING SEASONS ARE EXCLUDED, AND LEAVING THEM IN IS EXPENSIVE. A
  // season that has not started has no games and no statistics, so a career
  // file cannot hold a row for it and never will until it is played. Counting
  // one as "missing" flags a refetch that fetches nothing — and once a 2027
  // season exists, that is most of the cohort, which is tens of thousands of
  // pointless career fetches. Only a season that could HAVE statistics counts.
  const ourSids = [...new Set(teams
    .filter(t => t.season?.status?.value !== 'UPCOMING')
    .map(t => t.season?.id)
    .filter(sid => sid && manifestById.has(sid)))];
  if (!ourSids.length) return;

  const seen = new Set(Array.isArray(rec.rfSeen) ? rec.rfSeen : []);
  const f = careerPath(uuid);
  let career;
  try {
    if (!fs.existsSync(f)) { tally.noFile++; return; }
    career = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    tally.unreadable++;
    if (tally.samples.length < 5) tally.samples.push(`${uuid}: career file unreadable — ${e.message}`);
    return;
  }

  const held = new Set((Array.isArray(career.seasons) ? career.seasons : []).map(x => x && x.sid).filter(Boolean));
  const missing = ourSids.filter(sid => !held.has(sid) && !seen.has(sid));
  if (!missing.length) { tally.alreadyHeld++; return; }

  // Remember BEFORE flagging, so a crash between the two re-flags rather than
  // silently never flagging again.
  rec.rfSeen = [...seen, ...missing];
  career.refetch = true;
  fs.writeFileSync(f, JSON.stringify(career));
  tally.set++;
  if (tally.samples.length < 5) tally.samples.push(`${uuid}: missing ${missing.join(', ')}`);
}

async function main() {
  const startMs = Date.now();
  const NOW = isoAt(startMs);
  log(`=== ${VERSION} (${phq.LIB_VERSION}, store ${store.STORE_VERSION}) ===`);
  log(`today: ${NOW.slice(0, 10)}  pool: ${POOL_SIZE} session(s)  gap: ${GAP_MS}ms  ` +
    `rotate at ${MAX_CALLS} calls or 15 min  time budget: ${Math.round(TIME_BUDGET_MS / 60000)} min` +
    (FRACTION > 1 ? `  fraction: 1/${FRACTION}` : ''));

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = core.manifest || [];
  const manifestById = new Map(manifest.filter(m => m.seasonId).map(m => [m.seasonId, m]));

  log(`organisations — playing is a result in the last ${PLAY_WINDOW_DAYS} days or a fixture in the next ${PLAY_WINDOW_DAYS}:`);
  const { cohort, playing, noPlayed } = cohortSeasons(manifest);
  if (!cohort.length) {
    log(`Nothing to walk: ${playing} organisation(s) are playing, ${noPlayed} have no played season stored.`);
    process.exit(2);
  }
  const cohortById = new Map(cohort.map(c => [c.seasonId, c]));

  const reg = loadRegistrations();
  // "Changed" means the players moved — not the run stamp.
  const canon = (r) => JSON.stringify({
    meta: { ...r.meta, walkedAt: undefined, lastRun: undefined, people: undefined },
    players: r.players,
  });
  const before = canon(reg);

  // Merge the cohort into the file. A person in two cohort seasons keeps the
  // one with the later startDate.
  let added = 0;
  for (const c of cohort) {
    for (const p of playersForSeason(c.seasonId)) {
      if (!p.uuid) continue;
      const cur = reg.players[p.uuid];
      if (!cur) {
        reg.players[p.uuid] = {
          name: p.name || null, at: null,
          from: { seasonId: c.seasonId, compName: c.compName, club: null, clubName: null },
          tracked: [], other: [],
        };
        added++;
      } else if (!cur.from || String(cohortById.get(cur.from.seasonId)?.startDate || '') < c.startDate) {
        cur.from = { ...(cur.from || {}), seasonId: c.seasonId, compName: c.compName };
      }
    }
  }

  // ⚠️ ONLY PEOPLE IN THIS RUN'S COHORT ARE WALKED. A player whose competition
  // is still in season stays in the file untouched, with their previous answer
  // and their previous `at`. Walking them would record nothing (see the header)
  // and would spend a call doing it.
  const inCohort = (rec) => rec.from && cohortById.has(rec.from.seasonId);
  const everyone = Object.entries(reg.players).filter(([, rec]) => inCohort(rec));
  const people = everyone.length;
  log(`cohort: ${people} people (${added} new to the file; ${Object.keys(reg.players).length - people} in the file but in season)`);

  // ── Order ───────────────────────────────────────────────────────────────────
  // Oldest walked first; never-walked ahead of everyone. That is the whole
  // selection rule now. A run that stops on its time budget resumes exactly
  // where it left off, because the people it walked went to the back.
  const ordered = everyone
    .map(([uuid, rec]) => ({ uuid, rec, at: rec.at ? (parseIso(rec.at) || 0) : -1 }))
    .sort((a, b) => a.at - b.at);
  const plan = FRACTION > 1 ? ordered.slice(0, Math.ceil(people / FRACTION)) : ordered;
  const neverWalked = ordered.filter(x => x.at === -1).length;
  log(`never walked: ${neverWalked}; walking ${plan.length} this run`);

  // ── Walk ────────────────────────────────────────────────────────────────────
  let answered = 0, notFound = 0, errored = 0;
  let clubsHarvested = 0, trackedFound = 0, otherFound = 0, noOwnRecord = 0;
  let multiClub = 0, noOwnOrg = 0, dupClub = 0;
  let lastOrgChanged = 0, lastOrgDiffers = 0, lastOrgSame = 0, lastOrgNull = 0;
  const rf = { set: 0, noFile: 0, alreadyHeld: 0, unreadable: 0, samples: [] };
  const errorSamples = [], noOwnSamples = [];
  const byStatus = {};
  const rawUpcoming = [];
  let lastBeat = Date.now();

  const pool = phq.createPool({
    size: POOL_SIZE, gapMs: GAP_MS, maxCalls: MAX_CALLS, maxAgeMs: 15 * 60 * 1000,
    blockWaitMs: BLOCK_WAIT_MS,
  });
  log(`  pool caps per session: ${pool.describe().caps.join(', ')}`);

  const stoppedForTime = { yes: false };
  const result = await pool.each(plan, async ({ uuid, rec }, call) => {
    // ⚠️ NOTHING IS MUTATED BEFORE THE CALL RETURNS. A blocked call is requeued
    // by the pool and this handler never finishes, so anything written ahead of
    // the call would be written twice.
    const json = await call(Q_PROFILE, { profileID: uuid }, 'PublicProfileTeams');
    const at = isoAt(Date.now());

    if (json.errors && json.errors.length) {
      const msg = String(json.errors[0].message || '');
      if (/NOT_FOUND|failed to find profile/i.test(msg)) {
        notFound++;
        rec.at = at;
        rec.missing = true;
      } else {
        errored++;
        if (errorSamples.length < 5) errorSamples.push(`${uuid}: ${msg.slice(0, 160)}`);
      }
      return;
    }
    answered++;
    delete rec.missing;

    const teams = json?.data?.publicProfileTeams || [];
    const fromSeason = cohortById.get(rec.from?.seasonId);
    // Fall back to our startDate if the manifest lacks an endDate — that is the
    // v1 rule and over-includes, so it is logged once below.
    const fromEnd = fromSeason ? (fromSeason.endDate || fromSeason.startDate) : '';
    const tracked = [], other = [];
    let sawOwn = false;
    let ownRecs = null;

    for (const t of teams) {
      const sid = t.season?.id || null;
      const st = t.season?.status?.value || null;
      byStatus[st || '(none)'] = (byStatus[st || '(none)'] || 0) + 1;

      // Harvest before you strip: the player's own cohort-season record names
      // their club. Take it, then drop the record as already stored.
      //
      // ⚠️ A PERMIT PLAYER HAS TWO RECORDS FOR ONE SEASON, one per club, and
      // until v14 this assignment ran twice and PlayHQ's array order decided
      // which survived. Measured 2026-11-26 on the whole Norwood
      // Gold/Heathmont side: 12 of 24 players had two, Heathmont listed first
      // and Norwood second every time, so the HOST club won and twelve
      // Heathmont players were recorded as Norwood's. See
      // docs/permit_revert_design.md.
      //
      // Every record is kept now, in PlayHQ's order, and `from.club` is the
      // FIRST rather than the last — not because first is righter, but so the
      // field stops depending on array order. Which one is HOME is decided
      // downstream by build-transfers, which knows the organisation whose team
      // the player actually played for; this script does not.
      if (sid && sid === rec.from?.seasonId) {
        sawOwn = true;
        if (t.organisation?.id) {
          if (!rec.from.club) clubsHarvested++;
          if (!Array.isArray(ownRecs)) ownRecs = [];
          ownRecs.push({
            id: t.organisation.id,
            name: t.organisation.name || null,
            // ⚠️ THE TEAM TRAVELS, for the log and for a human reading the
            // file. It is NOT what the home-club rule matches on: stored team
            // names are age-stripped, so "Norwood Gold/Heathmont U12" here
            // never equals "Norwood Gold/Heathmont" there. Organisation ids
            // are compared instead.
            team: t.name || null,
          });
        }
      }
      const start = String(t.season?.startDate || '');
      if (!start || start <= fromEnd) continue;        // own season, earlier, or concurrent

      if (st && st !== 'COMPLETED' && st !== 'ACTIVE' && rawUpcoming.length < RAW_UPCOMING_LIMIT) rawUpcoming.push(t);

      if (sid && manifestById.has(sid)) {
        const m = manifestById.get(sid);
        const clubName = t.organisation?.name || null;
        tracked.push({
          seasonId: sid, compName: m.compName || null, status: st,
          club: t.organisation?.id || null, clubName,
          team: t.name && t.name !== clubName ? t.name : null, name: t.name || null,
        });
      } else {
        // Dates travel with outside registrations so the panel can tell a season
        // from a carnival: the first real run found "AFL Nines at Byron", a
        // two-day event, as a player's only post-season registration. ⚠️ THE
        // ORGANISATION ID TRAVELS WITH IT — data/organisations.json is keyed on
        // the id, and matching on league names is how clubs get mismatched.
        other.push({
          league: t.season?.competition?.name || null, season: t.season?.name || null, status: st,
          club: t.organisation?.id || null, clubName: t.organisation?.name || null,
          startDate: start || null, endDate: t.season?.endDate || null,
        });
      }
    }
    rec.tracked = tracked;
    rec.other = other;

    // ⚠️ WRITTEN ONLY WHEN THE CALL ANSWERED. Clearing it on a failed call
    // would silently drop a player's second club and look like the permit
    // ending, which is the exact confusion this field exists to remove.
    // ⚠️ THE SAME CLUB TWICE IS ONE CLUB. A player can hold several
    // registrations with their OWN club inside one season id — a lightning
    // premiership is the common case, its team name ending " - LP". Measured
    // 2026-11-26: 125 of 127 players the permit rule could not decide were
    // this, registered=[f9f163a0, f9f163a0].
    //
    // build-transfers dedupes as well, so an existing file is read correctly
    // without a fresh walk; this stops the duplicates being written at all.
    // ⚠️ DO NOT REMOVE EITHER ONE on the grounds that the other covers it:
    // the reader protects old files, the writer keeps new ones clean, and a
    // reader that trusts its input is how this defect reached production.
    if (Array.isArray(ownRecs) && ownRecs.length) {
      const seenOrg = new Set();
      const before = ownRecs.length;
      ownRecs = ownRecs.filter(x => !seenOrg.has(x.id) && seenOrg.add(x.id));
      if (ownRecs.length < before) dupClub++;
      rec.from.clubs = ownRecs;
      rec.from.club = ownRecs[0].id;
      rec.from.clubName = ownRecs[0].name;
      if (ownRecs.length > 1) multiClub++;
    } else if (sawOwn) {
      // Own season seen but no organisation on it: leave whatever was held.
      noOwnOrg++;
    }

    // ⚠️ A NOTE, NOT A REGISTRATION. No season and no date, so it cannot be
    // placed in time and must never be counted in a transfer total. Stored
    // under its own key so no reader can mistake it for a tracked registration.
    const lio = json?.data?.publicProfile?.lastInteractedOrganisation;
    if (lio?.id) {
      const changed = rec.lastOrg?.id && rec.lastOrg.id !== lio.id;
      rec.lastOrg = { id: lio.id, name: lio.name || null, at };
      if (changed) lastOrgChanged++;
      if (rec.from?.club && lio.id !== rec.from.club) lastOrgDiffers++;
      else if (rec.from?.club) lastOrgSame++;
    } else {
      // Absent is not the same as unchanged: clear it rather than leaving a
      // stale club sitting there looking current.
      if (rec.lastOrg) delete rec.lastOrg;
      lastOrgNull++;
    }

    // C2, after the record is settled: a career file missing a season of ours.
    flagCareerRefetch(uuid, rec, teams, manifestById, rf);

    rec.at = at;
    if (tracked.length) trackedFound++;
    if (other.length) otherFound++;
    if (!sawOwn) {
      noOwnRecord++;
      if (noOwnSamples.length < 5) {
        noOwnSamples.push(`${uuid} ${rec.name || ''} (${rec.from?.compName}): ${teams.length} registration(s)`);
      }
    }

    // Heartbeat by the clock, not by a call count: with a pool the calls arrive
    // in bursts and a modulo would print unevenly.
    if (Date.now() - lastBeat >= 60000) {
      lastBeat = Date.now();
      const el = (Date.now() - startMs) / 60000;
      const done = answered + notFound + errored;
      const rate = el > 0 ? done / el : 0;
      const left = plan.length - done;
      log(`  ${Math.round(el)}m  ${done}/${plan.length} done  ${rate.toFixed(0)}/min  ` +
        `~${rate > 0 ? Math.round(left / rate) : '?'}m left  (answered ${answered}, not found ${notFound}, errors ${errored})`);
    }
  }, {
    shouldStop: () => {
      if (Date.now() - startMs <= TIME_BUDGET_MS) return false;
      stoppedForTime.yes = true;
      return true;
    },
    onError: (item, e) => {
      errored++;
      if (errorSamples.length < 5) errorSamples.push(`${item.uuid}: thrown — ${e.message}`);
    },
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  const elapsedMin = (Date.now() - startMs) / 60000;
  const done = answered + notFound + errored;
  log('\n--- summary ---');
  log(`walked ${done} of ${plan.length} in ${elapsedMin.toFixed(1)} min ` +
    `(${elapsedMin > 0 ? (done / elapsedMin).toFixed(0) : '0'}/min)` +
    (stoppedForTime.yes ? '  STOPPED FOR TIME' : '') + (result.aborted ? '  ABORTED ON BLOCKS' : ''));
  log(`answered ${answered}  not found ${notFound}  errors ${errored}`);
  log(`pool: ${result.calls} call(s), ${result.rotations} rotation(s), ${result.blockCount} block(s), ` +
    `${result.requeued} requeued, gap now ${result.gapMs}ms` +
    (result.mintFailures ? `, ${result.mintFailures} failed bootstrap(s)` : ''));

  // ⚠️ THE BLOCK TIMESTAMPS ARE THE MEASUREMENT. Whether a WAF block punishes
  // the cookie or the whole runner is not established. Clustered inside a
  // second across different sessions means runner-wide; scattered means
  // per-cookie. Print them so the first real sweep answers it.
  if (result.blocks.length) {
    log(`blocks, in order — session, calls on that session, time:`);
    for (const b of result.blocks) log(`  session ${b.worker}  after ${b.callsOnSession} calls  ${b.atIso}`);
    const span = result.blocks[result.blocks.length - 1].at - result.blocks[0].at;
    log(`  ⚠️ ${result.blocks.length} block(s) spanning ${(span / 1000).toFixed(1)}s across ` +
      `${new Set(result.blocks.map(b => b.worker)).size} session(s). Clustered across different`);
    log(`     sessions means the penalty is RUNNER-WIDE; scattered means per-cookie.`);
  }
  if (result.requeuePending) {
    log(`⚠️ ${result.requeuePending} player(s) were requeued after the last session ran out of queue ` +
      `and were NOT walked. They keep their previous answer and go first next run.`);
  }
  log(`last-interacted club: ${lastOrgSame} same as ours, ${lastOrgDiffers} DIFFERENT, ` +
    `${lastOrgChanged} changed since last walk, ${lastOrgNull} none`);
  log('  ⚠️ A NOTE, NOT A REGISTRATION — it carries no season, so it is never');
  log('     counted in a transfer total. "DIFFERENT" is a lead to follow.');
  log(`clubs harvested this run: ${clubsHarvested}; with a next-season tracked registration: ${trackedFound}; with an outside one: ${otherFound}`);
  log(`  ${dupClub} player(s) held the SAME club more than once — a lightning`);
  log('     premiership or similar; deduped, because that is not a permit.');
  log(`cohort-season registrations per player: ${multiClub} player(s) hold MORE THAN ONE` +
    (noOwnOrg ? `; ${noOwnOrg} had their own season with no organisation on it` : ''));
  log('  ⚠️ MORE THAN ONE MEANS A PERMIT, not a transfer: the player is');
  log('     registered to one club and played in another\'s team. `from.clubs`');
  log('     holds them all; build-transfers decides which is home from the');
  log('     organisation whose team they actually played for.');
  if (!multiClub) {
    log('  ⚠️ ZERO IS SUSPICIOUS. 12 of the 24 players in one joint side had two');
    log('     on 2026-11-26. A zero here means the harvest is no longer seeing');
    log('     the second record, not that joint teams have stopped existing.');
  }
  log(`career refetch flags: ${rf.set} set, ${rf.alreadyHeld} already complete, ` +
    `${rf.noFile} with no career file` + (rf.unreadable ? `, ${rf.unreadable} UNREADABLE` : ''));
  for (const l of rf.samples) log('  ' + l);
  if (Object.keys(byStatus).length) log(`registration statuses seen: ${JSON.stringify(byStatus)}`);
  if (cohort.some(c => !c.endDate)) {
    log(`⚠️ a cohort season has no endDate in the manifest — falling back to the startDate rule for it, which over-includes concurrent seasons`);
  }
  if (noOwnRecord) {
    log(`${noOwnRecord} answered player(s) returned no registration for their own cohort season — club not harvested; first ${noOwnSamples.length}:`);
    for (const l of noOwnSamples) log('  ' + l);
  }
  if (errorSamples.length) { log('first error(s):'); for (const l of errorSamples) log('  ' + l); }
  if (rawUpcoming.length) {
    log(`first ${rawUpcoming.length} pre-season record(s) RAW — is name the club (unassigned) or a team (assigned)?`);
    for (const t of rawUpcoming) log('  ' + JSON.stringify(t));
  }

  reg.meta.version = FILE_VERSION;
  reg.meta.walkedAt = NOW;
  reg.meta.cohortSeasons = cohort.map(c => c.seasonId);
  reg.meta.people = people;
  reg.meta.lastRun = {
    walked: done, answered, notFound, errored,
    calls: result.calls, rotations: result.rotations, blocks: result.blockCount,
    requeued: result.requeued, requeuePending: result.requeuePending,
    gapMs: result.gapMs, poolSize: POOL_SIZE, refetchFlagged: rf.set,
    stoppedForTime: stoppedForTime.yes, aborted: result.aborted,
    minutes: Number(elapsedMin.toFixed(1)),
  };

  phq.logSummary('walk-registrations');

  // ⚠️ THE DATA IS WRITTEN BEFORE THE EXIT CODE IS DECIDED. A degraded run has
  // usually spent an hour collecting; exiting 1 here would fail the job before
  // the commit step and throw all of it away. Exit 3 means "commit this, then
  // fail the job" — the workflow does exactly that.
  const legacyPresent = fs.existsSync(LEGACY_PATH);
  const changed = canon(reg) !== before;
  if (!changed && fs.existsSync(OUT_PATH) && !legacyPresent && !result.aborted) {
    log('No change — exit 2');
    process.exit(2);
  }
  const out = JSON.stringify(reg);
  const gz = zlib.gzipSync(Buffer.from(out, 'utf8'), { level: 9 });
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, gz);
  if (legacyPresent) { fs.unlinkSync(LEGACY_PATH); log(`removed legacy ${path.relative(ROOT, LEGACY_PATH)}`); }
  log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${(gz.length / 1024).toFixed(0)} KB gzipped, ${(out.length / 1024).toFixed(0)} KB plain)`);

  if (result.aborted) {
    console.log(`::error::walk-registrations stopped after ${result.blockCount} WAF blocks. ` +
      `${done} of ${plan.length} players were walked and that data IS committed. ` +
      `Widen WALK_GAP_MS or lower WALK_POOL_SIZE before the next run.`);
    log('Degraded — data written, exit 3');
    process.exit(3);
  }
  log('exit 0');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
