// map.js — stage 3: architecture map.
// Heuristic (no deps): top-level structure, entry points (bin/main),
// hotspots by LOC + import degree, test topology.
// Integration: if the sibling ctxc CLI exists (../../ctxc/src/cli.js relative
// to this package, i.e. the vault sibling), shell out to
//   node <abs ctxc cli> build <repo> --out <repo>/.firstday/ctx
// then read MAP.md + symbols.json from that out dir; fall back to heuristics
// when it fails. Which source was used is recorded in the result (and later
// the state file).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, listFiles, readJsonSafe, readText, statOrNull } from './fsx.js';

// Byte-wise (code-unit) order: localeCompare depends on the host ICU/locale,
// which breaks the deterministic-ordering contract across machines.
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs',
  '.java', '.rb', '.php', '.sh', '.c', '.cpp', '.h', '.hpp', '.cs', '.kt', '.swift',
]);
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)/;
// Match the FILENAME segment, not the whole path: `tests/test_main.py` must
// count as a python unittest file just like a top-level `test_main.py`.
const TEST_FILE_RE = /(\.(test|spec)\.[jt]sx?$|(?:^|\/)[^/]*_test\.(py|go|rs)$|(?:^|\/)test_[^/]*\.py$|Test\.java$)/;
const PY_UNIT_RE = /(?:^|\/)test_[^/]*\.py$/;

function extOf(f) {
  const i = f.lastIndexOf('.');
  return i === -1 ? '' : f.slice(i).toLowerCase();
}

function isCode(f) {
  return CODE_EXT.has(extOf(f)) && !TEST_FILE_RE.test(f);
}

// --- import edges (very small, deterministic regex extractors) --------------

function extractImports(rel, text) {
  const out = [];
  const ext = extOf(rel);
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) {
    const re = /(?:import\s+(?:[\w*${},\s]+?\s+from\s+)?|export\s+[\w*${},\s]+?\s+from\s+|require\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
  } else if (ext === '.py') {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m;
    while ((m = re.exec(text))) out.push(m[1] || m[2]);
  } else if (ext === '.go') {
    const re = /^\s*(?:\w+\s+)?"([^"]+)"/gm;
    const block = /import\s*\(([\s\S]*?)\)/.exec(text);
    if (block) {
      let m;
      while ((m = re.exec(block[1]))) out.push(m[1]);
    }
    const single = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm;
    let m;
    while ((m = single.exec(text))) out.push(m[1]);
  }
  // rust use-crate paths are less directly mappable; skip for v0.
  return out;
}

