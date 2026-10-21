// state.test.js — SPEC §7: .firstday/state.json, stage records, resume logic.
//
// Durations come from the INJECTED clock so they are deterministic; only
// `--apply` persists, and persistence goes through the confined writer (never
// outside <root>/.firstday).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_REL,
  STATE_VERSION,
  createState,
  loadState,
  record,
  recordFailure,
  saveState,
  shouldSkip,
} from '../src/state.js';
import { tmpdir } from './helpers.js';

test('createState: versioned skeleton per SPEC §7', () => {
  const state = createState('my-repo');
  assert.deepEqual(state, { version: 1, repo: 'my-repo', stages: {} });
  assert.equal(STATE_VERSION, 1);
  assert.equal(STATE_REL, '.firstday/state.json');
});

test('record: status ok + deterministic ms from the injected clock', () => {
  const state = createState('r');
  let t = 1_000;
  const now = () => t;
  const startedAt = now();
  t = 1_450;
  const rec = record(state, 'detect', { languages: 'javascript' }, { now, startedAt });
  assert.equal(rec.status, 'ok');
  assert.equal(rec.ms, 450);
  assert.equal(rec.languages, 'javascript');
  assert.equal(state.stages.detect.status, 'ok');
});

test('record: explicit ms field is used when no startedAt is given', () => {
  const state = createState('r');
  const rec = record(state, 'map', { ms: 77 }, { now: () => 0 });
  assert.equal(rec.ms, 77);
  assert.equal(rec.status, 'ok');
});

test('recordFailure: failed status keeps context for --resume reporting', () => {
  const state = createState('r');
  const rec = recordFailure(state, 'verify', { tests: 'red', ms: 5 }, { now: () => 0 });
  assert.equal(rec.status, 'failed');
  assert.equal(rec.tests, 'red');
  assert.equal(shouldSkip(state, 'verify'), false, 'failed stages are never skipped');
});

test('shouldSkip: only status=ok skips; missing state/stage never skips', () => {
  const state = createState('r');
  assert.equal(shouldSkip(state, 'detect'), false);
  assert.equal(shouldSkip(null, 'detect'), false);
  assert.equal(shouldSkip(undefined, 'detect'), false);
  record(state, 'detect', {}, { now: () => 0 });
  assert.equal(shouldSkip(state, 'detect'), true);
  assert.equal(shouldSkip(state, 'tour'), false);
  assert.equal(shouldSkip({ stages: {} }, 'x'), false);
});

test('saveState + loadState: round-trip inside <root>/.firstday', async () => {
  const root = tmpdir('state-roundtrip');
  const state = createState('fixture');
  record(state, 'detect', { languages: 'go' }, { now: () => 0 });
  recordFailure(state, 'verify', { tests: 'red' }, { now: () => 0 });

  const file = await saveState(root, state);
  assert.equal(file, path.join(root, '.firstday', 'state.json'));
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);

  const loaded = await loadState(root);
  assert.deepEqual(loaded, state);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.stages.verify.status, 'failed');
});

test('loadState: missing state file is null (fresh run), not a crash', async () => {
  const loaded = await loadState(tmpdir('state-missing'));
  assert.equal(loaded, null);
});

test('loadState: corrupt state file is treated as absent (honest fresh start)', async () => {
  const root = tmpdir('state-corrupt');
  fs.mkdirSync(path.join(root, '.firstday'), { recursive: true });
  fs.writeFileSync(path.join(root, '.firstday', 'state.json'), '{not json');
  assert.equal(await loadState(root), null);
});

test('state lives only under .firstday (never sprinkled around the repo)', async () => {
  const root = tmpdir('state-loc');
  await saveState(root, createState('x'));
  const top = fs.readdirSync(root).sort();
  assert.deepEqual(top, ['.firstday']);
});
