// test/helpers.js — shared utilities for the firstday test suite.
//
// Everything here is test-only: it locates the pinned fixture repos, stages
// throwaway copies under os.tmpdir() (the code writes .firstday/state.json
// there), and provides injected runners/stubs so no test ever shells out to the
// network or mutates a fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRunner, createRunner } from '../src/runner.js';
import { fingerprintTree } from '../src/fsx.js';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(TEST_DIR, 'fixtures');
export const fixturePath = (name) => path.join(FIXTURES_DIR, name);

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `firstday-${prefix}-`));
}

/** Copy a pinned fixture into a fresh tmpdir so the original is never written. */
export function stageFixture(name) {
  const dest = tmpdir(name);
  fs.cpSync(fixturePath(name), dest, { recursive: true });
  return dest;
}

/** List every file under root (relative posix paths), including dotfiles. */
export function listAll(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else out.push(relPath);
    }
  };
  walk(root, '');
  out.sort();
  return out;
}

export function writeStub(file, body) {
  fs.writeFileSync(file, body);
  return file;
}

/**
 * Run `fn` with the sibling-CLI env overrides disabled. cli.js falls back to
 * the real oss-ideas/ctxc + issue-radar CLIs when FIRSTDAY_*_CLI is unset;
 * tests that do not inject those deps must keep the vault siblings out.
 */
export function withoutSiblingClis(fn) {
  const prevCtxc = process.env.FIRSTDAY_CTXC_CLI;
  const prevRadar = process.env.FIRSTDAY_RADAR_CLI;
  process.env.FIRSTDAY_CTXC_CLI = '';
  process.env.FIRSTDAY_RADAR_CLI = '';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevCtxc === undefined) delete process.env.FIRSTDAY_CTXC_CLI;
      else process.env.FIRSTDAY_CTXC_CLI = prevCtxc;
      if (prevRadar === undefined) delete process.env.FIRSTDAY_RADAR_CLI;
      else process.env.FIRSTDAY_RADAR_CLI = prevRadar;
    });
}

// --- injected integration CLIs (tiny stubs, never network) --------------------

/** A stub ctxc CLI: writes MAP.md + symbols.json into --out, or fails. */
export function writeCtxcStub(dir, { fail = false } = {}) {
  const file = path.join(dir, 'ctxc-stub.cjs');
  const body = fail
    ? `#!/usr/bin/env node\nprocess.stderr.write('ctxc stub failed\\n');\nprocess.exit(1);\n`
    : `#!/usr/bin/env node\n`
      + `const fs=require('node:fs');\nconst path=require('node:path');\n`
      + `const args=process.argv.slice(2);\nconst i=args.indexOf('--out');\n`
      + `const outDir=i>=0?args[i+1]:path.join(args[1]||'.','.ctx');\n`
      + `fs.mkdirSync(outDir,{recursive:true});\n`
      + `fs.writeFileSync(path.join(outDir,'MAP.md'),'# Architecture\\n\\nentry: src/index.js\\nhotspots: src/greet.js\\n');\n`
      + `fs.writeFileSync(path.join(outDir,'symbols.json'),JSON.stringify({symbols:[{name:'main'},{name:'greet'}]}));\n`
      + `process.stdout.write('ctxc stub ok\\n');\n`;
  return writeStub(file, body);
}

/** A stub issue-radar CLI with selectable output modes. */
export function writeRadarStub(dir, mode = 'ok') {
  const file = path.join(dir, 'radar-stub.cjs');
  let body;
  if (mode === 'fail') {
    body = `#!/usr/bin/env node\nprocess.stderr.write('radar boom\\n');\nprocess.exit(1);\n`;
  } else if (mode === 'badjson') {
    body = `#!/usr/bin/env node\nprocess.stdout.write('this is not json');\n`;
  } else if (mode === 'empty') {
    body = `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({results:[]}));\n`;
  } else {
    body = `#!/usr/bin/env node\nconst fs=require('node:fs');\n`
      + `const i=process.argv.indexOf('--fixture');\nconst fixture=i>=0?process.argv[i+1]:null;\nlet results;\n`
      + `if(fixture){results=JSON.parse(fs.readFileSync(fixture,'utf8'));}\n`
      + `else{results=[{number:42,title:'Fix greeting bug',url:'https://example.test/42',score:0.91,reasons:['mentions greet','small diff']},{number:7,title:'Add tests',url:'https://example.test/7',score:0.55,reasons:['docs']}];}\n`
      + `process.stdout.write(JSON.stringify({results}));\n`;
  }
  return writeStub(file, body);
}

/**
 * exec for radar-integration tests: answers match.js's `git remote get-url
 * origin` probe with a canned slug (fixture dirs aren't git repos), and runs
 * every other command (the radar scan) through the real spawner so the stub
 * CLI is actually executed.
 */
export function radarExec(slug = 'acme/widgets') {
  const real = createRunner();
  return (cmd, opts) => {
    if (cmd.includes('git remote get-url origin')) {
      return Promise.resolve({
        command: cmd,
        code: 0,
        signal: null,
        stdout: `git@github.com:${slug}.git\n`,
        stderr: '',
        timedOut: false,
        ms: 1,
        error: null,
      });
    }
    return real(cmd, opts);
  };
}

export { fakeRunner, createRunner, fingerprintTree };
