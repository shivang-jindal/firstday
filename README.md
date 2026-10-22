# firstday — clone to first merged PR in 60 seconds

> **The flagship.** One command: environment up, architecture tour, matched issue,
  branch ready, failing test written, draft PR opened.
> Bundles `ctxc` + `issue-radar` + `snipci` into the moment that actually matters.

**Archetype:** CLI (`npx firstday owner/repo`) · **Buzz:** 🔥🔥🔥 · **Overpowered:** 💊💊💊💊💊

---

## The problem

The single most expensive moment in open source is **day one.** The funnel:

```
lands on repo → reads README → clones → dev env breaks → gives up     (~40%)
              → env works → picks an impossible issue → stalls        (~30%)
              → opens a PR → doesn't know conventions → rejected/quiet (~20%)
              → merged 🎉                                              (…the rest)
```

Every OSS program on earth is trying to fix this with *more documentation.*
Documentation isn't the fix. **A working state is the fix.**

Devcontainers, Gitpod, and Codespaces solved the *environment* half and stopped
there. Nobody solved "okay, but what do I *do* now?"

## The idea

```bash
$ npx firstday vercel/next.js
  ── environment ────────────────────────────── ✅ node 22 + pnpm, 38s
  ── map ────────────────────────────────────── ctxc · 6 hotspots loaded
  ── your issue ─────────────────────────────── #61234 ★0.87 (issue-radar)
  ── tour ───────────────────────────────────── "route handler resolution"
       src/server/render.tsx → … → the 4 files you'll touch
  ── branch ─────────────────────────────────── fix/route-handler-docs
  ── failing test ───────────────────────────── test/docs/routes.test.ts (red)
  ── conventions ────────────────────────────── commit: conventional · tests: vitest

  Ready. Open your editor?  [y/N]
```

Sixty seconds later the newcomer is in an editor with a **red test that
reproduces the issue**, a map of exactly which 4 files matter, and a branch
already following repo conventions. The psychological shift is total: this is no
longer "a repo I might contribute to," it's "my PR in progress."

## Why it wins

- **It compresses the entire funnel into one command.** Competitors solve a
  slice (env) or a doc (guide). This solves the *outcome*.
- **It's the product version of three primitives.** `ctxc` gives the map,
  `issue-radar` gives the match, `snipci` guarantees the quickstart works. Each
  primitive is useful alone; together they're a demo nobody forgets.
- **Demo-ability is insane.** A 30-second terminal GIF of "npx firstday <repo>"
  going from nothing to a red test is the most shareable dev-tool clip possible.
- **Framing for maintainers:** "your project's contributor conversion rate" is a
  metric they've never had and instantly want.

## Who wants it

Individual newcomers (obviously), but the **buyer** is the project: maintainers
and foundations whose entire existence depends on a steady stream of
contributors. Hacktoberfest programs, university clubs, company OSS programs.

## Features

**v0 (weekend):** detect toolchain → build devcontainer or use local → run tests
until green → print "first good issue" from a static list.
**v1:** `ctxc` integration for the tour · `issue-radar` for matching · failing-
test skeleton generation · branch + conventional-commit setup · draft PR with
repo's own template · `--codespace` fallback.
**v2:** interactive walkthrough ("explain this function to me" wired to `.ctx/`),
post-merge celebration + credit graph, maintainer dashboard (how many firstdays
completed, conversion to merged), `firstday onboard` for companies' own repos.

## Architecture

```
firstday CLI
 ├─ detect      toolchain fingerprints → devcontainer / mise / codespace
 ├─ provision   docker · podman · gh codespace · local
 ├─ map         ctxc build  → .ctx/MAP.md + symbols.db
 ├─ match       issue-radar → issue + fingerprint score
 ├─ tour        .ctx + issue diff → call-path narrative (4-8 files)
 ├─ scaffold    branch · failing test from issue repro · commit-msg hook
 └─ open        draft PR w/ repo template · links to tour + test
```

Everything is deterministic except the tour text. Keep the model *optional* —
the tour degrades to a file list if no API key.

## Growth loop

1. **The GIF.** `npx firstday <famous-repo>` → Twitter/HN/Reddit. This is 80% of
   the launch.
2. **Maintainer embed:** a `Try it` button on the repo homepage and in
   CONTRIBUTING: `npx firstday .`. One line of copy for them to add.
3. **Education market:** bootcamps and university clubs run entire classes off
   it. Sticky, annual, and extremely loyal.
