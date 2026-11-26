#!/usr/bin/env node
// scripts/probe.js
//
// One dispatcher for every probe, so there is one workflow instead of 26.
//
// ⚠️ GITHUB CANNOT SHOW DIFFERENT FIELDS PER CHOICE. `workflow_dispatch`
// inputs are static: there is no conditional display, no dependency between
// one input and another. A 26-probe form would therefore need every field of
// every probe on screen at once — 50-odd boxes, all but a handful irrelevant
// to whatever you picked. So the arguments come in as one `args` string of
// key=value pairs, and THIS FILE is what makes that discoverable:
//
//   * an unknown probe prints every probe, with its arguments and defaults;
//   * an unknown key prints the keys that probe accepts;
//   * `probe=list` prints the table and calls nothing.
//
// The keys are the SAME NAMES the individual workflows used, so anything
// written down in a doc or a commit message still works.
//
// ⚠️ IT ONLY DISPATCHES. Nothing here knows what a probe does, and no probe
// changes because of this file: each is spawned as its own process with the
// same environment variables its own workflow set, and its exit code is this
// process's exit code.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'probe v1 2026-11-26 one-dispatcher';
const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);

// probe name -> { script, args: { inputName: [ENV_VAR, default] } }
//
// ⚠️ TRANSCRIBED FROM THE 26 WORKFLOWS, NOT INVENTED. Every env var name and
// every default is what that probe's own workflow passed, so a probe behaves
// identically dispatched either way. Change one here and you have changed the
// probe's behaviour without touching the probe.
const TABLE = {
  'concurrent-comps':       { args: { org: ['PROBE_ORG', '1cf85e52'], season: ['PROBE_SEASON', '4dfaaab5'], age: ['PROBE_AGE', 'U10'], max_calls: ['PROBE_MAX_CALLS', '120'] } },
  'finals-rounds':          { args: { comp: ['IN_COMP', ''], age: ['IN_AGE', ''], grade_id: ['IN_GRADE_ID', ''], limit: ['IN_LIMIT', '0'], fixtures: ['IN_FIXTURES', 'false'], fixture_cap: ['IN_FIXTURE_CAP', '5'], cooldown_every: ['IN_COOLDOWN_EVERY', '60'], cooldown_seconds: ['IN_COOLDOWN_SECONDS', '30'], all_rounds: ['IN_ALL_ROUNDS', 'false'] } },
  // ⚠️ THIS ONE TAKES COMMAND-LINE ARGUMENTS, NOT ENVIRONMENT VARIABLES.
  // `const argOf = (name, dflt) => args.find(x => x.startsWith(`--${name}=`))`
  // — it reads `--players=…`, and that is precisely why its own workflow had
  // no env block and why every value typed into that form was discarded: the
  // form had no way to reach the script at all.
  //
  // ⚠️ AND THE FLAG IS `--delay`, NOT `--delay_ms`. The input keeps the name
  // the old form used so anything written down still works; `cli` is what it
  // is actually passed as.
  'fixture-watch-afl': {
    cli: { players: ['players', ''], tenant: ['tenant', 'afl'],
           delay_ms: ['delay', '400'], grade: ['grade', ''] },
  },
  'game-fields':            { args: { game: ['PROBE_GAME', ''] } },
  'last-interacted':        { args: { sample: ['PL_SAMPLE', '40'], pace_ms: ['PL_PACE_MS', '900'] } },
  'leftovers':              { args: { season: ['PL_SEASON', ''] } },
  'nonfinal-scores':        { args: { comp: ['PROBE_COMP', ''], rounds: ['PROBE_ROUNDS', '2'], grades: ['PROBE_GRADES', '0'] } },
  'org-profile':            { args: { orgs: ['PO_ORGS', ''], pace_ms: ['PO_PACE_MS', '900'] } },
  'org-registrations':      { args: { org: ['PR_ORG', ''], season: ['PR_SEASON', ''] } },
  'permit-club':            { args: { team: ['PP_TEAM', ''], players: ['PP_PLAYERS', ''], pace_ms: ['PP_PACE_MS', '900'] } },
  'preseason-roster':       { args: { n: ['PROBE_N', '100'], comp: ['PROBE_COMP', ''] }, env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
  'quarter-scores':         { args: { comp: ['PROBE_COMP', ''], sample: ['PROBE_SAMPLE', '80'] } },
  'rate':                   { args: { workers: ['PRATE_WORKERS', '1,2,4,8,16,25'], per_stage: ['PRATE_PER_STAGE', '150'] } },
  'rate-sharded':           { args: { workers: ['PRS_WORKERS', '1,2,4,8'], per: ['PRS_PER', '200'], pace_ms: ['PRS_PACE_MS', '0'] } },
  'registration-budget':    { args: { comp: ['PROBE_COMP', 'WFNL 2026'], max_calls: ['PROBE_MAX', '300'], windows: ['PROBE_WINDOWS', '2'], mode: ['PROBE_MODE', 'upcoming'] } },
  'registration-date':      { args: { profile: ['PD_PROFILE', ''], season: ['PD_SEASON', ''], only: ['PD_ONLY', ''] } },
  'registrations-and-config': { args: { season: ['PC_SEASON', ''] } },
  'round-flags':            { args: { grade: ['PROBE_GRADE', ''], match: ['PROBE_MATCH', ''], grades: ['PROBE_GRADES', '8'] } },
  'round-periods':          { args: { grade: ['PROBE_GRADE', ''] } },
  'search-by-id':           { args: { profile: ['PI_PROFILE', ''], name: ['PI_NAME', ''], pace_ms: ['PI_PACE_MS', '900'] } },
  'signings':               { args: { sample: ['PS_SAMPLE', '120'], comp: ['PS_COMP', ''], pace_ms: ['PS_PACE_MS', '900'] } },
  'team-join':              { args: { seasons: ['PROBE_SEASONS', '75d8a232,ca9cc98b'], examples: ['PROBE_EXAMPLES', '8'] } },
  'team-logo':              { args: { season: ['PL_SEASON', ''], played: ['PL_PLAYED', ''], org: ['PL_ORG', ''], pace_ms: ['PL_PACE_MS', ''] } },
  'team-roster':            { args: { season: ['PR_SEASON', ''], team: ['PR_TEAM', ''], profile: ['PR_PROFILE', ''], name: ['PR_NAME', ''] } },
  'waf-state':              { args: { note: ['PW_NOTE', ''] } },
  'waf-window':             { args: { rounds: ['PROBE_ROUNDS', '3'], burst: ['PROBE_BURST', '6'] } },
};
for (const [k, v] of Object.entries(TABLE)) v.script = v.script || `scripts/probe-${k}.js`;

function table() {
  log('');
  log('probe                      arguments (key=value, separated by ; or newline)');
  log('─────────────────────────  ──────────────────────────────────────────────────');
  for (const name of Object.keys(TABLE).sort()) {
    const t = TABLE[name];
    const as = Object.entries(t.args || t.cli)
      .map(([k, [, d]]) => d === '' ? k : `${k}=${d}`).join('  ');
    log(`${name.padEnd(26)} ${as || '(none)'}`);
    if (!fs.existsSync(path.join(ROOT, t.script))) {
      log(`${' '.repeat(26)} ⚠️ ${t.script} is NOT in this checkout`);
    }
    if (t.cli) {
      log(`${' '.repeat(26)} (passed on the command line, not as env — its own`);
      log(`${' '.repeat(26)}  workflow had no env block, which is why nothing`);
      log(`${' '.repeat(26)}  typed into that form ever reached the script)`);
    }
  }
  log('');
  log('Defaults are shown after "="; an argument with no "=" defaults to empty.');
  log('Example:  probe = permit-club');
  log('          args  = team=EFNL 2026 | Norwood (EFNL) | Norwood Gold/Heathmont');
}

// ⚠️ SPLIT ON ';' AND NEWLINES ONLY. Not on commas: `workers=1,2,4,8` and
// `players=Archie Ward,Harley Thomas` are single values that contain commas,
// and a comma split would silently truncate both.
function parseArgs(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(/[;\n]+/)) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    // ⚠️ FIRST '=' ONLY. A value may contain one.
    if (i < 1) return { error: `"${t}" is not key=value` };
    out.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return { out };
}

