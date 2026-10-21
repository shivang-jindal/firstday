#!/usr/bin/env node
// cli.js — firstday v0 CLI. Zero dependencies; Node >= 20; ESM.
// Exit codes: 0 ready · 1 completed with warnings · 2 usage · 3 stage failure.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { statOrNull } from './fsx.js';
import { EXIT, persist, run } from './pipeline.js';
import { createRunner } from './runner.js';
import { resolveSiblingCli } from './map.js';
import { formatCard } from './card.js';

const HELP = `firstday — clone to first merged PR in 60 seconds (v0)

Usage:
  firstday <path> [options]

Options:
  --dry-run       show the plan and handoff card, change nothing (default)
  --apply         write outputs under <path>/.firstday/ (state, TOUR.md, plan)
  --resume        continue a previous run; ok stages are not redone
  --json          machine-readable output (plan/state/report on stdout)
  --no-verify     skip running tests; the card will say environment UNVERIFIED
  --timeout <s>   per-stage timeout budget in seconds (default 600)
  -h, --help      show this help
  -v, --version   print version

Stages: detect → verify → map → match → tour.
firstday only ever writes inside <path>/.firstday/, and only with --apply.
It never touches git branches, remotes, or your working tree.

Exit codes:
  0  ready (green tests, tour in hand)
  1  completed with warnings (no issue match, flaky suite, --no-verify, …)
  2  usage error
  3  stage failure (resumable with --resume)
`;

function parseArgs(argv) {
  const flags = {
    dryRun: true,
    apply: false,
    resume: false,
    json: false,
    noVerify: false,
    help: false,
    version: false,
    timeoutMs: 600_000,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '--dry-run') { flags.dryRun = true; flags.apply = false; }
    else if (a === '--apply') { flags.apply = true; flags.dryRun = false; }
    else if (a === '--resume') flags.resume = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--no-verify') flags.noVerify = true;
    else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: '--timeout requires a positive number of seconds' };
      flags.timeoutMs = v * 1000;
    } else if (a.startsWith('-')) {
      return { error: `unknown option: ${a}` };
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export async function main(argv, deps = {}) {
  // Injectable output sinks: tests collect instead of patching the global
  // process.stdout (which the test runner itself uses for its event stream).
  const write = deps.stdout ?? ((s) => process.stdout.write(s));
  const writeErr = deps.stderr ?? ((s) => process.stderr.write(s));
  const parsed = parseArgs(argv);
  if (parsed.error) {
    writeErr(`firstday: ${parsed.error}\nTry "firstday --help".\n`);
    return EXIT.USAGE;
  }
  const { flags, positional } = parsed;

  if (flags.help) {
    write(HELP);
    return EXIT.READY;
  }
  if (flags.version) {
    write('firstday 0.1.0\n');
    return EXIT.READY;
  }
  if (positional.length === 0) {
    writeErr('firstday: missing <path>\nTry "firstday --help".\n');
    return EXIT.USAGE;
  }
  if (positional.length > 1) {
    writeErr(`firstday: unexpected extra argument: ${positional[1]}\nTry "firstday --help".\n`);
    return EXIT.USAGE;
  }

  const root = path.resolve(positional[0]);
  const st = await statOrNull(root);
  if (!st || !st.isDirectory()) {
    writeErr(`firstday: not a directory: ${root}\n`);
    return EXIT.USAGE;
  }

  // Integration CLIs: env override > sibling vault project.
  const ctxcCli = deps.ctxcCli ?? process.env.FIRSTDAY_CTXC_CLI ?? await firstExisting([
    resolveSiblingCli('ctxc'),
  ]);
  const radarCli = deps.radarCli ?? process.env.FIRSTDAY_RADAR_CLI ?? await firstExisting([
    resolveSiblingCli('issue-radar'),
  ]);

  const exec = deps.exec ?? createRunner();
  const now = deps.now ?? (() => Date.now());

  let report = await run(root, flags, { exec, now, env: deps.env ?? process.env, ctxcCli, radarCli });
  // Persist on failure too: a failed stage is resumable, so the ok stages that
  // ran before it must survive on disk (--resume must not redo them).
  if (flags.apply) {
    report = await persist(report);
  }

  if (flags.json) {
    write(`${JSON.stringify(serialize(report), null, 2)}\n`);
    return report.exitCode;
  }
  write(formatCard(report, { ctxcCli, radarCli }));
  return report.exitCode;
}

function serialize(report) {
  return {
    exitCode: report.exitCode,
    mode: report.mode,
    root: report.root,
    needsInput: report.needsInput,
    stages: report.state.stages,
    match: report.match
      ? { source: report.match.source, issue: report.match.issue, note: report.match.note }
      : null,
    tour: report.tour ? { steps: report.tour.steps, touched: report.tour.touched, via: report.tour.via } : null,
    warnings: report.warnings,
    failure: report.failure,
    written: report.written,
  };
}

async function firstExisting(candidates) {
  for (const c of candidates) {
    const st = await statOrNull(c);
    if (st?.isFile()) return c;
  }
  return null;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    process.stderr.write(`firstday: unexpected error: ${err?.stack ?? err}\n`);
    process.exitCode = EXIT.STAGE_FAILURE;
  });
}
