// fsx.test.js — the hard safety rails (SPEC §6).
//
// Everything firstday writes must land inside <root>/.firstday and ONLY with
// --apply. createConfinedWriter is the chokepoint: path traversal, sibling
// subdirectories, and absolute escapes all refuse. listFiles/fingerprintTree
// give tests (and the safety suite) a way to prove the tree never changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createConfinedWriter,
  exists,
  fingerprintTree,
  listFiles,
  readJsonSafe,
  readText,
} from '../src/fsx.js';
import { tmpdir } from './helpers.js';

test('listFiles: sorted posix paths, skips junk dirs, honors includeHidden', async () => {
  const root = tmpdir('fsx-list');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'b.js'), '');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), '');
  fs.writeFileSync(path.join(root, 'z.txt'), '');
  fs.writeFileSync(path.join(root, '.env'), '');
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
  fs.writeFileSync(path.join(root, '.git', 'config'), '');
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), '');
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'run: npm test');

  const plain = await listFiles(root);
  assert.deepEqual(plain, ['.env', 'src/a.js', 'src/b.js', 'z.txt'], 'sorted, junk skipped');

  const hidden = await listFiles(root, { includeHidden: true });
  assert.ok(hidden.includes('.github/workflows/ci.yml'), 'hidden dirs visible when asked');
  assert.ok(!hidden.includes('node_modules/x.js'), 'node_modules never listed');
  assert.ok(!hidden.includes('.git/config'), '.git never listed');
  assert.ok(!hidden.includes('dist/bundle.js'), 'dist never listed');
});

test('listFiles: maxFiles caps the census', async () => {
  const root = tmpdir('fsx-cap');
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(root, `f${i}.js`), '');
  const files = await listFiles(root, { maxFiles: 3 });
  assert.ok(files.length <= 3);
  assert.ok(files.length > 0);
});

test('listFiles: missing root is empty, not a throw', async () => {
  const files = await listFiles(path.join(tmpdir('fsx-missing'), 'nope'));
  assert.deepEqual(files, []);
});

test('readJsonSafe + readText + exists', async () => {
  const root = tmpdir('fsx-json');
  const good = path.join(root, 'good.json');
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(good, '{"a":1}');
  fs.writeFileSync(bad, '{nope');
  assert.deepEqual(await readJsonSafe(good), { a: 1 });
  assert.equal(await readJsonSafe(bad), null);
  assert.equal(await readJsonSafe(path.join(root, 'missing.json')), null);
  assert.equal(await readText(good), '{"a":1}');
  assert.equal(await exists(good), true);
  assert.equal(await exists(path.join(root, 'missing')), false);
});

test('createConfinedWriter: writes only inside .firstday', async () => {
  const root = tmpdir('fsx-confined');
  const w = createConfinedWriter(root);
  const target = await w.writeFile('.firstday/state.json', '{"ok":true}');
  assert.equal(target, path.join(root, '.firstday', 'state.json'));
  assert.ok(fs.existsSync(target));
  assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}');
});

test('createConfinedWriter: refuses writes outside the allow-listed subtree', async () => {
  const root = tmpdir('fsx-refuse');
  const w = createConfinedWriter(root);
  await assert.rejects(() => w.writeFile('evil.txt', 'x'), /refusing to write outside \.firstday\//);
  await assert.rejects(() => w.writeFile('../evil.txt', 'x'), /refusing to write outside/);
  await assert.rejects(() => w.writeFile('.firstday/../evil.txt', 'x'), /refusing to write outside/);
  await assert.rejects(() => w.writeFile('sub/evil.txt', 'x'), /refusing to write outside/);
  await assert.rejects(() => w.writeFile(path.join(path.resolve(root), '..', 'abs-escape.txt'), 'x'), /refusing to write outside/);
  // Nothing leaked: the root (and its parent) contain no new files.
  assert.deepEqual(fs.readdirSync(root), []);
});

test('createConfinedWriter: writeJson pretty-prints and creates parents', async () => {
  const root = tmpdir('fsx-json-write');
  const w = createConfinedWriter(root);
  const file = await w.writeJson('.firstday/deep/nested.json', { b: 2, a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { b: 2, a: 1 });
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'trailing newline for clean git diffs');
});

test('createConfinedWriter: a different allow subdir is honored', async () => {
  const root = tmpdir('fsx-allow');
  const w = createConfinedWriter(root, '.cache');
  await w.writeFile('.cache/x.txt', 'ok');
  await assert.rejects(() => w.writeFile('.firstday/x.txt', 'x'), /refusing to write outside \.cache\//);
});

test('fingerprintTree: stable while unchanged, changes when files do', async () => {
  const root = tmpdir('fsx-fp');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\n');
  const before = await fingerprintTree(root);
  const again = await fingerprintTree(root);
  assert.deepEqual(before, again);
  assert.deepEqual(Object.keys(before), ['src/a.js']);

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 2; // changed\n');
  const after = await fingerprintTree(root);
  assert.notDeepEqual(before, after);
});
