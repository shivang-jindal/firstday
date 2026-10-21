// map.test.js — stage 3: architecture map + ctxc integration.
//
// The heuristic tier must produce a deterministic map (structure, entry points,
// hotspots with import degree, test topology, import edges). The ctxc tier is
// exercised through injected stub CLIs: success, failure, empty output,
// timeout, and the dry-run skip — never the network, never outside tmpdir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { map, resolveSiblingCli } from '../src/map.js';
import {
  createRunner,
  fixturePath,
  stageFixture,
  tmpdir,
  writeCtxcStub,
  writeStub,
} from './helpers.js';

test('map(node-pnpm): heuristic entry point, hotspots, edges, test topology', async () => {
  const root = fixturePath('node-pnpm');
  const m = await map(root);
  assert.equal(m.source, 'heuristic');
  assert.equal(m.ctxc, null);
  assert.equal(m.fileCount, 6);

  // Entry point comes from package.json "main" (not a guess).
  assert.deepEqual(m.entryPoints.map((e) => e.file), ['src/index.js']);
  assert.equal(m.entryPoints[0].kind, 'main');

  // Score = loc * (1 + log2(1 + importDegree)). src/greet.js (4 LOC, imported
  // by 1 file -> 8) outranks src/index.js (6 LOC, degree 0 -> 6).
  assert.deepEqual(m.hotspots.map((h) => h.file), ['src/greet.js', 'src/index.js']);
  assert.equal(m.hotspots[0].loc, 4);
  assert.equal(m.hotspots[0].importDegree, 1);
  assert.equal(m.hotspots[0].score, 8);
  assert.equal(m.hotspots[1].loc, 6);
  assert.equal(m.hotspots[1].importDegree, 0);
  assert.equal(m.hotspots[1].score, 6);

  // Test files never become hotspots; the topology records the pattern.
  assert.deepEqual(m.edges, { 'src/index.js': ['src/greet.js'] });
  assert.equal(m.tests.count, 1);
  assert.equal(m.tests.pattern, '*.test.{js,ts}');
  assert.deepEqual(m.tests.dirs, ['test']);

  const roles = Object.fromEntries(m.structure.map((s) => [s.dir, s.role]));
  assert.equal(roles.src, 'source');
  assert.equal(roles.test, 'tests');
});

test('map(go): conventional entry file + Go test pattern', async () => {
  const m = await map(fixturePath('go'));
  assert.deepEqual(m.entryPoints.map((e) => e.file), ['main.go']);
  assert.equal(m.entryPoints[0].kind, 'conventional');
  assert.equal(m.tests.count, 1);
  assert.equal(m.tests.pattern, '*_test.{py,go,rs}');
  assert.deepEqual(m.tests.files, ['main_test.go']);
  assert.deepEqual(m.structure, []); // everything at the repo root
});

test('map(python-marker): nested unittest files count as tests (regression)', async () => {
  const m = await map(fixturePath('python-marker'));
  assert.equal(m.tests.count, 1, 'tests/test_main.py must be recognized');
  assert.equal(m.tests.pattern, 'test_*.py');
  assert.deepEqual(m.tests.dirs, ['tests']);
  // The test file must NOT appear among code hotspots.
  assert.ok(!m.hotspots.some((h) => h.file.includes('test')));
  assert.deepEqual(m.entryPoints.map((e) => e.file), ['src/main.py']);
});

test('map: hotspots are sorted by score desc then path asc and capped at 8', async () => {
  const root = tmpdir('hotspots');
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.js`), `// file ${i}\n${'x\n'.repeat(i)}`);
  }
  const m = await map(root);
  assert.ok(m.hotspots.length <= 8);
  for (let i = 1; i < m.hotspots.length; i += 1) {
    const a = m.hotspots[i - 1];
    const b = m.hotspots[i];
    assert.ok(a.score > b.score || (a.score === b.score && a.file <= b.file));
  }
});

