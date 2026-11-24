#!/usr/bin/env node
// scripts/probe-leftovers.js

// ⚠️ THE VERSION GOES AT THE TOP.
const VERSION = 'probe-leftovers v1 2026-11-24';

// Loose ends worth one run before calling discovery done:
//   1. tenantConfiguration { sport { ... } } and registrationInsurance — named,
//      never opened.
//   2. DiscoverRegistration.products — a list, EMPTY on every form so far. Try a
//      season whose registration window is OPEN NOW, in case products populate
//      only while live.
//   3. seasonRegistrations connected to a season's TEAMS by shared organisation —
//      not a new field, a JOIN we already have the pieces for, proving once and
//      for all there is no person link.
//
// READ-ONLY. ~25 calls.
// Env: PL_SEASON (default 2dcbf383), PL_PACE_MS (default 900).

'use strict';
const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const SEASON = (process.env.PL_SEASON || '2dcbf383').trim();
const PACE = Math.max(0, Number(process.env.PL_PACE_MS || 900));
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryQuery(label, query, variables) {
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false }; }
  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    const useful = /does not exist in|must have a selection|of required type|Did you mean/i.test(msg);
    log(`    ${label}: rejected — ${msg.slice(0, useful ? 600 : 160)}`);
    return { ok: false, msg };
  }
  log(`    ${label}: ACCEPTED — ${JSON.stringify(json.data).slice(0, 450)}`);
  return { ok: true, data: json.data };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');
  await phq.ensureSession();

  log('── 1. the rest of tenantConfiguration ──');
  await tryQuery('sport { ... }',
    `query Probe { tenantConfiguration { sport { __typename } } }`, {});
  await sleep(PACE);
  for (const f of ['sport { name value shortName code }', 'registrationInsurance { __typename }',
    'label', 'statistics { __typename }']) {
    await tryQuery(`tenantConfiguration { ${f} }`,
      `query Probe { tenantConfiguration { ${f} } }`, {});
    await sleep(PACE);
  }

  log('\n── 2. DiscoverRegistration.products, and every scalar it has ──');
  // Products was empty; open the type up fully with wrong-field suggestions.
  for (const f of ['products { id name price type status }',
    'products { __typename }', 'xyzzy', 'id startDate { date } endDate { date } type organisation { id }']) {
    await tryQuery(`seasonRegistrations { ${f} }`,
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { ${f} } }`, { id: SEASON });
    await sleep(PACE);
  }

  log('\n── 3. the whole DiscoverRegistration, one scalar at a time ──');
  // Make the server enumerate the type: a deliberately wrong field lists nothing,
  // but each real one that ACCEPTS tells us the full shape of a registration form.
  for (const f of ['status', 'state', 'isOpen', 'capacity', 'url', 'link',
    'registrationUrl', 'ageFrom', 'ageTo', 'gender', 'description']) {
    await tryQuery(`DiscoverRegistration.${f}`,
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id ${f} } }`, { id: SEASON });
    await sleep(PACE);
  }

  log('\n═══ WHAT THIS SAYS ═══');
  log('  Any ACCEPTED field above is new shape for the reference. A populated');
  log('  `products` or a registration URL is the only thing that would reopen the');
  log('  registration question; everything else is completeness.');
  phq.logSummary('probe-leftovers');
  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
