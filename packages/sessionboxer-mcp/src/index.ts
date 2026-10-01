#!/usr/bin/env node
/**
 * The `sessionboxer` MCP server: what the Agent in a Sandbox knows about, and can do to, the
 * Sessionboxer Session it runs in (ADR-0062). Every tool is a `POST /sessionboxer` to the Sandbox
 * Daemon on loopback; the Daemon forwards it over its Control Plane connection, which is what names
 * the Session. Which tools the Control Plane accepts follows the Session's `agentTools` policy
 * (`session`: this Session only; `all`: other Sessions too); a refused call answers with the reason.
 */
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { fingerprint, instrumentTool, reportMcpExecution } from "@sessionboxer/protocol/node-telemetry";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeError, callTool, e2eCall, type E2eMethod } from "./bridge.js";
import { extractWav } from "./media.js";

const server = new McpServer({ name: "sessionboxer", version: "0.0.0" });

function registerTool<Shape extends z.ZodRawShape>(name: string, config: { description: string; inputSchema: Shape }, callback: ToolCallback<Shape>) {
  const schemaHash = fingerprint({ name, description: config.description, inputSchema: toJsonSchemaCompat(z.object(config.inputSchema)) });
  return server.registerTool(name, config, instrumentTool(schemaHash, callback, reportMcpExecution("sessionboxer", name)) as unknown as ToolCallback<Shape>);
}

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

registerTool(
  "whoami",
  {
    description:
      "Which Sessionboxer Session you are: id, title, URL, Provider and model, Environment, how it was created (fork, or by another Session's Agent), the conversation branch, Snapshots, status, usage and context, the user's open panes, Terminals, attached PRs, the current verification run and the repositories. The same identity is in /workspace/.sessionboxer/session.json.",
    inputSchema: {},
  },
  () => tool("whoami", {}),
);

registerTool(
  "docs",
  {
    description: "Look a topic up in the Sessionboxer user guide (the sections whose heading or text matches the query, at most a few).",
    inputSchema: { query: z.string().min(1).max(200).describe("A heading, a feature name or a few keywords") },
  },
  (args) => tool("docs", args),
);

registerTool(
  "settings_get",
  {
    description: "The Sessionboxer settings that apply to this Session, with any secret-shaped value left out.",
    inputSchema: {},
  },
  () => tool("settings_get", {}),
);

// --- This Session ------------------------------------------------------------------------------

registerTool(
  "pr_attach",
  {
    description: "Attach a pull request to this Session: the user sees it in the PRs pane with its checks and review comments. Use it right after creating a PR.",
    inputSchema: { ref: z.string().min(1).max(500).describe("The PR's URL, or owner/repo#number") },
  },
  (args) => tool("pr_attach", args),
);

registerTool(
  "pr_review_submit",
  {
    description:
      "Only in a Session an Auto review automation started for a pull request: hand the finished review to the Control Plane, which posts it on the PR under the connected login (GitHub review, Bitbucket comments). Call it exactly once; do not post through gh, the platform's API or git yourself. The verdict may be capped by the automation's settings. Findings use repository-relative paths and lines of the new version of the file; a path outside the diff goes into the review body instead.",
    inputSchema: {
      verdict: z.enum(["comment", "approve", "request_changes"]).describe("Your verdict; the automation's maxVerdict caps it (an over-cap verdict is posted as a comment)"),
      summary: z.string().min(1).max(4000).describe("The review in Markdown: what the change does, what is right, what is wrong; two to ten sentences"),
      findings: z
        .array(
          z.object({
            path: z.string().min(1).max(500).describe("Repository-relative path"),
            line: z.number().int().positive().describe("Line number in the head version (RIGHT) or base version (LEFT) of the file"),
            side: z.enum(["RIGHT", "LEFT"]).optional().describe("Default RIGHT"),
            severity: z.enum(["high", "medium", "low"]).optional().describe("Default medium; high is a bug or a security issue"),
            body: z.string().min(1).max(2000).describe("The finding, in Markdown"),
          }),
        )
        .max(50)
        .optional()
        .describe("Inline findings, none for a clean review"),
    },
  },
  (args) => tool("pr_review_submit", args),
);

registerTool(
  "pr_list",
  { description: "The pull requests attached to this Session, with their state, checks and unseen review items.", inputSchema: {} },
  () => tool("pr_list", {}),
);

