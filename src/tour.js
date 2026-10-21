// tour.js — stage 5: deterministic file tour (no LLM).
// Ordered steps from the entry point toward the matched-issue area using
// import edges (or LOC-rank fallback). Each step: { path, line?, role, why }.
// Every cited path/line is verified to exist; broken citations are dropped.
// Renders TOUR.md content + the "these are the N files you'll touch" summary.
import path from 'node:path';
import { readText, statOrNull } from './fsx.js';

/**
 * buildTour(root, { map, match, maxSteps }) -> TourResult
 * TourResult = {
 *   steps: [{ path, line, role, why }],
 *   touched: [paths],           // the "N files you'll touch" summary
 *   via: 'import-edges' | 'loc-rank',
 *   dropped: [descriptions],    // citations dropped for being broken
 *   title: string,
 *   markdown: string
 * }
 */
export async function buildTour(root, opts = {}) {
  const { map: mapResult, match: matchResult, maxSteps = 6 } = opts;
  const dropped = [];

  // Anchor: prefer the matched issue's path; else the top hotspot.
  let anchor = null;
  if (matchResult?.issue?.path) {
    anchor = matchResult.issue.path;
    if (!(await statOrNull(path.join(root, anchor)))) {
      dropped.push(`anchor from match (${anchor}) does not exist`);
      anchor = null;
    }
  }
  const hotspotFiles = (mapResult?.hotspots ?? []).map((h) => h.file);
  if (!anchor && hotspotFiles.length > 0) {
    anchor = hotspotFiles[0];
  }

  // BFS from entry points toward the anchor over import edges (outbound map
  // derived from hotspots' importDegree is not enough; we re-derive edges from
  // mapResult when ctxc gave us none — heuristic edges are recovered from the
  // hotspot/import info we stored; for v0 we reconstruct a minimal edge walk
  // using the map's entryPoints + hotspot ordering).
  const entry = mapResult?.entryPoints?.[0]?.file ?? null;
  const ordered = [];
  const seen = new Set();
  const push = (file) => {
    if (file && !seen.has(file)) {
      seen.add(file);
      ordered.push(file);
    }
  };

  let via = 'loc-rank';
  const edges = mapResult?.edges ?? null;
  if (edges && entry) {
    via = 'import-edges';
    // Simple deterministic BFS along adjacency from the entry point.
    const adj = new Map();
    for (const [from, tos] of Object.entries(edges)) {
      adj.set(from, [...tos].sort());
    }
    const queue = [entry];
    const visited = new Set([entry]);
    while (queue.length > 0 && ordered.length < maxSteps) {
      const cur = queue.shift();
      push(cur);
      if (cur === anchor) break;
      for (const next of adj.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    // If BFS didn't reach the anchor, append it (and rank-order in between).
    if (anchor && !seen.has(anchor)) {
      via = 'loc-rank';
      ordered.length = 0;
      seen.clear();
    }
  }

  if (via === 'loc-rank') {
    if (entry) push(entry);
    if (anchor) push(anchor);
    for (const h of hotspotFiles) {
      if (ordered.length >= maxSteps) break;
      push(h);
    }
    // Fill remaining slots with more hotspots/entrypoints deterministically.
    for (const e of mapResult?.entryPoints ?? []) {
      if (ordered.length >= maxSteps) break;
      push(e.file);
    }
  }

  // Verify citations: path must exist; line (if any) must be <= line count.
  const steps = [];
  for (const file of ordered.slice(0, maxSteps)) {
    const st = await statOrNull(path.join(root, file));
    if (!st || !st.isFile()) {
      dropped.push(`path ${file} does not exist`);
      continue;
    }
    let line = null;
    if (anchor === file && matchResult?.issue?.line) {
      const candidateLine = matchResult.issue.line;
      const text = await readText(path.join(root, file)).catch(() => null);
      const total = text === null ? 0 : text.split('\n').length;
      if (candidateLine >= 1 && candidateLine <= total) line = candidateLine;
      else dropped.push(`line ${file}:${candidateLine} out of range (${total} lines)`);
    }
    const role = describeRole(file, { entry, anchor, mapResult, matchResult });
    const why = describeWhy(file, { entry, anchor, mapResult, matchResult });
    steps.push({ path: file, line, role, why });
  }

  const touched = steps.map((s) => (s.line ? `${s.path}:${s.line}` : s.path));
  const title = matchResult?.issue?.title
    ? firstWords(matchResult.issue.title)
    : (mapResult?.entryPoints?.[0]?.detail ? `${mapResult.entryPoints[0].kind} tour` : 'repository tour');

  const markdown = renderTour({ title, steps, mapResult, matchResult, via });
  return { steps, touched, via, dropped, title, markdown };
}

function firstWords(s, n = 6) {
  const words = String(s).trim().split(/\s+/);
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '');
}

function describeRole(file, { entry, anchor, mapResult, matchResult }) {
  if (file === entry) return 'entry point';
  // Anchor without a matched issue is just the top hotspot — never pretend
  // otherwise ("never lie" applies to the tour too).
  if (file === anchor) return matchResult?.issue ? 'issue area' : 'highest-impact hotspot';
  if (/(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\./.test(file)) return 'tests';
  const h = (mapResult?.hotspots ?? []).find((x) => x.file === file);
  if (h && h.importDegree >= 2) return 'core (imported widely)';
  return 'supporting code';
}

function describeWhy(file, { entry, anchor, mapResult, matchResult }) {
  if (file === entry) return 'start here — this is where execution begins';
  if (file === anchor && matchResult?.issue) {
    return `matched candidate points here: ${matchResult.issue.reasons?.[0] ?? matchResult.issue.title}`;
  }
  if (file === anchor) return 'highest-impact file in the repo (hotspot #1)';
  const h = (mapResult?.hotspots ?? []).find((x) => x.file === file);
  if (h) return `hotspot: ${h.loc} LOC, imported by ${h.importDegree} file(s)`;
  return 'on the path from the entry point';
}

function renderTour({ title, steps, mapResult, matchResult, via }) {
  const lines = [];
  lines.push(`# firstday tour — ${title}`);
  lines.push('');
  lines.push(`**These are the ${steps.length} files you'll touch.** (ordered via ${via === 'import-edges' ? 'import edges' : 'LOC rank'})`);
  lines.push('');
  let i = 1;
  for (const s of steps) {
    const loc = s.line ? `${s.path}:${s.line}` : s.path;
    lines.push(`${i}. \`${loc}\` — **${s.role}**`);
    lines.push(`   ${s.why}`);
    i += 1;
  }
  lines.push('');
  lines.push('## Conventions detected');
  const tests = mapResult?.tests;
  if (tests && tests.count > 0) {
    lines.push(`- Tests: ${tests.count} file(s), pattern \`${tests.pattern}\`, dirs: ${tests.dirs.slice(0, 3).join(', ')}`);
  } else {
    lines.push('- Tests: none detected');
  }
  if (mapResult?.entryPoints?.length) {
    lines.push(`- Entry points: ${mapResult.entryPoints.map((e) => `${e.file} (${e.kind})`).join(', ')}`);
  }
  if (matchResult?.issue) {
    lines.push(`- Matched candidate: ${matchResult.issue.title ?? '(untitled)'} — ${matchResult.issue.reasons?.join(' · ') ?? matchResult.note}`);
  } else {
    lines.push('- Matched candidate: none found (honest none)');
  }
  lines.push('');
  lines.push('## Next steps');
  lines.push('1. Read the files above in order — that is the call path.');
  lines.push('2. Reproduce the issue or pick the TODO you want to fix.');
  lines.push('3. Make a change, run the test command from your plan, keep it green.');
  lines.push('4. Open a PR referencing the candidate/TODO — you now know where everything lives.');
  lines.push('');
  return lines.join('\n');
}
