#!/usr/bin/env node
// scripts/probe-team-logo.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-team-logo v1 2026-11-25';

//
// Where can a CURRENT team or club logo be read from, when the season that
// holds it will never be fetched again? READ-ONLY. Writes nothing. About forty
// calls, paced.
//
// ⚠️ WHY THIS EXISTS — measured 2026-11-24, not assumed.
//
// Norwood replaced its logo file. Every stored URL for the club is the same
// one, and it 404s:
//
//   https://res.cloudinary.com/playhq/image/upload/h_96,w_96/v1/production/
//     afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/1696902165682/logo.png
//
// The path carries the organisation UUID — 6d405ccb is Norwood — and a VERSION
// stamp. Replacing the file changes the stamp, so the old URL dies. Fifteen
// `teamLogos` keys for the club all hold that one dead URL; a sixteenth,
// `Donvale/Norwood`, points at a different organisation and still loads.
//
// ⚠️ AND IT CANNOT BE REFRESHED TODAY. Logos only enter `teamLogos` from
// `hLogo`/`aLogo` on match records, harvested by results-engine.js during a
// results fetch. store.fetchTargets() drops a retired season on its FIRST test:
//
//   if (!m.compName || !m.seasonId || m.retired) continue;
//
// Every 2026 season is retired, so `ignore_season_gate` cannot reach them —
// that input only adds non-retired COMPLETE seasons. A dispatch with it set was
// tried on 2026-11-24 (run #533) and fetched the 2027 seasons, which have no
// games and therefore no logos. The map for 2026 team names is frozen for good,
// and the 2027 fetch in April will write keys for 2027 team names, not for
// `Norwood U12 Purple`.
//
// So a logo has to come from somewhere other than a match record. This probe
// asks where.
//
// ⚠️ discoverTeams WORKS ON A COMPLETED SEASON, unlike discoverFixtureByRound —
// verified 2026-08-11 at 969 teams for EFNL 2026, 725 for 2025, 641 for 2024
// (playhq_api_reference.md §8). That is why it is the candidate: it reaches
// exactly the seasons fetchTargets refuses.
//
// ⚠️ INTROSPECTION IS DISABLED ("not allowed by Apollo Server"), so field names
// must be probed ONE AT A TIME. A rejected field fails the whole query, so they
// are never combined until each is known good.
//
// ⚠️ A REJECTION THAT NAMES A TYPE IS EVIDENCE THE FIELD EXISTS.
// "Cannot query field X on type DiscoverTeam" means no such field.
// 'Field "logo" of type "Image" must have a selection of subfields' means it
// DOES exist and was asked for wrongly. The log says which, every time.
//
// ⚠️ A 400 IS NOT RETRIED by lib/playhq.js and its body is RETURNED rather than
// thrown, precisely so a probe can read the GraphQL error — including PlayHQ's
// "Did you mean …?", which is worth more than the rest of the run. One
// candidate therefore costs exactly one call.
//
// TWO MORE QUESTIONS ANSWERED IN THE SAME RUN, because they need the same call:
//
//   EMPTY TEAMS. discoverTeams lists every team in a season and CANNOT return
//   its members (§14a). A team with nobody in it is therefore visible here and
//   invisible to the registrations walk, which only ever sees a team through a
//   player. Section 2 counts them against what data/rosters/ holds.
//
//   GRADES FOR A SEASON NOT YET PLAYED. A team carries its grade once the
//   league grades it (§14a, stage 3). The rosters view can only offer a grade
//   filter for a season with games, because grade comes from the stored
//   `roster` map. Section 3 reports how many 2027 teams are graded yet.
//
// Env: PL_SEASON    a seasonID to probe for teams. Default: the first tracked
//                   next-season entry in the manifest.
//      PL_PLAYED    a COMPLETED/retired seasonID, to prove discoverTeams
//                   reaches one. Default: the newest season that has a players
//                   file, which is what fetchTargets refuses.
//      PL_ORG       an 8-character organisation code for the club probes.
//                   Default: 6d405ccb, the club whose logo is broken.
//      PL_PACE_MS   gap between calls. Default 800, the walk's measured-safe
//                   value. Forty calls at 800ms is well under a minute of
//                   budget and nowhere near anything that has blocked.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const ROSTERS_DIR = path.join(ROOT, 'data', 'rosters');
const SEASON = (process.env.PL_SEASON || '').trim();
const PLAYED = (process.env.PL_PLAYED || '').trim();
const ORG = (process.env.PL_ORG || '6d405ccb').trim();
const PACE_MS = Math.max(0, Number(process.env.PL_PACE_MS || 800));

const log = (...a) => console.log(...a);
let calls = 0;