registerTool(
  "pr_items",
  {
    description: "The review comments, check results and other items of an attached pull request, with whether the user marked each as addressed.",
    inputSchema: { pr: z.string().min(1).describe("The PR's id from pr_list, or its URL / owner/repo#number") },
  },
  (args) => tool("pr_items", args),
);

registerTool(
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

registerTool(
  "snapshot",
  {
    description: "Take a Snapshot of this Sandbox now (its disk, the Workspace and your conversation), which the user can fork from or roll back to.",
    inputSchema: {},
  },
  () => tool("snapshot", {}),
);

registerTool(
  "queue_add",
  {
    description: "Queue a prompt for yourself: it is sent to you as the next user turn once this one ends (a follow-up you want a fresh turn for, not a note).",
    inputSchema: { text: z.string().min(1).max(20_000) },
  },
  (args) => tool("queue_add", args),
);

registerTool("queue_list", { description: "The prompts queued for this Session, in order.", inputSchema: {} }, () => tool("queue_list", {}));

registerTool(
  "title_set",
  {
    description: "Rename this Session (the sidebar and the browser tab); keep it short and specific.",
    inputSchema: { title: z.string().min(1).max(200) },
  },
  (args) => tool("title_set", args),
);

registerTool(
  "verify",
  {
    description:
      "Open a verification run for the work of this turn with a one-paragraph brief of what it checks (shown in the Auto QA pane), optionally with the cases planned at once; then follow the e2e-verification skill (e2e_case_start / e2e_case_end / e2e_finish). Do not call it when Sessionboxer already asked you to verify the turn.",
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

registerTool(
  "notify",
  {
    description: "Send the user a short notification (a browser push and the bell in Sessionboxer) about this Session, for something that cannot wait for your reply; not for progress.",
    inputSchema: { text: z.string().min(1).max(500) },
  },
  (args) => tool("notify", args),
);

registerTool(
  "terminal_list",
  { description: "The Terminals of this Session (the user's, and the ones opened for you), with whether each still runs.", inputSchema: {} },
  () => tool("terminal_list", {}),
);

registerTool(
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

registerTool(
  "transcribe_media",
  {
    description:
      "Speech to text for a video or audio file in the Workspace (an attached screen recording, a clip filmed with the camera, a voice note), with timestamps: the audio is extracted here with ffmpeg and transcribed by Whisper on the user's machine. Returns the text and its segments ({ start, end, text } in seconds); when a segment refers to the screen, take the frame at its time with `ffmpeg -ss <start> -i <file> -frames:v 1 frame.png` and look at it.",
    inputSchema: {
      path: z.string().min(1).max(4096).describe("The media file, absolute or relative to the Workspace (e.g. .sessionboxer/uploads/ab12cd34/screen-20260930-120000.webm)"),
      language: z
        .string()
        .min(2)
        .max(8)
        .optional()
        .describe("ISO 639-1 code of the speech (en, es, …) or auto to detect it; the user's speech setting when left out"),
    },
  },
  async (args) => {
    let wav;
    try {
      wav = await extractWav(args.path);
    } catch (e) {
      return errorText(e instanceof Error ? e.message : String(e));
    }
    try {
      const result = (await callTool("transcribe_media", { path: wav.workspacePath, language: args.language })) as Record<string, unknown> | null;
      return okText(JSON.stringify({ path: args.path, ...(result ?? {}) }));
    } catch (e) {
      if (e instanceof BridgeError) return errorText(e.message);
      throw e;
    } finally {
      wav.remove();
    }
  },
);

registerTool(
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

const PROVIDERS = ["claude-code", "devin", "codex", "cursor", "pi"] as const;
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

registerTool(
  "sessions_list",
  {
    description:
      "Every Sessionboxer Session on this Control Plane (yours marked self, the ones your Agent created marked mine): id, title, URL, status, Provider, Environment, repositories, who created it, queue length. Needs the all-Sessions policy.",
    inputSchema: {},
  },
  () => tool("sessions_list", {}),
);

registerTool(
  "session_get",
  {
    description: "One Session's summary plus the last thing its Agent said (capped). Needs the all-Sessions policy.",
    inputSchema: { id: SESSION_REF },
  },
  (args) => tool("session_get", args),
);

registerTool(
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

registerTool(
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

registerTool(
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

registerTool(
  "session_wait",
  {
    description:
      "Wait until another Session's Agent finishes its turn (and queue), at most timeout_s seconds; returns still_running, its status and the last thing its Agent said. Call it again while still_running is true. Needs the all-Sessions policy.",
    inputSchema: { id: SESSION_REF, timeout_s: WAIT_TIMEOUT },
  },
  (args) => tool("session_wait", args),
);

registerTool(
  "session_stop",
  {
    description: "Stop a Session your Agent created (session_create / session_fork); its Sandbox stops, the user can resume it. Other Sessions are the user's to stop. Needs the all-Sessions policy.",
    inputSchema: { id: SESSION_REF },
  },
  (args) => tool("session_stop", args),
);

registerTool(
  "approval_wait",
  {
    description:
      "Wait for the user's answer to a pending approval (the id session_create returned), at most timeout_s seconds: status pending / allowed (with the Session created) / denied / expired (unanswered for 10 minutes). Call it again while pending; tell the user what you are waiting for.",
    inputSchema: { id: z.string().min(1).max(100), timeout_s: WAIT_TIMEOUT },
  },
  (args) => tool("approval_wait", args),
);

registerTool(
  "schedule_create",
  {
    description:
      "Create a scheduled task (an automation with a schedule trigger; the user's Automations page shows it): on a cron schedule, prompt a Session (this one, or with the all-Sessions policy another) or start a new Session each time. Say what you scheduled in your reply.",
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

registerTool(
  "schedule_list",
  { description: "The automations with a schedule trigger (scheduled tasks): id, name, cron, time zone, enabled, action, next and last run. See automation_list for every automation.", inputSchema: {} },
  () => tool("schedule_list", {}),
);

// --- Utilities (ADR-0073) ---------------------------------------------------------------------
// The external systems the user registered for investigating (observability, applications), by
// target Environment; credentials never come back through these tools.

const UTILITY_REF = z.string().min(1).max(130).describe("A Utility's name from utilities_list (name@environment when the name exists in several Environments)");
const UTILITY_ENV = z.string().max(64).optional().describe("The target Environment (prod, staging, qa…) when the name exists in several");
const CREDENTIALS = z
  .array(z.object({ name: z.string().min(1).max(64).describe("user, password, token, totp (base32 secret), ssh_key, uri…"), value: z.string().max(10_000) }))
  .max(20)
  .default([]);
const KEY_VALUES = z.array(z.object({ name: z.string().min(1).max(200), value: z.string().max(10_000).describe("May contain ${cred:<name>} for one of the credentials") })).max(20).default([]);

registerTool(
  "utilities_list",
  {
    description:
      "The Utilities registered on this Control Plane — the observability systems and applications the user lets Agents investigate with — by target Environment (prod, staging, qa…): name, group, facets (mcp, web, http, ssh, cli), credential names, whether each is on for this Session, plus the presets utilities_add knows. Read .sessionboxer/utilities.json for the ones on right now.",
    inputSchema: {},
  },
  () => tool("utilities_list", {}),
);

registerTool(
  "utilities_get",
  {
    description:
      "One Utility in full: notes, every facet (its MCP server's name, web URL and login kind, HTTP base URL and header names, SSH host, CLI install step), credential names (never values) and how to use them (${util:name.credential} in the desktop type tool, sb-util in a shell).",
    inputSchema: { name: UTILITY_REF, environment: UTILITY_ENV },
  },
  (args) => tool("utilities_get", args),
);

registerTool(
  "utilities_open",
  {
    description:
      "Open a Utility's web UI in the Sandbox's browser and show the user the Desktop. Then take a screenshot and sign in by typing ${util:<name>.user}, ${util:<name>.password} (and ${util:<name>.otp} for a one-time code) with the desktop type tool — the real values are typed, you never see them.",
    inputSchema: { name: UTILITY_REF, environment: UTILITY_ENV, path: z.string().max(4000).optional().describe("A path or URL under the web UI to open instead of its front page") },
  },
  (args) => tool("utilities_open", args),
);

registerTool(
  "utilities_add",
  {
    description:
      "Register a Utility (\"add newrelic with user X password Y at URL Z\"): the user allows it in a card that shows every field with the credentials masked, then it is stored in Settings → Utilities and, by default, switched on for this Session. Pass a preset when one fits (utilities_list names them: newrelic, grafana, graylog, argocd, rabbitmq, mongodb, webapp, ssh) — it fills the facets from the URL; otherwise give the facets. Credentials go in `credentials`, never in notes. When the user pasted credentials in the chat, call this right away and suggest the /util composer command for next time (it keeps them out of the transcript). Returns a pending approval; approval_wait(id) waits for the answer.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe("Short lowercase id: newrelic, grafana-payments…"),
      label: z.string().max(200).optional(),
      group: z.enum(["observability", "applications"]).optional().describe("observability (dashboards, logs, traces, alerts) or applications (the systems under test, admin UIs, databases)"),
      environment: z.string().max(64).optional().describe("Target Environment; the first non-production one when omitted"),
      preset: z.string().max(64).optional(),
      credentials: CREDENTIALS,
      readOnly: z.boolean().optional().describe("Default true: for looking, not changing"),
      notes: z.string().max(20_000).optional().describe("How to use it: what to look for, useful queries, quirks"),
      web: z.object({ url: z.string().max(4000).optional(), login: z.enum(["form", "basic", "sso", "none"]).optional() }).optional(),
      http: z.object({ baseUrl: z.string().max(4000), headers: KEY_VALUES }).optional(),
      ssh: z.object({ host: z.string().max(500).optional(), port: z.number().int().positive().max(65535).optional(), user: z.string().max(200).optional(), jump: z.string().max(500).optional() }).optional(),
      cli: z.object({ install: z.string().max(4000).default(""), env: KEY_VALUES }).optional(),
      mcp: z
        .object({
          transport: z.enum(["stdio", "http", "sse"]).optional(),
          command: z.string().max(4000).optional(),
          args: z.array(z.string().max(4000)).optional(),
          env: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().default(false) })).optional(),
          url: z.string().max(4000).optional(),
          headers: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().default(false) })).optional(),
        })
        .optional(),
      enable: z.boolean().default(true).describe("Switch it on for this Session once stored"),
    },
  },
  (args) => tool("utilities_add", args),
);

registerTool(
  "utilities_update",
  {
    description:
      "Change a registered Utility (the user allows it in a card): fields given replace the stored ones; credentials given replace the stored ones of the same name, the others stay. Returns a pending approval; approval_wait(id) waits.",
    inputSchema: {
      name: UTILITY_REF,
      environment: UTILITY_ENV,
      label: z.string().max(200).optional(),
      group: z.enum(["observability", "applications"]).optional(),
      preset: z.string().max(64).optional(),
      credentials: CREDENTIALS,
      readOnly: z.boolean().optional(),
      notes: z.string().max(20_000).optional(),
      web: z.object({ url: z.string().max(4000).optional(), login: z.enum(["form", "basic", "sso", "none"]).optional() }).optional(),
      http: z.object({ baseUrl: z.string().max(4000), headers: KEY_VALUES }).optional(),
      ssh: z.object({ host: z.string().max(500).optional(), port: z.number().int().positive().max(65535).optional(), user: z.string().max(200).optional(), jump: z.string().max(500).optional() }).optional(),
      cli: z.object({ install: z.string().max(4000).default(""), env: KEY_VALUES }).optional(),
      mcp: z
        .object({
          transport: z.enum(["stdio", "http", "sse"]).optional(),
          command: z.string().max(4000).optional(),
          args: z.array(z.string().max(4000)).optional(),
          env: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().default(false) })).optional(),
          url: z.string().max(4000).optional(),
          headers: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().default(false) })).optional(),
        })
        .optional(),
    },
  },
  (args) => tool("utilities_update", args),
);

