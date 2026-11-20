#!/usr/bin/env node
// scripts/probe-team-roster.js
//
// Can discoverTeams tell us WHO is in a 2027 team? READ-ONLY, writes nothing,
// and makes a couple of dozen calls at most.
//
// ⚠️ WHY THIS EXISTS. We ask PlayHQ "what has this player registered for",
// 40,382 times, via publicProfileTeams. For Thomas Arbuckle that returns NOTHING
// — not his 2027 club, not even his 2026 one — while the PlayHQ app shows his new
// team plainly. So the data is published; we are asking down the wrong road.
//
// The right road is probably the one the club trigger already drives down:
// discoverTeams(filter:{seasonID}) returns 217 teams for YJFL 2027 today. It
// selects id, name and organisation and throws the rest away. If a team can also
// return its members, then ONE call per team — a few hundred — replaces 40,382
// profile calls and answers the question directly.
//
// ⚠️ A REJECTED FIELD FAILS THE WHOLE QUERY, so fields are tried ONE AT A TIME
// and never combined until each is known good. walk-registrations.js carries the
// same warning about Q_TEAMS.
//
// ⚠️ A REJECTION THAT NAMES A TYPE IS EVIDENCE THE FIELD EXISTS. "Cannot query
// field X on type DiscoverTeam" means no such field. 'Field "members" of type
// "[Member]" must have a selection of subfields' means it DOES exist and we asked
// for it wrongly — a very different answer, and the log says which.
//
// ⚠️ A 400 IS NOT RETRIED by lib/playhq.js, and its body is RETURNED rather than
// thrown precisely so a probe can read the GraphQL error — including PlayHQ's
// "Did you mean …?" hint. That is why one candidate costs exactly one call.
// Probing eleven field names once cost 36 requests because 400s were retried,
// and that burst is the likeliest cause of the WAF block that followed.
//
// ⚠️ THE PROFILE SIDE IS PROBED TOO. publicProfileTeams returns NOTHING for
// eccecaba-70f9-4c3b-8798-62a2e5a74d21 — not his 2027 club, not even his 2026
// one — while the PlayAFL app shows his new team. The app is the same PlayHQ
// client on the same `afl` tenant that this repo already uses, so the data is
// reachable; we are using the wrong operation. Section 4 tries the others.
//
// `profileSearch(fullName: String!)` is known good — it is the search the app
// uses, lifted verbatim from the capture brief rather than reconstructed.
//
// Env: PR_SEASON (a seasonID to probe; default is the first tracked next-season
//      entry in the manifest), PR_TEAM (a teamID, to probe a single team),
//      PR_PROFILE (a profile uuid), PR_NAME (a full name for profileSearch).

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const VERSION = 'probe-team-roster v5 2026-11-20 the-club-is-on-the-search-result';
const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);

const SEASON = (process.env.PR_SEASON || '').trim();
const TEAM = (process.env.PR_TEAM || '').trim();

// Candidate shapes, cheapest and most likely first. Each is ONE call.
const TEAM_FIELD_CANDIDATES = [
  // ⚠️ `pool` IS NOT A GUESS. PlayHQ suggested it twice, unprompted, in response
  // to `players` and `people` — which is the schema telling us the nearest real
  // field on DiscoverTeam.
  'pool { id }',
  'pool { id name }',
  'members { id }',
  'members { person { id } }',
  'players { id }',
  'people { id }',
  'roster { id }',
  'teamMembers { id }',
  'participants { id }',
  'squad { id }',
];

async function tryQuery(label, query, variables) {
  let json;
  // ⚠️ THE operationName MUST MATCH THE NAME IN THE QUERY TEXT, or PlayHQ answers
  // HTTP 500 "Unknown operation named X" — and lib/playhq.js RETRIES a 500 four
  // times, so v2 spent 28 calls learning nothing about six operations. Section 2
  // passed only because those queries happened to be named `Probe` too. Take the
  // name from the text rather than asserting one.
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false, fatal: true }; }

  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    // The two rejections mean opposite things. Say which.
    const exists = /must have a selection of subfields|Unknown argument|Cannot return null/i.test(msg);
    // PlayHQ suggests the right name on a near miss, and that suggestion is
    // worth more than the whole rest of this probe.
    const hint = /Did you mean/i.test(msg) ? msg.slice(msg.search(/Did you mean/i)) : '';
    if (hint) log(`      ↳ ${hint.slice(0, 120)}`);
    log(`    ${label}: ${exists ? 'FIELD EXISTS, asked wrongly' : 'rejected'} — ${msg.slice(0, 140)}`);
    return { ok: false, exists };
  }
  // ⚠️ LOG THE SUCCESSES TOO. v3's section 3 only logged failures, so
  // discoverTeam(teamID:) PASSED and said nothing — the single most useful
  // result of the run was invisible, and I read its absence as a failure.
  log(`    ${label}: ACCEPTED — ${JSON.stringify(json && json.data).slice(0, 240)}`);
  return { ok: true, data: json && json.data };
}

