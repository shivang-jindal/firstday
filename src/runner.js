// runner.js — injected exec runner with timeout + process-tree kill.
// Zero dependencies; Windows-safe (taskkill /T /F) and POSIX-safe (process group).
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 512 * 1024; // cap captured stdout/stderr per stream

function trimOutput(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return `…(truncated ${text.length - MAX_OUTPUT} chars)\n${text.slice(-MAX_OUTPUT)}`;
}

/**
 * Create an exec runner.
 * exec(command, { cwd, timeoutMs, env }) -> Promise<ExecResult>
 * ExecResult = { command, code, signal, stdout, stderr, timedOut, ms, error }
 * Never throws for nonzero exits; only rejects on programmer error.
 */
export function createRunner({ platform = process.platform } = {}) {
  return function exec(command, opts = {}) {
    const { cwd, timeoutMs = 0, env = {} } = opts;
    const started = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, {
          cwd,
          shell: true,
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
          // On POSIX put the child in its own process group so we can kill the tree.
          detached: platform !== 'win32',
          windowsHide: true,
        });
      } catch (err) {
        resolve({
          command,
          code: null,
          signal: null,
          stdout: '',
          stderr: String(err && err.message ? err.message : err),
          timedOut: false,
          ms: Date.now() - started,
          error: String(err && err.message ? err.message : err),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer = null;

      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });

      const killTree = () => {
        if (child.pid == null) return;
        if (platform === 'win32') {
          // taskkill the whole tree; ignore errors (process may already be gone).
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            }).on('error', () => {});
          } catch { /* best effort */ }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {
            try { child.kill('SIGKILL'); } catch { /* best effort */ }
          }
        }
      };

      const finish = (code, signal, error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          command,
          code,
          signal,
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
          timedOut,
          ms: Date.now() - started,
          error: error ?? null,
        });
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutMs);
      }

      child.on('error', (err) => finish(null, null, String(err && err.message ? err.message : err)));
      child.on('close', (code, signal) => finish(code, signal, null));
    });
  };
}

// A fake runner for tests: map command substrings -> canned results.
export function fakeRunner(handler) {
  const calls = [];
  const exec = async (command, opts = {}) => {
    calls.push({ command, opts });
    const result = await handler(command, opts, calls.length);
    return {
      command,
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      ms: 1,
      error: null,
      ...result,
    };
  };
  exec.calls = calls;
  return exec;
}

export const defaultRunner = createRunner();
