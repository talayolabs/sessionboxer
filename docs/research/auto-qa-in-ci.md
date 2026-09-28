# Research: running Auto QA (agent-driven end-to-end tests with a recorded video) in CI

Question (2026-09-28): the owner wants the Auto QA feature — an agent plans 2–5 cases, drives the app in a Linux
desktop, and a captioned `.mp4` comes out — to run **in hosted CI** on his repos' pull requests, one video per PR.
Use Sessionboxer for it, or a plain GitHub Action with a Claude/Devin token?

Short answer: **use Sessionboxer, in two shapes.** (A) A reusable Action that runs the Control Plane and one Sandbox
on the GitHub runner itself works today with the existing REST API — measured on a real `ubuntu-latest` job: the
Sandbox image pulls in **62–86 s** (4.31 GB on disk), `npx sessionboxer serve` is up in **23–54 s**, a Session
boots to an idle Agent in **4–6 s**, and the whole job minus the agent's own work is about **2½ minutes**. The
Sandbox's default 2 vCPU / 4 GiB fits the 2-vCPU / 8 GB private-repo runner. What is missing is small and
headless-only: a `sessionboxer qa` command / `POST …/e2e/run` that takes a **brief**, `--wait`, a JSON result and an
exit code — about one session of work, no image rebuild. (C) The same Action pointed at the owner's always-on
Sessionboxer (`SESSIONBOXER_URL` + token) skips the pull entirely and leaves a Session a human can open afterwards;
that is the better steady state and it is the same code path. (B) A Sessionboxer-free Action is possible — the
`desktop` MCP runs fine outside the box and recorded a captioned video on the runner in the spike — but it rebuilds
a worse Sandbox in YAML and loses the Session, the pane and the multi-provider credential handling. The one
question that is not engineering: **Claude subscription OAuth tokens are the wrong credential for CI**; use an
Anthropic API key (§6).

Spike: https://github.com/talayolabs/sessionboxer-qa-spike (private) —
run https://github.com/talayolabs/sessionboxer-qa-spike/actions/runs/36432071206 and two earlier runs (§8). The
Sessionboxer job booted a real Sandbox on the runner; the "agent drives the app" loop was proved with the desktop
MCP and a **scripted stand-in** for the model, because no agent credential was available to the spike (see §8).

## 1. What exists today (and what the CI path needs from it)

- **The trigger is a turn.** `apps/control-plane/src/sessions.ts` calls `e2e.afterTurn` after a user turn; the "Run
  now" button calls `e2eRunNow(id)`, which re-derives *the last user turn of the current branch* and passes it as the
  thing to verify. There is no way to say "verify this brief" over HTTP without first having a conversation. The hidden
  prompt itself (`apps/control-plane/src/e2e.ts`) and the skill it points at
  (`images/sandbox/skills/e2e-verification/SKILL.md`: plan cases → `start_recording` → per case `e2e_case_start` /
  drive / screenshot / `e2e_case_end` → `stop_recording` → `e2e_finish`) are exactly what CI needs, unchanged.
- **The agent can open a run itself** with the `sessionboxer` MCP's `verify({ brief, cases? })` tool
  (`packages/sessionboxer-mcp/src/index.ts`, `docs/MCP.md`). So today a CI script can `POST /api/sessions/:id/prompt`
  with "call `verify` with this brief and follow the skill" and then poll `GET /api/sessions/:id/e2e` — this is what
  the spike's `scripts/qa.sh` does. It works, but it is a prompt, not a contract: the model may chat instead of
  calling `verify`, and the result has to be fished out of the events.
- **Results are already structured.** Runs and cases live in SQLite and come back from `GET /api/sessions/:id/e2e`
  (`status`, `cases[]` with `status`/`screenshot`, `videoPath`); the video, `.vtt` and screenshots are workspace files,
  downloadable with `GET /api/sessions/:id/fs/raw?path=recordings/….mp4` (`packages/sandbox-daemon/src/raw-files.ts`).