async function main() {
  log(`=== ${VERSION} ===`);
  log('READ-ONLY: nothing is written. A handful of calls.\n');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const next = manifest.filter(m => yearOf(m.compName) === latest);

  log('── next-season entries in the manifest ──');
  for (const m of next) log(`  ${m.seasonId}  ${m.compName}  [${m.state}]`);

  const seasonID = SEASON || (next[0] && next[0].seasonId);
  if (!seasonID) { console.error('FATAL: no next-season entry and no PR_SEASON given.'); process.exit(1); }
  const seasonName = (next.find(m => m.seasonId === seasonID) || {}).compName || seasonID;
  log(`\nprobing season ${seasonID} (${seasonName})`);

  await phq.ensureSession();

  // ── 1. the query we already run, to confirm the baseline still works ───────
  log('\n── 1. the call the club trigger already makes ──');
  const base = await tryQuery('id + name + organisation',
    `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) {
      id name organisation { id name } } }`, { seasonID });
  if (!base.ok) {
    log('  ⚠️ THE BASELINE ITSELF FAILED. Nothing below can be trusted — fix this first.');
    process.exit(1);
  }
  const teams = (base.data && base.data.discoverTeams) || [];
  log(`  ${teams.length} team(s) returned.`);
  for (const t of teams.slice(0, 3)) log(`    ${t.id}  ${t.name}  (${t.organisation && t.organisation.name})`);
  if (!teams.length) {
    log('  ⚠️ NO TEAMS for this season, so there is nothing to probe. Try another');
    log('     season with PR_SEASON — an ACTIVE season may have teams where an');
    log('     UPCOMING one does not, or the other way round.');
    process.exit(0);
  }

  // ── 2. does a team carry its members? one field at a time ──────────────────
  log('\n── 2. member fields on discoverTeams, ONE AT A TIME ──');
  const accepted = [];
  for (const f of TEAM_FIELD_CANDIDATES) {
    const r = await tryQuery(f,
      `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) { id ${f} } }`,
      { seasonID });
    if (r.ok) accepted.push(f);
    if (r.fatal) break;
  }

  // ── 3. a single team by id, which may expose more ──────────────────────────
  const teamID = TEAM || teams[0].id;
  log(`\n── 3. one team by id (${teamID}) ──`);
  // ⚠️ discoverTeam EXISTS — "Unknown argument \"id\"" is the server confirming the
  // field and refusing the argument, which is a different answer from "no such
  // field". These try the arguments it is most likely to want instead.
  // ⚠️ discoverTeam(teamID: ID!) IS CONFIRMED GOOD — it answered in v3 without
  // saying so. These ask what a single team will tell us about its people, one
  // field at a time because a rejected field fails the whole query.
  for (const f of ['id name', 'pool { id name }', 'members { id }', 'players { id }',
    'people { id }', 'roster { id }', 'statistics { __typename }', 'season { id name }',
    'organisation { id name }', 'grade { id name }']) {
    await tryQuery(`discoverTeam { ${f} }`,
      `query Probe($id: ID!) { discoverTeam(teamID: $id) { ${f} } }`, { id: teamID });
  }

  // ⚠️ A TEAM THAT HAS NOT STARTED MAY SIMPLY HAVE NO POOL. `pool` came back
  // null on a 2027 team, which proves the field exists and says nothing about
  // whether it ever carries anybody. Ask a team from a season that has been
  // PLAYED before concluding the field is useless.
  const played = manifest.find(m => yearOf(m.compName) === latest - 1 && m.state === 'complete');
  if (played) {
    log(`\n── 3b. the same fields on a PLAYED season (${played.compName}) ──`);
    const t2 = await tryQuery('discoverTeams (played season)',
      `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) { id name } }`,
      { seasonID: played.seasonId });
    const list = (t2.data && t2.data.discoverTeams) || [];
    if (list.length) {
      await tryQuery('pool on a played team',
        `query Probe($id: ID!) { discoverTeam(teamID: $id) { id name pool { id name } } }`,
        { id: list[0].id });
    } else {
      log('    no teams returned for that season — nothing to ask.');
    }
  }

  // ── 4. the profile side ────────────────────────────────────────────────────
  const profile = (process.env.PR_PROFILE || '').trim();
  const fullName = (process.env.PR_NAME || '').trim();

  if (fullName) {
    log(`\n── 4a. profileSearch("${fullName}") ──`);
    // ⚠️ THE CLUB IS ON THE SEARCH RESULT. The PlayAFL app's own Search Players
    // screen shows "Thomas Arbuckle — South Croydon (Eastern Football Netball
    // League)" — his NEW club — while publicProfileTeams returns only his three
    // Norwood teams. So the current club hangs off the search result type,
    // DiscoverProfile, and v4 asked that type for firstName, id and lastName
    // only, throwing away the one field that answers the question.
    //
    // These ask DiscoverProfile what else it holds, one field at a time.
    for (const f of ['organisation { id name }', 'club { id name }', 'team { id name }',
      'season { id name }', 'competition { id name }', 'tenant { id name }',
      'organisationName', 'clubName', 'teamName', 'subtitle', 'description']) {
      await tryQuery(`profileSearch result { ${f} }`,
        `query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ` +
        `{ result { id ${f} } } }`, { fullName });
    }
    log('');
    // ⚠️ VERBATIM from the capture brief. A query retyped from memory cost three
    // wasted dispatches in the sibling project; this one is copied, not tidied.
    const r = await tryQuery('profileSearch',
      'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ' +
      '{ result { firstName id lastName __typename } __typename } }', { fullName });
    if (r.ok) {
      const res = ((r.data && r.data.profileSearch) || {}).result || [];
      log(`    ${res.length} result(s):`);
      for (const p of res.slice(0, 10)) log(`      ${p.id}  ${p.firstName} ${p.lastName}`);
      if (!res.length) log('    ⚠️ The search the APP uses returns nothing for this name either.');
    }
  }

  if (profile) {
    log(`\n── 4b. what operations return anything for ${profile} ──`);
    const CANDIDATES = [
      ['publicProfileTeams (what we use now)',
        'query P($id: ID!) { publicProfileTeams(profileID: $id) { id name } }'],
      ['publicProfile',
        'query P($id: ID!) { publicProfile(profileID: $id) { id firstName lastName } }'],
      ['profile',
        'query P($id: ID!) { profile(id: $id) { id } }'],
      ['discoverProfile',
        'query P($id: ID!) { discoverProfile(id: $id) { id } }'],
      // ⚠️ NAMED BY PlayHQ ITSELF in the v2 error text, alongside
      // publicProfileTeams. Not guesses.
      ['publicProfileStatistics',
        'query P($id: ID!) { publicProfileStatistics(profileID: $id) { __typename } }'],
      ['publicProfile (no arg name assumed)',
        'query P($id: ID!) { publicProfile(id: $id) { __typename } }'],
    ];
    for (const [label, q] of CANDIDATES) {
      const r = await tryQuery(label, q, { id: profile });
      /* tryQuery logs it */
    }
    // ⚠️ publicProfileStatistics ANSWERED with only __typename asked for, so the
    // operation works and we have never looked inside it. If a player's season
    // history lives anywhere on the profile side, this is where.
    log(`\n── 4c. inside publicProfileStatistics ──`);
    for (const f of ['seasons { id }', 'season { id }', 'teams { id }', 'games { id }',
      'statistics { __typename }', 'results { __typename }']) {
      await tryQuery(`publicProfileStatistics { ${f} }`,
        `query P($id: ID!) { publicProfileStatistics(profileID: $id) { ${f} } }`, { id: profile });
    }

    log('\n    ⚠️ "ACCEPTED but EMPTY" is the interesting one. It means the operation');
    log('       exists and PlayHQ is choosing to return nothing for this person —');
    log('       a different problem from asking down the wrong road.');
  } else {
    log('\n── 4. profile side SKIPPED — set PR_PROFILE to a uuid to probe it ──');
  }

  log('\n═══ WHAT THIS SAYS ═══');
  if (accepted.length) {
    // ⚠️ ACCEPTED IS NOT POPULATED. v4 declared `pool` "the route" because it was
    // not rejected — while being null on a PLAYED 2026 team as well as a 2027
    // one. A field that is null everywhere is not a roster. The rule this repo
    // already has: a field accepted is not a field populated.
    log(`  Fields accepted on a team: ${accepted.join(', ')}`);
    log('  ⚠️ Check the samples above before believing any of them carry people.');
  } else {
    log('  No member field was accepted on discoverTeams.');
    log('  ⚠️ THIS DOES NOT MEAN THE DATA IS UNREACHABLE. It means this operation is');
    log('     not the one the app uses. The next step is to capture the request the');
    log('     PlayHQ app itself makes when it shows a team\'s players, rather than');
    log('     guessing more field names — which is the rule this repo already has.');
  }
  log('\n  Nothing was written. No decision has been made from this run.');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
