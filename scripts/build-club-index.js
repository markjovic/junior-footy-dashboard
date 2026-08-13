#!/usr/bin/env node
// scripts/build-club-index.js
//
// Builds a first-class club index and merges it into data.json.
//
// WHY THIS EXISTS
// PlayHQ has a real club concept, but DiscoverTeam does not expose it — proven
// on 2026-08-09: "Cannot query field \"club\" on type \"DiscoverTeam\"", and
// introspection is disabled so the schema cannot be read. Deriving clubs from
// team names is not viable: "Norwood Gold/Heathmont U12" is a merged team, and
// no stripping rule maps it to Norwood.
//
// The route that works was established by probe-club-index.js:
//   PlayHQ logo URLs embed the owning organisation's UUID —
//     /production/afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/.../logo.png
//   whose first 8 hex characters are the public organisation code (6d405ccb =
//   Norwood). Every match record already stores hLogo/aLogo, so club identity
//   is already in data.json and needs no re-crawl of match data.
//   discoverOrganisation(code) then returns the official name and confirms
//   type === "CLUB".
//
// Probe result, EFNL 2026: 113 distinct club ids across 456 teams, 8 teams
// without any logo, and 10 of 10 sampled ids resolved as CLUB.
//
// discoverTeams(filter:{seasonID, organisationID}) is deliberately NOT used.
// It only returns teams registered under that season, so a club from another
// league fielding a team in an EFNL grade comes back empty — which is correct
// behaviour for that call and useless for identifying clubs.
//
// OUTPUT (merged into data.json, plus a clubs.json cache)
//   clubs:    { "6d405ccb": { name, type } }
//   teamClub: { "EFNL 2026|Norwood Purple|U12": "6d405ccb" }
//
// Teams are keyed compName|teamName|age, matching rebuildRoster exactly.
// Age is load-bearing, not decoration. PlayHQ routinely registers a senior and
// a junior club as separate organisations — Templestowe is 225d5de5 "Templestowe
// (Eastern Football Netball League)" and 2545b284 "Templestowe Junior Football
// Club" — and cleanTeam strips the age suffix, so both arrive as plain
// "Templestowe". Without age in the key they collapse into one entry and the
// majority vote silently assigns every senior team to the junior club.
// The same applies within a club: "Norwood U12 Purple" and "Norwood U14 Purple"
// both clean to "Norwood Purple" and are different teams.
//
// Exits 0 when data.json changed, 2 when nothing changed, 1 on fatal error —
// the same contract as fetch-results.js, so the workflow decides on committing.
//
// Usage:
//   node scripts/build-club-index.js
//   node scripts/build-club-index.js --comp="EFNL 2026"
//   node scripts/build-club-index.js --refresh      (re-resolve every club)

'use strict';

const fs     = require('fs');
const path   = require('path');

const ROOT        = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH   = path.join(ROOT, 'data', 'data.json');
const CLUBS_PATH  = path.join(ROOT, 'data', 'clubs.json');

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '250', 10);

// Cooldown pacing. probe-club-index.js saw "There was an error. Please try
// again later." from PlayHQ after a run of calls, so this paces deliberately.
const COOLDOWN_EVERY   = 40;
const COOLDOWN_SECONDS = 20;

// ─── Arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { comp: null, refresh: false };
  for (const arg of argv) {
    const eq  = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--comp':    opts.comp    = val.trim() || null; break;
      case '--refresh': opts.refresh = true; break;
      default:
        if (key.startsWith('--')) { console.error(`Unknown argument: ${key}`); process.exit(1); }
    }
  }
  return opts;
}
const OPTS = parseArgs(process.argv.slice(2));

// ─── HTTP (copied from fetch-results.js) ──────────────────────────────────────

// ─── HTTP / GraphQL ───────────────────────────────────────────────────────────
// Session and transport come from the shared module, so all four writers behave
// identically. The local copies removed here captured only phq_session — not
// phq_tier or phq_sub, which playhq_api_reference.md requires in that order —
// never refreshed inside a run longer than the 30-40 minute cookie life, and
// could not tell a CloudFront WAF block from an expired session.

const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');
const store = require('./lib/store');


