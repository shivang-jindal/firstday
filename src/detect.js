// detect.js — stage 1: toolchain matrix (SPEC §3.1).
// Pure filesystem. Each detection returns { value, source, confidence }.
// Anything below "high" confidence is listed in plan.needsInput ("conservative
// detection: ask, never guess").
import path from 'node:path';
import { listFiles, readJsonSafe, readText } from './fsx.js';

const CODE_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.rb': 'ruby', '.php': 'php', '.sh': 'shell', '.c': 'c', '.cpp': 'cpp',
  '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp', '.kt': 'kotlin', '.swift': 'swift',
};

export function detectJsPackageManager(names) {
  const locks = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['deno.lock', 'deno'],
  ];
  const found = locks.filter(([file]) => names.has(file));
  if (found.length === 1) {
    return { value: found[0][1], source: `lockfile ${found[0][0]}`, confidence: 'high' };
  }
  if (found.length > 1) {
    return {
      value: null,
      source: `ambiguous lockfiles: ${found.map(([f]) => f).join(', ')}`,
      confidence: 'low',
    };
  }
  return { value: null, source: 'no lockfile found', confidence: 'low' };
}

export function detectPythonEnv(names, pyprojectText) {
  if (names.has('uv.lock')) return { value: 'uv', source: 'uv.lock', confidence: 'high' };
  if (names.has('poetry.lock')) return { value: 'poetry', source: 'poetry.lock', confidence: 'high' };
  if (/\[tool\.uv\]/.test(pyprojectText)) return { value: 'uv', source: 'pyproject.toml [tool.uv]', confidence: 'high' };
  if (/\[tool\.poetry\]/.test(pyprojectText)) return { value: 'poetry', source: 'pyproject.toml [tool.poetry]', confidence: 'high' };
  if (names.has('requirements.txt')) return { value: 'pip', source: 'requirements.txt', confidence: 'medium' };
  if (names.has('pyproject.toml')) return { value: 'pip', source: 'pyproject.toml (no env marker)', confidence: 'low' };
  return { value: null, source: 'no python manifests', confidence: 'high' };
}

