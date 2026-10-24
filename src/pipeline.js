// pipeline.js — orchestrates the staged pipeline (SPEC §3) for local paths.
// Stages: detect -> verify -> map -> match -> tour (+ state/resume).
// Invariants: never lie about success (no green test => no "ready"), never
// write outside <root>/.firstday, and only write at all with --apply.
import path from 'node:path';
import { detect } from './detect.js';
import { verify } from './verify.js';
import { map as mapStage, resolveSiblingCli } from './map.js';
import { match as matchStage } from './match.js';
import { buildTour } from './tour.js';
import { createState, loadState, record, recordFailure, saveState, shouldSkip } from './state.js';
import { createConfinedWriter } from './fsx.js';

export const EXIT = {
  READY: 0,
  WARNINGS: 1,
  USAGE: 2,
  STAGE_FAILURE: 3,
};

/**
 * run(root, flags, deps) -> report
 * flags = { dryRun, apply, resume, json, noVerify, timeoutMs }
 * deps  = { exec, now, env, ctxcCli, radarCli }
 */
export async function run(root, flags = {}, deps = {}) {
  const {
    exec = null,
    now = () => Date.now(),
    env = process.env,
    ctxcCli = null,
    radarCli = null,
  } = deps;
  const apply = Boolean(flags.apply) && !flags.dryRun;
  const timeoutMs = flags.timeoutMs ?? 600_000;

  const prev = flags.resume ? await loadState(root) : null;
  const state = prev ?? createState(path.basename(root));
  if (!prev && flags.resume) {
    state.resumed = false;
  }

  const warnings = [];
  const failure = { stage: null, message: null, reproduce: null, output: null };
  // The detect stage records its plan/needsInput inside state.stages.detect;
  // recover them on --resume so ok stages are not redone (SPEC §3).
  let plan = prev?.plan ?? prev?.stages?.detect?.plan ?? null;
  let needsInput = prev?.needsInput ?? prev?.stages?.detect?.needsInputList ?? [];
  let verifyResult = null;
  let mapResult = null;
  let matchResult = null;
  let tourResult = null;

  // --- stage 1: detect ------------------------------------------------------
  if (shouldSkip(prev, 'detect') && plan) {
    state.stages.detect = { ...prev.stages.detect, skipped: 'resumed' };
  } else {
    const t0 = now();
    try {
      const d = await detect(root);
      plan = d.plan;
      needsInput = d.needsInput;
      record(state, 'detect', {
        languages: plan.languages.value.primary,
        packageManager: plan.js.value,
        testCommand: plan.test.value,
        needsInput: needsInput.map((n) => n.key),
        plan,
        needsInputList: needsInput,
      }, { now, startedAt: t0 });
    } catch (err) {
      recordFailure(state, 'detect', { message: String(err?.message ?? err) }, { now, startedAt: t0 });
      failure.stage = 'detect';
      failure.message = String(err?.message ?? err);
      return finish();
    }
  }

  // --- stage 2: verify ------------------------------------------------------
  if (shouldSkip(prev, 'verify')) {
    verifyResult = prev.stages.verify.result ?? null;
    state.stages.verify = { ...prev.stages.verify, skipped: 'resumed' };
  } else {
    const t0 = now(); // pre-stage clock — capturing it at record() time made every duration ~0
    verifyResult = await verify(root, plan, { exec, timeoutMs, skip: flags.noVerify, now });
    if (verifyResult.status === 'ok' || verifyResult.status === 'skipped' || verifyResult.status === 'no-command') {
      record(state, 'verify', {
        tests: verifyResult.status === 'ok' ? 'green' : verifyResult.status,
        verified: verifyResult.verified,
        attempts: verifyResult.attempts,
        flaky: verifyResult.flaky,
        result: verifyResult,
      }, { now, startedAt: t0 });
      if (verifyResult.flaky) {
        warnings.push('tests passed only on retry (flaky suite) — treat the baseline with suspicion');
      }
      if (verifyResult.status === 'skipped') {
        warnings.push('environment UNVERIFIED (--no-verify)');
      }
      if (verifyResult.status === 'no-command') {
        warnings.push('environment UNVERIFIED (no test command detected)');
      }
    } else {
      recordFailure(state, 'verify', {
        tests: verifyResult.status,
        verified: false,
        result: verifyResult,
      }, { now, startedAt: t0 });
      failure.stage = 'verify';
      failure.message = verifyResult.status === 'timeout'
        ? `test command timed out (phase: ${verifyResult.phase})`
        : `${verifyResult.phase ?? 'test'} command failed`;
      failure.reproduce = verifyResult.reproduce;
      failure.output = verifyResult.output;
      return finish();
    }
  }

  // --- stage 3: map ---------------------------------------------------------
  if (shouldSkip(prev, 'map')) {
    mapResult = prev.stages.map.result ?? null;
    state.stages.map = { ...prev.stages.map, skipped: 'resumed' };
  } else {
    const t0 = now(); // pre-stage clock
    try {
      mapResult = await mapStage(root, { apply, ctxcCli, exec, timeoutMs: Math.min(timeoutMs, 120_000) });
      record(state, 'map', {
        source: mapResult.source,
        hotspots: mapResult.hotspots.length,
        entryPoints: mapResult.entryPoints.length,
        result: mapResult,
      }, { now, startedAt: t0 });
      // A dry-run intentionally does not execute ctxc; that is not a failure.
      if (mapResult.ctxc && !mapResult.ctxc.ok && !mapResult.ctxc.skipped && ctxcCli) {
        warnings.push(`ctxc build failed (${mapResult.ctxc.error}) — map is heuristic`);
      }
    } catch (err) {
      recordFailure(state, 'map', { message: String(err?.message ?? err) }, { now, startedAt: t0 });
      failure.stage = 'map';
      failure.message = String(err?.message ?? err);
      return finish();
    }
  }

  // --- stage 4: match -------------------------------------------------------
  if (shouldSkip(prev, 'match')) {
    matchResult = prev.stages.match.result ?? null;
    state.stages.match = { ...prev.stages.match, skipped: 'resumed' };
  } else {
    const t0 = now(); // pre-stage clock
    try {
      matchResult = await matchStage(root, {
        radarCli, exec, timeoutMs: Math.min(timeoutMs, 120_000), env,
      });
      record(state, 'match', {
        issue: matchResult.issue?.number ?? null,
        score: matchResult.issue?.score ?? null,
        source: matchResult.source,
        note: matchResult.note,
        result: matchResult,
      }, { now, startedAt: t0 });
      if (!matchResult.issue) {
        warnings.push(`no match found — ${matchResult.note}`);
      }
    } catch (err) {
      recordFailure(state, 'match', { message: String(err?.message ?? err) }, { now, startedAt: t0 });
      failure.stage = 'match';
      failure.message = String(err?.message ?? err);
      return finish();
    }
  }

  // --- stage 5: tour --------------------------------------------------------
  if (shouldSkip(prev, 'tour')) {
    tourResult = prev.stages.tour.result ?? null;
    state.stages.tour = { ...prev.stages.tour, skipped: 'resumed' };
  } else {
    const t0 = now(); // pre-stage clock
    try {
      tourResult = await buildTour(root, { map: mapResult, match: matchResult, maxSteps: 6 });
      record(state, 'tour', {
        steps: tourResult.steps.length,
        model: 'none (deterministic)',
        via: tourResult.via,
        result: { steps: tourResult.steps, touched: tourResult.touched, via: tourResult.via, title: tourResult.title },
      }, { now, startedAt: t0 });
      if (tourResult.dropped.length > 0) {
        warnings.push(`tour dropped ${tourResult.dropped.length} broken citation(s)`);
      }
    } catch (err) {
      recordFailure(state, 'tour', { message: String(err?.message ?? err) }, { now, startedAt: t0 });
      failure.stage = 'tour';
      failure.message = String(err?.message ?? err);
      return finish();
    }
  }

  return finish();

  function finish() {
    const failed = failure.stage !== null;
    const exitCode = failed ? EXIT.STAGE_FAILURE : (warnings.length > 0 ? EXIT.WARNINGS : EXIT.READY);
    const report = {
      root,
      mode: apply ? 'apply' : 'dry-run',
      exitCode,
      state,
      plan,
      needsInput,
      verify: verifyResult,
      map: mapResult,
      match: matchResult,
      tour: tourResult,
      warnings,
      failure: failed ? failure : null,
      written: [],
    };
    return report;
  }
}

/** Persist state (+ TOUR.md) after a run. Only called with --apply. */
export async function persist(report) {
  if (report.mode !== 'apply') return report;
  const writer = createConfinedWriter(report.root);
  await saveState(report.root, report.state);
  report.written.push('.firstday/state.json');
  if (report.tour?.markdown) {
    await writer.writeFile('.firstday/TOUR.md', report.tour.markdown);
    report.written.push('.firstday/TOUR.md');
  }
  if (report.plan) {
    await writer.writeJson('.firstday/plan.json', {
      provision: report.plan.provision,
      languages: report.plan.languages,
      js: report.plan.js,
      test: report.plan.test,
      install: report.plan.install,
      steps: report.plan.steps,
      monorepo: report.plan.monorepo,
      repoSize: report.plan.repoSize,
    });
    report.written.push('.firstday/plan.json');
  }
  return report;
}
