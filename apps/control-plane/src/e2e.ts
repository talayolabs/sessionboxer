import {
  DAEMON_METHODS,
  E2E_MAX_FIX_ATTEMPTS,
  E2eCaseEndParams,
  E2eCaseStartParams,
  E2eFinishParams,
  E2ePlanParams,
  e2eTally,
  resolveSessionSettings,
  type E2eCase,
  type E2eRun,
  type E2eRunStatus,
  type Session,
  type SessionBroadcast,
  type SessionEvent,
  type SessionEventBody,
  type Settings,
} from "@sessionboxer/protocol";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";

/** Where the image installs the skill; the hidden prompt points the Agent at it. */
export const SKILL_PATH = "/home/agent/.claude/skills/e2e-verification/SKILL.md";
const PROMPT_EXCERPT_MAX = 2000;

export interface E2eDeps {
  db: Db;
  getSession: (id: string) => Session | null;
  settings: () => Settings;
  /** Sends the hidden verification prompt (`origin: "e2e"`) to the Agent. */
  prompt: (id: string, text: string) => Promise<void>;
  /** Appends a transcript event and broadcasts it. */
  appendEvent: (id: string, body: SessionEventBody) => SessionEvent;
  broadcast: (msg: SessionBroadcast) => void;
  log: (msg: string) => void;
}

/**
 * End-to-end verification of completed turns (ADR-0044). The Control Plane decides after each
 * completed user turn whether to open a run and send the hidden prompt; the Agent's `e2e_*`
 * tools (desktop MCP → Daemon → here) fill the run in; the verification turn's end closes it.
 */
export class E2eVerification {
  constructor(private readonly deps: E2eDeps) {}

  /** Runs left unfinished when the Control Plane last stopped are closed now. */
  closeStale(): void {
    for (const run of this.deps.db.listUnfinishedE2eRuns()) this.finalize(run, "aborted", "The Control Plane restarted before the verification finished.");
  }

  /** Whether the turn that starts with `first` is a verification turn (never verified itself). */
  static isVerificationTurn(turn: SessionEvent[]): boolean {
    const first = turn[0];
    return first?.body.type === "user_prompt" && first.body.origin === "e2e";
  }

