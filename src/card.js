// card.js — terminal rendering: plan (dry-run), stage progress lines, and the
// handoff card (SPEC §5.5): environment result with real durations, map
// source, matched issue (or honest "none"), tour summary, conventions, next
// steps. Pure string formatting; no I/O, no colors (deterministic tests).
function rail(label, value, width = 44) {
  const head = `── ${label} `;
  const pad = Math.max(1, width - head.length);
  return `${head}${'─'.repeat(pad)} ${value}`;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDuration(v) {
  if (v == null) return '—';
  if (v < 1000) return `${v}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

export function formatCard(report, cliInfo = {}) {
  const out = [];
  const head = report.mode === 'apply' ? 'firstday (apply)' : 'firstday (dry-run — nothing written)';
  out.push(`${head} · ${report.root}`);
  out.push('');

  // Environment -------------------------------------------------------------
  const v = report.verify;
  let envVal;
  if (!v) envVal = '— not run —';
  else if (v.status === 'ok') {
    const total = (v.installMs ?? 0) + (v.testMs ?? 0);
    envVal = `✅ green · tests ${fmtMs(v.testMs)}${v.installMs != null ? ` + install ${fmtMs(v.installMs)}` : ''} · ${fmtDuration(total)}${v.flaky ? ' ⚠ flaky (passed on retry)' : ''}`;
  } else if (v.status === 'skipped') envVal = '⚠ UNVERIFIED (--no-verify)';
  else if (v.status === 'no-command') envVal = '⚠ UNVERIFIED (no test command)';
  else if (v.status === 'timeout') envVal = `❌ ${v.phase ?? 'test'} timed out`;
  else envVal = `❌ red — ${v.phase ?? 'test'} command failed`;
  out.push(rail('environment', envVal));

  // Map ---------------------------------------------------------------------
  const m = report.map;
  let mapVal = '—';
  if (m) {
    mapVal = `${m.source === 'ctxc' ? 'ctxc' : 'heuristic'} · ${m.hotspots.length} hotspots · ${m.entryPoints.length} entr${m.entryPoints.length === 1 ? 'y' : 'ies'}`;
    if (m.entryPoints[0]) mapVal += ` (${m.entryPoints[0].file})`;
  }
  out.push(rail('map', mapVal));

  // Your issue --------------------------------------------------------------
  const mt = report.match;
  let issueVal;
  if (!mt) issueVal = '—';
  else if (mt.issue) {
    const num = mt.issue.number != null ? `#${mt.issue.number} ` : '';
    const score = mt.issue.score != null ? ` ★${Number(mt.issue.score).toFixed(2)}` : '';
    issueVal = `${num}${truncate(mt.issue.title ?? '(untitled)', 28)}${score} (${mt.source})`;
  } else issueVal = 'none found (honest none)';
  out.push(rail('your issue', issueVal));

  // Tour --------------------------------------------------------------------
  const t = report.tour;
  let tourVal = '—';
  if (t) {
    tourVal = `"${truncate(t.title, 24)}" · ${t.steps.length} files via ${t.via}`;
  }
  out.push(rail('tour', tourVal));

  // Conventions -------------------------------------------------------------
  const conv = conventionsLine(report);
  out.push(rail('conventions', conv));
  out.push('');

  // Failure -----------------------------------------------------------------
  if (report.failure) {
    out.push(`❌ stage "${report.failure.stage}" failed: ${report.failure.message}`);
    if (report.failure.reproduce) {
      out.push('');
      out.push('Reproduce exactly:');
      out.push(`    cd "${report.root}" && ${report.failure.reproduce}`);
    }
    if (report.failure.output) {
      out.push('');
      out.push('Output (tail):');
      for (const line of report.failure.output.split('\n')) out.push(`    ${line}`);
    }
    out.push('');
    out.push('Fix the baseline, then re-run with --resume. firstday never scaffolds onto a red suite.');
    out.push('');
    return `${out.join('\n')}\n`;
  }

  // Tour detail -------------------------------------------------------------
  if (t) {
    out.push('Files you’ll touch, in order:');
    let i = 1;
    for (const s of t.steps) {
      const loc = s.line ? `${s.path}:${s.line}` : s.path;
      out.push(`  ${i}. ${loc}  — ${s.role}`);
      i += 1;
    }
    out.push('');
  }

  // Needs input -------------------------------------------------------------
  if (report.needsInput?.length) {
    out.push('Needs your input (conservative detection):');
    for (const n of report.needsInput) {
      out.push(`  ? ${n.question}  [detected: ${JSON.stringify(n.detected)} from ${n.source}, ${n.confidence}]`);
    }
    out.push('');
  }

  // Warnings ----------------------------------------------------------------
  if (report.warnings.length > 0) {
    out.push('Warnings:');
    for (const w of report.warnings) out.push(`  ⚠ ${w}`);
    out.push('');
  }

  // Next steps --------------------------------------------------------------
  out.push('Next steps:');
  if (report.mode === 'apply') {
    if (report.written.length) out.push(`  · written: ${report.written.join(' · ')}`);
    out.push('  · open the files above in order; run the test command; keep it green');
    out.push('  · open a PR referencing the candidate above');
  } else {
    out.push('  · re-run with --apply to write .firstday/state.json + TOUR.md + plan.json');
    out.push('  · nothing was written; your tree is untouched');
  }
  // Any unavailable (null or empty-string override) integration gets the hint.
  if (!cliInfo.ctxcCli) out.push('  · ctxc not found (../../ctxc) — map is heuristic; install ctxc for deeper maps');
  if (!cliInfo.radarCli) out.push('  · issue-radar not found (../../issue-radar) — match is a static scan');
  out.push('');
  return `${out.join('\n')}\n`;
}

function conventionsLine(report) {
  const parts = [];
  const plan = report.plan;
  if (plan?.test?.value) parts.push(`tests: ${truncate(plan.test.source.replace('package.json ', ''), 22)}`);
  if (plan?.js?.value) parts.push(`pm: ${plan.js.value}`);
  if (plan?.monorepo?.value) parts.push(`monorepo: ${plan.monorepo.value}`);
  if (plan?.languages?.value?.primary) parts.push(`lang: ${plan.languages.value.primary}`);
  if (report.map?.tests?.count > 0) parts.push(`test files: ${report.map.tests.count}`);
  return parts.length ? parts.join(' · ') : '—';
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}