// Candidate shapes. Cheapest and most likely first; each is ONE call.
//
// Scalar forms come before object forms deliberately: if `logo` is a scalar URL
// the scalar probe succeeds outright, and if it is an object the rejection NAMES
// the type, which tells us what to ask for next without spending a guess.
const LOGO_CANDIDATES = [
  'logo',
  'logoUrl',
  'image',
  'imageUrl',
  'avatar',
  'avatarUrl',
  'badge',
  'crest',
  'logo { url }',
  'image { url }',
  'media { url }',
];

async function tryQuery(label, query, variables) {
  // ⚠️ THE operationName MUST MATCH THE NAME IN THE QUERY TEXT or PlayHQ answers
  // HTTP 500 "Unknown operation named X" — and a 500 IS retried four times, so a
  // mismatch costs four calls and teaches nothing. Take the name from the text
  // rather than asserting one. probe-team-roster.js v2 lost 28 calls to this.
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  calls++;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false, fatal: true }; }
  if (PACE_MS) await phq.sleep(PACE_MS);

  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    const exists = /must have a selection of subfields|Unknown argument|Cannot return null|cannot be queried on/i.test(msg);
    const hint = /Did you mean/i.test(msg) ? msg.slice(msg.search(/Did you mean/i)) : '';
    log(`    ${label}: ${exists ? 'FIELD EXISTS, asked wrongly' : 'rejected'} — ${msg.slice(0, 150)}`);
    if (hint) log(`      ↳ ${hint.slice(0, 140)}`);
    return { ok: false, exists };
  }
  // ⚠️ LOG THE SUCCESSES TOO, with their data. A probe that only logs failures
  // hides its single most useful result — that happened to probe-team-roster v3,
  // where discoverTeam(teamID:) passed in silence and the absence was read as a
  // failure.
  log(`    ${label}: ACCEPTED — ${JSON.stringify(json && json.data).slice(0, 300)}`);
  return { ok: true, data: json && json.data };
}

