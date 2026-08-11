// scripts/discover-seasons.js
//
// Reads every configured organisation's competitions and seasons from
// discoverCompetitions, and writes the manifest that the per-organisation file
// split depends on.
//
// Owns the `organisations` and `manifest` keys inside data/core.json and nothing
// else. Other keys in that file are preserved untouched, so a future writer can
// add clubs, venues or compLogos alongside without either clobbering the other.
//
// It also does the config.json migration, and does it by proof rather than by
// assumption. config.json currently names competitions like "EFNL 2026" and
// carries a hand-maintained seasonID. The new shape carries an 8-character
// organisation code instead and lets this manifest supply the seasons — but
// compName is a component of every match id, every roster key and every
// gradeMeta key, so it MUST keep producing byte-identical strings. This script
// therefore matches each configured seasonID against the seasons each
// organisation actually returns, derives the short name by stripping the matched
// season's name from the existing compName, and prints the proposed config.json.
// Nothing is guessed and config.json is never overwritten — it is hand-edited
// configuration.
//
// Exit codes follow the repo convention: 0 = changed, 2 = no change, 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');

const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
// Written by discover-orgs.js. Holds every AFL organisation with its seasons, so
// an unmatched seasonID can be traced to its owner without a single API call.
const ORG_DISCOVERY_PATH = path.join(ROOT, 'data', 'org-discovery.json');

// A season stops being live 30 days after it ends, not the moment its status
// flips. Both conditions are required: PlayHQ is not always prompt about
// flipping status, and a season whose status has flipped may still be receiving
// amended finals results.
const RETIRE_AFTER_DAYS = 30;

// seasons takes a required organisationID argument, and organisationID must be
// the 8-character organisation code rather than the UUID. Both verified
// 2026-08-11 by controlled comparison — see playhq_api_reference.md.
const Q_COMPETITIONS = `
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons(organisationID: $organisationID) {
      id name startDate endDate status { name value }
    }
    organisation { id name }
  }
}`;

const Q_ORGANISATION = `
query discoverOrganisation($organisationCode: String!) {
  discoverOrganisation(code: $organisationCode) {
    id type name address { suburb state postcode }
  }
}`;

// Generating today's date, not parsing one.
const TODAY = new Date().toISOString().slice(0, 10);