function resolveImport(fromRel, spec, fileSet, rootRel) {
  if (!spec.startsWith('.')) return null; // only relative edges in v0
  const baseDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  let target = path.posix.normalize(path.posix.join(baseDir, spec));
  if (target.startsWith('..')) return null;
  const candidates = [
    target,
    `${target}.js`, `${target}.ts`, `${target}.tsx`, `${target}.jsx`,
    `${target}.mjs`, `${target}.cjs`, `${target}.py`, `${target}.go`,
    `${target}/index.js`, `${target}/index.ts`, `${target}/__init__.py`,
  ];
  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

// --- entry points -----------------------------------------------------------

async function findEntryPoints(root, files, pkg) {
  const entries = [];
  const add = (file, kind, detail) => {
    if (file && !entries.some((e) => e.file === file)) entries.push({ file, kind, detail });
  };
  if (pkg) {
    if (typeof pkg.bin === 'string') add(pkg.bin, 'bin', `package.json bin "${pkg.name}"`);
    else if (pkg.bin) {
      const first = Object.entries(pkg.bin)[0];
      if (first) add(first[1], 'bin', `package.json bin "${first[0]}"`);
    }
    if (pkg.main) add(pkg.main, 'main', 'package.json main');
  }
  // Shebang files (CLI entrypoints) not already captured.
  for (const f of files) {
    if (entries.length >= 6) break;
    if (!isCode(f)) continue;
    if (!['.js', '.mjs', '.cjs', '.py', '.sh'].includes(extOf(f))) continue;
    const text = await readText(path.join(root, f)).catch(() => '');
    if (/^#!/.test(text)) add(f, 'shebang', 'has #! shebang');
  }
  if (entries.length === 0) {
    // Conventional fallbacks.
    for (const cand of ['src/index.ts', 'src/index.js', 'index.js', 'src/main.py', 'main.py', 'src/main.rs', 'cmd/main.go', 'main.go']) {
      if (files.includes(cand)) { add(cand, 'conventional', 'conventional entry filename'); break; }
    }
  }
  return entries.slice(0, 6);
}

// --- structure + tests ------------------------------------------------------

function topLevelStructure(files) {
  const dirs = new Map();
  for (const f of files) {
    const top = f.includes('/') ? f.split('/')[0] : null;
    if (!top) continue;
    dirs.set(top, (dirs.get(top) || 0) + 1);
  }
  const roleOf = (d) => {
    if (['src', 'lib', 'app', 'pkg', 'packages', 'internal'].includes(d)) return 'source';
    if (TEST_DIR_RE.test(`${d}/`)) return 'tests';
    if (['docs', 'doc', 'documentation'].includes(d)) return 'docs';
    if (['examples', 'example', 'demo', 'samples'].includes(d)) return 'examples';
    if (['scripts', 'tools', 'bin'].includes(d)) return 'tooling';
    if (['.github', 'config', 'ci'].includes(d)) return 'config';
    return 'other';
  };
  return [...dirs.entries()]
    .sort((a, b) => byStr(a[0], b[0]))
    .map(([dir, files_]) => ({ dir, files: files_, role: roleOf(dir) }));
}

function testTopology(files) {
  const testFiles = files.filter((f) => TEST_FILE_RE.test(f));
  const testDirs = [...new Set(testFiles.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.')))]
    .sort();
  let pattern = 'unknown';
  if (testFiles.some((f) => /\.test\.[jt]sx?$/.test(f))) pattern = '*.test.{js,ts}';
  else if (testFiles.some((f) => /\.spec\.[jt]sx?$/.test(f))) pattern = '*.spec.{js,ts}';
  else if (testFiles.some((f) => /_test\.(py|go|rs)$/.test(f))) pattern = '*_test.{py,go,rs}';
  else if (testFiles.some((f) => PY_UNIT_RE.test(f))) pattern = 'test_*.py';
  return { count: testFiles.length, dirs: testDirs, pattern, files: testFiles.slice(0, 20) };
}

// --- main -------------------------------------------------------------------

/**
 * map(root, { apply, ctxcCli, exec, timeoutMs }) -> MapResult
 * MapResult = {
 *   source: 'ctxc' | 'heuristic',
 *   structure, entryPoints, hotspots, tests,
 *   fileCount, ctxc: { ok, error, out } | null
 * }
 */
export async function map(root, opts = {}) {
  const { apply = false, ctxcCli = null, exec = null, timeoutMs = 120_000 } = opts;

  let ctxcInfo = null;
  if (ctxcCli && exec) {
    if (!apply) {
      ctxcInfo = { ok: false, skipped: 'dry-run', error: 'dry-run: ctxc build not executed', out: null };
    } else {
      const outDir = path.join(root, '.firstday', 'ctx');
      const r = await exec(`"${process.execPath}" "${ctxcCli}" build "${root}" --out "${outDir}"`, {
        cwd: root,
        timeoutMs,
      });
      if (!r.timedOut && !r.error && r.code === 0) {
        // Prefer the out dir; fall back to a repo-level .ctx if the CLI ignored --out.
        const mapMdPath = (await exists(path.join(outDir, 'MAP.md')))
          ? path.join(outDir, 'MAP.md')
          : path.join(root, '.ctx', 'MAP.md');
        const symbolsPath = (await exists(path.join(outDir, 'symbols.json')))
          ? path.join(outDir, 'symbols.json')
          : path.join(root, '.ctx', 'symbols.json');
        const mapMd = await readText(mapMdPath).catch(() => null);
        const symbols = await readJsonSafe(symbolsPath);
        if (mapMd || symbols) {
          ctxcInfo = { ok: true, error: null, out: path.dirname(mapMdPath), mapMd, symbols };
        } else {
          ctxcInfo = { ok: false, error: 'ctxc ran but produced no readable MAP.md/symbols.json', out: null };
        }
      } else {
        ctxcInfo = {
          ok: false,
          error: r.timedOut ? 'ctxc build timed out' : (r.error || `ctxc build exited ${r.code}`),
          out: null,
        };
      }
    }
  }

  const files = await listFiles(root, { maxFiles: 20000, includeHidden: true });
  const fileSet = new Set(files);
  const pkg = await readJsonSafe(path.join(root, 'package.json'));

  // LOC + import edges
  const loc = new Map();
  const outbound = new Map();
  const inbound = new Map();
  for (const f of files) {
    if (!isCode(f)) continue;
    const text = await readText(path.join(root, f)).catch(() => null);
    if (text === null) continue;
    loc.set(f, text.split('\n').length);
    const specs = extractImports(f, text);
    const resolved = new Set();
    for (const s of specs) {
      const t = resolveImport(f, s, fileSet, root);
      if (t) resolved.add(t);
    }
    outbound.set(f, [...resolved].sort());
    for (const t of resolved) {
      if (!inbound.has(t)) inbound.set(t, new Set());
      inbound.get(t).add(f);
    }
  }

  const hotspots = [...loc.entries()]
    .map(([file, lines]) => {
      const degree = inbound.get(file)?.size ?? 0;
      return { file, loc: lines, importDegree: degree, score: lines * (1 + Math.log2(1 + degree)) };
    })
    .sort((a, b) => b.score - a.score || byStr(a.file, b.file))
    .slice(0, 8)
    .map((h) => ({ ...h, score: Math.round(h.score * 100) / 100 }));

  // Bound the edges we ship in the result (tour BFS + state file stay small).
  const edgeEntries = [...outbound.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([, tos]) => tos.length > 0)
    .slice(0, 500);
  const edges = Object.fromEntries(edgeEntries);

  const result = {
    source: ctxcInfo?.ok ? 'ctxc' : 'heuristic',
    structure: topLevelStructure(files),
    entryPoints: await findEntryPoints(root, files, pkg),
    hotspots,
    edges,
    tests: testTopology(files),
    fileCount: files.length,
    ctxc: ctxcInfo,
  };

  // If ctxc produced symbols, enrich (or at least surface) them.
  if (ctxcInfo?.ok && ctxcInfo.symbols) {
    const syms = ctxcInfo.symbols;
    result.ctxc.symbolCount = Array.isArray(syms.symbols) ? syms.symbols.length
      : Array.isArray(syms) ? syms.length : 0;
  }
  return result;
}

/** Locate the sibling ctxc CLI (../../ctxc/src/cli.js relative to src/). */
export function resolveSiblingCli(name) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', name, 'src', 'cli.js');
}
