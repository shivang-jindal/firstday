// verify.test.js — stage 2: "never lie about success" (SPEC §3.3).
//
// The verify stage installs, runs the detected test command through the
// INJECTED exec runner, retries once on red (flaky guard), reports honest
// reproduce commands, and refuses to proceed on failure. Everything here uses
// fakeRunner — no real processes, no network, deterministic timings via the
// injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/verify.js';
import { detect } from '../src/detect.js';
import { fakeRunner, fixturePath } from './helpers.js';

const CLOCK_START = 10_000;
const clock = () => CLOCK_START;

async function planOf(fixture) {
  const { plan } = await detect(fixturePath(fixture));
  return plan;
}

test('verify: green install + test reports verified with honest durations', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner(() => ({ code: 0 }));
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'ok');
  assert.equal(res.verified, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.flaky, false);
  assert.equal(res.reproduce, null);
  assert.equal(res.installMs, 1); // fakeRunner's canned ms
  assert.equal(res.testMs, 0); // injected clock is frozen
  assert.deepEqual(res.steps.map((s) => s.stage), ['install', 'test']);
  assert.equal(res.steps[0].command, 'pnpm install --frozen-lockfile');
  assert.equal(res.steps[1].command, 'pnpm run test');
  // verify passes FIRSTDAY_VERIFY=1 so repos can detect a firstday run.
  assert.equal(res.steps[1].code, 0);
  assert.ok(exec.calls.every((c) => c.opts.env.FIRSTDAY_VERIFY === '1'));
  assert.ok(exec.calls.every((c) => c.opts.cwd === '/repo'));
});

test('verify: first attempt red, retry green -> ok but flagged flaky', async () => {
  const plan = await planOf('node-pnpm');
  let testCalls = 0;
  const exec = fakeRunner((cmd) => {
    if (!/run test/.test(cmd)) return { code: 0 };
    testCalls += 1;
    return testCalls === 1 ? { code: 1, stderr: 'flake' } : { code: 0 };
  });
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'ok');
  assert.equal(res.verified, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.flaky, true);
  assert.equal(testCalls, 2);
});

test('verify: persistently red suite -> red with exact reproduce command', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner((cmd) => (/run test/.test(cmd)
    ? { code: 1, stdout: '1..5\nnot ok 1 - flaky assertion\n' }
    : { code: 0 }));
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'red');
  assert.equal(res.verified, false);
  assert.equal(res.attempts, 2); // flaky guard retried exactly once
  assert.match(res.reproduce, /^pnpm run test\s+\(in \/repo\)$/);
  assert.equal(res.phase, 'test');
  assert.match(res.output, /not ok 1/);
});

test('verify: test timeout -> status timeout, no retry', async () => {
  const plan = await planOf('node-pnpm');
  let calls = 0;
  const exec = fakeRunner((cmd) => {
    if (!/run test/.test(cmd)) return { code: 0 };
    calls += 1;
    return { timedOut: true, code: null };
  });
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'timeout');
  assert.equal(res.verified, false);
  assert.equal(res.attempts, 1); // timeouts are never retried
  assert.equal(calls, 1);
  assert.equal(res.phase, 'test');
  assert.match(res.reproduce, /pnpm run test/);
});

test('verify: install failure short-circuits with phase=install', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner(() => ({ code: 1, stderr: 'E404 network unreachable' }));
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'red');
  assert.equal(res.phase, 'install');
  assert.equal(res.steps.length, 1); // tests never ran
  assert.equal(res.testMs, null);
  assert.match(res.reproduce, /pnpm install --frozen-lockfile/);
  assert.match(res.output, /E404/);
});

test('verify: install timeout -> phase=install timeout', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner(() => ({ timedOut: true, code: null }));
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'timeout');
  assert.equal(res.phase, 'install');
  assert.equal(res.steps.length, 1);
});

test('verify: runner error (spawn failure) is red, attempts=1', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner((cmd) => (/run test/.test(cmd)
    ? { error: 'spawn ENOENT', code: null }
    : { code: 0 }));
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'red');
  assert.equal(res.attempts, 1);
  assert.equal(res.verified, false);
});

test('verify: --no-verify skips entirely and says environment UNVERIFIED', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner(() => { throw new Error('exec must not run when skipped'); });
  const res = await verify('/repo', plan, { exec, skip: true, now: clock });
  assert.equal(res.status, 'skipped');
  assert.equal(res.verified, false);
  assert.match(res.note, /UNVERIFIED/);
  assert.deepEqual(res.steps, []);
  assert.equal(exec.calls.length, 0);
});

test('verify: no test command detected -> no-command, UNVERIFIED', async () => {
  const plan = await planOf('ambiguous-locks'); // package.json without scripts
  const exec = fakeRunner(() => { throw new Error('exec must not run without a test step'); });
  const res = await verify('/repo', plan, { exec, now: clock });
  assert.equal(res.status, 'no-command');
  assert.equal(res.verified, false);
  assert.match(res.note, /no test command detected/);
  assert.equal(exec.calls.length, 0);
});

test('verify: injected timeout budget reaches the runner', async () => {
  const plan = await planOf('node-pnpm');
  const exec = fakeRunner(() => ({ code: 0 }));
  await verify('/repo', plan, { exec, timeoutMs: 4_321, now: clock });
  assert.ok(exec.calls.length > 0);
  for (const call of exec.calls) assert.equal(call.opts.timeoutMs, 4_321);
});

test('verify: output is tailed to the last 20 lines (never floods the card)', async () => {
  const plan = await planOf('node-pnpm');
  const noisy = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const exec = fakeRunner((cmd) => (/run test/.test(cmd) ? { code: 1, stdout: noisy } : { code: 0 }));
  const res = await verify('/repo', plan, { exec, now: clock });
  const lines = res.output.split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[19], 'line 50');
});

test('verify: commandless-but-green plans never claim verification', async () => {
  // A plan whose only step is install (no test step) must not be "ok".
  const res = await verify('/repo', { steps: [{ stage: 'install', command: 'npm ci' }] }, {
    exec: fakeRunner(() => ({ code: 0 })),
    now: clock,
  });
  assert.equal(res.status, 'no-command');
  assert.equal(res.verified, false);
});
