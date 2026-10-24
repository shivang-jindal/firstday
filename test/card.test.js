// card.test.js — terminal rendering of the plan and handoff card (SPEC §5.5).
//
// formatCard is pure string formatting: environment result with real
// durations, map source, matched issue (or honest "none"), tour summary,
// conventions, warnings, and next steps. The failure card must always carry
// the exact reproduce command and the "never scaffold on red" promise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCard } from '../src/card.js';
import { persist, run } from '../src/pipeline.js';
import { fakeRunner, stageFixture, tmpdir, writeRadarStub, createRunner } from './helpers.js';

const frozenClock = () => 1_000;
const green = () => fakeRunner(() => ({ code: 0 }));

/**
 * Real exec ONLY for the injected radar/ctxc scan command; every other command
 * (install/test) uses the fake runner so tests never depend on pnpm/yarn being
 * installed on the machine running the suite.
 */
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

function deps(extra = {}) {
  return { exec: green(), now: frozenClock, env: {}, ctxcCli: null, radarCli: null, ...extra };
}

test('card: green dry-run shows durations, map, honest-none issue, tour', async () => {
  const root = stageFixture('node-pnpm');
  const report = await run(root, { dryRun: true }, deps());
  const card = formatCard(report, { ctxcCli: null, radarCli: null });

  assert.match(card, /^firstday \(dry-run — nothing written\) · /);
  assert.match(card, /── environment .*✅ green · tests 0ms \+ install 1ms · 1ms/);
  assert.match(card, /── map .*heuristic · 2 hotspots · 1 entry \(src\/index\.js\)/);
  assert.match(card, /── your issue .*none found \(honest none\)/);
  assert.match(card, /── tour .*"main tour" · 2 files via import-edges/);
  assert.match(card, /── conventions .*tests: scripts\.test · pm: pnpm · lang: javascript · test files: 1/);
  assert.match(card, /Warnings:/);
  assert.match(card, /⚠ no match found/);
  assert.match(card, /re-run with --apply to write \.firstday\/state\.json \+ TOUR\.md \+ plan\.json/);
  assert.match(card, /nothing was written; your tree is untouched/);
  assert.match(card, /ctxc not found \(\.\.\/\.\.\/ctxc\)/);
  assert.match(card, /issue-radar not found \(\.\.\/\.\.\/issue-radar\)/);
  assert.ok(!card.includes('Needs your input'), 'clean detection asks nothing');
});

test('card: matched static issue shows title, score, source and its citation', async () => {
  const root = stageFixture('node-match');
  const report = await run(root, { dryRun: true }, deps());
  const card = formatCard(report, { ctxcCli: null, radarCli: null });
  // Titles are truncated to 28 display columns (27 chars + ellipsis).
  assert.match(card, /── your issue .*1 TODO\/FIXME marker in src\/… ★0\.20 \(static\)/);
  assert.match(card, /Files you’ll touch, in order:/);
  assert.match(card, /  1\. src\/index\.js:3  — entry point/);
  assert.ok(!card.includes('none found'), 'a real match must not read as none');
  assert.ok(!card.includes('Warnings:'), 'no warnings on a matched run');
});

test('card: radar-sourced issue renders number + score + source', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeRadarStub(tmpdir('card-radar'), 'ok');
  const report = await run(root, { dryRun: true }, deps({ radarCli: stub, exec: routedExec(' --offline ') }));
  const card = formatCard(report, { ctxcCli: null, radarCli: stub });
  assert.match(card, /── your issue .*#42 Fix greeting bug ★0\.91 \(issue-radar\)/);
});

test('card: flaky suite is flagged inline in the environment rail', async () => {
  const root = stageFixture('node-pnpm');
  let calls = 0;
  const exec = fakeRunner((cmd) => {
    if (!/run test/.test(cmd)) return { code: 0 };
    calls += 1;
    return calls === 1 ? { code: 1 } : { code: 0 };
  });
  const report = await run(root, { dryRun: true }, deps({ exec }));
  const card = formatCard(report, { ctxcCli: null, radarCli: null });
  assert.match(card, /⚠ flaky \(passed on retry\)/);
  assert.match(card, /⚠ tests passed only on retry \(flaky suite\)/);
});

test('card: --no-verify and no-test-command both say UNVERIFIED, honestly', async () => {
  const root = stageFixture('node-pnpm');
  const skipped = await run(root, { dryRun: true, noVerify: true }, deps());
  assert.match(formatCard(skipped, {}), /⚠ UNVERIFIED \(--no-verify\)/);

  const bare = await run(stageFixture('ambiguous-locks'), { dryRun: true }, deps());
  const card = formatCard(bare, {});
  assert.match(card, /⚠ UNVERIFIED \(no test command\)/);
  assert.match(card, /Needs your input \(conservative detection\):/);
  assert.match(card, /\? Which JS package manager should firstday use\?/);
  assert.match(card, /\? No test command found — how should tests be run\?/);
});

test('card: failure card carries reproduce command and the red-suite promise', async () => {
  const root = stageFixture('red-test-suite');
  const red = fakeRunner(() => ({ code: 1, stdout: 'not ok 1 - baseline\n' }));
  const report = await run(root, { dryRun: true }, deps({ exec: red }));
  const card = formatCard(report, { ctxcCli: null, radarCli: null });

  assert.match(card, /❌ stage "verify" failed: test command failed/);
  assert.match(card, /Reproduce exactly:/);
  assert.ok(card.includes(`cd "${root}" && npm run test`));
  assert.match(card, /Output \(tail\):/);
  assert.match(card, /not ok 1 - baseline/);
  assert.match(card, /firstday never scaffolds onto a red suite\./);
  assert.ok(!card.includes('Next steps:'), 'no next steps on a failed run');
});

test('card: apply mode lists what was written and how to proceed', async () => {
  const root = stageFixture('node-match');
  const report = await persist(await run(root, { apply: true }, deps()));
  const card = formatCard(report, { ctxcCli: null, radarCli: null });
  assert.match(card, /^firstday \(apply\) · /);
  assert.match(card, /· written: \.firstday\/state\.json · \.firstday\/TOUR\.md · \.firstday\/plan\.json/);
  assert.match(card, /open the files above in order; run the test command; keep it green/);
});

test('card: timing helpers render ms below 1s and seconds above', async () => {
  const root = stageFixture('node-pnpm');
  let t = 0;
  const clock = () => { t += 2_500; return t; };
  const report = await run(root, { dryRun: true }, deps({ now: clock }));
  const card = formatCard(report, {});
  // testMs = 2500 -> "2.5s"; install stays at the fake runner's 1ms.
  assert.match(card, /✅ green · tests 2\.5s \+ install 1ms/);
});