4. **Data flywheel:** completed firstdays → merged-PR outcomes → better matching
   (shared, anonymized, opt-in) → higher conversion → more embeds.

## Competitors & wedge

| Existing | Gap you exploit |
|----------|-----------------|
| Gitpod / Codespaces / devcontainers | Environment only — "now what?" |
| `good first issue` lists | Discovery only, no environment |
| CONTRIBUTING.md | Static docs; people don't read walls of text |
| AI coding agents | Start from zero context, no repo conventions, no matched issue |

**Wedge:** the end-to-end outcome. Nobody ships "green test in your editor."

## 48-hour MVP

1. Day 1 AM: toolchain detection + devcontainer/local provisioning + test-run loop.
2. Day 1 PM: static `good-first-issue` fetch + branch + PR template.
3. Day 2 AM: tour = "top 5 files by churn in the issue's area" + a hard-coded
   prompt template for the narrative.
4. Day 2 PM: record the 30s GIF against 3 famous repos. Post it. That's the test.

## Monetization (open core)

- Free: public repos, local execution, forever.
- **Maintainer tier:** embeddable button, conversion dashboard, custom onboarding
  steps, private-repo support, "office hours" mode.
- **Enterprise:** internal-repo onboarding for new hires + OSS program metrics.

## Risks

- **"It works on my machine" risk is existential.** Ship conservative detection,
  always offer the devcontainer fallback, never claim success without a green test.
- **Repo heterogeneity.** Start with 10 ecosystems you can support well.
- **Maintenance burden of matching many repos' toolchains.** Community
  "adapters" (a JSON fingerprint per ecosystem) keep it manageable.

## Build & test

Zero runtime dependencies - Node >= 20 only. No `npm install`, no lockfile.

```bash
# run from the firstday directory
node src/cli.js --help
node src/cli.js <path>          # dry-run: plan + handoff card, writes nothing
node src/cli.js <path> --apply  # writes <path>/.firstday/ (state.json, TOUR.md, plan.json)
node src/cli.js <path> --json   # machine-readable report
node src/cli.js <path> --resume # skip stages recorded ok; rerun the failed one
node src/cli.js status <path>   # read-only stage table for a previous run
node --test test/               # 138 tests
```

## v0 status

**Shipped, covered by 138 passing tests:**

- **Detect**: a toolchain matrix from pure filesystem signals - JS package
  manager (multiple lockfiles detected as ambiguous instead of guessed),
  Python env (uv/poetry/pip), test command (package.json script > Makefile >
  CI workflow), languages, monorepo, devcontainer/nix, tool versions; anything
  below `high` confidence becomes a `needsInput` question, never a guess
- **Verify**: runs the real install + test through an injected runner -
  `FIRSTDAY_VERIFY=1` in the environment, one retry for flaky detection
  (flagged loudly, never hidden), process-tree timeout kill, and an exact
  reproduce command on red. No green test, no "ready"
- **Map**: deterministic heuristics (structure, entry points, LOC +
  import-degree hotspots, test topology, import edges) with optional `ctxc`
  deep-map integration that degrades honestly (dry-run skips the build,
  failure warns and falls back, nothing is invented)
- **Match**: optional `issue-radar` integration plus a static fallback
  (good-first-issue doc mentions + TODO/FIXME clusters); "no match found" is a
  first-class, honest result
- **Tour**: BFS along import edges from the entry point toward the matched
  area (LOC-rank fallback), with citation verification - every rendered
  `path:line` is checked to exist and broken citations are dropped
- **Safety rails**: dry-run is byte-for-byte read-only (asserted by tree
  fingerprints in the suite), `--apply` writes only inside `<path>/.firstday/`
  via a path-traversal-proof confined writer, and failed stages persist so
  `--resume` can continue
- **Output**: a handoff card with real durations and honest
  UNVERIFIED/flaky states, `--json`, and exit codes
  0 ready / 1 warnings / 2 usage / 3 stage failure
- **`status <path>`**: a strictly read-only stage table over a previous run's
  `.firstday/state.json` - per-stage status, duration, and timestamp; a failed
  stage prints the exact `--resume` command; no state at all is an honest
  exit 3, never a fresh run

**Deferred (v1+, documented, not silently dropped):** the mutation half (fresh
clone/worktree, branch + scaffold + first commit), the `adapters`/`onboard`
subcommands, LLM tour narration (v0 is fully
deterministic and model-optional), and remote-repo (URL) input.
