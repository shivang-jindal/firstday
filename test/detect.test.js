// detect.test.js — stage 1: toolchain matrix (SPEC §3.1).
//
// Detection is pure filesystem work over the pinned fixture repos. The suite
// covers the unit-level signal helpers AND the end-to-end `detect()` plan for
// every fixture, including the conservative `needsInput` list
// ("ask, never guess": anything below high confidence becomes a question).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detect,
  detectJsPackageManager,
  detectLanguages,
  detectMonorepo,
  detectPythonEnv,
  detectTestCommand,
  parseMakeTestTarget,
} from '../src/detect.js';
import { fixturePath, tmpdir } from './helpers.js';

const set = (...names) => new Set(names);

// --- detectJsPackageManager --------------------------------------------------

test('detectJsPackageManager: exactly one lockfile is high confidence', () => {
  assert.deepEqual(
    detectJsPackageManager(set('pnpm-lock.yaml', 'package.json')),
    { value: 'pnpm', source: 'lockfile pnpm-lock.yaml', confidence: 'high' },
  );
  assert.equal(detectJsPackageManager(set('yarn.lock')).value, 'yarn');
  assert.equal(detectJsPackageManager(set('package-lock.json')).value, 'npm');
  assert.equal(detectJsPackageManager(set('npm-shrinkwrap.json')).value, 'npm');
  assert.equal(detectJsPackageManager(set('bun.lockb')).value, 'bun');
  assert.equal(detectJsPackageManager(set('bun.lock')).value, 'bun');
  assert.equal(detectJsPackageManager(set('deno.lock')).value, 'deno');
});

test('detectJsPackageManager: multiple lockfiles is ambiguous (low)', () => {
  const det = detectJsPackageManager(set('pnpm-lock.yaml', 'yarn.lock'));
  assert.equal(det.value, null);
  assert.equal(det.confidence, 'low');
  assert.match(det.source, /ambiguous lockfiles: pnpm-lock\.yaml, yarn\.lock/);
});

test('detectJsPackageManager: no lockfile is low confidence', () => {
  const det = detectJsPackageManager(set('package.json'));
  assert.equal(det.value, null);
  assert.equal(det.confidence, 'low');
  assert.equal(det.source, 'no lockfile found');
});

// --- detectPythonEnv ---------------------------------------------------------

test('detectPythonEnv: env markers, each with source + confidence', () => {
  assert.deepEqual(detectPythonEnv(set('uv.lock'), ''), { value: 'uv', source: 'uv.lock', confidence: 'high' });
  assert.deepEqual(detectPythonEnv(set('poetry.lock'), ''), { value: 'poetry', source: 'poetry.lock', confidence: 'high' });
  assert.deepEqual(detectPythonEnv(set(), '[tool.uv]\nx = 1'), { value: 'uv', source: 'pyproject.toml [tool.uv]', confidence: 'high' });
  assert.deepEqual(detectPythonEnv(set(), '[tool.poetry]\nx = 1'), { value: 'poetry', source: 'pyproject.toml [tool.poetry]', confidence: 'high' });
  assert.deepEqual(detectPythonEnv(set('requirements.txt'), ''), { value: 'pip', source: 'requirements.txt', confidence: 'medium' });
  assert.deepEqual(detectPythonEnv(set('pyproject.toml'), ''), { value: 'pip', source: 'pyproject.toml (no env marker)', confidence: 'low' });
  assert.deepEqual(detectPythonEnv(set(), ''), { value: null, source: 'no python manifests', confidence: 'high' });
});

test('detectPythonEnv: uv.lock beats requirements.txt (specific wins)', () => {
  const det = detectPythonEnv(set('uv.lock', 'requirements.txt'), '');
  assert.equal(det.value, 'uv');
  assert.equal(det.confidence, 'high');
});

// --- parseMakeTestTarget -----------------------------------------------------

