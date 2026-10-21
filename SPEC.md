# firstday — technical specification

> Companion to [`README.md`](./README.md). Build document: the staged pipeline,
> provisioning ladder, tour generation, scaffolding, safety rails, and e2e test
> strategy.

---

## 1. Design invariants

1. **Never lie about success.** The final "ready" state is only reported after
   a *green test run* in the provisioned environment. No green test, no
   celebration — a clear explanation and a fallback instead.
2. **Never destructive.** firstday never force-pushes, never touches the user's
   existing branches, never modifies a repo it didn't create. All mutations
   happen on a new branch in a fresh clone (or a worktree).
3. **Idempotent stages.** Every stage can be re-run and resumed
   (`firstday --resume`). Users will Ctrl-C; that's a first-class path.
4. **Model-optional.** The tour narrative degrades to a deterministic file list
   when no model/API key is configured. The core experience never requires a
   paid API.
5. **Conservative detection.** When toolchain detection is ambiguous, ask —
   never guess and burn 10 minutes of someone's first impression.

## 2. CLI surface

```
firstday <repo|path>              owner/repo or local path
  --issue <n>                     skip matching; use this issue
  --no-issues                     env + map + tour only
  --provision docker|codespace|local|auto   (default auto)
  --editor vscode|cursor|zed|jetbrains|none
  --no-tour                       skip narrative generation
  --model <name>|none             tour generation backend (default: env-configured)
  --timeout <s>                   per-stage budget (default 600 total)
  --resume                        continue a previous run
  --json                          machine output (for scripts/CI)
  --dry-run                       show the plan, change nothing

firstday status                   current state of an in-progress setup
firstday onboard [--repo r]       generate ONBOARDING.md for a repo (maintainer)
firstday clean                    remove provisioned env + branches it created
firstday adapters                 list supported toolchains + detection confidence
```

Exit codes: `0` ready · `1` completed with warnings (env up, no issue match) ·
`2` usage · `3` stage failure (resumable) · `4` unsupported repo.

## 3. Pipeline

```
stage 1 detect      toolchain + repo shape → Plan { provision[], steps[] }
stage 2 provision   ladder: devcontainer → mise/asdf → codespace → raw
stage 3 verify      install deps, run the test suite, assert green
stage 4 map         ctxc build → .ctx/MAP.md + symbols.db
stage 5 match       issue-radar scan → ranked issues (or --issue)
stage 6 tour        narrative over map + issue → ordered steps w/ file:line
stage 7 scaffold    branch · failing test · hooks · PR template · draft PR
stage 8 ready       print handoff card; open editor
```

Each stage emits structured progress (for `--json` and the terminal renderer),
has a timeout, and records artifacts into `.firstday/state.json` for `--resume`.

### 3.1 Plan (detection matrix)

| Signal | How detected | Drives |
|--------|--------------|--------|
| Languages | extension census + manifest files | image/toolchain |
| JS package manager | lockfile (`pnpm-lock`, `yarn.lock`, `package-lock`) | install cmd |
| Python env | `pyproject` + uv/poetry/pip marker | env strategy |
| Rust/Go/Java | manifest + wrapper (`mvnw`, `gradlew`) | toolchain |
| Devcontainer | `.devcontainer/devcontainer.json` | highest-precedence provision |
| Nix | `flake.nix` | nix provision path |
| Tool versions | `.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml` | exact versions |
| Monorepo | workspaces/turbo/nx config | workspace selection step |
| Test command | scripts.test / Makefile / CI workflow parse | verify step |
| Repo size | file count, clone depth estimate | shallow clone decision |

Detection returns **confidence** per item; anything < high prompts the user
with a one-line question and a remembered answer (stored in
`~/.config/firstday/answers.toml`).

### 3.2 Provision ladder

Order of attempts, first success wins (each with its own timeout):

1. **devcontainer** — if present: `devcontainer up` (Docker/Podman). Highest
   fidelity to what maintainers actually use.
2. **nix** — if `flake.nix` present: `nix develop`.
3. **mise/asdf** — if `.tool-versions`/`mise.toml` present: install toolchain,
   then run install + tests locally.
4. **codespace** — `gh codespace create` when the user opts in (or when local
   Docker is unavailable and `gh` is authed). Fastest for heavy repos.
5. **raw local** — detected toolchain installed via system package managers;
   last resort, most fragile, explicitly labeled.

Warm caches matter: keep a content-addressed cache of built devcontainer
images keyed by (base image digest, lockfile hash) so the second `firstday` run
on the same ecosystem is near-instant.

### 3.3 Verify

Run the repo's own documented test path:

```
install → build (if any) → test (configured command) → capture durations
```

Success criteria: exit 0. On failure: run once more (flaky guard), then report
the failure with the exact command to reproduce manually, and offer
`firstday --provision codespace` as the escape hatch. **Never proceed to
scaffold on a red suite** — a failing baseline makes the "failing test" step
meaningless.

## 4. Map & tour

**Map** = `ctxc build` (dependency; degrade to a heuristic file tree + hotspots
by churn if ctxc is unavailable).

**Tour generation** inputs:

- `.ctx/MAP.md` (communities, entry points, hotspots)
- the matched issue (title, body, labels, referenced stack traces)
- git history for the issue's area (recent commits touching related paths)
- `conventions.md` (so the tour mentions "tests live here, commits look like this")

Algorithm:

