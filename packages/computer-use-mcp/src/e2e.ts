/**
 * The `e2e_*` tools' transport: `POST /e2e` on the Sandbox Daemon, which forwards to the Control
 * Plane over its own connection and answers with the verification run (ADR-0044). Mirrors
 * `E2E_PATH` / `E2eBridgeRequest` / `DAEMON_PORT` in `@sessionboxer/protocol`, which this
 * package does not depend on.
 */

export type E2eMethod = "plan" | "case_start" | "case_end" | "finish";

const DAEMON_PORT = 7000;
const E2E_PATH = "/e2e";

export interface E2eCaseView {
  index: number;
  title: string;
  status: string;
  cycle: number;
  durationMs: number | null;
  note: string | null;
}

export interface E2eRunView {
  id: string;
  status: string;
  cycles: number;
  skipReason: string | null;
  videoPath: string | null;
  cases: E2eCaseView[];
}

export class E2eError extends Error {}

export async function e2eCall(method: E2eMethod, params: unknown): Promise<E2eRunView> {
  const port = Number(process.env.SESSIONBOXER_DAEMON_PORT ?? DAEMON_PORT);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${E2E_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
  } catch (e) {
    throw new E2eError(`The Sandbox Daemon is not reachable (${e instanceof Error ? e.message : String(e)}).`);
  }
  const text = await res.text();
  if (!res.ok) throw new E2eError(text || `${res.status} ${res.statusText}`);
  return summarize(JSON.parse(text) as RunJson);
}

interface RunJson {
  id: string;
  status: string;
  cycles: number;
  skipReason: string | null;
  videoPath: string | null;
  cases: Array<{ index: number; title: string; status: string; cycle: number; durationMs: number | null; note: string | null }>;
}

/** The run as the Agent needs to see it: one line per case attempt, no ids or timestamps. */
function summarize(run: RunJson): E2eRunView {
  return {
    id: run.id,
    status: run.status,
    cycles: run.cycles,
    skipReason: run.skipReason,
    videoPath: run.videoPath,
    cases: run.cases.map((c) => ({ index: c.index, title: c.title, status: c.status, cycle: c.cycle, durationMs: c.durationMs, note: c.note })),
  };
}