test('parseMakeTestTarget: extracts recipe lines joined with &&', () => {
  const mk = ['test:', '\tgo test ./...', 'build:', '\tgo build ./...'].join('\n');
  assert.equal(parseMakeTestTarget(mk), 'go test ./...');
});

test('parseMakeTestTarget: multi-line recipe is chained, comments skipped', () => {
  const mk = ['test:', '\t# run everything', '\tnpm run lint', '\tnpm test', ''].join('\n');
  assert.equal(parseMakeTestTarget(mk), 'npm run lint && npm test');
});

test('parseMakeTestTarget: no test target returns null', () => {
  assert.equal(parseMakeTestTarget(['build:', '\tgo build'].join('\n')), null);
  assert.equal(parseMakeTestTarget(''), null);
});

// --- detectTestCommand -------------------------------------------------------

test('detectTestCommand: package.json script wins with high confidence', () => {
  const det = detectTestCommand({
    names: set('package.json'),
    pkg: { scripts: { test: 'vitest run' } },
    makefileText: 'test:\n\techo from-make',
    workflowTexts: [{ file: 'ci.yml', text: 'run: npm test' }],
  });
  assert.deepEqual(det, { value: 'vitest run', source: 'package.json scripts.test', confidence: 'high', kind: 'script' });
});