registerTool(
  "utilities_enable",
  {
    description:
      "Switch Utilities on or off for this Session: names (name or name@environment), an Environment name (all of it) or a group (observability, applications). Switching on asks the user in a card (returns a pending approval; approval_wait(id) waits); switching off is immediate. Their MCP facets join or leave your MCP servers once applied; the manifest and sb-util follow at once.",
    inputSchema: { names: z.array(z.string().min(1).max(130)).min(1).max(100), enabled: z.boolean().default(true) },
  },
  (args) => tool("utilities_enable", args),
);

registerTool(
  "procedure_save",
  {
    description:
      "Propose a procedure — a skill (SKILL.md) that says how to investigate or verify something with the Utilities (which to open, what to query, what a healthy result looks like) — for the user to keep; allowed, it is stored in Settings → Utilities and materialised as a skill in every Session whose Utilities and Environments it names. Write it after an investigation worked, general enough to reuse, never with credentials. Returns a pending approval; approval_wait(id) waits.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Skill directory name: investigate-5xx-spike, verify-checkout-flow…"),
      description: z.string().min(1).max(1024).describe("One or two sentences: when to use it (the skill's frontmatter)"),
      body: z.string().min(1).max(200_000).describe("Markdown: the steps, the Utilities and tools to use (sb-util, MCP servers, the web UIs), what to conclude"),
      utilities: z.array(z.string().max(64)).max(50).default([]).describe("Utility names it needs; empty = any"),
      environments: z.array(z.string().max(64)).max(20).default([]).describe("Environments it applies to; empty = any"),
    },
  },
  (args) => tool("procedure_save", args),
);

