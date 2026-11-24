// scripts/probe-fixture-watch-afl.js
//
// ONE-OFF PROBE. Read-only: no writes, no commits, no alerts.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// markjovic/fixture-watch is a working PlayHQ fixture watcher on the
// `basketball-victoria` tenant. The plan is to extend THAT repo to cover footy as
// well, rather than build a second one. Before a line of that is written, four
// things have to be measured on the `afl` tenant, because the two tenants have
// never been shown to behave the same way.
//
//   Q1  Does fetch() work on afl?
//       This repo uses https.request with a hand-set Content-Length. On
//       basketball-victoria that exact shape is REFUSED while fetch() is granted —
//       measured on one runner ten seconds apart. Nobody has tried fetch() here.
//       If the session bootstrap below succeeds, fetch() works.
//
//   Q2  Does a basketball-namespace profile uuid resolve on afl?
//       Mark's position is that a PlayHQ profile id is the same person across the
//       platform. The sibling repo's own notes record a counter-example — T72, Max
//       Counsel, a basketball profile AND a separate footy profile — so this is
//       settled per player, by asking.
//
//   Q3  Does publicProfileTeams return `grade { id name }` on afl?
//       This repo's copy of that query omits grade and wraps the selection in
//       `... on DiscoverTeam`. The watcher needs the grade for its regrade alert
//       and its fixture-coverage rule. A rejected field fails the WHOLE query, so
//       both shapes are tried and the probe reports which one the tenant accepts.
//
//   Q4  ⚠️ THE DECIDING ONE: does discoverTeamFixture(teamID) work on afl?
//       It is the call the whole watcher is built on — one request returns a
//       team's entire fixture. It appears NOWHERE in this repo: fixtures here are
//       fetched grade-by-round via gradeRounds -> discoverFixtureByRound.
//         · works  -> the port is close to a configuration change.
//         · fails  -> the fixture layer must be rebuilt around rounds, roughly
//                     15-18 calls per team per pass instead of one, which changes
//                     the cadence, the session budget and the cost model.
//       The query text is COPIED VERBATIM from the working basketball watcher, so
//       this is not a guess at a query that might exist — it is the exercised
//       query, asked of a different tenant.
//
//   Control: gradeRounds, which IS proven here, so a failure on Q4 can be told
//   apart from a session or header problem.
//
// ─── RULES ───────────────────────────────────────────────────────────────────
//   · The header set and the three-cookie session are this repo's own, from
//     playhq.js — same cookie names, same order (phq_tier; phq_session; phq_sub).
//   · NO actions/setup-node in the workflow. It changes the runner's outbound
//     fingerprint. Most workflows here already say so.
//   · Every outcome is TYPED. "I could not ask" is never reported as "the answer
//     is none". NOT_FOUND is reported as NOT_FOUND, never as "no teams".
//
// USAGE
//   node scripts/probe-fixture-watch-afl.js --players=<uuid>[,<uuid>...]
//        [--tenant=afl] [--delay=400] [--grade=<grade id for the control>]

'use strict';

const crypto = require('crypto');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3).trim();
};

const PLAYERS = (argOf('players', '') || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
const TENANT  = argOf('tenant', 'afl') || 'afl';
const DELAY_MS = (() => { const n = parseInt(argOf('delay', '400'), 10); return Number.isFinite(n) && n >= 0 ? n : 400; })();
// ⚠️ PASS THIS when both Q3 and Q4 fail. With the grade field rejected AND the
// fixture query rejected, nothing in the run can supply a grade id — and that is
// exactly the run where the control decides whether the tenant refused the QUERY
// or refused US. Any live afl grade id from this repo's data will do.
const CONTROL_GRADE = argOf('grade', '') || null;
const API_URL = 'https://api.playhq.com/graphql';

if (!PLAYERS.length) {
  console.error('FATAL: no player ids. Pass --players=<uuid>[,<uuid>...] — the 36-character api-namespace uuids.');
  process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Headers — this repo's own set from playhq.js, tenant swapped in ─────────
const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Accept':       'application/json',
  'User-Agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       TENANT,
  'origin':       'https://www.playhq.com',
};

// ─── fetch() client. Q1 is answered by whether this gets a session at all. ───
async function doFetch(url, bodyObj, headers) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...headers, 'request-id': crypto.randomUUID() },
    body:    JSON.stringify(bodyObj),
    signal:  AbortSignal.timeout(60000),
  });
  const rawText = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(rawText); } catch (_) { body = null; }
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return { status: res.status, rawCookies: cookies.length ? cookies : undefined, body, rawText };
}

