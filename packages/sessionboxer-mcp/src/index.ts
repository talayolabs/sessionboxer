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