test('map: dry-run never executes ctxc (skipped, not failed)', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeCtxcStub(tmpdir('map-stubs'));
  const exec = createRunner();
  const m = await map(root, { apply: false, ctxcCli: stub, exec });
  assert.equal(m.source, 'heuristic');
  assert.equal(m.ctxc.ok, false);
  assert.equal(m.ctxc.skipped, 'dry-run');
  assert.match(m.ctxc.error, /dry-run/);
  assert.equal(fs.existsSync(path.join(root, '.firstday')), false);
});

test('map --apply with ctxc stub: reads MAP.md + symbols.json, source=ctxc', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeCtxcStub(tmpdir('map-stubs'));
  const m = await map(root, { apply: true, ctxcCli: stub, exec: createRunner() });
  assert.equal(m.source, 'ctxc');
  assert.equal(m.ctxc.ok, true);
  assert.equal(m.ctxc.error, null);
  assert.equal(m.ctxc.out, path.join(root, '.firstday', 'ctx'));
  assert.match(m.ctxc.mapMd, /# Architecture/);
  assert.equal(m.ctxc.symbolCount, 2);
  assert.ok(fs.existsSync(path.join(root, '.firstday', 'ctx', 'MAP.md')));
  assert.ok(fs.existsSync(path.join(root, '.firstday', 'ctx', 'symbols.json')));
  // Heuristic data still present (structure/hotspots keep working alongside).
  assert.equal(m.entryPoints[0].file, 'src/index.js');
});

test('map --apply: failing ctxc stub degrades to heuristic with the exit code', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeCtxcStub(tmpdir('map-stubs'), { fail: true });
  const m = await map(root, { apply: true, ctxcCli: stub, exec: createRunner() });
  assert.equal(m.source, 'heuristic');
  assert.equal(m.ctxc.ok, false);
  assert.equal(m.ctxc.skipped, undefined);
  assert.equal(m.ctxc.error, 'ctxc build exited 1');
});

test('map --apply: ctxc succeeding without output is reported honestly', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeStub(path.join(tmpdir('map-stubs'), 'silent.cjs'),
    `#!/usr/bin/env node\nprocess.exit(0);\n`);
  const m = await map(root, { apply: true, ctxcCli: stub, exec: createRunner() });
  assert.equal(m.source, 'heuristic');
  assert.equal(m.ctxc.ok, false);
  assert.match(m.ctxc.error, /produced no readable MAP\.md\/symbols\.json/);
});

test('map --apply: ctxc timeout is surfaced as a timeout, not a crash', async () => {
  const root = stageFixture('node-pnpm');
  const stub = writeCtxcStub(tmpdir('map-stubs'));
  const exec = () => Promise.resolve({
    command: 'ctxc', code: null, signal: 'SIGKILL', stdout: '', stderr: '',
    timedOut: true, ms: 120_000, error: null,
  });
  const m = await map(root, { apply: true, ctxcCli: stub, exec, timeoutMs: 1_000 });
  assert.equal(m.source, 'heuristic');
  assert.equal(m.ctxc.ok, false);
  assert.equal(m.ctxc.error, 'ctxc build timed out');
});

test('map: sibling CLI resolution points at ../../ctxc/src/cli.js', () => {
  const p = resolveSiblingCli('ctxc');
  assert.ok(p.endsWith(path.join('..', '..', 'ctxc', 'src', 'cli.js')) || p.endsWith(path.join('ctxc', 'src', 'cli.js')));
  assert.ok(path.isAbsolute(p));
});

test('map: unreadable/missing root degrades to an empty but valid map', async () => {
  const m = await map(path.join(tmpdir('nowhere'), 'does-not-exist'));
  assert.equal(m.source, 'heuristic');
  assert.equal(m.fileCount, 0);
  assert.deepEqual(m.hotspots, []);
  assert.deepEqual(m.entryPoints, []);
  assert.deepEqual(m.tests.files, []);
});