const isWafBlock = (t) => /cloudfront|Request blocked|ERROR: The request could not be satisfied/i.test(t || '') || (t || '').includes('DOCTYPE');

let sessionCookie = null;
const COOKIE_QUERIES = [
  { operationName: 'TenantConfig', variables: {}, query: 'query TenantConfig { tenantConfiguration { label } }' },
  { operationName: 'ProfileSearch', variables: { fullName: 'a' }, query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
];

async function getSession() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const body of COOKIE_QUERIES) {
      let r;
      try { r = await doFetch(API_URL, body, HEADERS_BASE); }
      catch (err) { console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: fetch threw ${err.name} ${err.message}`); continue; }
      if (!r.rawCookies) {
        const b = r.rawText || '';
        const sniff = b.includes('Request blocked') ? `CLOUDFRONT-BLOCK (${b.length}b HTML)`
                    : b.includes('DOCTYPE')         ? `HTML page (${b.length}b)`
                    : (b.slice(0, 120) || '(empty body)');
        console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${r.status}, NO set-cookie, body: ${sniff.replace(/\s+/g, ' ')}`);
        continue;
      }
      // Three cookies, in order. playhq_api_reference.md is explicit that the
      // wrong order causes CloudFront 403s.
      const parts = (Array.isArray(r.rawCookies) ? r.rawCookies : [r.rawCookies])
        .flatMap(c => String(c).split(',')).map(c => c.trim().split(';')[0]).filter(Boolean);
      const get = (n) => parts.find(c => c.startsWith(n + '=')) || null;
      const tier = get('phq_tier'), sess = get('phq_session'), sub = get('phq_sub');
      if (!tier || !sess || !sub) {
        console.log(`  ⚠ session attempt ${attempt} ${body.operationName}: HTTP ${r.status}, set-cookie present but missing phq_* names — saw: ${parts.map(c => c.split('=')[0]).join(', ')}`);
        continue;
      }
      sessionCookie = `${tier}; ${sess}; ${sub}`;
      console.log(`  Session obtained via fetch() on attempt ${attempt}  → Q1: fetch() WORKS on tenant "${TENANT}"`);
      return true;
    }
    await sleep(5000 * attempt);
  }
  return false;
}

// ─── Queries ─────────────────────────────────────────────────────────────────
// A: this repo's shape — inline fragment, NO grade. Known to work on afl.
const Q_PROFILE_FOOTY = {
  operationName: 'PublicProfileTeams',
  query: `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    ... on DiscoverTeam {
      id
      name
      season { id name startDate endDate status { value } competition { id name } }
      organisation { id name }
    }
  }
}`,
};

// B: the basketball watcher's shape — no fragment, WITH grade. The watcher needs
// grade; a rejected field fails the whole query, so this is asked separately.
const Q_PROFILE_BBALL = {
  operationName: 'PublicProfileTeams',
  query: `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    id name
    organisation { id name }
    grade { id name }
    season {
      id name startDate endDate
      status { name value }
      competition { id name organisation { id name } }
    }
  }
}`,
};

// THE DECIDING QUERY. Copied verbatim from the working basketball watcher, which
// took it verbatim from sports-players-stats/scripts/discover-fixtures.js.
const Q_TEAM_FIXTURE = {
  operationName: 'TeamFixture',
  query: `query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id
    grade { id name }
    season {
      id name
      competition { id name organisation { id name } }
      status { value }
    }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade {
      id name
      season {
        id name
        competition { id name organisation { id name } }
      }
    }
    fixture {
      games {
        id dates
        status { value }
        home { ... on DiscoverTeam { id name organisation { id name } } }
        away { ... on DiscoverTeam { id name organisation { id name } } }
        allocation {
          dateTimeList { date time }
          court { id name venue { id name } }
        }
      }
    }
  }
}`,
};

