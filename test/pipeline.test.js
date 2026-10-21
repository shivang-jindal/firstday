// pipeline.test.js — the staged pipeline end to end (SPEC §3, §6, §10).
//
// Invariants under test:
//   * dry-run changes nothing (byte-for-byte tree fingerprints)
//   * --apply writes ONLY inside <root>/.firstday
//   * red suite -> exit 3, no later stage runs, exact reproduce command
//   * --resume skips ok stages (proven by a runner that would throw if called)
//   * warnings (no match, flaky, UNVERIFIED) -> exit 1, never a fake success
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, persist, run } from '../src/pipeline.js';
import {
  createRunner,
  fakeRunner,
  fingerprintTree,
  listAll,
  stageFixture,
  tmpdir,
} from './helpers.js';

const frozenClock = () => 1_000;
const green = () => fakeRunner(() => ({ code: 0 }));

function deps(extra = {}) {
  return { exec: green(), now: frozenClock, env: {}, ctxcCli: null, radarCli: null, ...extra };
}

test('EXIT codes: ready/warnings/usage/stage-failure per SPEC §2', () => {
  assert.deepEqual(EXIT, { READY: 0, WARNINGS: 1, USAGE: 2, STAGE_FAILURE: 3 });
});

test('pipeline dry-run: green suite but honest no-match -> exit 1, zero writes', async () => {
  const root = stageFixture('node-pnpm');
  const beforeFiles = listAll(root);
  const beforeFp = await fingerprintTree(root);

  const report = await run(root, { dryRun: true }, deps());

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.exitCode, EXIT.WARNINGS);
  assert.deepEqual(report.written, []);
  assert.deepEqual(report.needsInput, []);

  // Every stage ran and recorded honest results.
  assert.equal(report.state.stages.detect.status, 'ok');
  assert.equal(report.state.stages.verify.status, 'ok');
  assert.equal(report.verify.verified, true, 'only a green run may claim verification');
  assert.equal(report.map.source, 'heuristic');
  assert.equal(report.match.source, 'static');
  assert.equal(report.match.issue, null, 'clean repo -> no invented issue');
  assert.equal(report.tour.via, 'import-edges');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^no match found — static scan/);

  // The tree is byte-for-byte untouched.
  assert.deepEqual(listAll(root), beforeFiles);
  assert.deepEqual(await fingerprintTree(root), beforeFp);
  assert.equal(report.failure, null);
});

test('pipeline dry-run: matched TODO -> exit 0 with a cited tour', async () => {
  const root = stageFixture('node-match');
  const report = await run(root, { dryRun: true }, deps());
  assert.equal(report.exitCode, EXIT.READY);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.match.issue.kind, 'todo-cluster');
  assert.equal(report.tour.steps[0].path, 'src/index.js');
  assert.equal(report.tour.steps[0].line, 3);
  assert.deepEqual(report.written, []);
});

test('pipeline --apply: writes exactly .firstday/{state,TOUR.md,plan.json}', async () => {
  const root = stageFixture('node-match');
  const beforeFiles = listAll(root);

  const report = await persist(await run(root, { apply: true }, deps()));
  assert.deepEqual(report.written, [
    '.firstday/state.json',
    '.firstday/TOUR.md',
    '.firstday/plan.json',
  ]);

  // Files exist with SPEC §7 shape.
  const state = JSON.parse(fs.readFileSync(path.join(root, '.firstday', 'state.json'), 'utf8'));
  assert.equal(state.version, 1);
  assert.equal(state.repo, path.basename(root));
  for (const stage of ['detect', 'verify', 'map', 'match', 'tour']) {
    assert.equal(state.stages[stage].status, 'ok', `${stage} must be recorded ok`);
    assert.equal(typeof state.stages[stage].ms, 'number');
  }
  assert.ok(state.stages.detect.plan, 'plan is persisted for --resume');
  assert.equal(state.stages.detect.plan.js.value, 'npm');

  const tour = fs.readFileSync(path.join(root, '.firstday', 'TOUR.md'), 'utf8');
  assert.match(tour, /# firstday tour/);

  const plan = JSON.parse(fs.readFileSync(path.join(root, '.firstday', 'plan.json'), 'utf8'));
  for (const key of ['provision', 'languages', 'js', 'test', 'install', 'steps', 'monorepo', 'repoSize']) {
    assert.ok(key in plan, `plan.json must include ${key}`);
  }

  // Exactly the three new files, nothing else.
  const afterFiles = listAll(root);
  const added = afterFiles.filter((f) => !beforeFiles.includes(f)).sort();
  assert.deepEqual(added, ['.firstday/TOUR.md', '.firstday/plan.json', '.firstday/state.json']);
  const removed = beforeFiles.filter((f) => !afterFiles.includes(f));
  assert.deepEqual(removed, []);
});

test('pipeline: red suite -> exit 3, later stages never run, nothing written', async () => {
  const root = stageFixture('red-test-suite');
  const beforeFp = await fingerprintTree(root);
  const exec = fakeRunner(() => ({ code: 1, stdout: 'not ok 1 - baseline is red on purpose\n' }));

  const report = await run(root, { dryRun: true }, deps({ exec }));

  assert.equal(report.exitCode, EXIT.STAGE_FAILURE);
  assert.equal(report.failure.stage, 'verify');
  assert.equal(report.failure.message, 'test command failed');
  assert.match(report.failure.reproduce, /^npm run test\s+/);
  assert.ok(report.failure.reproduce.includes(root), 'reproduce includes the cwd');
  assert.match(report.failure.output, /baseline is red/);
  assert.equal(report.map, null, 'no map on a red suite');
  assert.equal(report.match, null);
  assert.equal(report.tour, null);
  assert.deepEqual(report.written, []);
  assert.equal(report.state.stages.verify.status, 'failed');
  assert.deepEqual(await fingerprintTree(root), beforeFp, 'failure wrote nothing');
});

test('pipeline: --resume skips ok stages and reruns the failed one', async () => {
  const root = stageFixture('red-test-suite');

  // Run 1: red, but --apply persists the failure for resumability.
  const redExec = fakeRunner(() => ({ code: 1, stdout: 'not ok\n' }));
  const first = await persist(await run(root, { apply: true }, deps({ exec: redExec })));
  assert.equal(first.exitCode, EXIT.STAGE_FAILURE);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, '.firstday', 'state.json'), 'utf8'));
  assert.equal(persisted.stages.verify.status, 'failed');
  assert.equal(persisted.stages.detect.status, 'ok');

  // Run 2: fixed baseline. detect must be reused (marked resumed), verify reruns.
  const greenExec = fakeRunner(() => ({ code: 0 }));
  const second = await persist(await run(root, { resume: true, apply: true }, deps({ exec: greenExec })));
  assert.equal(second.failure, null);
  assert.notEqual(second.exitCode, EXIT.STAGE_FAILURE);
  assert.equal(second.state.stages.detect.skipped, 'resumed');
  assert.equal(second.state.stages.verify.status, 'ok', 'failed stage reran and is now green');
  assert.equal(second.state.stages.detect.plan.js.value, 'npm', 'plan came from the state file');
  assert.ok(greenExec.calls.length >= 1, 'verify re-executed the test command');
  // Stages that never ran before run fresh (no skipped marker).
  assert.equal(second.state.stages.map.skipped, undefined);
  assert.equal(second.state.stages.tour.skipped, undefined);
});