// Date arithmetic on a YYYY-MM-DD string without ever constructing a Date from
// a string — working_practice.md forbids new Date(str) for parsing.
function addDays(ymd, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function isRetired(season) {
  const status = (season.status && season.status.value) || '';
  if (status !== 'COMPLETED') return false;
  const cutoff = addDays(season.endDate, RETIRE_AFTER_DAYS);
  if (!cutoff) return false;
  return cutoff < TODAY;
}

function log(...a) {
  console.log(...a);
}

async function fetchOrganisation(code) {
  try {
    const res = await gqlPost(Q_ORGANISATION, { organisationCode: code }, 'discoverOrganisation');
    const o = res && res.data && res.data.discoverOrganisation;
    if (!o) return null;
    return {
      name: o.name || null,
      type: o.type || null,
      suburb: (o.address && o.address.suburb) || null,
      state: (o.address && o.address.state) || null,
      postcode: (o.address && o.address.postcode) || null,
    };
  } catch (e) {
    log(`  ${code}: discoverOrganisation failed — ${e.message}`);
    return null;
  }
}

async function fetchCompetitions(code) {
  const res = await gqlPost(Q_COMPETITIONS, { organisationID: code }, 'discoverCompetitions');
  if (res && res.errors && res.errors.length) {
    throw new Error(res.errors.map((e) => e.message).join('; '));
  }
  return (res && res.data && res.data.discoverCompetitions) || [];
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('config.json not found');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Accept either shape. New: organisations[] with code and name. Old:
  // competitions[] plus an organisationCodes[] array added by hand for this
  // migration.
  const newShape = Array.isArray(cfg.organisations) && cfg.organisations.length;
  const codes = newShape
    ? cfg.organisations.map((o) => o.code)
    : cfg.organisationCodes || [];

  if (!codes.length) {
    console.error(
      'No organisation codes found. Add an "organisationCodes" array to config.json\n' +
      'listing the 8-character codes, or migrate to the "organisations" shape.'
    );
    process.exit(1);
  }

  const existingComps = cfg.competitions || [];
  const vipByCode = new Map(newShape ? cfg.organisations.map((o) => [o.code, !!o.vip]) : []);
  const excludeByCode = new Map(newShape ? cfg.organisations.map((o) => [o.code, o.excludeGrades || []]) : []);

  log(`=== season discovery ===`);
  log(`today: ${TODAY}`);
  log(`organisations: ${codes.length}`);
  log(`config shape: ${newShape ? 'organisations[]' : 'competitions[] + organisationCodes[]'}`);

  await refreshSession();

  const organisations = {};
  const manifest = [];
  const failures = [];

  for (const code of codes) {
    let comps;
    try {
      comps = await fetchCompetitions(code);
    } catch (e) {
      log(`  ${code}: FAILED — ${e.message}`);
      failures.push({ code, error: e.message });
      await sleep(200);
      continue;
    }

    const org = await fetchOrganisation(code);
    const orgNameFromComp =
      (comps[0] && comps[0].organisation && comps[0].organisation.name) || null;

    const seasons = [];
    for (const c of comps) {
      for (const s of c.seasons || []) {
        seasons.push({
          id: s.id,
          name: s.name,
          competitionId: c.id,
          competitionName: c.name,
          startDate: s.startDate,
          endDate: s.endDate,
          status: (s.status && s.status.value) || null,
          retired: isRetired(s),
        });
      }
    }
    // Newest first, by end date. Season names are years but are strings.
    seasons.sort((a, b) => String(b.endDate || '').localeCompare(String(a.endDate || '')));

    organisations[code] = {
      code,
      orgName: (org && org.name) || orgNameFromComp,
      type: org && org.type,
      state: org && org.state,
      suburb: org && org.suburb,
      competitions: comps.map((c) => ({ id: c.id, name: c.name })),
      seasons,
    };

    log(
      `  ${code} ${(organisations[code].orgName || '?').slice(0, 40).padEnd(40)} ` +
      `${comps.length} comp(s), ${seasons.length} season(s)` +
      (organisations[code].state ? ` [${organisations[code].state}]` : '')
    );
    await sleep(200);
  }

  // ── config.json migration, by matching rather than guessing ────────────────
  //
  // Each existing competition entry has a name like "EFNL 2026" and a seasonID.
  // Find which organisation actually returns that seasonID, then derive the
  // short name by removing the matched season's name from the end of the
  // existing one. "EFNL 2026" minus "2026" is "EFNL", and "EFNL" + " " + "2026"
  // reproduces the stored compName byte for byte. Anything that does not match
  // is reported rather than assumed.
  const shortNameByCode = new Map();
  const unmatched = [];

  for (const comp of existingComps) {
    let found = null;
    for (const code of Object.keys(organisations)) {
      const hit = organisations[code].seasons.find((s) => s.id === comp.seasonID);
      if (hit) { found = { code, season: hit }; break; }
    }
    if (!found) {
      unmatched.push(comp);
      continue;
    }
    const suffix = ' ' + found.season.name;
    const short = comp.name.endsWith(suffix) ? comp.name.slice(0, -suffix.length) : null;
    if (!short) {
      unmatched.push({ ...comp, note: `name "${comp.name}" does not end with " ${found.season.name}"` });
      continue;
    }
    // Prove the round trip before recommending it.
    const rebuilt = `${short} ${found.season.name}`;
    if (rebuilt !== comp.name) {
      unmatched.push({ ...comp, note: `round trip produced "${rebuilt}"` });
      continue;
    }
    shortNameByCode.set(found.code, short);
    if (!vipByCode.has(found.code)) vipByCode.set(found.code, !!comp.vip);
    if (!excludeByCode.has(found.code)) excludeByCode.set(found.code, comp.excludeGrades || []);
    log(`  matched ${comp.name} (season ${comp.seasonID}) -> ${found.code}, short name "${short}"`);
  }

  if (unmatched.length) {
    log(`\n  WARNING: ${unmatched.length} configured competition(s) could not be matched:`);
    for (const u of unmatched) log(`    ${u.name} seasonID=${u.seasonID}${u.note ? ' — ' + u.note : ''}`);

    // Don't just report the problem — find the answer. discover-orgs.js already
    // recorded every AFL organisation's seasons, so an unmatched seasonID can be
    // traced to its owning organisation locally. Without this the user is told
    // something is wrong and left to search 1,175 organisations by hand.
    let sweep = null;
    if (fs.existsSync(ORG_DISCOVERY_PATH)) {
      try { sweep = JSON.parse(fs.readFileSync(ORG_DISCOVERY_PATH, 'utf8')); }
      catch (e) { log(`  (could not parse org-discovery.json: ${e.message})`); }
    }

    if (!sweep) {
      log('  data/org-discovery.json is absent, so the owning organisation could not');
      log('  be traced. Run the "Discover organisations" workflow and try again.');
    } else {
      const owners = new Map();
      for (const o of sweep.organisations || []) {
        for (const s of o.seasons || []) {
          if (!owners.has(s.id)) owners.set(s.id, { code: o.code, name: o.name, season: s.name, state: o.effectiveState || o.state });
        }
      }
      log('\n  Traced against data/org-discovery.json:');
      for (const u of unmatched) {
        const hit = owners.get(u.seasonID);
        if (hit) {
          log(
            `    ${u.name} (season ${u.seasonID}) belongs to ${hit.code} — ` +
            `"${hit.name}"${hit.state ? ` [${hit.state}]` : ''}, season "${hit.season}"`
          );
          const suffix = ' ' + hit.season;
          const short = u.name.endsWith(suffix) ? u.name.slice(0, -suffix.length) : null;
          log(
            `      -> add "${hit.code}" to organisationCodes` +
            (short ? `; its short name will resolve to "${short}"` : '')
          );
        } else {
          log(`    ${u.name} (season ${u.seasonID}) — not found in org-discovery.json either.`);
          log('      That sweep only covers type ASSOCIATION under tenantSlug afl, so a');
          log('      season belonging to a CLUB-type organisation would not appear.');
        }
      }
    }
    log('\n  Do not migrate config.json until these are resolved — an unmatched');
    log('  competition means compName would change and orphan every stored match id.');
  }

  // Attach the resolved short name and flags, then build the flat manifest.
  for (const code of Object.keys(organisations)) {
    const o = organisations[code];
    o.name = shortNameByCode.get(code) || o.orgName || code;
    o.vip = vipByCode.get(code) === true;
    o.excludeGrades = excludeByCode.get(code) || [];
    o.migrated = shortNameByCode.has(code);

    for (const s of o.seasons) {
      manifest.push({
        org: code,
        orgName: o.orgName,
        seasonId: s.id,
        seasonName: s.name,
        // compName is what every stored key is built from. Only trusted where
        // the short name was proven above; otherwise recorded as null so nothing
        // downstream invents one.
        compName: o.migrated ? `${o.name} ${s.name}` : null,
        competitionId: s.competitionId,
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        retired: s.retired,
        file: `data/orgs/${code}-${s.retired ? 'archive' : 'current'}.json`,
        // Filled in by the writers as each phase lands. Absent is not the same
        // as empty: a season awaiting the player backfill must be
        // distinguishable from one whose players are genuinely missing.
        phases: { results: false, players: false },
      });
    }
  }

  manifest.sort((a, b) => a.org.localeCompare(b.org) || String(b.endDate || '').localeCompare(String(a.endDate || '')));

  // ── Summary ────────────────────────────────────────────────────────────────
  const live = manifest.filter((m) => !m.retired);
  const byStatus = {};
  for (const m of manifest) byStatus[m.status || '(none)'] = (byStatus[m.status || '(none)'] || 0) + 1;

  log(`\n--- summary ---`);
  log(`organisations resolved: ${Object.keys(organisations).length} of ${codes.length}`);
  log(`seasons: ${manifest.length} (${live.length} live, ${manifest.length - live.length} retired)`);
  log(`season status: ${JSON.stringify(byStatus)}`);
  log(`matched to existing config: ${shortNameByCode.size} of ${existingComps.length}`);
  if (failures.length) log(`failures: ${failures.length} — ${failures.map((f) => f.code).join(', ')}`);
  // A counter without examples cannot be checked.
  for (const m of live.slice(0, 10)) {
    log(`  LIVE ${m.org} ${m.seasonId} ${String(m.compName || m.orgName).slice(0, 34).padEnd(34)} ${m.status} ${m.startDate}..${m.endDate}`);
  }

  // ── Proposed config.json, printed not written ─────────────────────────────
  const proposed = {
    organisations: Object.keys(organisations)
      .sort((a, b) => organisations[a].name.localeCompare(organisations[b].name))
      .map((code) => ({
        code,
        name: organisations[code].name,
        vip: organisations[code].vip,
        excludeGrades: organisations[code].excludeGrades,
      })),
  };
  log(`\n--- proposed config.json (NOT written — config.json is hand-edited) ---`);
  log(JSON.stringify(proposed, null, 2));

  // `name` is half of every stored key, so the difference between a name proven
  // against existing data and one taken from the API matters more than it looks.
  // Warn on the unproven ones specifically — not merely when something failed to
  // match, which is a different condition and misses every newly added
  // organisation.
  const unproven = Object.keys(organisations).filter((c) => !organisations[c].migrated);
  if (unproven.length) {
    log(`\n  ⚠️ ${unproven.length} organisation(s) have an UNPROVEN name, taken from the API`);
    log('  because no existing config entry pinned them. compName is built as');
    log('  `name + " " + seasonName`, so choose these deliberately before pasting —');
    log('  once records are stored under one, changing it orphans every match id.');
    for (const c of unproven) {
      const o = organisations[c];
      const sample = o.seasons[0];
      log(`    ${c}  name="${o.name}"  ->  compName would be "${o.name} ${sample ? sample.name : 'YYYY'}"`);
    }
  }
  if (unmatched.length) {
    log(`\n  ⚠️ ${unmatched.length} configured competition(s) did not match — see above.`);
    log('  Do not migrate config.json until that is explained.');
  }

  // ── Write core.json, preserving keys this script does not own ─────────────
  let core = {};
  if (fs.existsSync(CORE_PATH)) {
    try { core = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')); }
    catch (e) { log('Could not parse core.json — starting fresh'); }
  }

  const next = { ...core, organisations, manifest, lastSeasonDiscovery: new Date().toISOString() };

  // lastSeasonDiscovery changes every run, so comparing whole files would always
  // report a change. Compare everything except it.
  const canon = (o) => {
    if (!o) return null;
    const { lastSeasonDiscovery, ...rest } = o;
    return JSON.stringify(rest);
  };
  const changed = canon(core) !== canon(next);

  fs.mkdirSync(path.dirname(CORE_PATH), { recursive: true });
  fs.writeFileSync(CORE_PATH, JSON.stringify(next, null, 2), 'utf8');
  log(`\nWrote ${CORE_PATH}`);
  logSummary('discover-seasons');

  if (failures.length) {
    console.error(`FATAL: ${failures.length} organisation(s) failed — manifest is incomplete`);
    process.exit(1);
  }
  if (unmatched.length) {
    console.error(
      `\nFATAL: ${unmatched.length} configured competition(s) have no organisation in the list.\n` +
      `core.json was still written and is usable, but config.json MUST NOT be migrated yet:\n` +
      `a competition with no organisation loses its compName, and every stored match id\n` +
      `built from it is orphaned. Add the traced codes above and re-run.`
    );
    process.exit(1);
  }
  if (!changed) {
    log('No change — exit 2');
    process.exit(2);
  }
  log('Changed — exit 0');
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
