// tour.test.js — stage 5: deterministic file tour with citation verification.
//
// tour.js is the "walk the call path" stage: BFS along import edges from the
// entry point toward the anchor (matched issue area), LOC-rank fallback, and a
// hard rule that EVERY cited path:line must exist — broken citations are
// dropped from the output, never rendered (SPEC §4 step 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTour } from '../src/tour.js';
import { map } from '../src/map.js';
import { match } from '../src/match.js';
import { fixturePath, tmpdir } from './helpers.js';

function syntheticRepo() {
  const root = tmpdir('tour-repo');
  fs.writeFileSync(path.join(root, 'a.js'), "import './b.js';\nimport { c } from './c.js';\nexport const a = 1;\n");
  fs.writeFileSync(path.join(root, 'b.js'), "import './c.js';\nexport const b = 2;\n");
  fs.writeFileSync(path.join(root, 'c.js'), 'export const c = 3;\nexport const pad1 = 0;\nexport const pad2 = 0;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't', main: 'a.js' }));
  return root;
}

test('tour: BFS along import edges reaches the issue anchor in call order', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  const mt = { issue: { path: 'c.js', line: 2, title: 'Bug in c', reasons: ['because c is broken'] }, note: 'x' };
  const t = await buildTour(root, { map: m, match: mt, maxSteps: 6 });

  assert.equal(t.via, 'import-edges');
  assert.deepEqual(t.steps.map((s) => s.path), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(t.dropped, []);

  assert.equal(t.steps[0].role, 'entry point');
  assert.match(t.steps[0].why, /start here/);
  assert.equal(t.steps[1].role, 'supporting code');
  assert.match(t.steps[1].why, /imported by 1 file/);
  assert.equal(t.steps[2].role, 'issue area');
  assert.match(t.steps[2].why, /matched candidate points here: because c is broken/);

  assert.deepEqual(t.touched, ['a.js', 'b.js', 'c.js:2']);
  assert.equal(t.steps[2].line, 2);
  assert.equal(t.title, 'Bug in c');
});

test('tour: markdown is a numbered tour with the summary at the top', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  const mt = { issue: { path: 'c.js', line: 2, title: 'Bug in c', reasons: ['because c is broken'] }, note: 'x' };
  const t = await buildTour(root, { map: m, match: mt });
  const md = t.markdown;
  assert.match(md, /^# firstday tour — Bug in c/);
  assert.match(md, /\*\*These are the 3 files you'll touch\.\*\* \(ordered via import edges\)/);
  assert.match(md, /1\. `a\.js` — \*\*entry point\*\*/);
  assert.match(md, /3\. `c\.js:2` — \*\*issue area\*\*/);
  assert.match(md, /## Conventions detected/);
  assert.match(md, /Matched candidate: Bug in c — because c is broken/);
  assert.match(md, /## Next steps/);
  // Citation validity: every `path:line` in the rendered list exists on disk.
  for (const step of t.steps) {
    assert.ok(fs.existsSync(path.join(root, step.path)), `${step.path} must exist`);
    if (step.line) {
      const total = fs.readFileSync(path.join(root, step.path), 'utf8').split('\n').length;
      assert.ok(step.line >= 1 && step.line <= total, `${step.path}:${step.line} out of range`);
    }
  }
});

test('tour: anchor that does not exist is dropped, hotspot anchor takes over', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  const mt = { issue: { path: 'gone.js', line: 1, title: 'Phantom', reasons: [] }, note: 'x' };
  const t = await buildTour(root, { map: m, match: mt });
  assert.ok(t.dropped.some((d) => /anchor from match \(gone\.js\) does not exist/.test(d)));
  assert.ok(t.steps.length > 0, 'tour still builds from hotspots');
  assert.ok(!t.steps.some((s) => s.path === 'gone.js'));
});

test('tour: out-of-range line citation is dropped, step keeps path only', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  const mt = { issue: { path: 'c.js', line: 9999, title: 'Bad line', reasons: [] }, note: 'x' };
  const t = await buildTour(root, { map: m, match: mt });
  assert.ok(t.dropped.some((d) => /line c\.js:9999 out of range \(4 lines\)/.test(d)));
  const step = t.steps.find((s) => s.path === 'c.js');
  assert.ok(step, 'the file itself is still toured');
  assert.equal(step.line, null, 'the bogus line must not be rendered');
  assert.ok(!t.touched.includes('c.js:9999'));
});

test('tour: a cited path missing from the checkout never reaches the steps', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  // entry point and hotspot both point at a file that does not exist.
  const brokenMap = {
    ...m,
    entryPoints: [{ file: 'nope.js', kind: 'bin', detail: 'missing' }],
    hotspots: [{ file: 'also-missing.js', loc: 5, importDegree: 0, score: 5 }],
    edges: {},
  };
  const t = await buildTour(root, { map: brokenMap, match: null });
  assert.ok(t.dropped.some((d) => /path nope\.js does not exist/.test(d)));
  assert.ok(t.dropped.some((d) => /path also-missing\.js does not exist/.test(d)));
  assert.deepEqual(t.steps, []);
  assert.match(t.markdown, /These are the 0 files you'll touch/);
});

test('tour: falls back to LOC rank when no import edges are available', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  const noEdges = { ...m, edges: null };
  const t = await buildTour(root, { map: noEdges, match: null });
  assert.equal(t.via, 'loc-rank');
  assert.match(t.markdown, /ordered via LOC rank/);
  assert.equal(t.steps[0].path, 'a.js', 'entry point still leads');
  assert.ok(t.steps.length >= 2);
});

test('tour: maxSteps caps the walk', async () => {
  const root = tmpdir('tour-many');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't', main: 'e0.js' }));
  for (let i = 0; i < 10; i += 1) {
    fs.writeFileSync(path.join(root, `e${i}.js`), Array.from({ length: 20 - i }, (_, k) => `// ${k}`).join('\n'));
  }
  const m = await map(root);
  const t = await buildTour(root, { map: m, match: null, maxSteps: 4 });
  assert.ok(t.steps.length <= 4);
  assert.equal(t.steps[0].path, 'e0.js');
});

test('tour: with no map and no match it stays honest and empty', async () => {
  const root = tmpdir('tour-empty');
  const t = await buildTour(root, { map: null, match: null });
  assert.deepEqual(t.steps, []);
  assert.deepEqual(t.dropped, []);
  assert.equal(t.title, 'repository tour');
  assert.match(t.markdown, /These are the 0 files you'll touch/);
  assert.match(t.markdown, /- Tests: none detected/);
  assert.match(t.markdown, /Matched candidate: none found \(honest none\)/);
});

test('tour: long issue titles are trimmed to six words in the tour title', async () => {
  const root = syntheticRepo();
  const m = await map(root);
  const mt = {
    issue: { path: 'c.js', title: 'one two three four five six seven eight', reasons: ['r'] },
    note: 'x',
  };
  const t = await buildTour(root, { map: m, match: mt });
  assert.equal(t.title, 'one two three four five six…');
});

test('tour: real fixture end-to-end (node-match: static issue anchors the tour)', async () => {
  const root = fixturePath('node-match');
  const m = await map(root);
  const mt = await match(root);
  const t = await buildTour(root, { map: m, match: mt });
  assert.equal(t.steps[0].path, 'src/index.js');
  assert.equal(t.steps[0].line, 3, 'TODO line is cited and valid');
  assert.equal(t.via, 'import-edges');
  assert.deepEqual(t.dropped, []);
  assert.match(t.markdown, /Matched candidate: 1 TODO\/FIXME marker in src\/index\.js/);
});
