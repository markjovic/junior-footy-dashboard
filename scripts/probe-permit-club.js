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
// ⚠️ v2 — WHY A WHOLE TEAM, NOT A SAMPLE. v1 probed five players and all five
// were registered to Heathmont, so it answered "what does a PERMIT player look
// like" and nothing else. The design rule turns on the other half: a player
// registered to the team's OWN club is assumed to hold ONE cohort-season
// record, and that assumption was never tested. If PlayHQ writes two records
// for everyone in a joint side, the rule needs another case.
//
// PP_TEAM reads the whole side out of the rosters file and probes all of it,
// which is ~22 calls — the only way to see both kinds of player at once.
//
// Env:
//   PP_TEAM     "<season> | <club> | <team>", e.g.
//               "EFNL 2026 | Norwood (Eastern Football Netball League) | Norwood Gold/Heathmont U12"
//               Reads data/rosters/ and probes every player in that team.
//   PP_PLAYERS  comma-separated names or uuids. Used when PP_TEAM is blank.
//   PP_PACE_MS  delay between calls, default 900 (about 66/min).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const VERSION = 'probe-permit-club v3 2026-11-26 match-on-org';

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const ROSTER_DIR = path.join(ROOT, 'data', 'rosters');
const TEAM_SPEC = String(process.env.PP_TEAM || '').trim();
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

  // ── a whole team, read from the rosters files ─────────────────────────────
  if (TEAM_SPEC) {
    const parts = TEAM_SPEC.split('|').map(x => x.trim());
    if (parts.length !== 3) {
      die('PP_TEAM must be "<season> | <club> | <team>" — got ' + JSON.stringify(TEAM_SPEC));
    }
    const [wantSeason, wantClub, wantTeam] = parts;
    const idxPath = path.join(ROSTER_DIR, 'index.json');
    if (!fs.existsSync(idxPath)) die(`${idxPath} is missing — run build-transfers first`);
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const ent = (idx.seasons || []).find(x => (x.compName || '') === wantSeason);
    if (!ent) {
      die(`no season "${wantSeason}" in the rosters index. Have: ` +
        (idx.seasons || []).map(x => x.compName).join(', '));
    }
    const f = path.join(ROSTER_DIR, ent.file || `${ent.sid}.json.gz`);
    if (!fs.existsSync(f)) die(`${f} is missing`);
    const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
    // ⚠️ THE KEY IS THE ORGANISATION ID. Taking Object.values() threw it away
    // and left only the name to compare against, which is exactly the mistake
    // this version exists to stop making.
    const hit = Object.entries(d.clubs || {}).find(([, c]) => (c.name || '') === wantClub);
    const clubId = hit ? hit[0] : null;
    const club = hit ? hit[1] : null;
    if (!club) {
      die(`no club "${wantClub}" in ${wantSeason}. Nearest: ` +
        Object.values(d.clubs || {}).map(c => c.name)
          .filter(n => fold(n).includes(fold(wantClub).split(' ')[0] || '\u0000'))
          .slice(0, 5).join(' | ') || '(none)');
    }
    const rows = (club.teams || {})[wantTeam];
    if (!Array.isArray(rows)) {
      die(`no team "${wantTeam}" at ${wantClub}. That club holds: ` +
        Object.keys(club.teams || {}).join(' | '));
    }
    log(`team "${wantTeam}" at ${wantClub}, ${wantSeason}: ${rows.length} player(s)`);
    for (const r of rows) {
      const rec = people[r.u];
      // ⚠️ A PLAYER WITH NO WALK RECORD IS STILL PROBED. Skipping them would
      // quietly bias the answer toward players the walk already understands.
      // ⚠️ THE PLAYED TEAM IS THE TEAM WE ARE ITERATING. It is not in the
      // registrations file — `lastPlayed` lives in build-transfers — so
      // reading it off the record would leave `played` null for everyone and
      // the home-club rule would never be exercised by this probe at all.
      // ⚠️ THE ORGANISATION, NOT THE TEAM NAME. v2 compared names and failed
      // on all twelve permit players: PlayHQ says "Norwood Gold/Heathmont U12"
      // and our stored name is age-stripped to "Norwood Gold/Heathmont".
      // The club fielding the team we are iterating IS the played org.
      targets.push({ uuid: r.u, rec: rec || { name: r.n, from: {} },
        noRec: !rec, played: wantTeam, playedOrg: clubId });
    }
  }

  for (const w of (TEAM_SPEC ? [] : WANT)) {
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
  let oneRecord = 0, noRecord = 0;
  const byHome = new Map();
  for (const { uuid, rec, noRec, played, playedOrg } of targets) {
    if (checked++) await phq.sleep(PACE_MS);
    const from = rec.from || {};
    log('');
    log(`── ${rec.name || '(unnamed)'}  ${uuid}${noRec ? '   ⚠️ no walk record' : ''}`);
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
      // ⚠️ WHICH ONE IS HOME, by the rule the design proposes: the record whose
      // team is NOT the one they played for. Printed per player so the rule can
      // be checked against reality rather than trusted.
      const notPlayed = playedOrg ? inCohort.filter(x => x.org !== playedOrg) : [];
      if (notPlayed.length === 1) {
        log(`      home by the played-organisation rule: ${notPlayed[0].orgName}`);
        byHome.set(notPlayed[0].orgName, (byHome.get(notPlayed[0].orgName) || 0) + 1);
      } else {
        log(`      ⚠️ cannot apply the rule: ${playedOrg
          ? 'played org ' + playedOrg + ' matches ' +
            (inCohort.length - notPlayed.length) + ' of these ' + inCohort.length + ' records'
          : 'no played organisation known (run with PP_TEAM)'}`);
      }
    } else if (inCohort.length === 1) {
      oneRecord++;
      log(`   ONE record for the cohort season: org ${inCohort[0].org} ` +
        `${inCohort[0].orgName} via "${inCohort[0].team}"`);
      byHome.set(inCohort[0].orgName, (byHome.get(inCohort[0].orgName) || 0) + 1);
    } else {
      noRecord++;
      log('   ⚠️ NO record for the cohort season at all.');
    }
  }

  log('');
  log('── verdict ──');
  log(`  players probed                                   : ${checked}`);
  log(`  with exactly ONE record in the cohort season     : ${oneRecord}`);
  log(`  with MORE THAN ONE record in the cohort season   : ${sameSeasonMulti}`);
  log(`  where those records name DIFFERENT organisations : ${homeClubFound}`);
  log(`  with NO record for the cohort season             : ${noRecord}`);
  if (byHome.size) {
    log('  home club, where this probe could tell:');
    for (const [k, v] of [...byHome.entries()].sort((a, b) => b[1] - a[1])) {
      log(`    ${String(v).padStart(4)}  ${k}`);
    }
  }
  // ⚠️ THE QUESTION v2 EXISTS TO ANSWER.
  if (TEAM_SPEC) {
    log('');
    if (oneRecord && sameSeasonMulti) {
      log('  → BOTH SHAPES ARE PRESENT IN ONE TEAM. A player registered to the');
      log('    team\'s own club holds one record; a permit player holds two.');
      log('    The design\'s §4.4 table is complete as written.');
    } else if (oneRecord && !sameSeasonMulti) {
      log('  → EVERY player in this side holds one record, so none of them is');
      log('    on a permit by this measure — which contradicts the five found');
      log('    earlier. Check the team name before trusting this.');
    } else if (!oneRecord && sameSeasonMulti) {
      log('  → ⚠️ EVERY player holds TWO records, including the host club\'s own.');
      log('    The design assumes a host-club player holds ONE, so §4.4 needs');
      log('    another case and the rule must NOT be built as written.');
    }
  }
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
