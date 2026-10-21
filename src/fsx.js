// fsx.js — rooted filesystem helpers. All reads/writes go through a root so
// the pipeline (and tests) can reason about containment. Writes are confined
// to an explicit allow-listed subtree (default: <root>/.firstday).
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.firstday', '.ctx', '.venv', 'venv',
  'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.cache',
  '__pycache__', '.tox', '.mypy_cache', '.ruff_cache', 'vendor',
]);

const DEFAULT_MAX_FILES = 20000;

/** Recursively list files under root (relative, posix-style paths), sorted. */
export async function listFiles(root, opts = {}) {
  const { skip = SKIP_DIRS, maxFiles = DEFAULT_MAX_FILES, includeHidden = false } = opts;
  const out = [];
  async function walk(dir, rel) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        if (!includeHidden && entry.name.startsWith('.')) continue;
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relPath);
      }
    }
  }
  await walk(root, '');
  out.sort();
  return out;
}

export async function readText(file) {
  return fs.readFile(file, 'utf8');
}

export async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

export async function readJsonSafe(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

export async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

export async function exists(file) {
  return (await statOrNull(file)) !== null;
}

/**
 * Create a writer that can only write inside allowDir (which itself must
 * resolve inside root). This is the hard safety rail: firstday output can
 * never land outside <root>/.firstday, and --dry-run never calls it.
 */
export function createConfinedWriter(root, allowSubdir = '.firstday') {
  const rootAbs = path.resolve(root);
  const allowAbs = path.resolve(rootAbs, allowSubdir);
  return {
    root: rootAbs,
    allowDir: allowAbs,
    async writeFile(relPath, content) {
      const target = path.resolve(rootAbs, relPath);
      if (target !== allowAbs && !target.startsWith(allowAbs + path.sep)) {
        throw new Error(
          `refusing to write outside ${allowSubdir}/: ${relPath} resolves to ${target}`,
        );
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      return target;
    },
    async writeJson(relPath, value) {
      return this.writeFile(relPath, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

/** Snapshot every file under root: relpath -> size+mtimeMs fingerprint. */
export async function fingerprintTree(root) {
  const files = await listFiles(root, { skip: new Set(['.git', 'node_modules']) });
  const map = {};
  for (const rel of files) {
    const st = await statOrNull(path.join(root, rel));
    if (st) map[rel] = `${st.size}:${Math.round(st.mtimeMs)}`;
  }
  return map;
}
