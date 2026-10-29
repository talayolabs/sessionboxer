// Pins "Copy session" (apps/web/src/session-export.ts): which transcript items each option keeps and the
// three formats. Node strips the model's TypeScript, as in feed.test.mjs. Expected values are written by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXPORT_OPTIONS, exportMessages, formatExport } from "../apps/web/src/session-export.ts";

const ts = "2026-10-29T10:00:00.000Z";
const items = [
  { kind: "status", key: "0", ts, status: "idle" },
  { kind: "user", key: "1", ts, text: "Fix the bug", attachments: [{ path: ".sessionboxer/uploads/a/log.txt", name: "log.txt", size: 3, mimeType: "text/plain" }] },
  { kind: "thought", key: "2", ts, text: "Look at the log" },
  { kind: "agent", key: "3", ts, text: "Reading the log." },
  { kind: "tool", key: "4", ts, toolCallId: "t1", title: "cat log.txt", toolKind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "boom" } }], locations: [], rawInput: { path: "log.txt" } },
  { kind: "agent", key: "5", ts, text: "Fixed: the parser crashed on ``` fences." },
  { kind: "turn_ended", key: "6", ts, stopReason: "end_turn", seq: 6, branchId: "main", tail: false, stats: {} },
  { kind: "user", key: "7", ts, text: "Thanks", fromAgent: { type: "agent", fromSessionId: "s2", fromTitle: "Other", hops: 1 } },
  { kind: "agent", key: "8", ts, text: "You're welcome." },
  { kind: "agent", key: "9", ts, text: "  " },
];
const session = { id: "s1", title: "Bug hunt", provider: "claude-code" };
const opts = (patch) => ({ ...DEFAULT_EXPORT_OPTIONS, ...patch });

test("default: user messages and the last Agent message of each turn", () => {
  assert.deepEqual(exportMessages(items, DEFAULT_EXPORT_OPTIONS), [
    { role: "user", text: "Fix the bug", attachments: [".sessionboxer/uploads/a/log.txt"] },
    { role: "assistant", text: "Fixed: the parser crashed on ``` fences." },
    { role: "user", text: "Thanks", from: 'Agent of "Other" (s2)' },
    { role: "assistant", text: "You're welcome." },
  ]);
});

test("all Agent messages, thinking, tool calls with output, timestamps", () => {
  const out = exportMessages(items, opts({ user: false, assistantScope: "all", thinking: true, toolCalls: true, toolOutput: true, timestamps: true }));
  assert.deepEqual(out, [
    { role: "thinking", ts, text: "Look at the log" },
    { role: "assistant", ts, text: "Reading the log." },
    { role: "tool", ts, tool: { title: "cat log.txt", kind: "read", status: "completed", input: { path: "log.txt" }, output: "boom" } },
    { role: "assistant", ts, text: "Fixed: the parser crashed on ``` fences." },
    { role: "assistant", ts, text: "You're welcome." },
  ]);
});

test("tool output stays out unless asked; Assistant off drops the Agent's messages", () => {
  assert.deepEqual(exportMessages(items, opts({ user: false, assistant: false, toolCalls: true })), [
    { role: "tool", tool: { title: "cat log.txt", kind: "read", status: "completed", input: { path: "log.txt" } } },
  ]);
});

test("markdown: title, headings, a fence longer than the text's backticks", () => {
  const md = formatExport(session, exportMessages(items.slice(0, 7), opts({ toolCalls: true, toolOutput: true })), "markdown");
  assert.equal(
    md,
    [
      "# Bug hunt",
      "Claude Code Session `s1`",
      "## User\n\nFix the bug\n\nAttachments: `.sessionboxer/uploads/a/log.txt`",
      '### Tool: cat log.txt (read, completed)\n\n```json\n{\n  "path": "log.txt"\n}\n```\n\nOutput:\n\n```\nboom\n```',
      "## Assistant\n\nFixed: the parser crashed on ``` fences.",
    ].join("\n\n") + "\n",
  );
});

test("json and jsonl", () => {
  const messages = exportMessages(items.slice(0, 7), DEFAULT_EXPORT_OPTIONS);
  assert.deepEqual(JSON.parse(formatExport(session, messages, "json")), { session, messages });
  assert.equal(
    formatExport(session, messages, "jsonl"),
    '{"role":"user","text":"Fix the bug","attachments":[".sessionboxer/uploads/a/log.txt"]}\n{"role":"assistant","text":"Fixed: the parser crashed on ``` fences."}\n',
  );
  assert.equal(formatExport(session, [], "jsonl"), "");
});