const probe = String(process.env.PROBE_NAME || '').trim();
log(`=== ${VERSION} ===`);

if (!probe || probe === 'list') {
  if (!probe) log('No probe selected.');
  table();
  process.exit(probe === 'list' ? 0 : 1);
}
const def = TABLE[probe];
if (!def) {
  log(`⚠️ "${probe}" is not a probe.`);
  table();
  process.exit(1);
}
const parsed = parseArgs(process.env.PROBE_ARGS);
if (parsed.error) {
  log(`⚠️ ${parsed.error}`);
  log(`   args is key=value pairs separated by ';' or newlines.`);
  log(`   ${probe} accepts: ${Object.keys(def.args).join(', ') || '(none)'}`);
  process.exit(1);
}
// ⚠️ AN UNKNOWN KEY IS A FAILURE, NOT A SHRUG. A typo that is ignored runs the
// probe on its defaults and the output looks like a real answer to the
// question you thought you asked.
const accepts = def.args || def.cli;
const bad = [...parsed.out.keys()].filter(k => !(k in accepts));
if (bad.length) {
  log(`⚠️ ${probe} does not take: ${bad.join(', ')}`);
  log(`   it accepts: ${Object.keys(accepts).join(', ') || '(none)'}`);
  process.exit(1);
}
const script = path.join(ROOT, def.script);
if (!fs.existsSync(script)) {
  log(`⚠️ ${def.script} is not in this checkout — commit it first.`);
  process.exit(1);
}

const env = { ...process.env, ...(def.env || {}) };
const argv = [];
const shown = [];
for (const [key, [target, dflt]] of Object.entries(accepts)) {
  const given = parsed.out.has(key);
  const val = given ? parsed.out.get(key) : dflt;
  // A blank default is NOT passed at all, so the script sees "unset" and uses
  // its own default rather than an empty string, which several read
  // differently. Same rule for both styles.
  if (val === '' && !given) continue;
  // ⚠️ `--name=value` AS ONE ARGV ENTRY. spawnSync with an array does no shell
  // parsing, so a value containing spaces or a pipe arrives whole and nothing
  // needs quoting.
  if (def.cli) argv.push(`--${target}=${val}`); else env[target] = val;
  shown.push(`${key}=${JSON.stringify(val)}${given ? '' : ' (default)'}`);
}
log(`probe: ${probe}   ->   ${def.script}${def.cli ? '   (command-line args)' : ''}`);
log(`args : ${shown.join('   ') || '(none)'}`);
log('');

const r = spawnSync(process.execPath, [script, ...argv], { stdio: 'inherit', env, cwd: ROOT });
if (r.error) { log(`⚠️ could not start ${def.script}: ${r.error.message}`); process.exit(1); }
// ⚠️ THE PROBE'S EXIT CODE IS OURS. Swallowing it would turn a failed probe
// into a green run.
process.exit(r.status === null ? 1 : r.status);
