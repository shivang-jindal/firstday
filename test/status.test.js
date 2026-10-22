// status.test.js — `firstday status <path>`: read-only stage table over a
// previous run's .firstday/state.json.
//
// Determinism: runs use the injected frozen clock, so durations and
// timestamps in the table are exact. The read-only proof fingerprints the
// whole tree before and after status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import {
  fakeRunner,
  fingerprintTree,
  stageFixture,
  tmpdir,
} from './helpers.js';

const FROZEN = 1_700_000_000_000; // fixed clock: deterministic ms + timestamps
const frozenClock = () => FROZEN;

function deps(extra = {}) {
  return {
    exec: fakeRunner(() => ({ code: 0 })),
    now: frozenClock,
    env: {},
    ctxcCli: '',
    radarCli: '',
    ...extra,
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

test('status: --apply then status prints a per-stage table with all stages', async () => {
  const root = stageFixture('node-match');
  const applied = await run([root, '--apply', '--json']);
  assert.equal(applied.code, 0);

  const r = await run(['status', root]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], `firstday status · ${root}`);
  assert.match(lines[1], /^stage\s+status\s+duration\s+timestamp$/);
  // every pipeline stage appears, in pipeline order
  const stageNames = lines.slice(3).map((l) => l.split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(
    stageNames.filter((s) => ['detect', 'verify', 'map', 'match', 'tour'].includes(s)),
    ['detect', 'verify', 'map', 'match', 'tour'],
  );
  // frozen clock → deterministic duration + ISO timestamp from the injected now
  assert.match(lines.find((l) => l.startsWith('detect')), /^detect\s+ok\s+0ms\s+2023-11-14T22:13:20\.000Z$/);
  assert.match(r.stdout, /all stages ok — nothing to resume/);
});

test('status --json: parses with {root, repo, version, stages, failed, resume}', async () => {
  const root = stageFixture('node-match');
  await run([root, '--apply', '--json']);

  const r = await run(['status', root, '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.root, root);
  assert.equal(out.version, 1);
  assert.ok(typeof out.repo === 'string');
  assert.deepEqual(out.failed, []);
  assert.equal(out.resume, null);
  assert.equal(out.stages.length, 5);
  const byStage = Object.fromEntries(out.stages.map((s) => [s.stage, s]));
  for (const stage of ['detect', 'verify', 'map', 'match', 'tour']) {
    assert.equal(byStage[stage].status, 'ok', `${stage} must be ok`);
    assert.equal(typeof byStage[stage].ms, 'number');
    assert.match(byStage[stage].at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('status: a failed stage shows the resume hint and exit stays 0 (reporting only)', async () => {
  const root = stageFixture('red-test-suite');
  const red = fakeRunner(() => ({ code: 1, stdout: 'not ok 1 - baseline red\n' }));
  const first = await run([root, '--apply', '--json'], deps({ exec: red }));
  assert.equal(first.code, 3, 'the run itself fails the stage');

  const r = await run(['status', root, '--json']);
  assert.equal(r.code, 0, 'status reports; it does not re-fail');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.failed, ['verify']);
  assert.equal(out.resume, `firstday ${root} --resume`);

  const human = await run(['status', root]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /failed stage\(s\): verify/);
  assert.match(human.stdout, new RegExp(`resume with: firstday ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --resume`));
  assert.match(human.stdout, /^verify\s+failed\s/m);
});

test('status: no state at all → exit 3 with the honest message; tree stays untouched', async () => {
  const root = stageFixture('node-pnpm'); // staged but never run
  const beforeFp = await fingerprintTree(root);
  const beforeFiles = fs.readdirSync(root).sort();

  const r = await run(['status', root]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.equal(
    r.stderr,
    `firstday: no state at ${path.join(root, '.firstday')} — run firstday ${root} first\n`,
  );

  // strictly read-only: nothing created, nothing modified
  assert.deepEqual(fs.readdirSync(root).sort(), beforeFiles);
  assert.deepEqual(await fingerprintTree(root), beforeFp);
});

test('status: strictly read-only on an existing state (fingerprint unchanged)', async () => {
  const root = stageFixture('node-match');
  await run([root, '--apply', '--json']);
  const beforeFp = await fingerprintTree(root);
  const beforeFiles = fs.readdirSync(root, { recursive: true }).sort();

  await run(['status', root]);
  await run(['status', root, '--json']);

  assert.deepEqual(
    fs.readdirSync(root, { recursive: true }).sort(),
    beforeFiles,
    'status must not create or remove files',
  );
  assert.deepEqual(await fingerprintTree(root), beforeFp, 'status must not modify files');
});

test('status: usage errors (missing path, extra args, not a directory)', async () => {
  const missing = await run(['status']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /usage: firstday status <path>/);

  const extra = await run(['status', fixtureDir(), 'extra']);
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /unexpected extra argument: extra/);

  const noDir = await run(['status', path.join(tmpdir('status-nodir'), 'nope')]);
  assert.equal(noDir.code, 2);
  assert.match(noDir.stderr, /not a directory/);
});

function fixtureDir() {
  return stageFixture('node-pnpm');
}
