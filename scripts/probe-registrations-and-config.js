#!/usr/bin/env node
// scripts/probe-registrations-and-config.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-registrations-and-config v1 2026-11-24';

//
// Three questions StatTrack's answer left open, none needing auth.
//
// 1. DOES seasonRegistrations RESOLVE `teams` ANONYMOUSLY? StatTrack's
//    test-api.js selects `teams { id name }` and `organisation { id name type }`
//    on it in schema mode, and NO run of that selection is recorded in either
//    project. My own probing got organisation/type/products/dates and never
//    tried `teams` on this operation. If it resolves, it is the club-side list
//    both projects concluded does not exist.
//
// 2. WHAT DOES THE afl tenantConfiguration EXPOSE? The basketball capture showed
//    tenantConfiguration { statistics { seasonStatisticsMeta } } listing every
//    stat with isDisplayable / offenceListPublicVisible flags. The afl answer
//    would replace this dashboard's INFERENCE about which stats are public with
//    PlayHQ's own declaration. Almost certainly anonymous — the capture's guest
//    bootstrap reached it.
//
// 3. WHAT DOES phq_rl GOVERN? Observed once, in a logged-in capture, signed so
//    it cannot be forged. NOT exhausted: this checks whether our anonymous
//    bootstrap is even issued one, and logs it verbatim if so. One forgery path
//    is closed; what the cookie does is not.
//
// READ-ONLY: nothing is written. About 30 calls.
//
// Env: PC_SEASON (a seasonID; defaults to the AFL 2026 id below),
//      PC_PACE_MS (default 900).

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
// A real AFL 2026 season id (EFNL 2026), supplied rather than a placeholder.
const SEASON = (process.env.PC_SEASON || '2dcbf383').trim();
const PACE = Math.max(0, Number(process.env.PC_PACE_MS || 900));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryQuery(label, query, variables) {
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false }; }
  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    const kind = /unauthenticated|unauthorized|forbidden/i.test(msg) ? 'BEHIND A LOGIN'
      : /must have a selection of subfields|Unknown argument|used in position expecting|of required type/i.test(msg) ? 'EXISTS, asked wrongly'
      : 'does not exist';
    // ⚠️ DO NOT TRUNCATE AN ERROR THAT NAMES FIELDS OR VALUES. A short slice hid
    // the server's own answers for four versions of the last probe.
    const useful = /does not exist in|must have a selection|of required type|Did you mean/i.test(msg);
    log(`    ${label}: ${kind} — ${msg.slice(0, useful ? 600 : 160)}`);
    return { ok: false, kind, msg };
  }
  const d = JSON.stringify(json && json.data);
  const empty = /:(null|\[\])[,}]/.test(d);
  log(`    ${label}: ACCEPTED${empty ? ' (but empty/null somewhere — check)' : ''} — ${d.slice(0, 400)}`);
  return { ok: true, data: json.data, empty };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');
  log(`season: ${SEASON}\n`);

  await phq.ensureSession();

  // ── A. what cookies does an anonymous bootstrap receive? ───────────────────
  // ⚠️ phq_rl IS NOT EXHAUSTED, IT IS UNPROBED. The only closed path is forging
  // it (signed). This makes ONE raw bootstrap call and reads Set-Cookie directly,
  // because lib/playhq.js does not expose its session cookie and this probe will
  // not edit the lib to find out. If the raw call shape drifts from the lib's,
  // this section is advisory only — the lib's own session still drives B and C.
  log('── A. what did a raw anonymous bootstrap receive? (advisory) ──');
  try {
    const res = await fetch(phq.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': phq.USER_AGENT,
        'tenant': phq.TENANT,
        'accept': '*/*',
        'origin': 'https://www.playhq.com',
      },
      body: JSON.stringify({ operationName: 'TenantConfig',
        query: 'query TenantConfig { tenantConfiguration { videoConsentEnabled } }', variables: {} }),
    });
    const setc = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
    if (!setc.length) {
      log('    no Set-Cookie on this response (the lib bootstraps on a different call)');
    }
    const names = [];
    for (const c of setc) {
      const pair = String(c).split(';')[0];
      const name = pair.split('=')[0];
      const val = pair.slice(name.length + 1);
      names.push(name);
      log(`    ${name} = ${val.slice(0, 48)}${val.length > 48 ? '…' : ''}`);
    }
    log(`    phq_rl present on anonymous tier: ${names.includes('phq_rl')}`);
    log('    ⚠️ a tier prefix of cookie-no-jwt is the anonymous tier; jwt-public needs a login.');
  } catch (e) {
    log(`    raw bootstrap failed — ${e.message}. Section A inconclusive; B and C still run.`);
  }

  // ── 1. seasonRegistrations: does `teams` resolve? ──────────────────────────
  log('\n── B. seasonRegistrations — does it carry TEAMS or PEOPLE? ──');
  for (const f of ['teams { id name }', 'organisation { id name type }',
    'team { id name }', 'participant { id }', 'profile { id }', 'members { id }',
    'status', 'status { value }', 'count', 'quantity']) {
    await tryQuery(`seasonRegistrations { ${f} }`,
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id ${f} } }`, { id: SEASON });
    await sleep(PACE);
  }

  // ── 2. the afl tenantConfiguration ─────────────────────────────────────────
  log('\n── C. tenantConfiguration on the afl tenant ──');
  // First the exact shape the capture showed, then probe for more top-level
  // fields by asking wrong ones and reading the suggestions.
  await tryQuery('tenantConfiguration { statistics { seasonStatisticsMeta } }',
    `query Probe { tenantConfiguration { statistics { seasonStatisticsMeta { value shortName name isDisplayable offenceListPublicVisible } } } }`, {});
  await sleep(PACE);
  await tryQuery('tenantConfiguration { videoConsentEnabled }',
    `query Probe { tenantConfiguration { videoConsentEnabled } }`, {});
  await sleep(PACE);
  log('    — probing for other top-level fields on TenantConfiguration —');
  for (const f of ['tenant { id name }', 'sport', 'sportName', 'finals { __typename }',
    'ladder { __typename }', 'grades { __typename }', 'features { __typename }',
    'registrationEnabled', 'liveScoringEnabled']) {
    await tryQuery(`tenantConfiguration { ${f} }`,
      `query Probe { tenantConfiguration { ${f} } }`, {});
    await sleep(PACE);
  }

  log('\n═══ WHAT THIS SAYS ═══');
  log('  B — if `teams` or a person field RESOLVED and returned data, the');
  log('      anonymous club-side registration list exists after all, and the');
  log('      walk question reopens. If it rejected or came back null, the earlier');
  log('      conclusion stands and this is written down for good.');
  log('  C — any field that returned data is authoritative tenant config we');
  log('      currently infer. seasonStatisticsMeta in particular says which AFL');
  log('      stats PlayHQ itself marks displayable and public.');
  log('  A — the cookie record. Not a conclusion, a fact for the reference:');
  log('      what tier an anonymous bootstrap gets, and whether phq_rl comes with it.');
  phq.logSummary('probe-registrations-and-config');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
