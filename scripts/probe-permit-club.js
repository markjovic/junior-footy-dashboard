#!/usr/bin/env node
// scripts/probe-permit-club.js
//
// Is a permit player's HOME club visible anywhere in publicProfileTeams?
//
// ⚠️ THE QUESTION. Norwood and Heathmont field a joint U12 side, "Norwood
// Gold/Heathmont". Twelve of its players appear in the dashboard as Norwood →
// Heathmont departures for 2027. Mark says they were Heathmont players all
// along, on a season permit, and are simply reverting to their home club — so
// Norwood's net loss is overstated by however many of them there are.
//
// ⚠️ WHAT THE WALK DOES TODAY, AND WHY IT COULD NOT ANSWER THIS.
// walk-registrations.js harvests the cohort season's club like so:
//
//     if (sid && sid === rec.from?.seasonId) {
//       if (t.organisation?.id) { rec.from.club = t.organisation.id; ... }
//     }
//     const start = String(t.season?.startDate || '');
//     if (!start || start <= fromEnd) continue;   // own season, earlier, or concurrent
//
// Two consequences, neither of them obvious:
//
//   1. ANY record starting on or before the cohort season's end is DISCARDED.
//      A second 2026 registration at the player's home club is exactly such a
//      record, so if PlayHQ serves one, the walk has been throwing it away.
//   2. If TWO records share the cohort season id, `rec.from.club` is set twice
//      and the LAST one in PlayHQ's array wins. That is not a decision, it is
//      an accident of array order, and it decides which club the dashboard
//      says the player is leaving.
//
// So the honest answer to "can we tell a real departure from a permit expiring"
// is: not from what we store. This probe asks whether we COULD.
//
// ⚠️ READ-ONLY. No file is written, nothing is committed. It makes one call per
// named player — a handful, not a sweep.
//
// Env:
//   PP_PLAYERS  comma-separated names or uuids. Default: the twelve-player
//               U12 case above, five of them.
//   PP_PACE_MS  delay between calls, default 900 (about 66/min).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const VERSION = 'probe-permit-club v1 2026-11-26 joint-team-home-club';

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const DEFAULT_PLAYERS = 'Archie Ward,Harley Thomas,Henry Tsantis,Jake Tomietto,Zach Watson';
const WANT = String(process.env.PP_PLAYERS || DEFAULT_PLAYERS)
  .split(',').map(s => s.trim()).filter(Boolean);