// ─── Query ────────────────────────────────────────────────────────────────────
// Argument name and shape copied from the live playhq.com call, not written
// from scratch.

const Q_ORG = `
query discoverOrganisation($organisationCode: String!) {
  discoverOrganisation(code: $organisationCode) {
    id
    type
    name
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The first 8 hex characters of the Cloudinary UUID are the public
// organisation code. Verified against Norwood's club logo and the team logos
// of Blackburn, Donvale and the EFNL league organisation.
function clubIdFromLogo(url) {
  const m = String(url || '').match(/\/production\/[a-z]+\/([0-9a-f]{8})-[0-9a-f-]+\//i);
  return m ? m[1].toLowerCase() : '';
}

function readJson(p, label, fallback) {
  if (!fs.existsSync(p)) {
    if (fallback !== undefined) return fallback;
    console.error(`${label} not found at ${p}`);
    process.exit(1);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    if (fallback !== undefined) { console.warn(`Could not parse ${label} — treating as empty`); return fallback; }
    console.error(`Could not parse ${label}: ${e.message}`);
    process.exit(1);
  }
}

const pad = (s, n) => { const t = String(s); return t.length >= n ? t : t + ' '.repeat(n - t.length); };

// ─── Club resolution ──────────────────────────────────────────────────────────

async function resolveClub(id) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) await sleep(attempt * 3000);
    let res;
    try {
      res = await gqlPost(Q_ORG, { organisationCode: id });
      await sleep(FETCH_DELAY);
    } catch (e) {
      if (attempt === 4) return { error: e.message };
      continue;
    }
    if (res?.errors?.length) {
      const msg = res.errors.map(e => e.message).join('; ');
      if (attempt === 4) return { error: msg };
      continue;
    }
    const o = res?.data?.discoverOrganisation;
    if (!o) return { missing: true };
    return { id: o.id || id, type: o.type || '', name: o.name || '' };
  }
  return { error: 'exhausted' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────


// ─── Data directory ───────────────────────────────────────────────────────────
// Machine-written JSON lives in data/. config.json stays at the repo root because
// it is hand-edited configuration, not generated data.
//
// This moves any legacy root-level copies on first run, so the relocation needs
// no manual git operation — Mark has no local git. It no-ops thereafter. If a
// file exists in BOTH places, data/ is authoritative and the root copy is
// deleted, which is what happens on the run after the move.
function ensureDataDir() {
  const dir = path.join(ROOT, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['data.json', 'grades.json', 'clubs.json']) {
    const legacy = path.join(ROOT, name);
    const target = path.join(dir, name);
    if (!fs.existsSync(legacy)) continue;
    if (fs.existsSync(target)) {
      fs.unlinkSync(legacy);
      console.log(`Removed superseded root copy of ${name}`);
    } else {
      fs.renameSync(legacy, target);
      console.log(`Moved ${name} -> data/${name}`);
    }
  }
}

// Bump on every change. Printed first so a stale copy in an Actions log is
// distinguishable from a real failure.
const VERSION = 'build-club-index v3 2026-08-12 accurate-log';

async function main() {
  ensureDataDir();
  console.log(`=== ${VERSION} ===`);
  console.log(`Options: ${JSON.stringify(OPTS)}`);

  readJson(CONFIG_PATH, 'config.json'); // presence check only
  // Unscoped: the club index is derived from every competition's records, and
  // it writes only cross-organisation keys.
  let data;
  try {
    // Unscoped so every season contributes — teamClub is keyed comp|team|age and
    // holds all eighteen, so a past season's teams resolve to a club too. That
    // is why the finals by-club view showed everything before 2026 as
    // Unattributed: this had not run since the backfill added those seasons.
    //
    // players:false because it reads teamOrg and match records and never a
    // player. Loading them meant 82.57 MB of records this script does not touch.
    data = store.load(null, { players: false });
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
  const cache = readJson(CLUBS_PATH, 'clubs.json', {});
  console.log(`Loaded ${(data.matches || []).length} match record(s) across every season`);
  console.log(`Loaded clubs.json cache: ${Object.keys(cache).length} club(s)`);

  // ── Scan match records for club evidence ──
  // A team can appear in many records. Count the club id seen per team rather
  // than trusting the first, so a single odd logo cannot decide the answer.
  const votes    = new Map(); // "comp|team|age" -> Map(clubId -> count)
  const noLogo   = new Set(); // "comp|team|age" with no logo on any record
  const withLogo = new Set();

  // teamOrg is written by fetch-results.js at fetch time, keyed comp|team|age,
  // and is authoritative: the competition and age were known when the logo was
  // read, so nothing is inferred. It supersedes scanning hLogo/aLogo on match
  // records, which fetch-results.js no longer stores.
  const teamOrgMap = data.teamOrg || {};
  let fromTeamOrg = 0;
  for (const [key, id] of Object.entries(teamOrgMap)) {
    const comp = key.slice(0, key.indexOf('|'));
    if (OPTS.comp && !comp.toLowerCase().includes(OPTS.comp.toLowerCase())) continue;
    if (!id) continue;
    withLogo.add(key);
    if (!votes.has(key)) votes.set(key, new Map());
    votes.get(key).set(id, (votes.get(key).get(id) || 0) + 1);
    fromTeamOrg++;
  }
  console.log(`Club codes from teamOrg (fetch-time): ${fromTeamOrg}`);

  // Fallback for records written before that change, and for the scheduled
  // fixtures fetch-fixtures.js still stores logos on.
  let fromMatchLogos = 0;
  for (const m of (data.matches || [])) {
    if (m.isBye || m.isPartial) continue;
    const comp = m.compName || '';
    if (OPTS.comp && !comp.toLowerCase().includes(OPTS.comp.toLowerCase())) continue;
    for (const [name, logo, prov] of [
      [m.home, m.hLogo, m.provisional && !m.hLogo],
      [m.away, m.aLogo, m.provisional && !m.aLogo],
    ]) {
      if (!name || name.startsWith('__')) continue;
      // A provisional placeholder such as "Winner Game 1" is not a team and
      // must never become a club member.
      if (prov) continue;
      const key = `${comp}|${name}|${m.age || ''}`;
      const id  = clubIdFromLogo(logo);
      if (!id) { noLogo.add(key); continue; }
      withLogo.add(key);
      if (!votes.has(key)) votes.set(key, new Map());
      const v = votes.get(key);
      v.set(id, (v.get(id) || 0) + 1);
      fromMatchLogos++;
    }
  }
  console.log(`Club codes from match logos (fallback): ${fromMatchLogos}`);
  for (const k of [...noLogo]) if (withLogo.has(k)) noLogo.delete(k);

  // Resolve each team to a single club id, reporting any disagreement rather
  // than silently picking one.
  const teamClub = {};
  const conflicts = [];
  for (const [key, v] of votes) {
    const ranked = [...v.entries()].sort((a, b) => b[1] - a[1]);
    teamClub[key] = ranked[0][0];
    if (ranked.length > 1) conflicts.push({ key, ranked });
  }

  const clubIds = new Set(Object.values(teamClub));
  console.log(`\n${Object.keys(teamClub).length} team(s) mapped to ${clubIds.size} club id(s).`);
  console.log(`${noLogo.size} team(s) have no logo on any record and cannot be attributed.`);
  if (noLogo.size) {
    console.log(`  ${[...noLogo].slice(0, 12).join('\n  ')}`);
    if (noLogo.size > 12) console.log(`  ... and ${noLogo.size - 12} more`);
  }
  if (conflicts.length) {
    console.log(`\n*** ${conflicts.length} team(s) had logos pointing at more than one club:`);
    for (const c of conflicts.slice(0, 10)) {
      console.log(`  ${pad(c.key, 44)} ${c.ranked.map(([id, n]) => `${id}x${n}`).join('  ')}`);
    }
    console.log('  Highest count wins. Investigate any that look wrong.');
  }

  // ── Resolve unknown club ids ──
  const toResolve = [...clubIds].filter(id => OPTS.refresh || !cache[id]).sort();
  console.log(`\n${toResolve.length} club id(s) to resolve (${clubIds.size - toResolve.length} already cached).`);

  if (toResolve.length) await refreshSession();

  let resolved = 0, failed = 0, notClub = 0;
  let idx = 0;
  for (const id of toResolve) {
    idx++;
    if (idx > 1 && (idx - 1) % COOLDOWN_EVERY === 0) {
      console.log(`  [cooldown ${COOLDOWN_SECONDS}s after ${idx - 1} lookups]`);
      await sleep(COOLDOWN_SECONDS * 1000);
    }
    const r = await resolveClub(id);
    if (r.error)   { console.log(`  ${pad(id, 10)} FAILED: ${r.error.slice(0, 90)}`); failed++; continue; }
    if (r.missing) { console.log(`  ${pad(id, 10)} no organisation returned`); failed++; continue; }
    cache[id] = { name: r.name, type: r.type };
    if (r.type !== 'CLUB') notClub++;
    resolved++;
    console.log(`  ${pad(id, 10)} ${pad(r.type, 8)} ${r.name}`);
  }
  console.log(`\nResolved ${resolved}, failed ${failed}.`);
  if (notClub) {
    console.log(`${notClub} organisation(s) are not type CLUB — usually the league itself.`);
    console.log('They are kept in the cache so they are not re-fetched, but the dashboard');
    console.log('should only group on entries whose type is CLUB.');
  }

  // ── Build the clubs map actually referenced by teamClub ──
  const clubs = {};
  for (const id of clubIds) if (cache[id]) clubs[id] = cache[id];
  const unresolved = [...clubIds].filter(id => !cache[id]);
  if (unresolved.length) {
    console.log(`\n${unresolved.length} club id(s) still unresolved — teams keep their id but have no name.`);
  }

  // ── Write ──
  const before = JSON.stringify({ clubs: data.clubs || {}, teamClub: data.teamClub || {} });
  // A --comp run must not delete mappings for other competitions.
  // ⚠️ A full run REPLACES teamClub, so a run that resolved almost nothing would
  // silently wipe it. That is exactly what happened when fetch-results.js
  // stopped storing hLogo/aLogo and this script's only evidence source vanished.
  // Refuse rather than commit an empty index — "no data" must never be mistaken
  // for "no clubs".
  const priorTeamClubCount = Object.keys(data.teamClub || {}).length;
  if (!OPTS.comp && priorTeamClubCount > 0 && Object.keys(teamClub).length < priorTeamClubCount * 0.5) {
    console.error(
      `FATAL: resolved ${Object.keys(teamClub).length} team-to-club mappings but ${priorTeamClubCount} ` +
      `are already stored. A full run replaces teamClub, so this would discard most of it.\n` +
      `Check that data.teamOrg is populated — fetch-results.js writes it, and this script depends on it.`
    );
    process.exit(1);
  }

  const mergedTeamClub = OPTS.comp ? { ...(data.teamClub || {}), ...teamClub } : teamClub;
  const mergedClubs    = { ...(data.clubs || {}), ...clubs };
  const after = JSON.stringify({ clubs: mergedClubs, teamClub: mergedTeamClub });

  fs.writeFileSync(CLUBS_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`\nWrote clubs.json (${Object.keys(cache).length} club(s) cached)`);

  if (before === after) {
    console.log('Club index unchanged — skipping data.json write and commit.');
    process.exit(2);
  }

  data.clubs    = mergedClubs;
  data.teamClub = mergedTeamClub;
  data.lastClubIndex = new Date().toISOString();
  // data.json is written MINIFIED. At 53MB pretty-printed it was 98% of the
  // repository, checked out by every workflow run and downloaded by every
  // visitor. All four writers — fetch-results, fetch-fixtures, fetch-stats and
  // build-club-index — must agree, or whichever runs next re-inflates the file
  // and every run produces a whole-file diff.
  // Only clubs and teamClub changed, both cross-organisation. Using save()
  // would rewrite every organisation file with a fresh timestamp and produce a
  // whole-file diff on every run.
  // store.report prints the STORE's version, which reads oddly beside this
  // script's own. Labelled so the two are not mistaken for each other.
  store.report(store.saveCore(data), `${VERSION} via store`);
  console.log(`Wrote data/core.json and data/clubs.json — ${Object.keys(mergedClubs).length} club(s), ` +
    `${Object.keys(mergedTeamClub).length} team mapping(s)`);
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