- **Credentials without the UI already work.** `apps/control-plane/src/config.ts`: `claudeToken()` reads
  `CLAUDE_CODE_OAUTH_TOKEN` from the Control Plane's environment before Settings, `claudeApi` accepts
  `ANTHROPIC_API_KEY`, Devin reads `WINDSURF_API_KEY`, and `providerEnv()` forwards them into the Sandbox for the
  agent CLI. The spike confirmed the path end to end: with a placeholder token the Claude CLI inside the box answered
  `401 Invalid bearer token` within the first turn (run 36431029242). Codex and Cursor need a login file /
  `CURSOR_API_KEY` (ADR-0046, ADR-0054) — see §6.
- **Workspace at the PR head.** `POST /api/sessions` accepts repos of type `git` (clone a URL at a ref) or `copy`
  (copy a host directory). On the runner, `copy` of `$GITHUB_WORKSPACE` after `actions/checkout` is the simplest and
  needs no token inside the box; `git` with the PR head SHA is the choice for Option C where the box is elsewhere.
- **Docker.** The Control Plane needs a Docker engine; GitHub's Ubuntu runners ship one (Docker 28.0.4 measured) and
  the Sandbox runs as an ordinary `runc` container. Sysbox (ADR-0008) is only for Docker *inside* the box; `/dev/kvm`
  only for Windows/macOS Sessions (`docs/GUIDE.md`). Neither matters for Linux QA — `/dev/kvm` happens to exist on the
  runner, `sysbox-runc` does not, and the Sandbox booted fine.

## 2. Measured on a real `ubuntu-latest` runner

