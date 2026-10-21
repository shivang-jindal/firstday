// verify.js — stage 2 (SPEC §3.3): run the detected install/test path with a
// timeout via the injected exec. NEVER proceed on red: a red suite ends the
// run with exit 3 and exact reproduction instructions. `--no-verify` skips
// and the handoff card must say "environment UNVERIFIED".
//
// verify(root, plan, { exec, timeoutMs, skip, now }) -> result
// result = {
//   status: 'ok' | 'red' | 'timeout' | 'skipped' | 'no-command',
//   verified: boolean, installMs, testMs, attempts, flaky,
//   steps: [{ stage, command, code, timedOut, ms }],
//   reproduce: string|null, output: string|null
// }
export async function verify(root, plan, deps) {
  const { exec, timeoutMs = 600_000, skip = false, now = () => Date.now() } = deps;

  if (skip) {
    return {
      status: 'skipped',
      verified: false,
      installMs: null,
      testMs: null,
      attempts: 0,
      flaky: false,
      steps: [],
      reproduce: null,
      output: null,
      note: 'verification skipped via --no-verify; environment UNVERIFIED',
    };
  }

  const steps = [];
  const testStep = plan.steps.find((s) => s.stage === 'test') ?? null;
  if (!testStep) {
    return {
      status: 'no-command',
      verified: false,
      installMs: null,
      testMs: null,
      attempts: 0,
      flaky: false,
      steps: [],
      reproduce: null,
      output: null,
      note: 'no test command detected — environment UNVERIFIED',
    };
  }

  // 1. install (if planned)
  const installStep = plan.steps.find((s) => s.stage === 'install') ?? null;
  let installMs = null;
  if (installStep) {
    const r = await exec(installStep.command, { cwd: root, timeoutMs, env: { FIRSTDAY_VERIFY: '1' } });
    steps.push({ stage: 'install', command: installStep.command, code: r.code, timedOut: r.timedOut, ms: r.ms });
    installMs = r.ms;
    if (r.timedOut) {
      return {
        status: 'timeout', verified: false, installMs, testMs: null, attempts: 0, flaky: false,
        steps, reproduce: `${installStep.command}   (in ${root})`, output: tail(r), phase: 'install',
      };
    }
    if (r.error || r.code !== 0) {
      return {
        status: 'red', verified: false, installMs, testMs: null, attempts: 0, flaky: false,
        steps, reproduce: `${installStep.command}   (in ${root})`, output: tail(r), phase: 'install',
      };
    }
  }

  // 2. test, with one flaky-guard retry on nonzero exit (not on timeout).
  const started = now();
  let attempts = 0;
  let r = null;
  let flaky = false;
  for (;;) {
    attempts += 1;
    r = await exec(testStep.command, { cwd: root, timeoutMs, env: { FIRSTDAY_VERIFY: '1' } });
    steps.push({ stage: 'test', command: testStep.command, code: r.code, timedOut: r.timedOut, ms: r.ms });
    if (r.timedOut || r.error || r.code === 0 || attempts >= 2) break;
    flaky = true; // first attempt failed; retrying once
  }
  const testMs = now() - started;

  if (r.timedOut) {
    return {
      status: 'timeout', verified: false, installMs, testMs, attempts, flaky: false,
      steps, reproduce: `${testStep.command}   (in ${root})`, output: tail(r), phase: 'test',
    };
  }
  if (r.error || r.code !== 0) {
    return {
      status: 'red', verified: false, installMs, testMs, attempts, flaky: false,
      steps,
      reproduce: `${testStep.command}   (in ${root})`,
      output: tail(r),
      phase: 'test',
    };
  }
  return {
    status: 'ok',
    verified: true,
    installMs,
    testMs,
    attempts,
    // flaky means: first attempt failed, retry passed — report honestly.
    flaky,
    steps,
    reproduce: null,
    output: tail(r),
  };
}

function tail(r, lines = 20) {
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  const all = text.split('\n');
  return all.slice(-lines).join('\n') || null;
}