// Control: proven on afl by fetch-fixtures.js.
const Q_GRADE_ROUNDS = {
  operationName: 'gradeRounds',
  query: `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name
    rounds { id name abbreviatedName current number isFinalsRound }
  }
}`,
};

// ─── Typed call ──────────────────────────────────────────────────────────────
async function ask(q, variables, label) {
  let r;
  try { r = await doFetch(API_URL, { ...q, variables }, { ...HEADERS_BASE, Cookie: sessionCookie }); }
  catch (err) { return { kind: 'error', detail: `${err.name}: ${err.message}` }; }

  if (r.status === 403) {
    return isWafBlock(r.rawText)
      ? { kind: 'blocked', detail: `CLOUDFRONT-BLOCK (${(r.rawText || '').length}b HTML)` }
      : { kind: 'forbidden', detail: 'application 403 — NOT a CloudFront block' };
  }
  if (r.status === 429 || r.status === 503) return { kind: 'blocked', detail: `HTTP ${r.status} rate signal` };
  if (r.status < 200 || r.status >= 300) return { kind: 'error', detail: `HTTP ${r.status}` };
  if (!r.body) return { kind: 'error', detail: `unparseable body: ${(r.rawText || '').slice(0, 160)}` };
  if (r.body.errors?.length) {
    const msg = r.body.errors.map(e => e.message).join(' | ');
    if (/not.?found/i.test(msg)) return { kind: 'notfound', detail: msg };
    // A rejected field names itself here — that is how Q3 is answered.
    return { kind: 'gql-error', detail: msg };
  }
  return { kind: 'ok', data: r.body.data || r.body };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  const line = '═'.repeat(78);
  console.log(line);
  console.log('probe-fixture-watch-afl');
  console.log(`  tenant:  ${TENANT}`);
  console.log(`  players: ${PLAYERS.length}`);
  console.log(line);

  const answers = { q1: null, q2: null, q3: null, q4: null, control: null };
  // The control needs A grade id from anywhere. When Q3 rejects the grade field the
  // profile cannot supply one, and that is precisely the run where the control is
  // the discriminator — so take it from the fixture response too.
  let gradeFromFixture = null;

  console.log('\n── Q1 · session via fetch() ──');
  if (!await getSession()) {
    answers.q1 = 'NO — fetch() could not obtain a session';
    console.error('\nFATAL: no session. Q1 is answered NO and nothing below can be asked. If this repo\'s https.request client still works, the watcher must keep that client for afl.');
    console.log(`\nANSWERS: ${JSON.stringify(answers, null, 2)}`);
    process.exit(1);
  }
  answers.q1 = 'YES — fetch() obtained a session';

  const unanswered = [];
  const teamsSeen = [];

  for (const uuid of PLAYERS) {
    console.log(`\n${'─'.repeat(78)}\nPLAYER ${uuid}\n${'─'.repeat(78)}`);
    if (uuid.length !== 36) console.log(`  ⚠ ${uuid.length} characters, not 36. A truncated or spectator id returns NOT_FOUND, which is NOT "no teams".`);

    // ── Q3 first: which profile query shape does afl accept? ──
    console.log('\n  ── Q3 · which publicProfileTeams shape does afl accept? ──');
    const withGrade = await ask(Q_PROFILE_BBALL, { profileID: uuid }, 'profile+grade');
    await sleep(DELAY_MS);
    console.log(`     basketball shape (no fragment, WITH grade): ${withGrade.kind}${withGrade.detail ? ` — ${withGrade.detail}` : ''}`);

    const footyShape = await ask(Q_PROFILE_FOOTY, { profileID: uuid }, 'profile-fragment');
    await sleep(DELAY_MS);
    console.log(`     footy shape (inline fragment, no grade):     ${footyShape.kind}${footyShape.detail ? ` — ${footyShape.detail}` : ''}`);

    const use = withGrade.kind === 'ok' ? withGrade : footyShape;
    const shapeUsed = withGrade.kind === 'ok' ? 'basketball (grade available)' : 'footy (no grade)';
    if (answers.q3 === null) answers.q3 = withGrade.kind === 'ok'
      ? 'YES — afl accepts the grade field; the watcher query ports unchanged'
      : `NO — grade rejected (${withGrade.detail || withGrade.kind}); grade must come from the fixture response`;

    if (use.kind !== 'ok') {
      console.log(`  ✖ NEITHER shape answered. ${use.kind}: ${use.detail}`);
      if (use.kind === 'notfound') console.log('    NOT_FOUND = this id did not resolve ON THIS TENANT. It does NOT mean the player has no footy teams — it may mean a SEPARATE footy profile exists (sibling repo T72, Max Counsel).');
      unanswered.push({ uuid, kind: use.kind, detail: use.detail });
      if (answers.q2 === null) answers.q2 = `NO — ${use.kind}: the basketball uuid did not resolve on afl`;
      continue;
    }

    const teams = use.data?.publicProfileTeams;
    if (!Array.isArray(teams)) { console.log('  ✖ publicProfileTeams was not an array — PRIVATE profile, or the id does not resolve. These two cannot be told apart here.'); unanswered.push({ uuid, kind: 'null' }); continue; }

    console.log(`\n  ── Q2 · ${teams.length} registration(s) returned using the ${shapeUsed} shape ──`);
    if (answers.q2 === null) answers.q2 = teams.length
      ? `YES — the basketball-namespace uuid resolved on afl and returned ${teams.length} registration(s)`
      : 'RESOLVED but EMPTY — the id is valid on afl and holds no footy registrations (not the same as NOT_FOUND)';

    console.log('\n  ── RAW payload (unmerged, untouched) ──');
    console.log(JSON.stringify(use.data, null, 2).split('\n').map(l => `  ${l}`).join('\n'));

    for (const t of teams) {
      const s = t.season || {};
      console.log(`\n  ── registration ──`);
      console.log(`     team:    ${t.id}  ${t.name || ''}`);
      console.log(`     club:    ${t.organisation?.id || '—'}  ${t.organisation?.name || ''}`);
      console.log(`     grade:   ${t.grade ? `${t.grade.id}  ${t.grade.name || ''}` : 'ABSENT from this query shape'}`);
      console.log(`     season:  ${s.id || '—'}  ${s.name || ''}  [${s.status?.value || '—'}]  ${s.startDate || '?'} → ${s.endDate || 'NO endDate'}`);
      teamsSeen.push({ tid: t.id, name: t.name, gid: t.grade?.id || null });
    }
  }

  // ── Q4 · the deciding test ──
  console.log(`\n${line}\nQ4 · discoverTeamFixture on tenant ${TENANT} — THE DECIDING TEST\n${line}`);
  if (!teamsSeen.length) {
    answers.q4 = 'NOT TESTED — no teams came back to ask about';
    console.log('  No teams to ask about.');
  } else {
    for (const t of teamsSeen.slice(0, 3)) {
      const r = await ask(Q_TEAM_FIXTURE, { teamID: t.tid }, 'team fixture');
      await sleep(DELAY_MS);
      if (r.kind !== 'ok') {
        console.log(`  ${t.tid} ${t.name || ''} → ✖ ${r.kind}: ${r.detail}`);
        if (answers.q4 === null) answers.q4 = `NO — ${r.kind}: ${r.detail}`;
        continue;
      }
      const rounds = Array.isArray(r.data.discoverTeamFixture) ? r.data.discoverTeamFixture : null;
      if (rounds === null) {
        console.log(`  ${t.tid} ${t.name || ''} → answered, but discoverTeamFixture is NULL (the field exists, this team has no rounds)`);
        if (answers.q4 === null) answers.q4 = 'PARTIAL — the field exists and answered, but returned null for this team';
        continue;
      }
      const games = rounds.reduce((n, rd) => n + (rd?.fixture?.games || []).length, 0);
      console.log(`  ${t.tid} ${t.name || ''} → ✔ ${rounds.length} round(s), ${games} game(s). discoverTeam.grade = ${r.data.discoverTeam?.grade?.id || '—'} ${r.data.discoverTeam?.grade?.name || ''}`);
      const g0 = rounds.find(rd => (rd?.fixture?.games || []).length);
      if (g0) {
        const gm = g0.fixture.games[0];
        console.log(`     sample game: ${gm.id} ${gm.allocation?.dateTimeList?.[0]?.date || gm.dates?.[0] || '?'} ${gm.allocation?.dateTimeList?.[0]?.time || ''} ${gm.home?.name || '?'} v ${gm.away?.name || '?'} @ ${gm.allocation?.court?.venue?.name || '?'} [${g0.name}]`);
      }
      if (r.data.discoverTeam?.grade?.id) gradeFromFixture = r.data.discoverTeam.grade.id;
      answers.q4 = 'YES — discoverTeamFixture works on afl';
    }
  }

  // ── Control ──
  console.log(`\n── control · gradeRounds (proven on afl by fetch-fixtures.js) ──`);
  const controlGid = (teamsSeen.find(t => t.gid) || {}).gid || gradeFromFixture || CONTROL_GRADE;
  if (!controlGid) {
    answers.control = 'NOT TESTED — no grade id available from the profile query';
    console.log('  No grade id was available from the profile query or the fixture response.');
    console.log('  ⚠ RE-RUN WITH --grade=<any live afl grade id> (the workflow has a `grade` input).');
    console.log('    Without the control, a Q4 failure cannot be told apart from a session or header problem.');
  } else {
    const r = await ask(Q_GRADE_ROUNDS, { gradeID: controlGid }, 'grade rounds');
    if (r.kind === 'ok') {
      const rd = r.data?.discoverGrade?.rounds || [];
      answers.control = `OK — ${rd.length} round(s)`;
      console.log(`  ${controlGid} → ✔ ${rd.length} round(s); current = ${(rd.find(x => x.current) || {}).name || 'none flagged'}`);
    } else {
      answers.control = `FAILED — ${r.kind}: ${r.detail}`;
      console.log(`  ${controlGid} → ✖ ${r.kind}: ${r.detail}`);
      console.log('  ⚠ The control failed too, so a Q4 failure says nothing about discoverTeamFixture — the session or headers are the problem. Fix that and re-run.');
    }
  }

  // ── Verdict ──
  console.log(`\n${line}\nANSWERS\n${line}`);
  console.log(`  Q1 fetch() on ${TENANT}        : ${answers.q1}`);
  console.log(`  Q2 basketball uuid resolves    : ${answers.q2 || 'NOT TESTED'}`);
  console.log(`  Q3 grade field accepted        : ${answers.q3 || 'NOT TESTED'}`);
  console.log(`  Q4 discoverTeamFixture         : ${answers.q4 || 'NOT TESTED'}`);
  console.log(`  control gradeRounds            : ${answers.control || 'NOT TESTED'}`);
  console.log('');
  if (String(answers.q4).startsWith('YES')) {
    console.log('  → The footy port is close to a configuration change: the watcher keeps its');
    console.log('    one-call-per-team design, with the tenant and the profile query swapped.');
  } else if (answers.q4) {
    console.log('  → The fixture layer must be rebuilt around gradeRounds -> discoverFixtureByRound,');
    console.log('    roughly 15-18 calls per team per pass instead of one. That changes the cadence,');
    console.log('    the session budget and the cost model, and must be designed rather than ported.');
  }

  if (unanswered.length) {
    console.log(`\n  ⚠ ${unanswered.length} call(s) were NOT answered and are not part of the above:`);
    for (const u of unanswered) console.log(`    ${u.uuid}  ${u.kind}${u.detail ? `: ${u.detail}` : ''}`);
  }
  console.log(`\n  elapsed ${Math.round((Date.now() - started) / 1000)}s`);
  if (unanswered.length) process.exit(1);
  console.log('\nDone.');
})().catch(err => {
  console.error(`\nFATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