test('pipeline: --resume on a fresh dir behaves like a normal run', async () => {
  const root = stageFixture('node-match');
  const report = await run(root, { resume: true, dryRun: true }, deps());
  assert.equal(report.state.resumed, false, 'honestly reports there was nothing to resume');
  assert.equal(report.exitCode, EXIT.READY);
  assert.equal(report.state.stages.detect.skipped, undefined);
});

test('pipeline --no-verify: UNVERIFIED warning, exit 1, exec never called', async () => {
  const root = stageFixture('node-pnpm');
  const exec = fakeRunner(() => { throw new Error('exec must not run with --no-verify'); });
  const report = await run(root, { dryRun: true, noVerify: true }, deps({ exec }));
  assert.equal(report.verify.status, 'skipped');
  assert.equal(report.verify.verified, false);
  assert.equal(report.warnings[0], 'environment UNVERIFIED (--no-verify)');
  assert.equal(report.exitCode, EXIT.WARNINGS);
  assert.equal(exec.calls.length, 0);
});

test('pipeline: flaky suite (red then green) is warned about, never hidden', async () => {
  const root = stageFixture('node-pnpm');
  let testCalls = 0;
  const exec = fakeRunner((cmd) => {
    if (!/run test/.test(cmd)) return { code: 0 };
    testCalls += 1;
    return testCalls === 1 ? { code: 1 } : { code: 0 };
  });
  const report = await run(root, { dryRun: true }, deps({ exec }));
  assert.ok(report.warnings.some((w) => /passed only on retry \(flaky suite\)/.test(w)));
  assert.equal(report.verify.flaky, true);
  assert.equal(report.exitCode, EXIT.WARNINGS);
});

test('pipeline: --timeout budget flows through to every verify command', async () => {
  const root = stageFixture('node-pnpm');
  const exec = green();
  await run(root, { dryRun: true, timeoutMs: 4_321 }, deps({ exec }));
  assert.ok(exec.calls.length > 0);
  for (const call of exec.calls) assert.equal(call.opts.timeoutMs, 4_321);
});

test('pipeline: a dry-run never blames ctxc for not being executed', async () => {
  const root = stageFixture('node-match');
  const report = await run(root, { dryRun: true }, deps({ ctxcCli: 'C:/not-used/in-dry-run.js' }));
  assert.equal(report.map.ctxc.skipped, 'dry-run');
  assert.deepEqual(report.warnings, [], 'a skipped ctxc build is not a failure');
  assert.equal(report.exitCode, EXIT.READY);
});

test('pipeline --apply: a genuinely failing ctxc build warns and degrades', async () => {
  const root = stageFixture('node-match');
  // Route only the ctxc invocation through the real runner (the file does not
  // exist, so node exits 1); keep verify on the fake runner for determinism.
  const fake = green();
  const real = createRunner();
  const exec = (cmd, opts) => (cmd.includes('ctxc-missing') ? real(cmd, opts) : fake(cmd, opts));
  const report = await run(root, { apply: true }, deps({
    exec,
    ctxcCli: path.join(tmpdir('no-such-dir'), 'ctxc-missing.js'),
  }));
  assert.equal(report.map.source, 'heuristic');
  assert.equal(report.map.ctxc.ok, false);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^ctxc build failed \(ctxc build exited 1\) — map is heuristic/);
  assert.equal(report.exitCode, EXIT.WARNINGS);
});

test('pipeline: detection needsInput surfaces as questions on the report', async () => {
  const root = stageFixture('ambiguous-locks');
  const report = await run(root, { dryRun: true }, deps());
  const keys = report.needsInput.map((n) => n.key);
  assert.ok(keys.includes('js.packageManager'));
  assert.ok(keys.includes('test.command'));
  assert.equal(report.verify.status, 'no-command');
  assert.ok(report.warnings.some((w) => /UNVERIFIED \(no test command detected\)/.test(w)));
});
