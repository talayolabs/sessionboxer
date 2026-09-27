#!/usr/bin/env node
/**
 * The `sessionboxer` MCP server: what the Agent in a Sandbox knows about, and can do to, the
 * Sessionboxer Session it runs in (ADR-0062). Every tool is a `POST /sessionboxer` to the Sandbox
 * Daemon on loopback; the Daemon forwards it over its Control Plane connection, which is what names
 * the Session. Which tools the Control Plane accepts follows the Session's `agentTools` policy
 * (`session`: this Session only; `all`: other Sessions too); a refused call answers with the reason.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeError, callTool, e2eCall, type E2eMethod } from "./bridge.js";

const server = new McpServer({ name: "sessionboxer", version: "0.0.0" });

const okText = (text = "OK") => ({ content: [{ type: "text" as const, text }] });
const errorText = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });

const tool = async (name: string, args: unknown) => {
  try {
    const result = await callTool(name, args);
    return okText(typeof result === "string" ? result : JSON.stringify(result));
  } catch (e) {
    if (e instanceof BridgeError) return errorText(e.message);
    throw e;
  }
};

// --- Self-knowledge --------------------------------------------------------------------------

server.registerTool(
  "whoami",
  {
    description:
      "Which Sessionboxer Session you are: id, title, URL, Provider and model, Environment, how it was created (fork, or by another Session's Agent), the conversation branch, Snapshots, status, usage and context, the user's open panes, Terminals, attached PRs, the current verification run and the repositories. The same identity is in /workspace/.sessionboxer/session.json.",
    inputSchema: {},
  },
  () => tool("whoami", {}),
);

server.registerTool(
  "docs",
  {
    description: "Look a topic up in the Sessionboxer user guide (the sections whose heading or text matches the query, at most a few).",
    inputSchema: { query: z.string().min(1).max(200).describe("A heading, a feature name or a few keywords") },
  },
  (args) => tool("docs", args),
);

server.registerTool(
  "settings_get",
  {
    description: "The Sessionboxer settings that apply to this Session, with any secret-shaped value left out.",
    inputSchema: {},
  },
  () => tool("settings_get", {}),
);

// --- This Session ------------------------------------------------------------------------------

server.registerTool(
  "pr_attach",
  {
    description: "Attach a pull request to this Session: the user sees it in the PRs pane with its checks and review comments. Use it right after creating a PR.",
    inputSchema: { ref: z.string().min(1).max(500).describe("The PR's URL, or owner/repo#number") },
  },
  (args) => tool("pr_attach", args),
);

server.registerTool(
  "pr_list",
  { description: "The pull requests attached to this Session, with their state, checks and unseen review items.", inputSchema: {} },
  () => tool("pr_list", {}),
);

server.registerTool(
  "pr_items",
  {
    description: "The review comments, check results and other items of an attached pull request, with whether the user marked each as addressed.",
    inputSchema: { pr: z.string().min(1).describe("The PR's id from pr_list, or its URL / owner/repo#number") },
  },
  (args) => tool("pr_items", args),
);

server.registerTool(
  "pr_mark_addressed",
  {
    description: "Mark review items of an attached pull request as addressed, after you dealt with them.",
    inputSchema: {
      pr: z.string().min(1).describe("The PR's id from pr_list, or its URL / owner/repo#number"),
      items: z.array(z.string().min(1)).min(1).max(200).describe("Item ids from pr_items"),
    },
  },
  (args) => tool("pr_mark_addressed", args),
);

server.registerTool(
  "snapshot",
  {
    description: "Take a Snapshot of this Sandbox now (its disk, the Workspace and your conversation), which the user can fork from or roll back to.",
    inputSchema: {},
  },
  () => tool("snapshot", {}),
);

server.registerTool(
  "queue_add",
  {
    description: "Queue a prompt for yourself: it is sent to you as the next user turn once this one ends (a follow-up you want a fresh turn for, not a note).",
    inputSchema: { text: z.string().min(1).max(20_000) },
  },
  (args) => tool("queue_add", args),
);

server.registerTool("queue_list", { description: "The prompts queued for this Session, in order.", inputSchema: {} }, () => tool("queue_list", {}));

server.registerTool(
  "title_set",
  {
    description: "Rename this Session (the sidebar and the browser tab); keep it short and specific.",
    inputSchema: { title: z.string().min(1).max(200) },
  },
  (args) => tool("title_set", args),
);

server.registerTool(
  "verify",
  {
    description:
      "Open a verification run for the work of this turn with a one-paragraph brief of what it checks (shown in the Verification pane), optionally with the cases planned at once; then follow the e2e-verification skill (e2e_case_start / e2e_case_end / e2e_finish). Do not call it when Sessionboxer already asked you to verify the turn.",
    inputSchema: {
      brief: z.string().min(1).max(2000).describe("What the run verifies and how, in two or three sentences"),
      cases: z
        .array(
          z.object({
            title: z.string().min(1).max(200),
            steps: z.string().max(4000),
            expected: z.string().max(2000),
          }),
        )
        .max(10)
        .optional()
        .describe("The cases, when you already know them; else call e2e_plan next"),
    },
  },
  (args) => tool("verify", args),
);

server.registerTool(
  "notify",
  {
    description: "Send the user a short notification (a browser push and the bell in Sessionboxer) about this Session, for something that cannot wait for your reply; not for progress.",
    inputSchema: { text: z.string().min(1).max(500) },
  },
  (args) => tool("notify", args),
);

server.registerTool(
  "terminal_list",
  { description: "The Terminals of this Session (the user's, and the ones opened for you), with whether each still runs.", inputSchema: {} },
  () => tool("terminal_list", {}),
);

server.registerTool(
  "terminal_read",
  {
    description: "The last lines a Terminal printed (its retained output, plain text).",
    inputSchema: {
      id: z.string().min(1).describe("A Terminal id from terminal_list"),
      lines: z.number().int().positive().max(2000).default(100),
    },
  },
  (args) => tool("terminal_read", args),
);

server.registerTool(
  "ui_open",
  {
    description:
      "Ask the user's browser to show a pane of this Session (only when they are on this Session and not typing). With pane terminal and a command, a new Terminal opens and runs the command visibly, so the user can watch it.",
    inputSchema: {
      pane: z.enum(["chat", "desktop", "code", "terminal", "context", "prs", "e2e", "schedules"]),
      terminal: z.object({ command: z.string().min(1).max(4000) }).optional().describe("With pane terminal: the command the new Terminal runs"),
    },
  },
  (args) => tool("ui_open", args),
);

// --- Other Sessions (policy `all`; ADR-0062 Stage 2) ----------------------------------------------
// The Control Plane refuses these under the `session` policy with the reason; `session_create` may
// answer `{ pending: true, id }` when the user has to allow it first (a card in their chat).

const PROVIDERS = ["claude-code", "devin", "codex", "cursor"] as const;
const SESSION_REF = z.string().min(1).max(100).describe("A Session id from sessions_list (a prefix of 6+ characters does)");
const REPOS = z
  .array(
    z.object({
      name: z.string().min(1).max(100).optional().describe("Directory name under /workspace (derived from the source when omitted)"),
      source: z.discriminatedUnion("type", [
        z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().min(1).optional() }),
        z.object({ type: z.literal("copy"), path: z.string().min(1).describe("A directory on the host, copied in") }),
      ]),
    }),
  )
  .max(20)
  .default([])
  .describe("Repositories the new Session starts with");
const WAIT_TIMEOUT = z.number().int().positive().max(20).default(15).describe("Seconds to wait at most (the call returns earlier when the Session settles); up to 20");

server.registerTool(
  "sessions_list",
  {
    description:
      "Every Sessionboxer Session on this Control Plane (yours marked self, the ones your Agent created marked mine): id, title, URL, status, Provider, Environment, repositories, who created it, queue length. Needs the all-Sessions policy.",
    inputSchema: {},
  },
  () => tool("sessions_list", {}),
);

server.registerTool(
  "session_get",
  {
    description: "One Session's summary plus the last thing its Agent said (capped). Needs the all-Sessions policy.",
    inputSchema: { id: SESSION_REF },
  },
  (args) => tool("session_get", args),
);

server.registerTool(
  "session_create",
  {
    description:
      "Start a new Session whose first prompt is first_prompt; it is marked as created by this Session. When the user's settings ask for approval the result is { pending: true, id }: a card in their chat asks them to allow or deny; approval_wait(id) blocks for the answer. At most 3 alive Sessions created by you at a time (session_stop frees a place) and a global cap in Settings. Needs the all-Sessions policy.",
    inputSchema: {
      title: z.string().min(1).max(200).optional().describe("Defaults to the start of first_prompt"),
      provider: z.enum(PROVIDERS).optional().describe("Defaults to this Session's Provider"),
      repos: REPOS,
      first_prompt: z.string().min(1).max(20_000).describe("What the new Session's Agent is asked first: the whole task, self-contained (it shares nothing with you but this text)"),
    },
  },
  (args) => tool("session_create", args),
);

server.registerTool(
  "session_fork",
  {
    description:
      "Fork this Session from a Snapshot taken now: the fork gets the same files and tools. conversation continue keeps your conversation (same Provider only), new starts an empty one, handoff starts from the handoff document you pass (goal, state of the work, decisions, open items, files, how to run it). Needs the all-Sessions policy.",
    inputSchema: {
      conversation: z.enum(["continue", "new", "handoff"]).default("continue"),
      provider: z.enum(PROVIDERS).optional().describe("Another Agent for the fork (then conversation must be new or handoff)"),
      title: z.string().min(1).max(200).optional(),
      document: z.string().min(1).max(200_000).optional().describe("With conversation handoff: the handoff, written by you, in Markdown"),
      first_prompt: z.string().min(1).max(20_000).optional().describe("A prompt queued for the fork's Agent after it starts"),
    },
  },
  (args) => tool("session_fork", args),
);

server.registerTool(
  "session_message",
  {
    description:
      "Send a prompt to another Session's Agent; its transcript shows it as coming from this Session, and yours shows it was sent. Not to yourself (use queue_add); at most one message of yours in flight per Session (session_wait for the reply first); chains of Agents prompting Agents stop at 4 hops. A busy Session gets it queued for when it is idle; when queue always queues it. Needs the all-Sessions policy.",
    inputSchema: {
      id: SESSION_REF,
      text: z.string().min(1).max(20_000),
      when: z.enum(["now", "queue"]).default("now"),
    },
  },
  (args) => tool("session_message", args),
);

server.registerTool(
  "session_wait",
  {
    description:
      "Wait until another Session's Agent finishes its turn (and queue), at most timeout_s seconds; returns still_running, its status and the last thing its Agent said. Call it again while still_running is true. Needs the all-Sessions policy.",
    inputSchema: { id: SESSION_REF, timeout_s: WAIT_TIMEOUT },
  },
  (args) => tool("session_wait", args),
);

server.registerTool(
  "session_stop",
  {
    description: "Stop a Session your Agent created (session_create / session_fork); its Sandbox stops, the user can resume it. Other Sessions are the user's to stop. Needs the all-Sessions policy.",
    inputSchema: { id: SESSION_REF },
  },
  (args) => tool("session_stop", args),
);

server.registerTool(
  "approval_wait",
  {
    description:
      "Wait for the user's answer to a pending approval (the id session_create returned), at most timeout_s seconds: status pending / allowed (with the Session created) / denied / expired (unanswered for 10 minutes). Call it again while pending; tell the user what you are waiting for.",
    inputSchema: { id: z.string().min(1).max(100), timeout_s: WAIT_TIMEOUT },
  },
  (args) => tool("approval_wait", args),
);

server.registerTool(
  "schedule_create",
  {
    description:
      "Create a scheduled task (the user's Scheduled tasks page shows it): on a cron schedule, prompt a Session (this one, or with the all-Sessions policy another) or start a new Session each time. Say what you scheduled in your reply.",
    inputSchema: {
      name: z.string().min(1).max(200),
      cron: z.string().min(1).max(200).describe("5-field cron expression, e.g. '0 9 * * 1-5'"),
      timezone: z.string().min(1).max(100).optional().describe("IANA time zone; the Control Plane's when omitted"),
      action: z.discriminatedUnion("type", [
        z.object({ type: z.literal("prompt"), sessionId: SESSION_REF.optional().describe("Defaults to this Session"), text: z.string().min(1).max(20_000) }),
        z.object({
          type: z.literal("new_session"),
          title: z.string().min(1).max(200).optional(),
          provider: z.enum(PROVIDERS).optional(),
          repos: REPOS,
          prompt: z.string().min(1).max(20_000),
          stopAfter: z.boolean().default(true).describe("Stop the Session once its first turn ends"),
        }),
      ]),
    },
  },
  (args) => tool("schedule_create", args),
);

server.registerTool("schedule_list", { description: "The scheduled tasks on this Control Plane: id, name, cron, time zone, enabled, action, next and last run.", inputSchema: {} }, () => tool("schedule_list", {}));

// --- End-to-end verification runs (ADR-0044) -------------------------------------------------
// The Control Plane opens a run after a user turn and asks for the `e2e-verification` skill; these
// tools fill the run in (Daemon → Control Plane) so the user's Verification pane follows along.

const e2eTool = async (method: E2eMethod, params: unknown) => {
  try {
    return okText(JSON.stringify(await e2eCall(method, params)));
  } catch (e) {
    if (e instanceof BridgeError) return errorText(e.message);
    throw e;
  }
};

server.registerTool(
  "e2e_plan",
  {
    description:
      "Register the test cases of the current verification run (the e2e-verification skill, step Plan), or skip the run when the turn changed nothing testable. Call it once, before start_recording. Cases are numbered from 1 in the order given; the user sees them in the Verification pane at once.",
    inputSchema: {
      cases: z
        .array(
          z.object({
            title: z.string().min(1).max(200).describe("What the case checks, as a short sentence"),
            steps: z.string().max(4000).describe("The steps you will take on the desktop, one per line"),
            expected: z.string().max(2000).describe("What must be true at the end for the case to pass"),
          }),
        )
        .max(10)
        .default([])
        .describe("2 to 5 cases normally; up to 10 only for a very large change. Empty when skipping."),
      skip_reason: z.string().max(1000).optional().describe("Why nothing is verified (answer-only turn, research, no testable change); no cases then"),
    },
  },
  ({ cases, skip_reason }) => e2eTool("plan", { cases, skipReason: skip_reason ?? null }),
);

server.registerTool(
  "e2e_case_start",
  {
    description:
      "Mark a case as running (its timer starts and the user's Verification pane opens on it). Calling it for a case that already passed or failed reruns it as a new cycle, after you fixed the code; at most 3 fix attempts per case. One case runs at a time: end the previous one first.",
    inputSchema: { index: z.number().int().positive().describe("Case number from e2e_plan, starting at 1") },
  },
  ({ index }) => e2eTool("case_start", { index }),
);

server.registerTool(
  "e2e_case_end",
  {
    description: "Record the result of the running case: passed, failed (then fix the code and e2e_case_start it again) or skipped (could not be exercised), with a one-line note and the screenshot that shows the final state.",
    inputSchema: {
      index: z.number().int().positive().describe("Case number from e2e_plan"),
      status: z.enum(["passed", "failed", "skipped"]),
      note: z.string().max(2000).optional().describe("One line: what you saw, and for a failure what went wrong"),
      screenshot_path: z.string().max(1000).optional().describe("A /workspace path of a screenshot of the final state (save one with the desktop tools or a shell command)"),
    },
  },
  ({ index, status, note, screenshot_path }) => e2eTool("case_end", { index, status, note: note ?? null, screenshotPath: screenshot_path ?? null }),
);

server.registerTool(
  "e2e_finish",
  {
    description:
      "Close the verification run after stop_recording: attach the video and a short summary. Cases never started are marked skipped. The run's verdict is passed when no case's last attempt failed. After this, end your reply with a short summary that mentions the video's /workspace path.",
    inputSchema: {
      video_path: z.string().max(1000).optional().describe("The recording's path as returned by stop_recording"),
      summary: z.string().max(4000).optional().describe("Two or three sentences: what was verified, what failed and what you fixed"),
    },
  },
  ({ video_path, summary }) => e2eTool("finish", { videoPath: video_path ?? null, summary: summary ?? null }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