const PACE_MS = Math.max(0, Number(process.env.PP_PACE_MS || 900));

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const Q = `query PublicProfileTeams($profileID: ID!) {
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

(async () => {
  log(`=== ${VERSION} (playhq ${phq.LIB_VERSION}, store ${store.STORE_VERSION}) ===`);
  log(`players: ${WANT.length}   pace: ${PACE_MS}ms   READ-ONLY`);

  if (!fs.existsSync(REG_PATH)) die(`${REG_PATH} is missing — run the walk first`);
  const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
  const people = reg.players || {};

  // Resolve each name or uuid to a stored record, so the probe can print what
  // we HOLD beside what PlayHQ SERVES. Without the stored side there is nothing
  // to compare and the dump is just data.
  const targets = [];
  for (const w of WANT) {
    if (people[w]) { targets.push({ uuid: w, rec: people[w] }); continue; }
    const f = fold(w);
    const hits = Object.entries(people).filter(([, r]) => fold(r.name) === f);
    if (!hits.length) { log(`  ⚠️ no stored player matches "${w}" — skipped`); continue; }
    if (hits.length > 1) log(`  ⚠️ "${w}" matches ${hits.length} players; taking all`);
    for (const [uuid, rec] of hits) targets.push({ uuid, rec });
  }
  if (!targets.length) die('no players resolved — nothing to probe');

  await phq.ensureSession();

  let sameSeasonMulti = 0, homeClubFound = 0, checked = 0;
  for (const { uuid, rec } of targets) {
    if (checked++) await phq.sleep(PACE_MS);
    const from = rec.from || {};
    log('');
    log(`── ${rec.name || '(unnamed)'}  ${uuid}`);
    log(`   stored: cohort season ${from.seasonId || '(none)'} ${from.compName || ''}`);
    log(`           from.club ${from.club || '(none)'}  ${from.clubName || ''}`);
    log(`           lastOrg   ${(rec.lastOrg && rec.lastOrg.id) || '(none)'}  ` +
      `${(rec.lastOrg && rec.lastOrg.name) || ''}`);

    let json;
    try { json = await phq.gqlPost(Q, { profileID: uuid }, 'PublicProfileTeams'); }
    catch (e) { log(`   ⚠️ call failed: ${e.message}`); continue; }
    if (json.errors && json.errors.length) {
      log(`   ⚠️ ${String(json.errors[0].message || '').slice(0, 160)}`);
      continue;
    }
    const teams = (json.data && json.data.publicProfileTeams) || [];
    log(`   PlayHQ returns ${teams.length} record(s):`);

    // ⚠️ EVERY RECORD, INCLUDING THE ONES THE WALK DROPS. That is the point:
    // the walk skips anything starting on or before the cohort season's end,
    // which is exactly where a home-club registration would sit.
    const inCohort = [];
    for (const t of teams) {
      const s = t.season || {};
      const org = t.organisation || {};
      const own = s.id && s.id === from.seasonId;
      if (own) inCohort.push({ org: org.id, orgName: org.name, team: t.name });
      log(`     ${own ? '>>' : '  '} ${String(s.name || '?').padEnd(6)} ` +
        `${String(s.startDate || '?')}..${String(s.endDate || '?')} ` +
        `${String((s.status && s.status.value) || '?').padEnd(9)} ` +
        `org ${String(org.id || '?')} ${String(org.name || '?')}`);
      log(`        team "${t.name || ''}"   comp "${(s.competition && s.competition.name) || ''}"`);
    }

    // ── the two things this probe exists to settle ──────────────────────────
    if (inCohort.length > 1) {
      sameSeasonMulti++;
      const orgs = [...new Set(inCohort.map(x => x.org))];
      log(`   ⚠️ ${inCohort.length} RECORDS SHARE THE COHORT SEASON, naming ` +
        `${orgs.length} organisation(s):`);
      for (const x of inCohort) log(`        ${x.org} ${x.orgName}  via "${x.team}"`);
      if (orgs.length > 1) {
        homeClubFound++;
        log('      → the home club IS visible, and `rec.from.club` is currently');
        log('        whichever of these PlayHQ listed LAST. That is the bug.');
      }
    } else if (inCohort.length === 1) {
      log(`   one record for the cohort season: org ${inCohort[0].org} ` +
        `${inCohort[0].orgName} via "${inCohort[0].team}"`);
    } else {
      log('   ⚠️ NO record for the cohort season at all.');
    }
  }

  log('');
  log('── verdict ──');
  log(`  players probed                                   : ${checked}`);
  log(`  with MORE THAN ONE record in the cohort season   : ${sameSeasonMulti}`);
  log(`  where those records name DIFFERENT organisations : ${homeClubFound}`);
  if (homeClubFound) {
    log('  → A permit player\'s home club is recoverable. The walk must keep');
    log('    every cohort-season record instead of letting the last one win,');
    log('    and build-transfers must treat a revert to the home club as the');
    log('    END OF A PERMIT, not as a departure.');
  } else if (sameSeasonMulti) {
    log('  → Several records per season, but all the same organisation, so');
    log('    this route does NOT distinguish a permit from a transfer.');
  } else {
    log('  → One record per season. PlayHQ serves the TEAM\'s organisation and');
    log('    nothing about where the player is registered, so a permit cannot');
    log('    be told from a transfer by this query. A different route is needed');
    log('    before any of this is built.');
  }
  log('');
  log('⚠️ NOTHING WAS WRITTEN. This probe only reads.');
  phq.logSummary('probe-permit-club');
})().catch(e => die(e && e.stack ? e.stack : String(e)));
