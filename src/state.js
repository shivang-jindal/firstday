// state.js — SPEC §7: .firstday/state.json with stage statuses + ms via the
// injected clock. `--resume` skips stages whose status is "ok".
import path from 'node:path';
import { createConfinedWriter, readJsonSafe } from './fsx.js';

export const STATE_VERSION = 1;
export const STATE_REL = '.firstday/state.json';

export function createState(repo) {
  return { version: STATE_VERSION, repo, stages: {} };
}

/**
 * record(state, stage, fields, { now, startedAt }) — fills status/ms/at.
 * Uses the injected clock so tests get deterministic durations + timestamps.
 */
export function record(state, stage, fields, { now = () => Date.now(), startedAt } = {}) {
  const ms = typeof startedAt === 'number' ? now() - startedAt : fields.ms ?? 0;
  state.stages[stage] = { status: 'ok', ...fields, ms, at: isoAt(now) };
  return state.stages[stage];
}

export function recordFailure(state, stage, fields, { now = () => Date.now(), startedAt } = {}) {
  const ms = typeof startedAt === 'number' ? now() - startedAt : fields.ms ?? 0;
  state.stages[stage] = { status: 'failed', ...fields, ms, at: isoAt(now) };
  return state.stages[stage];
}

function isoAt(now) {
  try {
    return new Date(now()).toISOString();
  } catch {
    return null;
  }
}

export function shouldSkip(prevState, stage) {
  return prevState?.stages?.[stage]?.status === 'ok';
}

export async function loadState(root) {
  const loaded = await readJsonSafe(path.join(root, STATE_REL));
  if (loaded === null || loaded === undefined) return null;
  // Wrong-shaped state (hand-edited, another tool's file, corrupt-but-valid
  // JSON) must never be resumed as ours — treat as absent so the run starts
  // fresh and `status` honestly reports no-state.
  if (typeof loaded !== 'object' || Array.isArray(loaded)) return null;
  if (loaded.version !== STATE_VERSION) return null;
  const stages = loaded.stages;
  if (typeof stages !== 'object' || stages === null || Array.isArray(stages)) return null;
  return loaded;
}

export async function saveState(root, state) {
  const writer = createConfinedWriter(root);
  await writer.writeJson(STATE_REL, state);
  return path.join(root, STATE_REL);
}