// --- Followed pull requests (ADR-0064) --------------------------------------------------------

registerTool(
  "pr_follow",
  {
    description:
      "Follow pull requests without attaching them to a Session: every open PR of a repository (kind repo), the PRs a connected login opened (mine) or is asked to review (requested). Followed PRs show on the user's Pull requests page and can trigger automations (automation_create with a pr_event trigger). Say what you followed in your reply.",
    inputSchema: {
      kind: z.enum(["repo", "mine", "requested"]).default("repo"),
      repo: z.string().max(500).optional().describe("For kind repo: owner/repo, or a repository / PR URL (GitHub or Bitbucket Data Center)"),
      account: z.string().min(1).optional().describe("The connected login to read with; omitted takes the first Connector of the provider"),
      provider: z.enum(["github", "bitbucket"]).optional().describe("Omitted guesses from the URL, else github"),
      host: z.string().optional().describe("Bitbucket Data Center host when there is more than one"),
    },
  },
  (args) => tool("pr_follow", args),
);

registerTool(
  "pr_followed_list",
  {
    description: "The follows and the followed pull requests: repository, number, title, state, author, head, review decision, checks, the Sessions each is attached to and its last automation runs.",
    inputSchema: { repo: z.string().max(500).optional().describe("owner/repo to narrow down to"), state: z.enum(["open", "all"]).default("open") },
  },
  (args) => tool("pr_followed_list", args),
);