Three runs of the same workflow, private repo. Runner facts from the job log: `nproc` **2**, `free -g` **7 GiB**
(GitHub documents "2 CPU / 8 GB / 14 GB SSD" for private repos; the **4 CPU / 16 GB** figure is for *public*
repos — https://docs.github.com/en/actions/reference/runners/github-hosted-runners), 72 GiB root filesystem with
~14 GiB free before the pull (the 4.3 GB image fits), Docker 28.0.4 client/server, kernel `6.17.0-1022-azure`,
Node 22, Chrome 153 preinstalled, `/dev/kvm` present, no Sysbox.

| Step | Run 1 | Run 2 | Run 3 | Notes |
| --- | --- | --- | --- | --- |
| `docker pull ghcr.io/talayolabs/sessionboxer-sandbox:1.4.1` | 61.9 s | 63.4 s | 85.8 s | **4.31 GB on disk** (compressed manifest, amd64 layers: 1.72 GB; local pull on a fast box: 32.6 s). Dominant fixed cost. |
| `npx -y sessionboxer@1.4.1 serve` → `/api/health` 200 | 35.4 s | 23.3 s | 53.5 s | npm download + start; a prebuilt Action or `ghcr.io/talayolabs/sessionboxer` container would cut this. |
| `POST /api/sessions` (copy of the checkout) → Sandbox booted, Agent idle | 4.3 s | 4.1 s | 6.1 s | Xvfb + XFCE + daemon + ACP agent start. Fast because the image is already local. |
| Prompt accepted (Agent ready) after session create | 4.4 s | – | – | Measured once; `idle` can arrive slightly before the Agent accepts a prompt (the driver retries `POST …/prompt` until 202). |
| Sandbox at idle (`docker stats`) | – | 344 MiB / 4 GiB, 75% of one CPU at the sample | – | Host: 1.4 GB of 7.9 GB used. Room for one Sandbox at the default 2 vCPU / 4 GiB; not for two. |
| Whole `sessionboxer-in-ci` job (no model work) | 3:00 | 1:40 | 2:42 | checkout + pull + serve + session + artifacts. |
| Option B: `apt-get install xvfb xdotool ffmpeg imagemagick x11-utils` | 107 s | 46 s | 27 s | Runner apt mirrors vary a lot. |
| Option B: `npm ci` + `tsc -b packages/computer-use-mcp` | 41 s | 44 s | 33 s | |
| Option B: Xvfb + Chrome + 3 scripted cases + recording | – | 10.9 s | 8.9 s | 7.8 s video, 1024×894 h264 (768 px desktop + caption band), MP4 26 KB, VTT 245 B, GIF 56 KB. |
| Whole `standalone-desktop` job | 3:00 | 2:14 | 1:34 | |

Not measured: the agent's own work (minutes and tokens per run), because no credential was available (§8). Expect
the model loop to dominate wall time: a 3-case run in the desktop is typically 3–8 minutes of tool calls in the
Sandbox; the fixed CI overhead above is ~2½ minutes on top.

Other CI hosts, briefly: GitLab.com hosted Linux runners run `privileged` with Docker available
(`saas-linux-small-amd64` 2 vCPU / 8 GB, `medium` 4 / 16 — https://docs.gitlab.com/ci/runners/hosted_runners/linux/),
so the same script works there. Buildkite hosted Linux agents are isolated VMs; the `LINUX_AMD64_2X4` small shape has
only 4 GB, which is exactly the Sandbox's default, so use `4X16`
(https://buildkite.com/docs/agent/buildkite-hosted/linux).

## 3. Option A — Sessionboxer on the CI runner

**Shape.** One job: checkout → `docker pull` the Sandbox → start the Control Plane against the runner's Docker
(`npx sessionboxer serve`, or the `ghcr.io/talayolabs/sessionboxer` image with `/var/run/docker.sock` mounted) →
create a Session whose workspace is a `copy` of the checkout → run Auto QA with a brief → wait → download
`cases`, `.mp4`, `.vtt`, screenshots → `actions/upload-artifact` → job summary / PR comment / check run → stop the
Session. The spike's `scripts/qa.sh` (≈150 lines of bash + curl + jq) does all of this against 1.4.1 and is the
model for the real command.

**What is missing for headless use** (all Control Plane / CLI, none of it in the image):

1. **A brief-driven run.** `POST /api/sessions/:id/e2e/run` today takes no body and verifies the last user turn.
   Add an optional body `{ brief: string, cases?: [{title, steps, expected}] }`: `E2e.runNow` already builds a hidden
   prompt from a "turn" — build it from the brief instead (the `verify` tool in `openByAgent` already does exactly
   this for the agent-initiated case, so it is mostly plumbing). A Session with zero turns must be allowed to run.
2. **`--wait` and a result.** `GET /api/sessions/:id/e2e/:runId` exists; add `?wait=<seconds>` long-poll (or the CLI
   polls). Define the finished states and a stable JSON result: `{ status: passed|failed|aborted, cases: [{title,
   status, screenshot}], video: "recordings/….mp4", vtt, startedAt, finishedAt, usage }`.
3. **`sessionboxer qa`** in `apps/cli`: `--url` (default: start a local Control Plane like `serve` does, stop it at
   the end), `--repo <path|git URL> [--ref]`, `--brief <text|@file>`, `--provider`, `--timeout`, `--out <dir>` (writes
   `result.json`, video, vtt, screenshots, `summary.md`), `--json`, `--keep` (do not delete the Session — for Option
   C). Exit code **0** passed, **1** a case failed, **2** no result (agent never opened a run / timeout / error). The
   spike script used the same mapping.
4. **Credentials.** Nothing new: the Action sets `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `WINDSURF_API_KEY`
   on the `serve` process from GitHub secrets and `providerEnv` forwards them. Document it.
5. **The Action** `talayolabs/sessionboxer-qa@v1`, a composite action in its own repo wrapping 1–4 plus upload,
   summary, and the optional PR comment.

**Draft `action.yml`** (composite; secrets come in as `env` so they never appear in `with:`):

```yaml
name: Sessionboxer Auto QA
description: Run Sessionboxer's Auto QA (agent-driven desktop tests, recorded video) on this checkout
inputs:
  brief:           { description: "What to verify (text or @path); default: the PR body", required: false }
  provider:        { description: "claude-code | codex | cursor | devin", default: claude-code }
  url:             { description: "Existing Control Plane (Option C); empty = start one on the runner", default: "" }
  version:         { description: "sessionboxer npm/image version", default: "1.4.1" }
  workspace:       { description: "Directory to test", default: "${{ github.workspace }}" }
  timeout-minutes: { description: "Give up after", default: "25" }
  artifact-name:   { description: "Artifact with mp4/vtt/screenshots/result.json", default: auto-qa }
  comment:         { description: "Post/refresh a sticky PR comment", default: "true" }
outputs:
  status:
    value: ${{ steps.qa.outputs.status }}
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: 22
    - if: inputs.url == ''
      shell: bash
      run: docker pull ghcr.io/talayolabs/sessionboxer-sandbox:${{ inputs.version }}
    - id: qa
      shell: bash
      env:
        SESSIONBOXER_URL: ${{ inputs.url }}   # SESSIONBOXER_TOKEN and the provider keys come from the caller's env
      run: |
        npx -y sessionboxer@${{ inputs.version }} qa \
          --repo "${{ inputs.workspace }}" --provider "${{ inputs.provider }}" \
          --brief "${{ inputs.brief || format('@{0}/pr-body.md', runner.temp) }}" \
          --timeout "${{ inputs.timeout-minutes }}m" --out "${{ runner.temp }}/qa" --json
        echo "status=$(jq -r .status "${{ runner.temp }}/qa/result.json")" >> "$GITHUB_OUTPUT"
    - if: always()
      uses: actions/upload-artifact@v4
      with:
        name: ${{ inputs.artifact-name }}
        path: ${{ runner.temp }}/qa
        retention-days: 14
    - if: always()
      shell: bash
      run: cat "${{ runner.temp }}/qa/summary.md" >> "$GITHUB_STEP_SUMMARY"
    - if: always() && inputs.comment == 'true' && github.event_name == 'pull_request'
      uses: actions/github-script@v7   # sticky comment: case table + artifact link (§7)
      with:
        script: require('${{ github.action_path }}/comment.js')({ github, context }, '${{ runner.temp }}/qa')
```

**Sample workflow** in a repo:

```yaml
name: Auto QA
on:
  pull_request:
    types: [opened, synchronize, labeled]
jobs:
  qa:
    if: contains(github.event.pull_request.labels.*.name, 'qa')   # opt in per PR; every run costs tokens
    runs-on: ubuntu-latest
    timeout-minutes: 40
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build && (npm run start & npx wait-on http://localhost:3000)   # the app under test
      - uses: talayolabs/sessionboxer-qa@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          brief: ${{ github.event.pull_request.body }}
```

Where does the app run? Either the Sandbox builds and starts it from the copied workspace (the brief says
"`npm start`, then open http://localhost:3000") — that is what Auto QA does locally and it needs nothing from the
runner — or the job starts it on the runner and the Sandbox reaches it through the Docker host address. The first is
simpler and is what the Action should default to; the second is for apps with heavy setup already scripted in CI.

**Cost per PR in runner minutes:** ~2.5 min fixed + the agent's run; on the private-repo Linux rate that is small
next to the model tokens. **Cache the pull?** `actions/cache` caps at 10 GB per repo and restoring a 4 GB layer
tarball is not faster than the 60–85 s pull from GHCR; a slimmer CI image is the lever (§9, stage 3).

## 4. Option B — a plain GitHub Action, no Sessionboxer

**What the spike proved.** `packages/computer-use-mcp` is a plain stdio MCP server that needs only `DISPLAY`,
`xdotool`, `ffmpeg`, ImageMagick and a workspace dir; on the runner it listed its tools, `start_recording`, three
`annotate_recording`s, clicks/keys/screenshots and `stop_recording` produced the same captioned `.mp4` + `.vtt` the
Sandbox produces (`runs/36432071206`, artifact `auto-qa-standalone`). One thing to know: without a window manager
X keyboard focus is fragile — the first two runs typed into nothing because a click on the page body cleared the
input's autofocus; a WM (`openbox`/`xfwm4`) or Tab-based focusing fixes it. The Sandbox has XFCE and does not
have this problem.

**Which agent drives it.**

- **Claude Code directly** (`claude -p "<brief + skill text>" --mcp-config desktop.json --output-format json`,
  https://code.claude.com/docs/en/headless) or **`anthropics/claude-code-action@v1`**, which runs Claude Code on
  your runner, takes a `prompt`, and passes extra CLI flags through `claude_args`, including `--mcp-config`
  (https://github.com/anthropics/claude-code-action, `docs/configuration.md`, `docs/usage.md`). It has **no desktop
  and no recorder** of its own; the job must start Xvfb + a WM + the app before the step and hand the desktop MCP
  in. That is a viable Option B in ~60 lines of YAML — not spiked with a live model here for lack of a credential.
- **Devin's API** (https://docs.devin.ai/api-reference/overview): `POST` a session with a prompt, poll it, read
  attachments (https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-attachments). Devin tests
  in **its own machine** and records annotated videos
  (https://docs.devin.ai/work-with-devin/testing-and-recordings, https://docs.devin.ai/work-with-devin/computer-use),
  so the runner does no desktop work at all — this is really Option C with Devin's cloud instead of the owner's
  Sessionboxer, priced in ACUs. The Devin CLI as a *provider inside Sessionboxer* (`WINDSURF_API_KEY`) is the
  Option A/C route.
- **Playwright-only tools** (Playwright MCP https://github.com/microsoft/playwright-mcp, or any "AI test" product
  on top of it, plus `video: 'on'` — https://playwright.dev/docs/videos) record the **browser context**, not a
  desktop: no OS dialogs, no second app, no captions band, and the model gets an accessibility tree instead of
  screenshots. Good for web-only flows, cheaper in tokens; not the feature the owner asked for.

**Lost vs. Sessionboxer:** the Session (nothing to open afterwards and continue by hand), Snapshots/fork, the Auto QA
pane and its case/video rendering, the shipped skill and MCP wiring, four providers behind one credential switch,
Windows/macOS boxes, and the isolation — the agent runs as `runner` with the repo's secrets in the environment.
**Gained:** no Docker pull (−60–85 s), no Control Plane start (−25–55 s), one YAML file, the model's tokens are the only
external dependency. Net: Option B is what you build if Sessionboxer did not exist; since it does, and its own
overhead is ~2 minutes, it is not worth a second implementation of the desktop loop.

## 5. Option C — the owner's always-on Sessionboxer as the CI target

CI does `curl -H "Authorization: Bearer $SESSIONBOXER_TOKEN" https://<tunnel>/api/sessions` with a `git` repo at the
PR head SHA, then the same `e2e/run` + wait + `fs/raw` calls as Option A — i.e. `sessionboxer qa --url … --keep`.
Nothing to pull (images are warm), Windows/macOS Sessions possible, and the Session **stays**: the PR comment can
link to it and a human opens the Auto QA pane, watches the video in the UI, forks the Session and keeps
investigating. Costs: the home server does the work (one PR at a time per 2 vCPU / 4 GiB box), the tunnel must be
reachable from GitHub (a token-scoped URL, `docs/GUIDE.md` remote access), and GitHub cannot reach a private repo
from inside the box unless the Session gets a read token — pass `GITHUB_TOKEN` as a repo credential or have CI push
the checkout in with `copy` over the API. This overlaps with the "Automations" research (PR events → Auto QA
Session): Automations is the *push* design (Sessionboxer subscribes to GitHub and decides), this is the *pull*
design (CI decides and calls in). They share the `qa` endpoint and result contract from §3; build that once. The
Action's `url` input is the whole difference between A and C, so ship both in one Action.

## 6. Credentials and terms

- **Claude subscription OAuth token in a GitHub secret.** `claude setup-token` exists for exactly "CI and scripts": it
  mints a one-year token for `CLAUDE_CODE_OAUTH_TOKEN`
  (https://code.claude.com/docs/en/authentication). But Anthropic's terms and docs now draw a line between *you*
  running Claude Code (including headless, in your CI) and a **third-party product routing a subscription
  credential**: the consumer terms forbid automated access other than through an API key "or where explicitly
  permitted" (https://www.anthropic.com/legal/consumer-terms), the Agent SDK docs say third-party developers must
  not offer claude.ai login/rate limits in their own products without approval
  (https://code.claude.com/docs/en/agent-sdk/quickstart.md), and `legal-and-compliance` restates the distinction
  (https://code.claude.com/docs/en/legal-and-compliance; the public discussion:
  https://github.com/anthropics/claude-code/issues/27125). Sessionboxer is a third-party wrapper around the Claude
  Code CLI over ACP, so **a `sessionboxer-qa` Action running on a subscription token is the case Anthropic objects
  to**, even if it technically works. Recommendation: the Action documents `ANTHROPIC_API_KEY` (the Control Plane
  already accepts it) as the supported credential; a personal `setup-token` in the owner's own repos is his call,
  not the product's default.
- **Anthropic API key**: intended for automation, metered per token
  (https://code.claude.com/docs/en/iam). Cost per QA run was **not measured** (no key). Rule of thumb from Anthropic's
  image tokenisation (one visual token per 28×28 patch, https://platform.claude.com/docs/en/build-with-claude/vision):
  a 1024×768 screenshot is ⌈1024/28⌉×⌈768/28⌉ = 1,036 tokens; a 3-case run takes 15–30 screenshots plus the
  skill/prompt text, re-sent each turn, so budget on the order of a few hundred thousand input tokens per run — and
  measure it: the Session's `usage` (`GET /api/sessions/:id`) gives it per run.
- **Devin**: API keys are org-scoped Bearer tokens (https://docs.devin.ai/api-reference/overview); billing is in ACUs,
  by session time, not tokens — check the current rate on Devin's pricing/billing pages before quoting a number;
  older per-ACU prices circulating on the web are not authoritative.
- **Codex**: `codex exec` is non-interactive and takes `OPENAI_API_KEY` or an access token
  (https://developers.openai.com/codex/auth, https://developers.openai.com/codex/cli/reference); the ChatGPT-login
  `auth.json` rotates (ADR-0046) and is a poor CI secret. API key: viable.
- **Cursor**: `agent -p` headless with a service-account/`CURSOR_API_KEY`
  (https://cursor.com/docs/cli/headless, https://cursor.com/docs/cli/reference/authentication,
  https://cursor.com/docs/account/enterprise/service-accounts); Cursor even documents GitHub Actions use
  (https://cursor.com/docs/cli/github-actions). Viable; the Control Plane's `CURSOR_API_KEY` path (ADR-0054) applies.

## 7. Publishing the video

| Where | Verdict |
| --- | --- |
| **Actions artifact** (`upload-artifact@v4`, `retention-days` per artifact within the repo/org limit — https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow; the spike used 14) | Always works, keeps the original `.mp4` + `.vtt` + screenshots; only visible on the run page behind a login, as a zip. Baseline. |
| **Job summary** (`$GITHUB_STEP_SUMMARY`, Markdown) | Case table renders well; images only by URL, no local files, no video. |
| **PR comment via API** (`POST /repos/…/issues/{n}/comments`, https://docs.github.com/en/rest/issues/comments) | Markdown only; the web UI's drag-and-drop video upload has no API. A sticky comment (edit the same one per PR) with the case table, the artifact link and one screenshot URL is the useful part. |
| **GIF from the `.mp4`** (`ffmpeg -vf "fps=6,scale=640:-1"`; 56 KB for the 8 s spike video) | Nice in a comment — *if* it has a URL: GitHub Markdown does not render `data:` images, so the GIF must live somewhere: an orphan `qa-media` branch in the same repo (works for public repos via `raw.githubusercontent.com`; private repos need a login and the URL may not render in the PR view), a release asset (same visibility rule), Pages (public only), or a bucket (signed URLs expire). |
| **Check run** with the case list | Good for status/required checks; text only. Add later. |
| **Option C's own UI** | The comment links to the Session's Auto QA pane where the video streams with captions. Best viewing experience, needs the tunnel. |

Default: **artifact + job summary + sticky PR comment** (case table with ✓/✗, artifact link, and in Option C the
Session link). Add the GIF to the comment only where the repo is public (orphan-branch upload) — it is a
three-line addition once the rest exists. Do not spend time on release assets or Pages.

## 8. The spike

Repo https://github.com/talayolabs/sessionboxer-qa-spike (private; `app/index.html` is a 60-line todo list,
`scripts/qa.sh` the REST driver, `scripts/standalone-desktop.mjs` the Option B driver, `scripts/cases-to-summary.mjs`
the summary writer, `.github/workflows/auto-qa.yml` two jobs). Runs:
https://github.com/talayolabs/sessionboxer-qa-spike/actions/runs/36431029242 (run 1, prompt sent with a
placeholder token → `401`), …/runs/36431603750 (run 2), …/runs/36432071206 (run 3, clean).

- `sessionboxer-in-ci`: pulled the Sandbox, started the Control Plane with `npx sessionboxer@1.4.1 serve`, created a
  Session from a `copy` of the checkout, waited for `idle`, (run 1) sent the QA prompt and saw the agent turn start
  and fail on auth, dumped `docker stats`, uploaded `control-plane.log`, `events.json`, `timing.json`, `usage.json`.
  All numbers in §2.
- `standalone-desktop`: `apt` desktop tools, built `packages/computer-use-mcp` from the Sessionboxer checkout, Xvfb
  `:99` 1024×768, Chrome `--app=http://localhost:8080`, drove the desktop MCP over stdio: recording on, three
  annotated cases (add a todo → 1 open; tick it → 0 open 1 done; delete → empty), screenshot per case, recording
  off; wrote `cases.json`, the job summary table, a GIF; uploaded `standalone.mp4` (captions burned in a band
  under the desktop), `standalone.vtt`, four PNGs.

What it did **not** prove: a live model planning and executing the cases. The job that would have done it (run 1)
reached the Claude CLI inside the Sandbox and stopped at `401 Invalid bearer token`. To close that gap, add
`ANTHROPIC_API_KEY` to the spike repo's Actions secrets and re-run the workflow with the default brief; the driver
then goes through `verify` → `e2e_*` → video and exits 0/1/2.

## 9. Recommendation and plan

**Recommendation:** Sessionboxer, as one reusable Action with two modes — on-runner (A) for any repo, remote (C)
against the owner's box for his own repos once the tunnel is set up. Claude Code on an **Anthropic API key** as the
default provider. Opt in per PR with a label, one run per push, artifact + summary + sticky comment.

| Stage | What | Files | Effort |
| --- | --- | --- | --- |
| 1. Headless Auto QA | `POST /api/sessions/:id/e2e/run` with `{brief, cases?}`; `GET …/e2e/:runId?wait=`; result contract in `packages/protocol`; `sessionboxer qa` (create/copy/git, brief, wait, download, `result.json`, `summary.md`, exit code, `--url`, `--keep`); docs | `packages/protocol/src/index.ts`, `apps/control-plane/src/e2e.ts`, `apps/control-plane/src/sessions.ts`, `apps/control-plane/src/index.ts`, `apps/cli/src/index.ts`, `apps/cli/src/service.ts`, `docs/GUIDE.md`, `docs/MCP.md` | 1 session |
| 2. The Action | New repo `talayolabs/sessionboxer-qa`: `action.yml` (§3), `comment.js` (sticky comment, GIF when public), examples, `v1` tag; the spike repo becomes its integration test | new repo | ½–1 session |
| 3. Faster start (optional) | A `sessionboxer-sandbox-ci` image variant without VS Code / Windows tooling / unused agent CLIs to cut the 4.3 GB pull; publish the Control Plane as a prebuilt tarball or use the container image instead of `npx` | `images/sandbox/Dockerfile` (+ CI matrix), release workflow | ½ session |
| 4. Remote mode polish | `--keep` Session linking in the comment, a read-only share link to the Auto QA pane for the PR, GitHub token for private clones inside the box | Action + `apps/web`/Control Plane share route | ½ session (shared with Automations) |

Image rebuild: **no** for stages 1–2 (the skill and MCP in the image are used as they are; the hidden prompt lives in
the Control Plane). **Yes** only for stage 3, and only to make a smaller variant.

**For other people's repos** the Action is the whole story: `uses: talayolabs/sessionboxer-qa@v1` with one secret
(`ANTHROPIC_API_KEY`, or `WINDSURF_API_KEY` with `provider: devin`) and a brief. They need nothing installed and
nothing self-hosted; the runner pulls the Sandbox. If they run their own Sessionboxer, they set `url` and
`SESSIONBOXER_TOKEN` and get the persistent Session instead.

## 10. Open questions (recommended default in bold)

1. Credential for Claude in the Action: **`ANTHROPIC_API_KEY` only in the docs and examples**; `CLAUDE_CODE_OAUTH_TOKEN`
   keeps working technically because the Control Plane accepts it, but the Action does not advertise it.
2. Where the brief comes from when the input is empty: **a `## QA` section of the PR body if present, else the whole
   body, else the PR title + changed-file list** with a "plan 2–5 cases yourself" line; the workflow input overrides.
3. When to run: **on a `qa` label (and every push while labelled)**, not on every PR — each run is minutes of model
   time and tokens.
4. Where the app under test runs: **inside the Sandbox, from the brief** (what Auto QA does today); the runner-side
   app with the Docker host address as an alternative documented for heavy setups.
5. Result when the agent never opens a run (chats, refuses, times out): **exit 2 and a failed check with the last
   agent message in the comment**, so it is visible but distinguishable from "a case failed".