  /**
   * A user turn completed (`end_turn`). Opens a run and sends the hidden prompt when the switch is
   * on and the turn did something; returns whether a verification turn was started, so the caller
   * holds the saved-messages queue until it ends.
   */
  async afterUserTurn(id: string, turnSeq: number, turn: SessionEvent[]): Promise<boolean> {
    const s = this.deps.getSession(id);
    if (!s || s.status !== "idle") return false;
    if (!resolveSessionSettings(s.settings, this.deps.settings()).e2eVerify) return false;
    const active = this.deps.db.activeE2eRun(id);
    if (active) {
      this.deps.log(`e2e ${id}: run ${active.id} still ${active.status}; not starting another`);
      return false;
    }
    const prompt = turn.find((e) => e.body.type === "user_prompt");
    if (!prompt || prompt.body.type !== "user_prompt") return false;
    if (!turn.some((e) => e.body.type === "update" && (e.body.update.sessionUpdate === "tool_call" || e.body.update.sessionUpdate === "tool_call_update"))) {
      const run = this.deps.db.insertE2eRun(id, turnSeq, "skipped", "The turn used no tools, so nothing in the workspace changed.");
      this.announce(run);
      return false;
    }
    const run = this.deps.db.insertE2eRun(id, turnSeq, "planning");
    this.deps.broadcast({ type: "e2e_changed", sessionId: id, run });
    try {
      await this.deps.prompt(id, verificationPrompt(run.id, prompt.body.text));
    } catch (e) {
      this.finalize(run, "aborted", `The verification prompt could not be sent: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return true;
  }

  /** The verification turn ended (any stop reason): whatever the Agent did not close is closed now. */
  onVerificationTurnEnded(id: string, how: "end_turn" | "cancelled" | "error" | string): void {
    const run = this.deps.db.activeE2eRun(id);
    if (!run) return;
    if (how === "end_turn") {
      if (run.status === "planning") this.finalize(run, "aborted", "The verification turn ended without planning any test case.");
      else this.finish(run, { videoPath: null, summary: null }, "The verification turn ended before e2e_finish was called.");
    } else {
      this.finalize(run, "aborted", how === "cancelled" ? "The verification turn was stopped." : `The verification turn ended with an error (${how}).`);
    }
  }

  /** The Sandbox stopped or the Session was deleted while a run was open. */
  abortActive(id: string, reason: string): void {
    const run = this.deps.db.activeE2eRun(id);
    if (run) this.finalize(run, "aborted", reason);
  }

  list(id: string): E2eRun[] {
    return this.deps.db.listE2eRuns(id);
  }

  get(id: string, runId: string): E2eRun {
    const run = this.deps.db.getE2eRun(id, runId);
    if (!run) throw new HttpError(404, `run ${runId} not found`);
    return run;
  }

  /** A request from the Daemon on behalf of the Agent's `e2e_*` tools; answers with the run. */
  async handleRequest(id: string, method: string, params: unknown): Promise<E2eRun> {
    switch (method) {
      case DAEMON_METHODS.e2ePlan:
        return this.plan(id, E2ePlanParams.parse(params ?? {}));
      case DAEMON_METHODS.e2eCaseStart:
        return this.caseStart(id, E2eCaseStartParams.parse(params));
      case DAEMON_METHODS.e2eCaseEnd:
        return this.caseEnd(id, E2eCaseEndParams.parse(params));
      case DAEMON_METHODS.e2eFinish:
        return this.finishByAgent(id, E2eFinishParams.parse(params ?? {}));
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  private active(id: string): E2eRun {
    const run = this.deps.db.activeE2eRun(id);
    if (!run) throw new Error("No verification run is open for this Session. The Control Plane starts one after a user turn; do not verify on your own.");
    return run;
  }

  private plan(id: string, p: E2ePlanParams): E2eRun {
    const run = this.active(id);
    if (run.status !== "planning") throw new Error(`The run is already ${run.status}; e2e_plan is only accepted once, before the first case starts.`);
    if (p.skipReason) {
      this.finalize(run, "skipped", p.skipReason);
      return this.get(id, run.id);
    }
    p.cases.forEach((c, i) => this.deps.db.insertE2eCase(run.id, { index: i + 1, title: c.title, steps: c.steps, expected: c.expected, cycle: 1, status: "pending" }));
    this.deps.db.updateE2eRun(run.id, { status: "running", cycles: 1 });
    return this.changed(id, run.id);
  }

  private caseStart(id: string, p: E2eCaseStartParams): E2eRun {
    const run = this.active(id);
    if (run.status === "planning") throw new Error("Call e2e_plan first.");
    const attempts = run.cases.filter((c) => c.index === p.index);
    const latest = attempts[attempts.length - 1];
    if (!latest) throw new Error(`No case ${p.index} in the plan (${new Set(run.cases.map((c) => c.index)).size} cases).`);
    const running = run.cases.find((c) => c.status === "running" && c.index !== p.index);
    if (running) throw new Error(`Case ${running.index} is still running; call e2e_case_end for it first.`);
    const now = new Date().toISOString();
    if (latest.status === "pending" || latest.status === "running") {
      this.deps.db.updateE2eCase(latest.id, { status: "running", startedAt: now });
    } else {
      const done = attempts.filter((c) => c.status !== "pending").length;
      if (done > E2E_MAX_FIX_ATTEMPTS) {
        throw new Error(`Case ${p.index} was already run ${done} times (1 + ${E2E_MAX_FIX_ATTEMPTS} fix attempts). Leave it failed and call e2e_finish.`);
      }
      const next = this.deps.db.insertE2eCase(run.id, { index: latest.index, title: latest.title, steps: latest.steps, expected: latest.expected, cycle: latest.cycle + 1, status: "running" });
      this.deps.db.updateE2eCase(next.id, { startedAt: now });
      if (next.cycle > run.cycles) this.deps.db.updateE2eRun(run.id, { cycles: next.cycle });
    }
    this.deps.db.updateE2eRun(run.id, { status: "running" });
    return this.changed(id, run.id);
  }

  private caseEnd(id: string, p: E2eCaseEndParams): E2eRun {
    const run = this.active(id);
    const attempts = run.cases.filter((c) => c.index === p.index);
    const latest = attempts[attempts.length - 1];
    if (!latest) throw new Error(`No case ${p.index} in the plan.`);
    if (latest.status !== "running" && latest.status !== "pending") throw new Error(`Case ${p.index} is not running (it is ${latest.status}); call e2e_case_start first.`);
    const now = new Date();
    const startedAt = latest.startedAt ?? now.toISOString();
    this.deps.db.updateE2eCase(latest.id, {
      status: p.status,
      startedAt,
      finishedAt: now.toISOString(),
      durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
      note: p.note,
      screenshotPath: p.screenshotPath === null ? null : workspaceRelative(p.screenshotPath),
    });
    this.deps.db.updateE2eRun(run.id, { status: p.status === "failed" ? "fixing" : "running" });
    return this.changed(id, run.id);
  }

  private finishByAgent(id: string, p: E2eFinishParams): E2eRun {
    const run = this.active(id);
    if (run.status === "planning") throw new Error("Call e2e_plan first (with cases, or with a skip_reason).");
    this.finish(run, p, "Not run: the Agent finished the verification before this case.");
    return this.get(id, run.id);
  }

  /** Closes an open run after its cases: unfinished cases are skipped with `openNote`, the verdict is the cases'. */
  private finish(run: E2eRun, p: E2eFinishParams, openNote: string): void {
    const now = new Date().toISOString();
    for (const c of run.cases) {
      if (c.status === "running" || c.status === "pending") {
        this.deps.db.updateE2eCase(c.id, { status: "skipped", finishedAt: c.status === "running" ? now : null, note: c.note ?? openNote });
      }
    }
    const fresh = this.deps.db.getE2eRun(run.sessionId, run.id) ?? run;
    const verdict: E2eRunStatus = latestAttempts(fresh.cases).some((c) => c.status === "failed") ? "failed" : "passed";
    this.deps.db.updateE2eRun(run.id, {
      status: verdict,
      finishedAt: now,
      videoPath: p.videoPath === null ? null : workspaceRelative(p.videoPath),
      summary: p.summary,
    });
    this.announce(this.get(run.sessionId, run.id));
  }

  /** Ends a run without a verdict from its cases (skipped, aborted). */
  private finalize(run: E2eRun, status: "skipped" | "aborted", reason: string): void {
    const now = new Date().toISOString();
    for (const c of run.cases) if (c.status === "running" || c.status === "pending") this.deps.db.updateE2eCase(c.id, { status: "skipped", note: c.note ?? reason });
    this.deps.db.updateE2eRun(run.id, { status, skipReason: reason, finishedAt: now });
    this.announce(this.get(run.sessionId, run.id));
  }

  /** A finished run: broadcast it and leave the transcript marker. */
  private announce(run: E2eRun): void {
    this.deps.broadcast({ type: "e2e_changed", sessionId: run.sessionId, run });
    const { passed, total } = e2eTally(run);
    this.deps.appendEvent(run.sessionId, {
      type: "e2e_run",
      run: {
        runId: run.id,
        status: run.status,
        passed,
        total,
        cycles: run.cycles,
        durationMs: Math.max(0, new Date(run.finishedAt ?? run.startedAt).getTime() - new Date(run.startedAt).getTime()),
        videoPath: run.videoPath,
        skipReason: run.skipReason,
      },
    });
    this.deps.log(`e2e ${run.sessionId}: run ${run.id} ${run.status} (${passed}/${total}, ${run.cycles} cycle(s))`);
  }

  private changed(id: string, runId: string): E2eRun {
    const run = this.get(id, runId);
    this.deps.broadcast({ type: "e2e_changed", sessionId: id, run });
    return run;
  }
}

/** The last attempt of each case. */
function latestAttempts(cases: E2eCase[]): E2eCase[] {
  const latest = new Map<number, E2eCase>();
  for (const c of cases) latest.set(c.index, c);
  return [...latest.values()];
}

/** `/workspace/recordings/x.mp4` → `recordings/x.mp4`; other paths are kept as written. */
export function workspaceRelative(p: string): string {
  const trimmed = p.trim();
  return trimmed.startsWith("/workspace/") ? trimmed.slice("/workspace/".length) : trimmed.replace(/^\.\//, "");
}

/** The hidden prompt that starts a verification turn; the skill has the long form. */
export function verificationPrompt(runId: string, userPrompt: string): string {
  const excerpt = userPrompt.length > PROMPT_EXCERPT_MAX ? `${userPrompt.slice(0, PROMPT_EXCERPT_MAX)}…` : userPrompt;
  return [
    `Sessionboxer: verify the turn you just finished end to end (verification run ${runId}). This message is from the Control Plane, not from the user; do not answer it as a question.`,
    `Follow the \`e2e-verification\` skill exactly. It is at ${SKILL_PATH}; read that file now if it is not already in your context. In short:`,
    "1. Decide: in each repository under /workspace run `git status --short` and `git diff --stat` (and `git diff --stat <base>..HEAD` if you committed) to see what the turn changed. If nothing testable changed (only an answer, research, or changes you cannot exercise on the desktop), call `e2e_plan` with a `skip_reason` and end your reply with one line saying so. No recording then.",
    "2. Plan: derive 2 to 5 test cases (up to 10 only for a very large change) from the user's request and what you understood you were asked; each with a title, steps and the expected result. Register them with one `e2e_plan` call.",
    "3. Run: `start_recording`, then for each case in order: `e2e_case_start`, do the steps with the desktop tools (screenshot, clicks, typing, the browser, a terminal), check the expected result on a screenshot, then `e2e_case_end` with passed/failed, a one-line note and the screenshot path.",
    `4. Fix: when a case fails, fix the code (that is normal work), then \`e2e_case_start\` the same case again and rerun it; that is a new cycle. At most ${E2E_MAX_FIX_ATTEMPTS} fix attempts per case, then leave it failed.`,
    "5. Finish: `stop_recording`, then `e2e_finish` with the video path and a short summary, and end your reply with one short paragraph (what passed, what failed and why) that mentions the video's /workspace path so the user sees it in the chat.",
    "Do not start another verification, do not ask the user anything, and do not do unrelated work in this turn.",
    "",
    "The user's request for the turn being verified was:",
    "",
    ...excerpt.split("\n").map((l) => `> ${l}`),
  ].join("\n");
}
