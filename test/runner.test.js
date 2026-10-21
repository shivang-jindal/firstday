// runner.test.js — the injected exec runner (real processes, local only).
//
// createRunner must: never reject on nonzero exits, capture bounded output,
// report durations, and kill the WHOLE process tree on timeout — on Windows
// that means taskkill /T /F, and these tests run on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, fakeRunner } from '../src/runner.js';

const node = `"${process.execPath}"`;

test('createRunner: success captures stdout, code 0, no throw', async () => {
  const exec = createRunner();
  const r = await exec(`${node} -p "1+1"`);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '2');
  assert.equal(r.timedOut, false);
  assert.equal(r.error, null);
  assert.match(r.command, /-p/);
  assert.equal(typeof r.ms, 'number');
  assert.ok(r.ms >= 0);
});

test('createRunner: nonzero exit is a result, not an exception', async () => {
  const exec = createRunner();
  const r = await exec(`${node} -e "process.exit(7)"`);
  assert.equal(r.code, 7);
  assert.equal(r.error, null, 'a clean nonzero exit is not an error');
  assert.equal(r.timedOut, false);
});

test('createRunner: stderr is captured separately from stdout', async () => {
  const exec = createRunner();
  const r = await exec(`${node} -e "process.stderr.write('to-err')"`);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, 'to-err');
  assert.equal(r.stdout, '');
});

test('createRunner: timeout kills the process tree and flags timedOut', async () => {
  const exec = createRunner();
  const started = Date.now();
  const r = await exec(`${node} -e "setInterval(()=>{},1000)"`, { timeoutMs: 700 });
  const wall = Date.now() - started;
  assert.equal(r.timedOut, true, 'the timeout flag must be set');
  assert.notEqual(r.code, 0, 'a killed process tree never reports success');
  assert.ok(wall < 8_000, `process tree must die promptly, took ${wall}ms`);
});

test('createRunner: a missing command fails gracefully with a nonzero code', async () => {
  const exec = createRunner();
  const r = await exec('definitely-not-a-real-command-xyz-123');
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
});

test('createRunner: output beyond 512KB is tailed with an honest truncation note', async () => {
  const exec = createRunner();
  const r = await exec(`${node} -e "process.stdout.write('x'.repeat(700000))"`);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\u2026\(truncated \d+ chars\)\n/);
  assert.ok(r.stdout.length < 700_000);
  assert.ok(r.stdout.endsWith('x'.repeat(1000)), 'the TAIL is kept');
});

test('createRunner: env options reach the child process', async () => {
  const exec = createRunner();
  const r = await exec(`${node} -p "process.env.FIRSTDAY_RUNNER_TEST || 'unset'"`, {
    env: { FIRSTDAY_RUNNER_TEST: 'yes' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'yes');
});

test('fakeRunner: records calls and merges canned results over defaults', async () => {
  const exec = fakeRunner((command, opts, n) => ({ code: n === 1 ? 0 : 3, stdout: `call-${n}` }));
  const a = await exec('first', { cwd: '/one' });
  const b = await exec('second');
  assert.equal(a.code, 0);
  assert.equal(a.stdout, 'call-1');
  assert.equal(b.code, 3);
  assert.equal(b.stdout, 'call-2');
  assert.equal(b.signal, null);
  assert.equal(b.timedOut, false);
  assert.equal(b.error, null);
  assert.deepEqual(exec.calls.map((c) => c.command), ['first', 'second']);
  assert.equal(exec.calls[0].opts.cwd, '/one');
});