```
1. anchor      map issue terms → symbols/paths via ctxc.ask (BM25)
2. frontier    seed = anchor paths; expand one hop along import edges
3. rank        frontier by (centrality × churn × issue relevance)
4. select      top 4–8 files, ordered along the call path from entry → seed
5. narrate     template per step: role (from symbol docs), what to look at,
               why it matters for THIS issue
6. verify      every file:line cited must exist in the current checkout
               (broken citations are dropped, not rendered)
```

Output renders as a numbered tour in the terminal and as `TOUR.md` on the
branch, with an explicit "these are the 4 files you'll touch" summary at the
top. The narrative step is the only LLM-dependent part; steps 1–5 are
deterministic.

## 5. Scaffolding

Everything happens on a **new branch in the fresh clone/worktree**:

1. **Branch name** from repo conventions detected in `ctxc conventions.md`
   (`feat/…`, `fix/…`, `chore-…`), prefixed with the issue number:
   `fix/61234-route-handler-docs`.
2. **Failing test skeleton** generated per language:
   - detect the test framework + naming convention from the existing suite
   - create the test file adjacent to the code the tour identified
   - seed it with the issue's repro steps as assertions (marked TODO where
     uncertain)
   - **run it** — it must fail (red is the proof the test targets the bug)
3. **Hooks/config:** commit-msg hook enforcing conventional commits if the repo
   uses them; `.vscode` launch config if missing (opt-in).
4. **Draft PR** via `gh pr create --draft` with the repo's own PR template
   filled: linked issue, tour link, checklist. Skippable with `--no-pr`.
5. **Handoff card:**

```
✅ ready — branch fix/61234-route-handler-docs
   failing test: test/docs/routes.test.ts:12   (red, as intended)
   tour: TOUR.md · map: .ctx/MAP.md
   conventions: conventional commits · vitest · changeset for releases
   next: open your editor, make the test green, push
```

## 6. Safety rails

- Fresh clone into `~/.cache/firstday/repos/<owner>/<repo>` (or worktree for
  `firstday <local-path>`); never mutate the user's own working tree.
- Push only to the user's fork if one is detected/configured; otherwise the
  draft PR is prepared as a patch file + instructions (no surprise pushes).
- Secrets: never read `.env` files; never echo tokens; `gh` auth is used only
  for read + the explicit `--pr` step.
- Telemetry (opt-in, off by default): stage durations + success booleans only.
  Never repo names, file paths, or code.
- `firstday clean` removes exactly what was created (clone dir, branch, env
  container), verified against `.firstday/state.json`.

## 7. State file

```jsonc
// .firstday/state.json  (inside the managed clone)
{
  "version": 1,
  "repo": "vercel/next.js",
  "sha": "9c1f2ab",
  "stages": {
    "detect":    { "status": "ok", "ms": 1200 },
    "provision": { "status": "ok", "strategy": "devcontainer", "ms": 38000 },
    "verify":    { "status": "ok", "tests": 214, "ms": 61000 },
    "map":       { "status": "ok", "ms": 4200 },
    "match":     { "status": "ok", "issue": 61234, "score": 0.87 },
    "tour":      { "status": "ok", "steps": 6, "model": "claude" },
    "scaffold":  { "status": "ok", "branch": "fix/61234-…", "test": "test/docs/routes.test.ts" }
  }
}
```

## 8. Performance budgets

| Stage | Budget | Notes |
|-------|--------|-------|
| detect | < 2 s | pure filesystem |
| provision (warm) | < 60 s | cached devcontainer image |
| provision (cold) | bounded by repo | progress + escape hatch offered at 5 min |
| verify | repo's suite + 10% | report actual duration honestly |
| map | < 10 s | ctxc budget |
| match | < 20 s warm | radar cache |
| tour | < 15 s | model latency bound; deterministic fallback < 1 s |
| **total (warm)** | **< 3 min** | the marketing number must be honest |

## 9. Test strategy

1. **Ecosystem fixture repos.** 10 pinned small repos (one per supported
   toolchain) in CI; full pipeline runs against them on every PR (docker-in-docker).
2. **Snapshot tours.** Deterministic tour output (file lists, ordering) is
   snapshot-tested; narrative text is checked for citation validity only.
3. **Adversarial fixtures:** broken lockfile, missing test command, monorepo,
   no devcontainer, private-repo-without-auth, huge repo (must refuse cleanly).
4. **Failure-path tests.** Every stage has a forced-failure fixture asserting
   graceful degradation + resumability.
5. **Safety tests.** Assert no writes outside the managed clone dir; assert
   `clean` is exactly inverse of creation.
6. **Manual gauntlet (pre-release).** Run against 10 famous repos with fresh
   machines; record actual wall-clock times and publish them. The performance
   table in the README is sourced from this run.

## 10. Failure modes

| Failure | Behavior |
|---------|----------|
| Provision fails at every ladder rung | exit 3 with per-strategy diagnostics + suggestion to open a codespace |
| Tests fail in the provided env | exit 3; print the failure; offer codespace/local fallback; never scaffold |
| Issue matching returns nothing | continue with env+map; suggest `--issue` or label browsing |
| Model unavailable for tour | deterministic file-list tour (steps 1–5) |
| Repo requires sign-in / is huge | detect early, fail with clear guidance |
| `gh` missing | skip draft PR; emit patch + instructions |
| User's editor not detected | print the path; don't guess |

## 11. v1 → v2 cut line

v1: 10 ecosystems, devcontainer+codespace+local ladder, ctxc/radar integration,
failing-test scaffolding, draft PR, resume, `onboard` generator.

v2: interactive walkthrough ("explain this function"), maintainer dashboard
(conversion metrics), company-internal mode, celebration/credit graph after
merge, adapter contribution registry.
