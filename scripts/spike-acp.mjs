#!/usr/bin/env node
// M0 spike: drive claude-agent-acp over stdio the way the Sandbox Daemon will.
// Runs INSIDE a Sandbox (docker exec), never on the host:
//
//   docker exec -e CLAUDE_CODE_OAUTH_TOKEN sbx node /tmp/spike-acp.mjs "<prompt>"
//
// Prints every ACP session/update as a compact line, saves any image content
// (screenshots returned by the computer-use MCP) to /tmp/acp-*.png, answers
// permission requests with the first "allow" option, and exits non-zero if
// the turn does not end cleanly.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The ACP SDK is only installed as a dependency of the global adapter, so
// resolve it from there instead of shipping a second copy.
function locateSdk() {
  const candidates = [
    "/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@agentclientprotocol/sdk/dist/acp.js",
    "/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@agentclientprotocol/sdk/dist/acp.js",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("could not find @agentclientprotocol/sdk next to claude-agent-acp");
  return pathToFileURL(hit).href;
}

const { client, ndJsonStream } = await import(locateSdk());

const prompt =
  process.argv.slice(2).join(" ") ||
  "Take a screenshot of the desktop and tell me in one sentence what you see.";
const cwd = process.env.SPIKE_CWD ?? "/workspace";
const mcpCommand = process.env.SPIKE_MCP ?? "/usr/local/bin/sessionboxer-computer-use-mcp";

const started = Date.now();
const ts = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const log = (...a) => console.log(ts(), ...a);

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  log("WARN: no CLAUDE_CODE_OAUTH_TOKEN in env; expect an auth error");
}

const agent = spawn("claude-agent-acp", [], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});
agent.stderr.on("data", (d) => process.stderr.write(`[claude-agent-acp] ${d}`));
agent.on("exit", (code, sig) => log(`claude-agent-acp exited code=${code} sig=${sig}`));

const stream = ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout));

let imageCount = 0;
const toolCalls = new Map();
let assistantText = "";
let sawToolCall = false;
let sawImage = false;

function saveImages(content, label) {
  for (const block of content ?? []) {
    const inner = block.type === "content" ? block.content : block;
    if (inner?.type === "image" && inner.data) {
      const file = `/tmp/acp-${String(++imageCount).padStart(2, "0")}-${label}.png`;
      writeFileSync(file, Buffer.from(inner.data, "base64"));
      sawImage = true;
      log(`  image saved -> ${file}`);
    }
  }
}

const app = client({ name: "sessionboxer-spike", version: "0.0.0" })
  .onRequest("session/request_permission", (ctx) => {
    const { options, toolCall } = ctx.params;
    const allow =
      options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once") ?? options[0];
    log(`permission requested for ${toolCall?.title ?? "?"} -> ${allow.kind}`);
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  })
  .onNotification("session/update", (ctx) => {
    const u = ctx.params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          assistantText += u.content.text;
          process.stdout.write(u.content.text);
        }
        break;
      case "agent_thought_chunk":
        break;
      case "tool_call":
        sawToolCall = true;
        toolCalls.set(u.toolCallId, u.title);
        log(`tool_call ${u.toolCallId} [${u.kind ?? "?"}] ${u.title} ${JSON.stringify(u.rawInput ?? {}).slice(0, 160)}`);
        saveImages(u.content, "call");
        break;
      case "tool_call_update":
        log(`tool_call_update ${u.toolCallId} status=${u.status ?? "?"}`);
        saveImages(u.content, "result");
        break;
      case "current_mode_update":
        log(`mode -> ${u.currentModeId}`);
        break;
      case "usage_update":
        break;
      default:
        log(`update ${u.sessionUpdate}`);
    }
  });

let exitCode = 1;
try {
  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "sessionboxer-spike", version: "0.0.0" },
    });
    log(`initialize ok: ${init.agentInfo?.name}@${init.agentInfo?.version} authMethods=${init.authMethods.map((m) => m.id).join(",")}`);

    const session = await ctx.request("session/new", {
      cwd,
      mcpServers: [{ name: "desktop", command: mcpCommand, args: [], env: [] }],
    });
    log(`session/new ok: ${session.sessionId} modes=${session.modes?.availableModes?.map((m) => m.id).join(",")} current=${session.modes?.currentModeId}`);

    if (session.modes?.currentModeId !== "bypassPermissions" && session.modes?.availableModes?.some((m) => m.id === "bypassPermissions")) {
      await ctx.request("session/set_mode", { sessionId: session.sessionId, modeId: "bypassPermissions" });
      log("session/set_mode -> bypassPermissions");
    }

    log(`prompt: ${prompt}`);
    const result = await ctx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    process.stdout.write("\n");
    log(`turn ended: stopReason=${result.stopReason}`);
    exitCode = result.stopReason === "end_turn" ? 0 : 2;
  });
} catch (err) {
  process.stdout.write("\n");
  log(`ERROR: ${err?.message ?? err}`);
  if (err?.data) log(JSON.stringify(err.data));
  exitCode = 1;
} finally {
  agent.kill();
}

log(`summary: toolCalls=${toolCalls.size} sawToolCall=${sawToolCall} sawImage=${sawImage} images=${imageCount} textChars=${assistantText.length}`);
process.exit(exitCode);
