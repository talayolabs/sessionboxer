// ---------------------------------------------------------------------------
// End-to-end verification (ADR-0044). After a completed turn, when `e2eVerify` is on, the
// Control Plane opens an `E2eRun` for it and sends the Agent a hidden prompt to follow the
// `e2e-verification` skill: decide whether the work is testable, plan 2–5 cases, record the
// desktop while running them, fix and rerun what fails (a new cycle), hand over the video.
// The Agent writes the records through the `e2e_*` tools of the desktop MCP, which the Daemon
// forwards to the Control Plane over its own connection (the Sandbox has no route to the API).
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Test cases per run the planner may register; more than 5 should be rare. */
export const E2E_MAX_CASES = 10;
/** Fix-and-rerun attempts per case before the run gives up on it (cycles 2..1+n). */
export const E2E_MAX_FIX_ATTEMPTS = 3;

export const E2eRunStatus = z.enum(["planning", "running", "fixing", "passed", "failed", "skipped", "aborted"]);
export type E2eRunStatus = z.infer<typeof E2eRunStatus>;

export const E2eCaseStatus = z.enum(["pending", "running", "passed", "failed", "skipped"]);
export type E2eCaseStatus = z.infer<typeof E2eCaseStatus>;

/** One attempt of one test case: the same `index` appears once per cycle it was run in. */
export const E2eCase = z.object({
  id: z.string(),
  runId: z.string(),
  /** Position in the plan (1-based); stable across cycles. */
  index: z.number().int().positive(),
  title: z.string(),
  /** What the Agent does, as it planned it (free text, usually numbered steps). */
  steps: z.string(),
  expected: z.string(),
  status: E2eCaseStatus,
  /** 1 for the first run of the plan; +1 for each fix-and-rerun. */
  cycle: z.number().int().positive(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Why it passed/failed/was skipped, in the Agent's words. */
  note: z.string().nullable(),
  /** Workspace-relative path of a screenshot taken at the end of the case. */
  screenshotPath: z.string().nullable(),
});
export type E2eCase = z.infer<typeof E2eCase>;

export const E2eRun = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** `seq` of the `turn_ended` event of the turn being verified. */
  turnSeq: z.number().int(),
  status: E2eRunStatus,
  /** Set with `status: "skipped"` (nothing testable changed) and `"aborted"` (the verification turn ended without finishing). */
  skipReason: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Workspace-relative path of the recording, once `e2e_finish` handed it over. */
  videoPath: z.string().nullable(),
  /** Highest cycle any case reached (1 = no fix was needed). */
  cycles: z.number().int().nonnegative(),
  /** The Agent's closing words (`e2e_finish`). */
  summary: z.string().nullable(),
  /** What the run verifies, when the Agent started it itself (`verify` tool); `null` for the Control Plane's after-turn runs. */
  brief: z.string().nullable().default(null),
  /** Every attempt of every case, by index then cycle. */
  cases: z.array(E2eCase),
});
export type E2eRun = z.infer<typeof E2eRun>;

/** What the transcript marker of a finished run shows. */
export const E2eRunSummary = z.object({
  runId: z.string(),
  status: E2eRunStatus,
  /** Cases whose last attempt passed / cases planned. */
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  cycles: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  videoPath: z.string().nullable(),
  skipReason: z.string().nullable(),
});
export type E2eRunSummary = z.infer<typeof E2eRunSummary>;

/** Cases whose latest attempt passed, over the cases planned. */
export function e2eTally(run: E2eRun): { passed: number; total: number } {
  const latest = new Map<number, E2eCase>();
  for (const c of run.cases) latest.set(c.index, c);
  let passed = 0;
  for (const c of latest.values()) if (c.status === "passed") passed++;
  return { passed, total: latest.size };
}

/** `e2e_plan`: the cases for the run, or why it is skipped (then no cases and no recording). */
export const E2ePlanParams = z
  .object({
    cases: z
      .array(z.object({ title: z.string().min(1).max(200), steps: z.string().max(4000), expected: z.string().max(2000) }))
      .max(E2E_MAX_CASES)
      .default([]),
    skipReason: z.string().max(1000).nullable().default(null),
  })
  .refine((p) => (p.skipReason ? p.cases.length === 0 : p.cases.length > 0), "either cases or a skipReason");
export type E2ePlanParams = z.infer<typeof E2ePlanParams>;

/** `e2e_case_start`: the case begins (again, as a new cycle, when its last attempt failed). */
export const E2eCaseStartParams = z.object({ index: z.number().int().positive() });
export type E2eCaseStartParams = z.infer<typeof E2eCaseStartParams>;

export const E2eCaseEndParams = z.object({
  index: z.number().int().positive(),
  status: z.enum(["passed", "failed", "skipped"]),
  note: z.string().max(2000).nullable().default(null),
  /** `/workspace/...` or Workspace-relative. */
  screenshotPath: z.string().max(1000).nullable().default(null),
});
export type E2eCaseEndParams = z.infer<typeof E2eCaseEndParams>;

export const E2eFinishParams = z.object({
  /** `/workspace/...` or Workspace-relative; `null` when there is no recording. */
  videoPath: z.string().max(1000).nullable().default(null),
  summary: z.string().max(4000).nullable().default(null),
});
export type E2eFinishParams = z.infer<typeof E2eFinishParams>;

/** Daemon `POST /e2e` body (older desktop MCPs): one of the `DAEMON_METHODS.e2e*` methods and its params. */
export const E2E_PATH = "/e2e";
export const E2eBridgeRequest = z.object({
  method: z.enum(["plan", "case_start", "case_end", "finish"]),
  params: z.unknown(),
});
export type E2eBridgeRequest = z.infer<typeof E2eBridgeRequest>;