export function parseMakeTestTarget(makefileText) {
  const lines = makefileText.split('\n');
  let inTest = false;
  const recipe = [];
  for (const line of lines) {
    if (line && !line.startsWith('\t') && !line.startsWith(' ') && /^[^=#][^:]*:/.test(line)) {
      if (inTest) break;
      inTest = line.split(':')[0].trim() === 'test';
      continue;
    }
    if (inTest && (line.startsWith('\t') || line.startsWith('    '))) {
      const cmd = line.replace(/^[\t ]+/, '');
      if (cmd && !cmd.startsWith('#')) recipe.push(cmd);
    }
  }
  return recipe.length > 0 ? recipe.join(' && ') : null;
}

export function detectTestCommand({ names, pkg, makefileText, workflowTexts }) {
  if (pkg?.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
    return { value: pkg.scripts.test, source: 'package.json scripts.test', confidence: 'high', kind: 'script' };
  }
  if (makefileText) {
    const cmd = parseMakeTestTarget(makefileText);
    if (cmd) return { value: cmd, source: 'Makefile test target', confidence: 'high', kind: 'make' };
  }
  for (const { file, text } of workflowTexts) {
    const testRun = text.split('\n').find((l) => /run:.*\btest\b/.test(l));
    if (testRun) {
      const cmd = testRun.replace(/^\s*(?:-\s*)?run:\s*/, '').trim();
      return { value: cmd, source: `CI workflow ${file}`, confidence: 'medium', kind: 'ci' };
    }
  }
  if (names.has('package.json')) {
    return { value: null, source: 'package.json has no test script', confidence: 'low', kind: 'none' };
  }
  return { value: null, source: 'no test command detected', confidence: 'low', kind: 'none' };
}

export function detectMonorepo({ names, pkg }) {
  if (names.has('pnpm-workspace.yaml')) return { value: 'pnpm-workspaces', source: 'pnpm-workspace.yaml', confidence: 'high' };
  if (names.has('turbo.json')) return { value: 'turbo', source: 'turbo.json', confidence: 'high' };
  if (names.has('nx.json')) return { value: 'nx', source: 'nx.json', confidence: 'high' };
  if (names.has('lerna.json')) return { value: 'lerna', source: 'lerna.json', confidence: 'high' };
  if (pkg?.workspaces) return { value: 'npm-workspaces', source: 'package.json workspaces', confidence: 'high' };
  return { value: null, source: 'no monorepo markers', confidence: 'high' };
}

async function detectToolVersions(root, names) {
  const files = ['.nvmrc', '.node-version', '.tool-versions', 'mise.toml', '.python-version'];
  const found = files.filter((f) => names.has(f));
  if (found.length === 0) return { value: null, source: 'none', confidence: 'high' };
  const versions = {};
  for (const f of found) {
    const text = await readText(path.join(root, f)).catch(() => '');
    versions[f] = text.trim().split('\n')[0];
  }
  return { value: versions, source: found.join(', '), confidence: 'high' };
}

export function detectLanguages(files) {
  const counts = {};
  let code = 0;
  for (const f of files) {
    const lang = CODE_EXT[path.posix.extname(f)];
    if (!lang) continue;
    counts[lang] = (counts[lang] || 0) + 1;
    code += 1;
  }
  const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  let confidence = 'high';
  if (!primary) confidence = 'low';
  else if (code < 2) confidence = 'low'; // census is thin
  else if (counts[primary] / code < 0.6) confidence = 'medium'; // mixed repo
  return {
    value: { primary, counts, codeFiles: code },
    source: `extension census (${code} code files)`,
    confidence,
  };
}

function tierFor(size) {
  if (size < 200) return 'small';
  if (size < 2000) return 'medium';
  if (size < 20000) return 'large';
  return 'huge';
}

/**
 * detect(root) -> { plan, needsInput }
 */
export async function detect(root) {
  // Include hidden entries: .devcontainer/, .github/workflows/ are first-class signals.
  const files = await listFiles(root, { maxFiles: 20000, includeHidden: true });
  const names = new Set(files.filter((f) => !f.includes('/')));
  const has = (rel) => files.includes(rel);

  const pkg = has('package.json') ? await readJsonSafe(path.join(root, 'package.json')) : null;
  let makefileText = null;
  if (has('Makefile')) makefileText = await readText(path.join(root, 'Makefile')).catch(() => null);
  else if (has('makefile')) makefileText = await readText(path.join(root, 'makefile')).catch(() => null);
  const pyprojectText = has('pyproject.toml')
    ? await readText(path.join(root, 'pyproject.toml')).catch(() => '') : '';
  const workflowTexts = [];
  for (const f of files) {
    if (/^\.github\/workflows\/.*\.ya?ml$/.test(f)) {
      const text = await readText(path.join(root, f)).catch(() => '');
      workflowTexts.push({ file: f, text });
    }
  }

  const languages = detectLanguages(files);
  const js = pkg
    ? { ...detectJsPackageManager(names), present: true }
    : { value: null, source: 'no package.json', confidence: 'high', present: false };
  const python = detectPythonEnv(names, pyprojectText);
  const go = has('go.mod')
    ? { value: true, source: 'go.mod', confidence: 'high' }
    : { value: false, source: 'no go.mod', confidence: 'high' };
  const rust = has('Cargo.toml')
    ? { value: true, source: 'Cargo.toml', confidence: 'high' }
    : { value: false, source: 'no Cargo.toml', confidence: 'high' };
  const devcontainer = has('.devcontainer/devcontainer.json')
    ? { value: true, source: '.devcontainer/devcontainer.json', confidence: 'high' }
    : { value: false, source: 'none', confidence: 'high' };
  const nix = has('flake.nix')
    ? { value: true, source: 'flake.nix', confidence: 'high' }
    : { value: false, source: 'none', confidence: 'high' };
  const toolVersions = await detectToolVersions(root, names);
  const monorepo = detectMonorepo({ names, pkg });
  const test = detectTestCommand({ names, pkg, makefileText, workflowTexts });
  const repoSize = {
    value: { files: files.length, tier: tierFor(files.length) },
    source: 'filesystem census',
    confidence: 'high',
  };

  // Provision ladder (v0 records the plan; only "local" is executed in v0).
  const provision = [];
  if (devcontainer.value) provision.push({ strategy: 'devcontainer', confidence: 'high', source: devcontainer.source });
  if (nix.value) provision.push({ strategy: 'nix', confidence: 'high', source: nix.source });
  provision.push({ strategy: 'local', confidence: 'high', source: 'host toolchain' });

  // Install command (JS only in v0).
  let install = null;
  if (js.present && js.value && pkg) {
    const hasDeps = Object.keys(pkg.dependencies || {}).length > 0
      || Object.keys(pkg.devDependencies || {}).length > 0;
    if (hasDeps) {
      const installCmd = {
        npm: 'npm ci',
        pnpm: 'pnpm install --frozen-lockfile',
        yarn: 'yarn install --frozen-lockfile',
        bun: 'bun install --frozen-lockfile',
        deno: 'deno install',
      }[js.value];
      install = { command: installCmd, source: js.source, confidence: js.confidence };
    } else {
      install = { command: null, source: 'no runtime dependencies declared', confidence: 'high' };
    }
  }

  const steps = [];
  if (install?.command) steps.push({ stage: 'install', command: install.command });
  if (test.value) {
    steps.push({
      stage: 'test',
      // Run package.json test scripts through the detected package manager.
      command: test.kind === 'script' && js.value ? `${js.value} run test` : test.value,
    });
  }

  const plan = {
    root,
    languages, js, python, go, rust, devcontainer, nix, toolVersions,
    monorepo, test, repoSize, provision, install, steps,
  };

  // Conservative detection: anything < high goes to needsInput.
  const needsInput = [];
  const check = (key, det, question) => {
    if (det && det.confidence !== 'high') {
      needsInput.push({
        key,
        question,
        detected: det.value,
        source: det.source,
        confidence: det.confidence,
      });
    }
  };
  check('js.packageManager', js.present ? js : null, 'Which JS package manager should firstday use?');
  check('python.env', python.value ? python : null, 'Which Python environment manager should firstday use?');
  check('test.command', test.confidence !== 'high' ? test : null, 'No test command found — how should tests be run?');
  check('languages.primary', languages.confidence === 'medium' ? languages : null,
    `Mixed-language repo (${Object.keys(languages.value.counts).join(', ')}) — which language is primary?`);

  return { plan, needsInput };
}