// Pull every string that looks like a URL out of an arbitrary response, so a
// logo found under a field name this probe did not predict is still reported.
function urlsIn(obj, out) {
  out = out || [];
  if (obj == null) return out;
  if (typeof obj === 'string') { if (/^https?:\/\//.test(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach(x => urlsIn(x, out)); return out; }
  if (typeof obj === 'object') { Object.values(obj).forEach(v => urlsIn(v, out)); return out; }
  return out;
}

// Does a URL actually resolve? This is the whole question for Norwood — the
// stored one is a perfectly well-formed string that 404s.
//
// ⚠️ "COULD NOT CHECK" IS NOT "DEAD". A runner with no egress to Cloudinary
// throws, and counting that as a 404 would report "the API is serving stale
// URLs too" when nothing of the sort had been established. Returns
// { status, ok, checked } so the verdict can tell the three apart.
//
// Memoised: section 7 printed each URL and then re-tested it to count the live
// ones, so every URL was fetched twice and the two results could in principle
// disagree.
const _urlCache = new Map();
async function checkUrl(u) {
  if (_urlCache.has(u)) return _urlCache.get(u);
  let r;
  try {
    const res = await fetch(u, { method: 'GET' });
    r = { status: res.status, ok: res.status === 200, checked: true };
  } catch (e) {
    r = { status: `unreachable (${e.message})`, ok: false, checked: false };
  }
  _urlCache.set(u, r);
  return r;
}

function rosterTeamCount(sid) {
  const f = path.join(ROSTERS_DIR, `${sid}.json.gz`);
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
    let teams = 0;
    for (const c of Object.values(d.clubs || {})) teams += Object.keys(c.teams || {}).length;
    return teams;
  } catch (e) { return null; }
}

async function main() {
  log(`=== ${VERSION} (${phq.LIB_VERSION}, store ${store.STORE_VERSION}) ===`);
  log(`READ-ONLY: nothing is written. Pace ${PACE_MS}ms between calls.\n`);

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  if (!manifest.length) { console.error('FATAL: no seasons in the manifest.'); process.exit(1); }
  const teamLogos = core.teamLogos || {};
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));

  // A season that has been played: it has a players file. That is the class of
  // season fetchTargets refuses once it is retired, and the one whose logos are
  // stranded.
  const hasPlayers = (sid) => fs.existsSync(path.join(store.SEASONS_DIR, `${sid}-players.json`));
  const playedSeasons = manifest.filter(m => hasPlayers(m.seasonId))
    .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  const nextSeasons = manifest.filter(m => yearOf(m.compName) === latest && !hasPlayers(m.seasonId));

  const playedID = PLAYED || (playedSeasons[0] && playedSeasons[0].seasonId);
  const seasonID = SEASON || (nextSeasons[0] && nextSeasons[0].seasonId) || playedID;
  const nameOf = (sid) => (manifest.find(m => m.seasonId === sid) || {}).compName || sid;
  const entryOf = (sid) => manifest.find(m => m.seasonId === sid) || {};

  log('── what is being probed ──');
  log(`  next season   ${seasonID}  ${nameOf(seasonID)}  ` +
    `[state ${entryOf(seasonID).state}, retired ${!!entryOf(seasonID).retired}]`);
  log(`  played season ${playedID}  ${nameOf(playedID)}  ` +
    `[state ${entryOf(playedID).state}, retired ${!!entryOf(playedID).retired}]`);
  log(`  organisation  ${ORG}`);

  // What the stored map holds for this organisation, and whether it still works.
  log(`\n── the stored logos for organisation ${ORG} ──`);
  const stored = Object.entries(teamLogos).filter(([, u]) => String(u || '').includes(ORG));
  if (!stored.length) {
    log(`  no teamLogos entry references ${ORG}. Nothing stored to compare against.`);
  } else {
    const distinct = [...new Set(stored.map(([, u]) => u))];
    log(`  ${stored.length} key(s), ${distinct.length} distinct URL(s):`);
    for (const u of distinct) {
      const st = await checkUrl(u);
      log(`    ${st.checked ? 'HTTP ' + st.status : st.status}  ${u}`);
      log(`      keys: ${stored.filter(([, v]) => v === u).map(([k]) => k).slice(0, 6).join(', ')}` +
        (stored.filter(([, v]) => v === u).length > 6 ? ' …' : ''));
    }
  }

  await phq.ensureSession();

  // ── 1. baseline, ON A SEASON fetchTargets REFUSES ─────────────────────────
  // ⚠️ THIS IS THE LOAD-BEARING CLAIM OF THE WHOLE PROBE. If discoverTeams does
  // not answer for a retired, completed season then no amount of logo fields
  // helps, because there is no route to the teams at all. It is checked first
  // and the run stops here if it fails.
  log(`\n── 1. does discoverTeams answer for a RETIRED, COMPLETED season? (${nameOf(playedID)}) ──`);
  const basePlayed = await tryQuery('id + name + organisation',
    `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) {
      id name organisation { id name } } }`, { seasonID: playedID });
  if (!basePlayed.ok) {
    log('  ⚠️ IT DOES NOT. There is no route to a retired season\'s teams, so a logo');
    log('     refresh cannot be built this way. Stopping — everything below would');
    log('     be probing a road that does not exist.');
    phq.logSummary();
    process.exit(1);
  }
  const playedTeams = (basePlayed.data && basePlayed.data.discoverTeams) || [];
  log(`  ${playedTeams.length} team(s) in a season fetchTargets will not fetch.`);
  const ourOrgTeams = playedTeams.filter(t => t.organisation && t.organisation.id === ORG);
  log(`  ${ourOrgTeams.length} of them belong to ${ORG}` +
    (ourOrgTeams.length ? ` — e.g. ${ourOrgTeams.slice(0, 3).map(t => t.name).join(', ')}` : ''));

  // ── 2. the next season: teams we can see, against teams we hold ───────────
  log(`\n── 2. teams in ${nameOf(seasonID)}, against what data/rosters holds ──`);
  const baseNext = await tryQuery('id + name + organisation',
    `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) {
      id name organisation { id name } } }`, { seasonID });
  const nextTeams = (baseNext.data && baseNext.data.discoverTeams) || [];
  const held = rosterTeamCount(seasonID);
  log(`  discoverTeams : ${nextTeams.length} team(s)`);
  if (held === null) {
    log('  data/rosters  : no file for this season yet — run build-transfers first.');
  } else {
    log(`  data/rosters  : ${held} team(s) with at least one player`);
    // ⚠️ THIS IS THE EMPTY-TEAM COUNT, and it is a SUBTRACTION, not a probe.
    // discoverTeams cannot return members (§14a), so a team with nobody in it
    // looks exactly like a full one from here; the only way to count them is
    // against what the walk found through players.
    const empty = nextTeams.length - held;
    log(`  ⇒ ${empty} team(s) exist with NO player we have seen` +
      (empty < 0 ? '  ⚠️ NEGATIVE — we hold teams PlayHQ does not list, which needs explaining'
                 : empty === 0 ? '  (every team has at least one)' : ''));
  }

  // ── 3. grade coverage on the next season ──────────────────────────────────
  log(`\n── 3. is ${nameOf(seasonID)} graded yet? ──`);
  const graded = await tryQuery('grade { id name }',
    `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) {
      id name grade { id name } } }`, { seasonID });
  if (graded.ok) {
    const gs = (graded.data && graded.data.discoverTeams) || [];
    const withGrade = gs.filter(t => t.grade && (t.grade.name || t.grade.id));
    log(`  ${withGrade.length} of ${gs.length} team(s) carry a grade.`);
    const names = [...new Set(withGrade.map(t => t.grade.name).filter(Boolean))].sort();
    log(`  ${names.length} distinct grade name(s)${names.length ? ': ' + names.slice(0, 12).join(', ') : ''}` +
      (names.length > 12 ? ' …' : ''));
    if (!withGrade.length) {
      log('  ⇒ NOT GRADED YET. The rosters grade filter cannot offer anything for');
      log('     this season until the league grades its teams; age is all there is.');
    }
  }

  // ── 4. logo fields on discoverTeams ───────────────────────────────────────
  log('\n── 4. logo fields on DiscoverTeam, ONE AT A TIME ──');
  const found = [];
  for (const f of LOGO_CANDIDATES) {
    const r = await tryQuery(f,
      `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) { id ${f} } }`,
      { seasonID: playedID });
    if (r.ok) found.push({ where: 'DiscoverTeam', field: f, data: r.data });
    if (r.fatal) break;
  }

  // ── 5. logo fields on the team's ORGANISATION ─────────────────────────────
  // The logo is a club asset — the URL embeds the organisation's UUID, not the
  // team's — so this is the likelier home of the two.
  log('\n── 5. logo fields on organisation { } inside discoverTeams ──');
  for (const f of LOGO_CANDIDATES) {
    const r = await tryQuery(`organisation { ${f} }`,
      `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) {
        id organisation { id ${f} } } }`, { seasonID: playedID });
    if (r.ok) found.push({ where: 'DiscoverTeam.organisation', field: f, data: r.data });
    if (r.fatal) break;
  }

  // ── 6. discoverOrganisation, which is one call per CLUB ───────────────────
  // ⚠️ `code` IS A String, NOT an ID, and it is the 8-CHARACTER form. The UUID
  // returns null rather than an error (§6), which is the failure mode that looks
  // like "no logo" and is really "wrong id shape".
  log(`\n── 6. logo fields on discoverOrganisation(code: "${ORG}") ──`);
  const orgBase = await tryQuery('id name',
    `query Probe($code: String!) { discoverOrganisation(code: $code) { id name } }`, { code: ORG });
  if (orgBase.ok) {
    for (const f of LOGO_CANDIDATES) {
      const r = await tryQuery(f,
        `query Probe($code: String!) { discoverOrganisation(code: $code) { id ${f} } }`, { code: ORG });
      if (r.ok) found.push({ where: 'DiscoverOrganisation', field: f, data: r.data });
      if (r.fatal) break;
    }
  } else {
    log('  the baseline organisation query failed, so the field probes below would');
    log('  all fail for that reason rather than for the field. Skipped.');
  }

  // ── 7. anything that answered: is the URL alive? ──────────────────────────
  log('\n── 7. verdict ──');
  if (!found.length) {
    log('  NO logo field was accepted anywhere.');
    log('  ⇒ There is no API route to a current logo from these three operations.');
    log('     The stored map cannot be refreshed without a results fetch, and a');
    log('     retired season is never fetched. Read the "FIELD EXISTS, asked');
    log('     wrongly" lines and any "Did you mean" hints above before concluding');
    log('     the field does not exist — those two are different answers.');
  } else {
    for (const f of found) log(`  ACCEPTED  ${f.where}.${f.field}`);
    const urls = [...new Set(found.flatMap(f => urlsIn(f.data)))];
    log(`\n  ${urls.length} distinct URL(s) came back. Checking each actually resolves —`);
    log('  a URL that 404s is exactly the state we are trying to get out of:');
    const live = [], dead = [], unchecked = [];
    for (const u of urls.slice(0, 12)) {
      const st = await checkUrl(u);
      const isStored = Object.values(teamLogos).includes(u);
      log(`    ${st.checked ? 'HTTP ' + st.status : st.status}  ` +
        `${isStored ? '(SAME as stored)' : '(NEW)'}  ${u}`);
      (st.ok ? live : st.checked ? dead : unchecked).push(u);
    }
    if (live.length) {
      log(`\n  ⇒ ${live.length} live URL(s). A refresh is buildable: one call per season`);
      log('     over discoverTeams, or one per club over discoverOrganisation,');
      log('     rewrites teamLogos — and it reaches retired seasons, which a');
      log('     results fetch cannot.');
    } else if (dead.length && !unchecked.length) {
      log('\n  ⇒ Every URL returned is dead too. The API is serving the same stale');
      log('     reference, so refreshing from here would change nothing.');
    } else {
      // ⚠️ THE HONEST ANSWER WHEN THE CHECKER ITSELF FAILED.
      log(`\n  ⇒ ${unchecked.length} URL(s) COULD NOT BE CHECKED from this runner — that is`);
      log('     not evidence they are dead. The field exists and returned a URL,');
      log('     which is the part that matters; open one in a browser to settle');
      log('     whether it resolves.');
    }
  }

  log(`\ncalls made: ${calls}`);
  phq.logSummary();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