// --- Automations (ADR-0063) ------------------------------------------------------------------

const PR_EVENTS = ["opened", "synchronize", "ready_for_review", "converted_to_draft", "review_requested", "review_submitted", "comment", "check_failed", "merged", "closed", "reopened"] as const;

registerTool(
  "automation_create",
  {
    description:
      "Create an automation (the user's Automations page shows it): a trigger — a cron schedule, a followed pull request's event (opened, new commits, comment, failing check…), or manual — and an action — prompt a Session (this one; another or a new one with the all-Sessions policy), auto-review or auto-QA the PR, attach the PR to its Session, or notify the user. PR-event triggers need the user to follow repositories on the Pull requests page first (pr_follow). Say what you created in your reply.",
    inputSchema: {
      name: z.string().min(1).max(200),
      enabled: z.boolean().default(true),
      trigger: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("schedule"),
          cron: z.string().min(1).max(200).describe("5-field cron expression, e.g. '0 9 * * 1-5'"),
          timezone: z.string().min(1).max(100).describe("IANA time zone"),
          missedRun: z.enum(["skip", "catch_up"]).default("skip"),
        }),
        z.object({
          type: z.literal("pr_event"),
          follows: z.array(z.string()).default([]).describe("pr_follows ids to listen to; empty = every follow"),
          events: z.array(z.enum(PR_EVENTS)).min(1),
          filters: z
            .object({
              drafts: z.enum(["skip", "include"]).default("skip"),
              forks: z.enum(["skip", "review_only", "allow"]).default("review_only"),
              authors: z.enum(["any", "not_self", "self_only"]).default("not_self"),
              includeOwn: z.boolean().default(false),
              baseRef: z.string().max(200).optional(),
              titleMatch: z.string().max(200).optional(),
              labels: z.array(z.string()).max(20).optional(),
            })
            .default({}),
        }),
        z.object({ type: z.literal("manual") }),
      ]),
      action: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("prompt"),
          sessionId: z.union([SESSION_REF, z.literal("attached")]).optional().describe("Defaults to this Session; 'attached' = the Session the PR is attached to (PR triggers)"),
          text: z.string().min(1).max(20_000).describe("Placeholders for PR triggers: {pr.url} {pr.number} {pr.title} {pr.repo} {pr.headSha} {event}"),
        }),
        z.object({
          type: z.literal("new_session"),
          title: z.string().min(1).max(200).optional(),
          provider: z.enum(PROVIDERS).optional(),
          repos: REPOS,
          prompt: z.string().min(1).max(20_000),
          stopAfter: z.boolean().default(true).describe("Stop the Session once its first turn ends"),
          checkoutPrHead: z.boolean().default(true).describe("PR triggers: clone the PR's repository at the PR head first"),
        }),
        z.object({
          type: z.literal("auto_review"),
          provider: z.enum(PROVIDERS).optional(),
          instructions: z.string().max(20_000).optional(),
          maxVerdict: z.enum(["comment", "request_changes", "approve"]).default("comment"),
          deltaOnly: z.boolean().default(true),
          notifyOn: z.enum(["always", "findings", "never"]).default("findings"),
          stopAfter: z.boolean().default(true),
        }),
        z.object({
          type: z.literal("auto_qa"),
          provider: z.enum(PROVIDERS).optional(),
          instructions: z.string().max(20_000).optional(),
          publish: z.enum(["github_attachment", "link_only"]).default("github_attachment"),
          commentOnSkip: z.boolean().default(false),
          maxMinutes: z.number().int().min(1).max(30).default(10),
          stopAfter: z.boolean().default(true),
        }),
        z.object({ type: z.literal("attach") }),
        z.object({ type: z.literal("notify"), text: z.string().max(500).optional() }),
      ]),
      limits: z
        .object({
          maxConcurrent: z.number().int().min(1).max(20).optional(),
          maxRunsPerDay: z.number().int().min(1).max(1000).optional(),
          maxRunsPerPrPerDay: z.number().int().min(1).max(100).optional(),
          debounceSeconds: z.number().int().min(0).max(3600).optional(),
          timeoutMinutes: z.number().int().min(1).max(1440).optional(),
        })
        .default({}),
    },
  },
  (args) => tool("automation_create", args),
);

