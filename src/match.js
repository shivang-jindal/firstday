// match.js — stage 4: issue matching.
// If the sibling issue-radar CLI exists, shell out with --offline (and fixture
// support via FIRSTDAY_RADAR_FIXTURE, passed through as radar's --fixture
// flag). The repo argument is the owner/repo slug from the git origin remote
// — radar validates owner/repo and rejects filesystem paths. Otherwise static
// fallback: grep docs for "good first issue" mentions + TODO/FIXME clusters ->
// candidate list with reasons. NEVER fabricates an issue; says "no match
// found" honestly.
import path from 'node:path';
import { listFiles, readJsonSafe, readText } from './fsx.js';

const DOC_EXT = new Set(['.md', '.mdx', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.firstday', 'dist', 'build', 'vendor', 'target']);

// Byte-wise (code-unit) order: localeCompare depends on the host ICU/locale,
// which breaks the deterministic-ordering contract across machines.
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const GOOD_FIRST_RE = /good[\s_-]?first[\s_-]?issue|first[\s_-]?timers?\b|help[\s_-]?wanted/i;
const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b/;

async function staticScan(root) {
  const files = await listFiles(root, { maxFiles: 8000, includeHidden: true });
  const candidates = [];

  // 1) "good first issue" mentions in docs -> candidate with reasons.
  for (const f of files) {
    const ext = path.posix.extname(f).toLowerCase();
    if (!DOC_EXT.has(ext)) continue;
    const text = await readText(path.join(root, f)).catch(() => null);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (GOOD_FIRST_RE.test(lines[i])) {
        const nearby = lines.slice(i, Math.min(i + 3, lines.length)).join(' ').trim();
        candidates.push({
          kind: 'doc-mention',
          title: nearby.slice(0, 120),
          reason: `docs mention good-first-issue area at ${f}:${i + 1}`,
          path: f,
          line: i + 1,
          score: 0.5,
        });
        break; // one candidate per doc file keeps it honest and small
      }
    }
  }

  // 2) TODO/FIXME clusters in code -> candidate per file (capped).
  const markerFiles = [];
  for (const f of files) {
    if (SKIP_DIRS.has(f.split('/')[0])) continue;
    const ext = path.posix.extname(f).toLowerCase();
    if (!CODE_LIKE.has(ext)) continue;
    const text = await readText(path.join(root, f)).catch(() => null);
    if (text === null) continue;
    const lines = text.split('\n');
    let count = 0;
    let firstLine = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (MARKER_RE.test(lines[i])) {
        count += 1;
        if (firstLine === null) firstLine = i + 1;
      }
    }
    if (count > 0) markerFiles.push({ f, count, firstLine });
  }
  markerFiles.sort((a, b) => b.count - a.count || byStr(a.f, b.f));
  for (const m of markerFiles.slice(0, 5)) {
    candidates.push({
      kind: 'todo-cluster',
      title: `${m.count} TODO/FIXME marker${m.count === 1 ? '' : 's'} in ${m.f}`,
      reason: `${m.count} open marker${m.count === 1 ? '' : 's'} (first at ${m.f}:${m.firstLine})`,
      path: m.f,
      line: m.firstLine,
      score: Math.min(0.4, 0.1 + 0.1 * m.count),
    });
  }

  // Deterministic ordering: doc mentions first, then by score desc, path asc.
  candidates.sort((a, b) => {
    const ka = a.kind === 'doc-mention' ? 0 : 1;
    const kb = b.kind === 'doc-mention' ? 0 : 1;
    return ka - kb || b.score - a.score || byStr(a.path, b.path);
  });
  return candidates;
}

const CODE_LIKE = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs',
  '.java', '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.cs',
]);

// radar expects `owner/repo` (it validates the slug and rejects filesystem
// paths) — derive it from the git origin remote; no remote, no radar.
async function gitRemoteSlug(root, exec, timeoutMs) {
  try {
    const r = await exec('git remote get-url origin', {
      cwd: root,
      timeoutMs: Math.min(timeoutMs, 10_000),
      env: {},
    });
    if (r.timedOut || r.error || r.code !== 0) return null;
    const url = String(r.stdout ?? '').trim();
    // git@github.com:owner/repo.git | https://github.com/owner/repo(.git)
    const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * match(root, { radarCli, exec, timeoutMs, env }) -> MatchResult
 * MatchResult = {
 *   source: 'issue-radar' | 'static',
 *   issue: { number, title, url, score, reasons } | null,
 *   candidates: [...],
 *   note: string   // always present; "no match found ..." when honest-none
 * }
 */
export async function match(root, opts = {}) {
  const { radarCli = null, exec = null, timeoutMs = 120_000, env = {} } = opts;

  if (radarCli && exec) {
    const slug = await gitRemoteSlug(root, exec, timeoutMs);
    if (!slug) {
      const candidates = await staticScan(root);
      return finishStatic(
        candidates,
        'issue-radar needs a github origin remote (none found); static fallback',
      );
    }
    // radar's fixture interface is a --fixture <file> flag (it has no env var)
    const fixture = env.FIRSTDAY_RADAR_FIXTURE;
    const fixtureArg = fixture ? ` --fixture "${fixture}"` : '';
    const cmd = `"${process.execPath}" "${radarCli}" scan --offline --json${fixtureArg} "${slug}"`;
    const r = await exec(cmd, { cwd: root, timeoutMs, env: {} });
    if (!r.timedOut && !r.error && r.code === 0) {
      try {
        const data = JSON.parse(r.stdout);
        const results = Array.isArray(data.results) ? data.results : [];
        if (results.length > 0) {
          const top = results[0];
          return {
            source: 'issue-radar',
            issue: {
              number: top.number ?? null,
              title: top.title ?? null,
              url: top.url ?? null,
              score: typeof top.score === 'number' ? top.score : null,
              reasons: Array.isArray(top.reasons) ? top.reasons : [],
            },
            candidates: results.slice(0, 5).map((x) => ({
              kind: 'radar',
              number: x.number ?? null,
              title: x.title ?? null,
              score: x.score ?? null,
            })),
            note: `issue-radar offline scan returned ${results.length} result(s)`,
          };
        }
        return {
          source: 'issue-radar',
          issue: null,
          candidates: [],
          note: 'issue-radar offline scan found no matches (honest none)',
        };
      } catch {
        // fall through to static with a note
        const candidates = await staticScan(root);
        return finishStatic(candidates, 'issue-radar produced unparseable output; static fallback');
      }
    }
    const candidates = await staticScan(root);
    return finishStatic(candidates, `issue-radar unavailable (${r.timedOut ? 'timeout' : r.error || `exit ${r.code}`}); static fallback`);
  }

  const candidates = await staticScan(root);
  return finishStatic(candidates, 'static scan (issue-radar not present)');
}

function finishStatic(candidates, note) {
  if (candidates.length === 0) {
    return {
      source: 'static',
      issue: null,
      candidates: [],
      note: `${note} — no match found (no good-first-issue mentions, no TODO clusters)`,
    };
  }
  const top = candidates[0];
  return {
    source: 'static',
    issue: {
      number: null,
      title: top.title,
      url: null,
      score: top.score,
      reasons: [top.reason],
      kind: top.kind,
      path: top.path,
      line: top.line,
    },
    candidates,
    note,
  };
}
