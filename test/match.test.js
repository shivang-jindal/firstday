// match.test.js — stage 4: issue matching ("NEVER fabricates an issue").
//
// Two tiers: the sibling issue-radar CLI (injected stub, --offline) and the
// static fallback (good-first-issue doc mentions + TODO/FIXME clusters).
// Every path must return a note; honest "no match found" is a first-class
// result, not an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { match } from '../src/match.js';
import {
  createRunner,
  fixturePath,
  stageFixture,
  tmpdir,
  writeRadarStub,
} from './helpers.js';

test('match(python-marker): static scan finds the doc mention first', async () => {
  const m = await match(fixturePath('python-marker'));
  assert.equal(m.source, 'static');
  assert.equal(m.issue.kind, 'doc-mention');
  assert.equal(m.issue.path, 'README.md');
  assert.equal(m.issue.line, 7); // "…labelled **good first issue**…"
  assert.equal(m.issue.number, null); // static candidates are never fake issues
  assert.equal(m.issue.url, null);
  assert.equal(m.issue.score, 0.5);
  assert.match(m.note, /static scan \(issue-radar not present\)/);

  // Doc mentions sort before TODO clusters; the code cluster is still listed.
  assert.equal(m.candidates[0].kind, 'doc-mention');
  const todo = m.candidates.find((c) => c.kind === 'todo-cluster');
  assert.ok(todo, 'python-marker/src/main.py has a TODO that must be listed');
  assert.equal(todo.path, 'src/main.py');
  assert.match(todo.reason, /1 open marker/);
});

test('match(node-match): TODO cluster with real path:line, still honest', async () => {
  const m = await match(fixturePath('node-match'));
  assert.equal(m.source, 'static');
  assert.equal(m.issue.kind, 'todo-cluster');
  assert.equal(m.issue.path, 'src/index.js');
  const lines = fs.readFileSync(path.join(fixturePath('node-match'), 'src', 'index.js'), 'utf8').split('\n');
  const expectedLine = lines.findIndex((l) => l.includes('TODO')) + 1;
  assert.equal(m.issue.line, expectedLine);
  assert.equal(m.issue.number, null, 'a TODO is not an issue number');
  assert.equal(m.issue.title, '1 TODO/FIXME marker in src/index.js');
});

test('match(node-pnpm): clean repo -> honest "no match found", no invention', async () => {
  const m = await match(fixturePath('node-pnpm'));
  assert.equal(m.source, 'static');
  assert.equal(m.issue, null);
  assert.deepEqual(m.candidates, []);
  assert.match(m.note, /— no match found/);
  assert.match(m.note, /no good-first-issue mentions, no TODO clusters/);
});

test('match: an empty directory is honest none, not a crash', async () => {
  const m = await match(tmpdir('match-empty'));
  assert.equal(m.issue, null);
  assert.match(m.note, /no match found/);
});

test('match: issue-radar stub offline scan supplies the ranked issue', async () => {
  const root = fixturePath('node-pnpm');
  const stub = writeRadarStub(tmpdir('radar-stubs'), 'ok');
  const m = await match(root, { radarCli: stub, exec: createRunner() });
  assert.equal(m.source, 'issue-radar');
  assert.deepEqual(m.issue, {
    number: 42,
    title: 'Fix greeting bug',
    url: 'https://example.test/42',
    score: 0.91,
    reasons: ['mentions greet', 'small diff'],
  });
  assert.equal(m.candidates.length, 2);
  assert.equal(m.candidates[0].kind, 'radar');
  assert.match(m.note, /issue-radar offline scan returned 2 result\(s\)/);
});

test('match: radar with zero results is an honest none (no fallback invention)', async () => {
  const stub = writeRadarStub(tmpdir('radar-stubs'), 'empty');
  const m = await match(fixturePath('python-marker'), { radarCli: stub, exec: createRunner() });
  assert.equal(m.source, 'issue-radar');
  assert.equal(m.issue, null);
  assert.deepEqual(m.candidates, []);
  assert.match(m.note, /found no matches \(honest none\)/);
});

test('match: radar fixture env var drives the scan result', async () => {
  const dir = tmpdir('radar-fixture');
  const fixture = path.join(dir, 'results.json');
  // The stub treats the fixture file as the raw results ARRAY it should print.
  fs.writeFileSync(fixture, JSON.stringify([
    { number: 7, title: 'From fixture', url: 'https://example.test/7', score: 0.3, reasons: ['fixture'] },
  ]));
  const stub = writeRadarStub(dir, 'ok');
  const m = await match(fixturePath('node-pnpm'), {
    radarCli: stub,
    exec: createRunner(),
    env: { FIRSTDAY_RADAR_FIXTURE: fixture },
  });
  assert.equal(m.source, 'issue-radar');
  assert.equal(m.issue.number, 7);
  assert.equal(m.issue.title, 'From fixture');
});

test('match: radar crashing falls back to static with the exit code in the note', async () => {
  const stub = writeRadarStub(tmpdir('radar-stubs'), 'fail');
  const m = await match(fixturePath('node-match'), { radarCli: stub, exec: createRunner() });
  assert.equal(m.source, 'static');
  assert.equal(m.issue.kind, 'todo-cluster'); // static fallback still found something
  assert.match(m.note, /issue-radar unavailable \(exit 1\); static fallback/);
});

test('match: radar emitting garbage falls back to static', async () => {
  const stub = writeRadarStub(tmpdir('radar-stubs'), 'badjson');
  const m = await match(fixturePath('python-marker'), { radarCli: stub, exec: createRunner() });
  assert.equal(m.source, 'static');
  assert.equal(m.issue.kind, 'doc-mention');
  assert.match(m.note, /unparseable output; static fallback/);
});

test('match: radar timing out falls back to static with timeout in the note', async () => {
  const stub = writeRadarStub(tmpdir('radar-stubs'), 'ok');
  const exec = () => Promise.resolve({
    command: 'radar', code: null, signal: 'SIGKILL', stdout: '', stderr: '',
    timedOut: true, ms: 120_000, error: null,
  });
  const m = await match(fixturePath('node-match'), { radarCli: stub, exec });
  assert.equal(m.source, 'static');
  assert.equal(m.issue.kind, 'todo-cluster');
  assert.match(m.note, /issue-radar unavailable \(timeout\); static fallback/);
});

test('match: TODO clusters are ranked by marker count, capped at 5', async () => {
  const root = tmpdir('match-clusters');
  fs.writeFileSync(path.join(root, 'a.js'), 'x\nTODO one\nTODO two\nTODO three\n');
  fs.writeFileSync(path.join(root, 'b.js'), 'TODO only\n');
  fs.writeFileSync(path.join(root, 'c.md'), 'nothing to see here\n');
  const m = await match(root);
  const clusters = m.candidates.filter((c) => c.kind === 'todo-cluster');
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].path, 'a.js');
  assert.equal(clusters[0].line, 2, 'first marker line is cited');
  assert.match(clusters[0].title, /3 TODO\/FIXME markers/);
  assert.ok(clusters[0].score >= clusters[1].score);
  assert.equal(m.issue.path, 'a.js');
});