registerTool(
  "automation_list",
  { description: "Every automation on this Control Plane: id, name, enabled, trigger, action, limits, next/last run, runs today.", inputSchema: {} },
  () => tool("automation_list", {}),
);

registerTool(
  "automation_runs",
  { description: "The last 50 runs of an automation: trigger, status, PR, Session, detail, error, result.", inputSchema: { id: z.string().min(1) } },
  (args) => tool("automation_runs", args),
);

// --- End-to-end verification runs (ADR-0044) -------------------------------------------------
// The Control Plane opens a run after a user turn and asks for the `e2e-verification` skill; these
// tools fill the run in (Daemon → Control Plane) so the user's Auto QA pane follows along.

const e2eTool = async (method: E2eMethod, params: unknown) => {
  try {
    return okText(JSON.stringify(await e2eCall(method, params)));
  } catch (e) {
    if (e instanceof BridgeError) return errorText(e.message);
    throw e;
  }
};

registerTool(
  "e2e_plan",
  {
    description:
      "Register the test cases of the current verification run (the e2e-verification skill, step Plan), or skip the run when the turn changed nothing testable. Call it once, before start_recording. Cases are numbered from 1 in the order given; the user sees them in the Auto QA pane at once.",
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

registerTool(
  "e2e_case_start",
  {
    description:
      "Mark a case as running (its timer starts and the user's Auto QA pane opens on it). Calling it for a case that already passed or failed reruns it as a new cycle, after you fixed the code; at most 3 fix attempts per case. One case runs at a time: end the previous one first.",
    inputSchema: { index: z.number().int().positive().describe("Case number from e2e_plan, starting at 1") },
  },
  ({ index }) => e2eTool("case_start", { index }),
);

registerTool(
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

registerTool(
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
