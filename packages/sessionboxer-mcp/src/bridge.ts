/**
 * The tools' transport: `POST /sessionboxer` on the Sandbox Daemon (loopback), which forwards the
 * call as JSON-RPC over its own Control Plane connection and answers with the result (ADR-0062).
 * The request names the tool and its arguments only: which Session it concerns is the Daemon's
 * connection, so nothing here can speak for another Session. Mirrors `AGENT_BRIDGE_PATH` /
 * `AgentBridgeRequest` / `DAEMON_PORT` / `E2E_PATH` in `@sessionboxer/protocol`, which this
 * package does not depend on (it is installed on its own in the image).
 */

const DAEMON_PORT = 7000;
const AGENT_BRIDGE_PATH = "/sessionboxer";
const E2E_PATH = "/e2e";

export class BridgeError extends Error {}

function daemonUrl(path: string): string {
  const port = Number(process.env.SESSIONBOXER_DAEMON_PORT ?? DAEMON_PORT);
  return `http://127.0.0.1:${port}${path}`;
}

async function post(path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(daemonUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new BridgeError(`The Sandbox Daemon is not reachable (${e instanceof Error ? e.message : String(e)}).`);
  }
  const text = await res.text();
  if (!res.ok) throw new BridgeError(text || `${res.status} ${res.statusText}`);
  return text === "" ? null : (JSON.parse(text) as unknown);
}

/** Runs a `sessionboxer` tool on the Control Plane, for this Session. */
export function callTool(tool: string, args: unknown): Promise<unknown> {
  return post(AGENT_BRIDGE_PATH, { tool, args });
}

export type E2eMethod = "plan" | "case_start" | "case_end" | "finish";

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
  brief: string | null;
  cycles: number;
  skipReason: string | null;
  videoPath: string | null;
  cases: E2eCaseView[];
}

interface RunJson {
  id: string;
  status: string;
  brief?: string | null;
  cycles: number;
  skipReason: string | null;
  videoPath: string | null;
  cases: Array<{ index: number; title: string; status: string; cycle: number; durationMs: number | null; note: string | null }>;
}

/** The `e2e_*` tools' older transport (`/e2e`, ADR-0044); the run comes back summarized for the Agent. */
export async function e2eCall(method: E2eMethod, params: unknown): Promise<E2eRunView> {
  return summarizeRun((await post(E2E_PATH, { method, params })) as RunJson);
}

/** The run as the Agent needs to see it: one line per case attempt, no ids or timestamps. */
export function summarizeRun(run: RunJson): E2eRunView {
  return {
    id: run.id,
    status: run.status,
    brief: run.brief ?? null,
    cycles: run.cycles,
    skipReason: run.skipReason,
    videoPath: run.videoPath,
    cases: run.cases.map((c) => ({ index: c.index, title: c.title, status: c.status, cycle: c.cycle, durationMs: c.durationMs, note: c.note })),
  };
}
