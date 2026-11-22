#!/usr/bin/env node
// scripts/probe-registration-date.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-registration-date v7 2026-11-23 it-is-a-surname-search';

//
// Two questions, both open after today's work.
//
// 1. IS THERE A DATE ON lastInteractedOrganisation?
//
// ⚠️ WITHOUT ONE, RE-SIGNING WITH THE SAME CLUB IS INVISIBLE. The field names a
// club and nothing else. A player who re-registers with the club they already
// played for leaves it UNCHANGED, so we cannot tell "signed up for 2027" from
// "last played there in 2026". Every one of the 1,187 we found was a player
// moving to a DIFFERENT club — the ones staying put are the blind spot, and
// they are the majority.
//
// A timestamp would close it outright: a club unchanged but interacted with
// LAST WEEK is a re-registration.
//
// 2. WHERE IS THE LIST OF WHO REGISTERED?
//
// It must exist — a registration is taken against a season. `participant(id:)`
// answered "Unauthenticated", NOT "no such field", so the data is there and
// requires a login this pipeline does not have.
//
// ⚠️ RECORD WHICH OPERATIONS REQUIRE AUTH, so the boundary is documented and
// nobody re-probes it. This pipeline is anonymous and stays anonymous.
//
// READ-ONLY: nothing is written. About 30 calls.
//
// ⚠️ PD_ONLY=16 RUNS ONLY THE LAST SECTION. Sections 1-15 are settled and are
// kept as the written record, but re-running 74 calls to reach the one open
// question wastes the budget and the clock.
//
// Env: PD_PROFILE (a uuid), PD_SEASON (a seasonID), PD_PACE_MS (default 900),
//      PD_ONLY (section number to run alone).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const PACE = Math.max(0, Number(process.env.PD_PACE_MS || 900));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryQuery(label, query, variables) {
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false }; }
  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    // ⚠️ THREE DIFFERENT ANSWERS, AND THEY MEAN DIFFERENT THINGS.
    const kind = /unauthenticated|unauthorized|forbidden/i.test(msg) ? 'BEHIND A LOGIN'
      : /must have a selection of subfields|Unknown argument|used in position expecting/i.test(msg) ? 'EXISTS, asked wrongly'
      : 'does not exist';
    // ⚠️ DO NOT TRUNCATE AN ERROR THAT CONTAINS THE ANSWER. A rejected enum
    // value makes GraphQL list EVERY VALID VALUE after the type name, and a
    // 130-character slice cut the list off on every run for four versions —
    // the server was answering the question and the log was throwing it away.
    const full = /does not exist in|must have a selection|of required type|Did you mean/i.test(msg);
    log(`    ${label}: ${kind} — ${msg.slice(0, full ? 600 : 130)}`);
    return { ok: false, kind, msg };
  }
  const d = JSON.stringify(json && json.data);
  log(`    ${label}: ACCEPTED — ${d.slice(0, 230)}`);
  return { ok: true, data: json.data };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');

  let profile = (process.env.PD_PROFILE || '').trim();
  if (!profile && fs.existsSync(REG_PATH)) {
    const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
    // Prefer somebody whose lastOrg we already hold, so a date would be checkable
    // against a club we know.
    for (const [u, r] of Object.entries(reg.players || {})) {
      if (r && r.lastOrg && r.lastOrg.id) { profile = u; break; }
    }
    if (!profile) profile = Object.keys(reg.players || {})[0];
  }
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const season = (process.env.PD_SEASON || '').trim()
    || (manifest.find(m => yearOf(m.compName) === latest) || {}).seasonId;

  const org = Object.keys(core.clubs || {})[0] || '';
  log(`profile : ${profile}`);
  log(`season  : ${season}`);
  log(`org     : ${org}`);
  const ONLY = (process.env.PD_ONLY || '').trim();
  if (ONLY) log(`⚠️ PD_ONLY=${ONLY} — running that section alone\n`); else log('');
  await phq.ensureSession();

  // ── 1. a date anywhere on the profile ──────────────────────────────────────
  if (!ONLY) {
  log('── 1. is there a DATE on the profile or its last organisation? ──');
  for (const f of ['lastInteractedAt', 'lastInteractedDate', 'lastActiveAt', 'updatedAt',
    'createdAt', 'lastSeenAt', 'lastInteraction { at }', 'lastInteraction { date }',
    'lastInteractedOrganisation { id name updatedAt }',
    'lastInteractedOrganisation { id name lastInteractedAt }',
    'lastInteractedOrganisation { id name season { __typename } }']) {
    await tryQuery(`publicProfile { ${f} }`,
      `query P($id: ID!) { publicProfile(profileID: $id) { id ${f} } }`, { id: profile });
    await sleep(PACE);
  }

  // ── 2. the same on the search result type ──────────────────────────────────
  // DiscoverProfile is a different type from whatever publicProfile returns, and
  // has carried a field the other lacked before.
  log('\n── 2. the same fields on the search result type ──');
  for (const f of ['lastInteractedAt', 'updatedAt', 'createdAt']) {
    await tryQuery(`profileSearch result { ${f} }`,
      `query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ` +
      `{ result { id ${f} } } }`, { fullName: 'john smith' });
    await sleep(PACE);
  }

  // ── 3. the registration operations PlayHQ named ────────────────────────────
  // ⚠️ NAMED BY THE SERVER, not invented: "Did you mean registrationAssert,
  // registrationCheck, or seasonRegistrations?"
  log('\n── 3. registrationCheck / registrationAssert / seasonRegistration ──');
  for (const [label, q, vars] of [
    ['registrationCheck(seasonID:)',
      `query Probe($id: ID!) { registrationCheck(seasonID: $id) { __typename } }`, { id: season }],
    ['registrationCheck(profileID:)',
      `query Probe($id: ID!) { registrationCheck(profileID: $id) { __typename } }`, { id: profile }],
    ['registrationAssert(seasonID:)',
      `query Probe($id: ID!) { registrationAssert(seasonID: $id) { __typename } }`, { id: season }],
    ['seasonRegistration(seasonID:)',
      `query Probe($id: ID!) { seasonRegistration(seasonID: $id) { __typename } }`, { id: season }],
    ['discoverSeasonRegistration(id:)',
      `query Probe($id: ID!) { discoverSeasonRegistration(id: $id) { __typename } }`, { id: season }],
    ['discoverSeasonRegistration(code:)',
      `query Probe($id: ID!) { discoverSeasonRegistration(code: $id) { __typename } }`, { id: season }],
  ]) {
    await tryQuery(label, q, vars);
    await sleep(PACE);
  }

  // ── 4. where exactly is the boundary? ──────────────────────────────────────
  // ⚠️ WRITING DOWN WHICH OPERATIONS NEED A LOGIN. That is the whole purpose of
  // this section — the boundary belongs in the reference so it is not rediscovered.
  log('\n── 4. which operations answer "unauthenticated"? ──');
  for (const [label, q, vars] of [
    ['participant(id:)', `query Probe($id: ID!) { participant(id: $id) { __typename } }`, { id: profile }],
    ['myTeamsParticipants { __typename }',
      `query Probe { myTeamsParticipants { __typename } }`, {}],
    ['profile(id:)', `query Probe($id: ID!) { profile(id: $id) { __typename } }`, { id: profile }],
  ]) {
    await tryQuery(label, q, vars);
    await sleep(PACE);
  }

  // ── 5. THE OPERATIONS THAT EXIST BUT REJECTED EVERY ARGUMENT ───────────────
  // ⚠️ "Unknown argument X" MEANS THE FIELD IS REAL. registrationCheck,
  // registrationAssert and discoverSeasonRegistration all exist and refused
  // seasonID, profileID, id and code. The argument has a name we have not
  // guessed, and PlayHQ will tell us: asking with NO arguments makes the server
  // name the required one, exactly as it did for organisationRegistrations
  // ("argument \"code\" of type \"ID!\" is required").
  log('\n── 5. ask with NO arguments, and let the server name them ──');
  for (const op of ['registrationCheck', 'registrationAssert',
    'discoverSeasonRegistration', 'seasonRegistrationCart', 'socialTeamRegistration']) {
    await tryQuery(`${op}() no args`, `query Probe { ${op} { __typename } }`, {});
    await sleep(PACE);
  }

  // ⚠️ A FILTER TYPE IS A NAMED SHAPE, and the server names its fields the same
  // way. myTeamsParticipants wants MyTeamsParticipantsFilter! — passing an empty
  // object makes it list what is missing.
  log('\n── 6. myTeamsParticipants: make the server describe its filter ──');
  for (const [label, vars] of [
    ['empty filter', {}],
    ['filter { seasonID }', { seasonID: season }],
    ['filter { organisationID }', { organisationID: org }],
  ]) {
    await tryQuery(`myTeamsParticipants(filter: ${label})`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { __typename } }`,
      { f: vars });
    await sleep(PACE);
  }

  // ── 7. the TEAM route, now that a 2027 team exists ─────────────────────────
  // ⚠️ `pool` WAS NULL ON EVERY TEAM TRIED — but every team tried was either a
  // 2027 team with nobody in it yet or a completed season. YJFL 2027 now has 217
  // teams that clubs have actually filled. Asking one of those is a different
  // question from the one that was answered NO.
  log('\n── 7. does a FILLED 2027 team expose its players? ──');
  const t = await tryQuery('discoverTeams (a season with filled teams)',
    `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) { id name } }`,
    { seasonID: season });
  await sleep(PACE);
  const teamId = ((t.data && t.data.discoverTeams) || [])[0]?.id;
  if (teamId) {
    for (const f of ['pool { id name }', 'pool { __typename }', 'lineup { id }',
      'squad { id }', 'playerList { id }', 'teamSheet { id }']) {
      await tryQuery(`discoverTeam(${teamId}) { ${f} }`,
        `query Probe($id: ID!) { discoverTeam(teamID: $id) { id name ${f} } }`, { id: teamId });
      await sleep(PACE);
    }
  } else {
    log('    no team returned for this season — nothing to ask.');
  }

  // ── 8. BOTH HALVES OF THE FILTER, TOGETHER ─────────────────────────────────
  // ⚠️ I SUPPLIED THEM ONE AT A TIME AND NEVER BOTH. MyTeamsParticipantsFilter
  // requires seasonID AND organisationID; each attempt named the half that was
  // missing and I read two rejections as a dead end instead of as one
  // instruction. Both are values we already hold for every club and season.
  log('\n── 8. myTeamsParticipants with BOTH filter fields ──');
  const bothFilter = { seasonID: season, organisationID: org };
  for (const f of ['__typename', 'participants { id }', 'items { id }', 'nodes { id }',
    'edges { node { id } }', 'results { id }', 'totalCount']) {
    await tryQuery(`myTeamsParticipants { ${f} }`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { ${f} } }`,
      { f: bothFilter });
    await sleep(PACE);
  }

  // ── 9. FOLLOW THE REGISTRATION ID ──────────────────────────────────────────
  // ⚠️ discoverSeasonRegistration WANTS registrationID: String!, AND
  // seasonRegistrations HANDS US THOSE IDS. The chain has been available since
  // the moment seasonRegistrations was found and nobody followed it: list the
  // registrations for a season, then ask what one of them contains.
  log('\n── 9. seasonRegistrations -> discoverSeasonRegistration ──');
  const list = await tryQuery('seasonRegistrations (for ids)',
    `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id type } }`, { id: season });
  await sleep(PACE);
  const regs = (list.data && list.data.seasonRegistrations) || [];
  log(`    ${regs.length} registration(s) on this season`);
  const regId = regs[0] && regs[0].id;
  if (regId) {
    for (const f of ['__typename', 'id', 'name', 'type', 'organisation { id name }',
      'participants { id }', 'members { id }', 'profiles { id }', 'entrants { id }',
      'season { __typename }', 'fees { __typename }']) {
      await tryQuery(`discoverSeasonRegistration { ${f} }`,
        `query Probe($id: String!) { discoverSeasonRegistration(registrationID: $id) { ${f} } }`,
        { id: regId });
      await sleep(PACE);
    }
  } else {
    log('    no registration id returned — nothing to follow.');
  }

  // ── 10. THE FILTER WANTS A THIRD FIELD ─────────────────────────────────────
  // ⚠️ EACH ROUND THE SERVER NAMES ONE MORE THING. seasonID, then
  // organisationID, and now `type` of SeasonRegistrationType — and we already
  // know its values from seasonRegistrations: PARTICIPANT_TO_CLUB and
  // PARTICIPANT_TO_ASSOCIATION. The list type also has a field called `result`,
  // singular, which it suggested when `results` was rejected.
  log('\n── 10. myTeamsParticipants with all three filter fields ──');
  for (const type of ['PARTICIPANT_TO_CLUB', 'PARTICIPANT_TO_ASSOCIATION']) {
    for (const f of ['result { id }', 'result { id firstName lastName }',
      'result { __typename }']) {
      await tryQuery(`myTeamsParticipants(type: ${type}) { ${f} }`,
        `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { ${f} } }`,
        { f: { seasonID: season, organisationID: org, type } });
      await sleep(PACE);
    }
  }

  // ── 11. WHAT ELSE IS ON DiscoverRegistration ───────────────────────────────
  // ⚠️ `products` AND `endDate` WERE NAMED BY THE SERVER, not guessed —
  // suggested when `profiles` and `entrants` were rejected. seasonRegistrations
  // works and returns these objects, so ask IT rather than
  // discoverSeasonRegistration, which validates the query and then answers
  // "could not be found" at runtime: the field list is right, the ID FORMAT is
  // wrong, and that is a separate problem.
  log('\n── 11. the rest of DiscoverRegistration, via seasonRegistrations ──');
  for (const f of ['products { __typename }', 'products { id name }',
    'startDate', 'endDate', 'name', 'displayName', 'fee', 'url', 'code']) {
    await tryQuery(`seasonRegistrations { ${f} }`,
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id ${f} } }`, { id: season });
    await sleep(PACE);
  }

  // ── 12. the id format discoverSeasonRegistration wants ─────────────────────
  // It took the uuid without complaint and found nothing, so it is keyed on
  // something else. If `code` exists on the object above, that is the candidate.
  log('\n── 12. does discoverSeasonRegistration want a code rather than a uuid? ──');
  const withCode = await tryQuery('seasonRegistrations { id code }',
    `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id code } }`, { id: season });
  await sleep(PACE);
  const code = ((withCode.data && withCode.data.seasonRegistrations) || [])[0]?.code;
  if (code) {
    await tryQuery(`discoverSeasonRegistration(registrationID: "${code}")`,
      `query Probe($id: String!) { discoverSeasonRegistration(registrationID: $id) { id type } }`,
      { id: code });
  } else {
    log('    no code field to try.');
  }

  } // end of the settled sections

  // ── 16. THE ONE OPEN QUESTION: what is a SeasonRegistrationUserType? ───────
  // ⚠️ THE ENUM TRICK IS SPENT. Apollo lists valid values only when the one sent
  // is CLOSE to a real one; "PARTICIPANT_TO_CLUB" was not close to anything and
  // the server said so without naming a single alternative. The remaining way in
  // is a short list of plausible values — and a near-miss would make it suggest
  // the real one, which is the actual goal here.
  //
  // ⚠️ EXPECT "Unauthenticated" EVEN IF ONE IS ACCEPTED. The operation is called
  // myTeamsParticipants. If it answers that, this whole line of enquiry is
  // closed and the per-player walk stands as the only route.
  log('\n── 16. plausible values for SeasonRegistrationUserType ──');
  for (const t of ['PARTICIPANT', 'PLAYER', 'COACH', 'TEAM_MANAGER', 'VOLUNTEER',
    'OFFICIAL', 'ADMIN', 'MEMBER', 'GUARDIAN', 'PARENT']) {
    const r = await tryQuery(`type: ${t}`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { result { __typename } } }`,
      { f: { seasonID: season, organisationID: org, type: t } });
    await sleep(PACE);
    // The moment one is accepted, ask what the participant holds — that is the
    // only reason any of this matters.
    if (r.ok || (r.kind === 'BEHIND A LOGIN')) {
      log(`    ⇒ "${t}" is a VALID value.`);
      if (r.kind === 'BEHIND A LOGIN') {
        log('      …and the operation needs a login, so it is unavailable to us. Closed.');
        break;
      }
      for (const f of ['id', 'profileID', 'participantID', 'displayName', 'fullName']) {
        await tryQuery(`MyTeamsParticipant { ${f} }`,
          `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { result { ${f} } } }`,
          { f: { seasonID: season, organisationID: org, type: t } });
        await sleep(PACE);
      }
      break;
    }
  }

  // ── 17. IT IS A SURNAME SEARCH, AND THE ENUM IS SOLVED ─────────────────────
  // ⚠️ PLAYER, COACH, TEAM_MANAGER, VOLUNTEER and OFFICIAL ARE ALL VALID. Four
  // of the ten guesses were right, and the error then moved PAST the enum to
  // the next missing field:
  //
  //     Field "lastName" of required type "String!" was not provided
  //
  // So myTeamsParticipants is a search for REGISTERED PARTICIPANTS at a club, in
  // a season, of a given type, BY SURNAME. That is the club-side registration
  // list this probe has spent six versions failing to find — and nothing has
  // demanded a login yet.
  //
  // ⚠️ "THE TRICK IS SPENT" WAS WRONG. One round of near-misses moved the error
  // forward. A rejected enum that names no alternatives means the value sent was
  // not close to a real one — it does NOT mean there is nothing to find.
  if (ONLY === '17' || !ONLY) {
  log('\n── 17. myTeamsParticipants with a real surname ──');

  // A surname that certainly exists in this cohort, taken from our own data
  // rather than invented.
  let surname = 'Smith';
  if (fs.existsSync(REG_PATH)) {
    const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
    const counts = {};
    for (const r of Object.values(reg.players || {})) {
      const n = String(r.name || '').trim().split(/\s+/).pop();
      if (n) counts[n] = (counts[n] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) { surname = top[0]; log(`    commonest surname in our cohort: ${top[0]} (${top[1]})`); }
  }

  const base = { seasonID: season, organisationID: org, type: 'PLAYER', lastName: surname };
  for (const f of ['__typename', 'result { __typename }', 'result { id }',
    'result { lastName }', 'result { firstName }', 'result { dateOfBirth }',
    'result { team { id name } }', 'result { organisation { id name } }',
    'result { profile { id } }', 'result { profileID }', 'result { status }',
    'result { registeredAt }', 'result { createdAt }']) {
    await tryQuery(`PLAYER lastName:"${surname}" { ${f} }`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { ${f} } }`,
      { f: base });
    await sleep(PACE);
  }

  // ⚠️ IS lastName A PREFIX OR AN EXACT MATCH? That decides whether the whole
  // club roster can be enumerated (a, b, c …) or only looked up name by name.
  log('\n── 17b. does lastName match a prefix, or exactly? ──');
  for (const probe of [surname.slice(0, 2), surname.slice(0, 1), '', 'Zzzzzz']) {
    await tryQuery(`lastName: "${probe}"`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { result { __typename } } }`,
      { f: { ...base, lastName: probe } });
    await sleep(PACE);
  }

  // And whether the other participant types answer the same way.
  log('\n── 17c. the other valid types ──');
  for (const t of ['COACH', 'TEAM_MANAGER', 'VOLUNTEER', 'OFFICIAL']) {
    await tryQuery(`type: ${t}`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { result { __typename } } }`,
      { f: { ...base, type: t } });
    await sleep(PACE);
  }
  }

  // ── 13. MAKE THE SERVER LIST THE ENUM ──────────────────────────────────────
  // ⚠️ AN INVALID ENUM VALUE IS A QUESTION. GraphQL answers it by naming every
  // valid one. The values we had — PARTICIPANT_TO_CLUB, PARTICIPANT_TO_ASSOCIATION
  // — come from DiscoverRegistration.type, which is a DIFFERENT enum from the
  // filter's SeasonRegistrationType. One deliberately wrong value gets the list.
  log('\n── 13. what values does the filter type accept? ──');
  await tryQuery('myTeamsParticipants(type: NOT_A_REAL_VALUE)',
    `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { __typename } }`,
    { f: { seasonID: season, organisationID: org, type: 'NOT_A_REAL_VALUE' } });
  await sleep(PACE);

  // The same trick on the participant type: a wrong field makes it suggest real
  // ones, and `firstName` was rejected so it holds something else.
  log('\n── 14. what is on MyTeamsParticipant? ──');
  for (const f of ['id', 'name', 'profile { id }', 'participant { id }', 'xyzzy']) {
    await tryQuery(`MyTeamsParticipant { ${f} }`,
      `query Probe($f: MyTeamsParticipantsFilter!) { myTeamsParticipants(filter: $f) { result { ${f} } } }`,
      { f: { seasonID: season, organisationID: org, type: 'NOT_A_REAL_VALUE' } });
    await sleep(PACE);
  }

  // ── 15. THE FIRST DATE WE HAVE FOUND ANYWHERE ──────────────────────────────
  // ⚠️ startDate AND endDate ARE REAL on DiscoverRegistration, as
  // TimeZoneDateTime!. They are the window the registration form is OPEN, not
  // when a person signed up — but no date has turned up anywhere else, so its
  // shape is worth knowing.
  log('\n── 15. the dates on a registration ──');
  for (const f of ['startDate { __typename }', 'startDate { date }', 'startDate { dateTime }',
    'startDate { value }', 'startDate { timeZone }', 'endDate { date }']) {
    await tryQuery(`seasonRegistrations { ${f} }`,
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id ${f} } }`, { id: season });
    await sleep(PACE);
  }

  log('\n═══ WHAT THIS SAYS ═══');
  log('  A DATE anywhere in section 1 or 2 closes the biggest remaining gap: a');
  log('  player re-signing with the SAME club is invisible today, and they are the');
  log('  majority of registrations.');
  log('');
  log('  ⚠️ "REQUIRES A LOGIN" IS A FINAL ANSWER. This pipeline is anonymous, so');
  log('     an operation that needs one is unavailable to it. Record which, and move on.');
  phq.logSummary('probe-registration-date');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