test('detectTestCommand: npm placeholder test script is ignored', () => {
  const det = detectTestCommand({
    names: set('package.json'),
    pkg: { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
    makefileText: 'test:\n\tmake test-thing',
    workflowTexts: [],
  });
  assert.equal(det.kind, 'make');
  assert.equal(det.value, 'make test-thing');
});

test('detectTestCommand: CI workflow fallback is medium confidence', () => {
  const det = detectTestCommand({
    names: set(),
    pkg: null,
    makefileText: null,
    workflowTexts: [{ file: 'ci.yml', text: 'jobs:\n  build:\n    steps:\n      - run: pnpm test\n' }],
  });
  assert.deepEqual(det, { value: 'pnpm test', source: 'CI workflow ci.yml', confidence: 'medium', kind: 'ci' });
});

test('detectTestCommand: no command is low confidence with honest reasons', () => {
  const withPkg = detectTestCommand({ names: set('package.json'), pkg: {}, makefileText: null, workflowTexts: [] });
  assert.deepEqual(withPkg, { value: null, source: 'package.json has no test script', confidence: 'low', kind: 'none' });
  const bare = detectTestCommand({ names: set(), pkg: null, makefileText: null, workflowTexts: [] });
  assert.deepEqual(bare, { value: null, source: 'no test command detected', confidence: 'low', kind: 'none' });
});

// --- detectMonorepo ----------------------------------------------------------

test('detectMonorepo: marker files, package.json workspaces, and none', () => {
  assert.equal(detectMonorepo({ names: set('pnpm-workspace.yaml'), pkg: null }).value, 'pnpm-workspaces');
  assert.equal(detectMonorepo({ names: set('turbo.json'), pkg: null }).value, 'turbo');
  assert.equal(detectMonorepo({ names: set('nx.json'), pkg: null }).value, 'nx');
  assert.equal(detectMonorepo({ names: set('lerna.json'), pkg: null }).value, 'lerna');
  assert.equal(detectMonorepo({ names: set(), pkg: { workspaces: ['packages/*'] } }).value, 'npm-workspaces');
  const none = detectMonorepo({ names: set(), pkg: null });
  assert.equal(none.value, null);
  assert.equal(none.confidence, 'high');
});

// --- detectLanguages ---------------------------------------------------------

test('detectLanguages: majority language is high, mixed is medium', () => {
  const tsHeavy = detectLanguages(['a.ts', 'b.ts', 'c.ts', 'd.js']);
  assert.equal(tsHeavy.value.primary, 'typescript');
  assert.equal(tsHeavy.confidence, 'high', '3/4 = 75% primary -> high');
  const mixed = detectLanguages(['a.ts', 'b.ts', 'c.ts', 'd.js', 'e.js', 'f.js']);
  assert.equal(mixed.value.primary, 'typescript');
  assert.equal(mixed.confidence, 'medium', '3/6 = 50% -> medium, must ask which is primary');
  assert.deepEqual(mixed.value.counts, { typescript: 3, javascript: 3 });
});

test('detectLanguages: thin or empty census is low confidence', () => {
  const single = detectLanguages(['only.js']);
  assert.equal(single.confidence, 'low');
  const none = detectLanguages(['README.md']);
  assert.equal(none.value.primary, null);
  assert.equal(none.confidence, 'low');
  assert.equal(none.value.codeFiles, 0);
});

// --- detect(): full plans over the pinned fixtures ---------------------------

test('detect(node-pnpm): pnpm high, install + test steps, zero questions', async () => {
  const { plan, needsInput } = await detect(fixturePath('node-pnpm'));
  assert.equal(plan.js.value, 'pnpm');
  assert.equal(plan.js.confidence, 'high');
  assert.equal(plan.test.value, 'node --test test/smoke.test.js');
  assert.equal(plan.test.kind, 'script');
  assert.equal(plan.languages.value.primary, 'javascript');
  assert.deepEqual(plan.steps, [
    { stage: 'install', command: 'pnpm install --frozen-lockfile' },
    { stage: 'test', command: 'pnpm run test' },
  ]);
  assert.equal(plan.install.command, 'pnpm install --frozen-lockfile');
  assert.equal(plan.toolVersions.value['.nvmrc'], '22.14.0');
  assert.equal(plan.devcontainer.value, false);
  assert.deepEqual(plan.provision.map((p) => p.strategy), ['local']);
  assert.equal(plan.repoSize.value.tier, 'small');
  assert.deepEqual(needsInput, []);
});

test('detect(node-match): npm, no deps so no install step, no questions', async () => {
  const { plan, needsInput } = await detect(fixturePath('node-match'));
  assert.equal(plan.js.value, 'npm');
  assert.equal(plan.install.command, null);
  assert.equal(plan.install.source, 'no runtime dependencies declared');
  assert.deepEqual(plan.steps, [{ stage: 'test', command: 'npm run test' }]);
  assert.deepEqual(needsInput, []);
});

test('detect(ambiguous-locks): both lockfiles and no test script become questions', async () => {
  const { plan, needsInput } = await detect(fixturePath('ambiguous-locks'));
  assert.equal(plan.js.value, null);
  assert.equal(plan.js.confidence, 'low');
  assert.match(plan.js.source, /ambiguous lockfiles/);
  assert.equal(plan.test.kind, 'none');
  assert.deepEqual(plan.steps, []);
  const keys = needsInput.map((n) => n.key);
  assert.ok(keys.includes('js.packageManager'), 'ambiguous lockfile must be asked, not guessed');
  assert.ok(keys.includes('test.command'), 'missing test command must be asked');
  const pmQuestion = needsInput.find((n) => n.key === 'js.packageManager');
  assert.equal(pmQuestion.confidence, 'low');
  assert.match(pmQuestion.question, /package manager/);
});

test('detect(ambiguous-test-command): CI workflow is medium and gets asked', async () => {
  const { plan, needsInput } = await detect(fixturePath('ambiguous-test-command'));
  assert.equal(plan.test.kind, 'ci');
  assert.equal(plan.test.value, 'npm test');
  assert.equal(plan.test.source, 'CI workflow .github/workflows/ci-a.yml');
  assert.equal(plan.test.confidence, 'medium');
  assert.deepEqual(needsInput.map((n) => n.key), ['test.command']);
  assert.equal(needsInput[0].source, 'CI workflow .github/workflows/ci-a.yml');
});

test('detect(go): go.mod, Makefile test target, tool-versions', async () => {
  const { plan, needsInput } = await detect(fixturePath('go'));
  assert.equal(plan.go.value, true);
  assert.equal(plan.go.source, 'go.mod');
  assert.equal(plan.test.value, 'go test ./...');
  assert.equal(plan.test.kind, 'make');
  assert.equal(plan.test.confidence, 'high');
  assert.equal(plan.languages.value.primary, 'go');
  assert.deepEqual(plan.toolVersions.value, { '.tool-versions': 'go 1.21.0' });
  assert.deepEqual(plan.steps, [{ stage: 'test', command: 'go test ./...' }]);
  assert.deepEqual(needsInput, []);
});

test('detect(python-marker): uv env high, python primary, no test command asked', async () => {
  const { plan, needsInput } = await detect(fixturePath('python-marker'));
  assert.equal(plan.python.value, 'uv');
  assert.equal(plan.python.confidence, 'high');
  assert.equal(plan.languages.value.primary, 'python');
  assert.equal(plan.go.value, false);
  assert.equal(plan.rust.value, false);
  assert.equal(plan.test.kind, 'none');
  assert.deepEqual(needsInput.map((n) => n.key), ['test.command']);
});

test('detect(rust): Cargo.toml + no test command', async () => {
  const { plan, needsInput } = await detect(fixturePath('rust'));
  assert.equal(plan.rust.value, true);
  assert.equal(plan.rust.source, 'Cargo.toml');
  assert.equal(plan.languages.value.primary, 'rust');
  assert.equal(plan.test.kind, 'none');
  assert.deepEqual(needsInput.map((n) => n.key), ['test.command']);
});

test('detect(devcontainer): devcontainer + nix lead the provision ladder', async () => {
  const { plan } = await detect(fixturePath('devcontainer'));
  assert.equal(plan.devcontainer.value, true);
  assert.equal(plan.nix.value, true);
  assert.deepEqual(plan.provision.map((p) => p.strategy), ['devcontainer', 'nix', 'local']);
  assert.equal(plan.provision[0].confidence, 'high');
  assert.equal(plan.monorepo.value, null);
});

test('detect(monorepo): pnpm workspace marker + workspace test script', async () => {
  const { plan } = await detect(fixturePath('monorepo'));
  assert.equal(plan.monorepo.value, 'pnpm-workspaces');
  assert.equal(plan.monorepo.confidence, 'high');
  assert.equal(plan.js.value, 'pnpm');
  assert.deepEqual(plan.steps, [{ stage: 'test', command: 'pnpm run test' }]);
});

test('detect: deterministic across repeated runs (same plan, same questions)', async () => {
  const a = await detect(fixturePath('node-pnpm'));
  const b = await detect(fixturePath('node-pnpm'));
  assert.deepEqual(a, b);
});

test('detect: empty directory yields honest low-confidence questions', async () => {
  const root = tmpdir('empty-detect');
  const { plan, needsInput } = await detect(root);
  assert.equal(plan.js.present, false);
  assert.equal(plan.languages.value.primary, null);
  assert.equal(plan.languages.confidence, 'low');
  assert.equal(plan.test.value, null);
  assert.equal(plan.repoSize.value.files, 0);
  assert.deepEqual(plan.provision.map((p) => p.strategy), ['local']);
  assert.deepEqual(needsInput.map((n) => n.key), ['test.command']);
});

test('detect: output shape always carries value/source/confidence', async () => {
  const { plan } = await detect(fixturePath('python-marker'));
  for (const [key, det] of Object.entries(plan)) {
    if (key === 'root' || key === 'provision' || key === 'steps' || key === 'install') continue;
    assert.ok(det && typeof det === 'object', `${key} must be a detection object`);
    assert.ok('value' in det, `${key}.value missing`);
    assert.ok(typeof det.source === 'string', `${key}.source missing`);
    assert.ok(['high', 'medium', 'low'].includes(det.confidence), `${key}.confidence invalid`);
  }
  for (const step of plan.steps) {
    assert.equal(typeof step.stage, 'string');
    assert.equal(typeof step.command, 'string');
  }
});
