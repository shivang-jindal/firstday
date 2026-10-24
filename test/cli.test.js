// cli.test.js — argv parsing, exit codes, output modes, and persistence wiring.
//
// `main(argv, deps)` is fully injectable: exec, integration CLIs, clock, env.
// The sibling-vault CLIs are forced off with empty-string overrides so results
// never depend on the machine this suite runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import {
  createRunner,
  fakeRunner,
  fixturePath,
  stageFixture,
  writeRadarStub,
  tmpdir,
} from './helpers.js';

const frozenClock = () => 1_000;
const green = () => fakeRunner(() => ({ code: 0 }));

function deps(extra = {}) {
  return {
    exec: green(),
    now: frozenClock,
    env: {},
    ctxcCli: '', // disable vault sibling integration
    radarCli: '',
    ...extra,
  };
}

/** Real exec only for the radar scan command; verify stays on the fake runner. */
function routedExec(scanMarker) {
  const fake = green();
  const real = createRunner();
  return (cmd, opts) => {
    // match.js probes the git origin remote before invoking radar
    if (cmd.includes('git remote get-url origin')) {
      return Promise.resolve({
        command: cmd, code: 0, signal: null, stdout: 'git@github.com:acme/widgets.git\n',
        stderr: '', timedOut: false, ms: 1, error: null,
      });
    }
    return cmd.includes(scanMarker) ? real(cmd, opts) : fake(cmd, opts);
  };
}

const run = async (argv, d = deps()) => {
  const out = [];
  const err = [];
  const code = await main(argv, {
    ...d,
    stdout: (s) => { out.push(String(s)); return true; },
    stderr: (s) => { err.push(String(s)); return true; },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
};

test('cli: --help prints usage and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^firstday — clone to first merged PR in 60 seconds/);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--dry-run/);
  assert.match(r.stdout, /Exit codes:/);
  assert.equal(r.stderr, '');
});

test('cli: -v prints the version and exits 0', async () => {
  const r = await run(['-v']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'firstday 0.1.0\n');
});

test('cli: missing path is a usage error (exit 2)', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /missing <path>/);
  assert.match(r.stderr, /--help/);
});

test('cli: extra positional arguments are rejected (exit 2)', async () => {
  const r = await run([fixturePath('node-pnpm'), 'extra']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unexpected extra argument: extra/);
});

test('cli: unknown option is rejected with a hint (exit 2)', async () => {
  const r = await run(['--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown option: --bogus/);
});

test('cli: --timeout requires a positive number (exit 2)', async () => {
  for (const bad of ['abc', '0', '-5']) {
    const r = await run([fixturePath('node-pnpm'), '--timeout', bad]);
    assert.equal(r.code, 2, `--timeout ${bad} must be rejected`);
    assert.match(r.stderr, /--timeout requires a positive number of seconds/);
  }
});

test('cli: a path that is not a directory is a usage error (exit 2)', async () => {
  const r = await run([path.join(tmpdir('cli-nodir'), 'no-such-thing')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a directory/);
});

test('cli --json: machine output with stages, warnings, honest exit code', async () => {
  const r = await run([fixturePath('node-pnpm'), '--json']);
  assert.equal(r.code, 1, 'no match found -> warnings exit code');
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.exitCode, 1);
  assert.equal(out.mode, 'dry-run');
  assert.equal(out.stages.detect.status, 'ok');
  assert.equal(out.stages.verify.verified, true);
  assert.equal(out.match.source, 'static');
  assert.equal(out.match.issue, null);
  assert.equal(out.tour.via, 'import-edges');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /no match found/);
  assert.deepEqual(out.written, []);
  assert.equal(out.failure, null);
});

test('cli --apply: writes .firstday outputs and reports them in JSON', async () => {
  const root = stageFixture('node-match');
  const r = await run([root, '--apply', '--json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.written, ['.firstday/state.json', '.firstday/TOUR.md', '.firstday/plan.json']);
  assert.equal(out.mode, 'apply');
  for (const rel of out.written) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} must exist on disk`);
  }
  // Nothing outside .firstday was created or removed.
  const top = fs.readdirSync(root).filter((n) => n !== '.firstday').sort();
  assert.deepEqual(top, ['package-lock.json', 'package.json', 'src', 'test']);
});

test('cli: human card output (no --json) shows the full handoff', async () => {
  const root = stageFixture('node-match');
  const r = await run([root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /firstday \(dry-run — nothing written\)/);
  assert.match(r.stdout, /── environment .*✅ green/);
  assert.match(r.stdout, /── map .*heuristic/);
  assert.match(r.stdout, /── your issue .*★0\.20 \(static\)/);
  assert.match(r.stdout, /── tour .*via import-edges/);
  assert.match(r.stdout, /── conventions/);
  assert.match(r.stdout, /Files you’ll touch, in order:/);
  assert.match(r.stdout, /  1\. src\/index\.js:3  — entry point/);
  assert.match(r.stdout, /nothing was written; your tree is untouched/);
  assert.match(r.stdout, /ctxc not found/); // deps.ctxcCli '' -> honest hint
  assert.match(r.stdout, /issue-radar not found/);
});

test('cli --no-verify: card says UNVERIFIED and exit is 1', async () => {
  const root = stageFixture('node-pnpm');
  const r = await run([root, '--no-verify']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /⚠ UNVERIFIED \(--no-verify\)/);
  assert.match(r.stdout, /environment UNVERIFIED/);
});

test('cli: red suite exits 3, persists on --apply, and --resume finishes', async () => {
  const root = stageFixture('red-test-suite');
  const redExec = fakeRunner(() => ({ code: 1, stdout: 'not ok 1 - baseline red\n' }));
  const first = await run([root, '--apply', '--json'], deps({ exec: redExec }));
  assert.equal(first.code, 3);
  const firstOut = JSON.parse(first.stdout);
  assert.equal(firstOut.failure.stage, 'verify');
  assert.match(firstOut.failure.reproduce, /npm run test/);
  assert.ok(firstOut.written.includes('.firstday/state.json'),
    'a failed stage is still persisted so --resume can continue');
  const state = JSON.parse(fs.readFileSync(path.join(root, '.firstday', 'state.json'), 'utf8'));
  assert.equal(state.stages.verify.status, 'failed');

  // Fixed baseline: --resume must not redo detect, then completes honestly.
  const second = await run([root, '--apply', '--resume', '--json'], deps());
  assert.notEqual(second.code, 3);
  const secondOut = JSON.parse(second.stdout);
  assert.equal(secondOut.failure, null);
  assert.equal(secondOut.stages.detect.skipped, 'resumed');
  assert.equal(secondOut.stages.verify.status, 'ok');
});

test('cli: a radar issue makes it onto the card via the injected stub', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeRadarStub(tmpdir('cli-radar'), 'ok');
  const r = await run([root], deps({ radarCli: stub, exec: routedExec(' --offline ') }));
  assert.equal(r.code, 0, 'matched issue -> no warnings');
  assert.match(r.stdout, /── your issue .*#42 Fix greeting bug ★0\.91 \(issue-radar\)/);
  assert.match(r.stdout, /Files you’ll touch, in order:/);
});

test('cli: --apply --json on a fresh dir after --resume-without-state still works', async () => {
  const root = stageFixture('node-match');
  const r = await run([root, '--resume', '--json'], deps());
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.stages.detect.status, 'ok');
  assert.equal(out.stages.detect.skipped, undefined);
});
