// Built-in extension of the Sandbox's openvscode-server (installed under its `extensions/`
// folder by the Dockerfile). It runs in the remote extension host, i.e. inside the box, and
// listens on the loopback interface for the Sandbox Daemon's "open this file" requests, so a
// click on a path in the chat lands in the editor the Code pane shows, without reloading it.
//
//   POST http://127.0.0.1:<SESSIONBOXER_CODE_OPEN_PORT>/open  {"path": "/workspace/src/a.ts", "line": 12, "column": 3}
//
// One remote extension host exists per connected window; the first one to bind the port takes
// the requests, the others retry until it goes away (a window that closed for good).
"use strict";
const http = require("http");
const vscode = require("vscode");

const PORT = Number(process.env.SESSIONBOXER_CODE_OPEN_PORT || 7101);
const RETRY_MS = 2000;

let server = null;
let retry = null;

async function open(req) {
  if (typeof req.path !== "string" || req.path === "") throw new Error("path required");
  const uri = vscode.Uri.file(req.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = Number.isInteger(req.line) && req.line > 0 ? Math.min(req.line, doc.lineCount) - 1 : null;
  const column = Number.isInteger(req.column) && req.column > 0 ? req.column - 1 : 0;
  const options = { preview: false, preserveFocus: false };
  if (line !== null) {
    const pos = new vscode.Position(line, column);
    options.selection = new vscode.Range(pos, pos);
  }
  const editor = await vscode.window.showTextDocument(doc, options);
  if (line !== null) editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(log) {
  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/open") {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      await open(body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.appendLine(`open failed: ${message}`);
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
    }
  });
  server.on("error", (e) => {
    server = null;
    if (e && e.code === "EADDRINUSE") {
      retry = setTimeout(() => listen(log), RETRY_MS);
    } else {
      log.appendLine(`listen failed: ${e && e.message ? e.message : String(e)}`);
    }
  });
  server.listen(PORT, "127.0.0.1", () => log.appendLine(`listening on 127.0.0.1:${PORT}`));
}

function activate(context) {
  const log = vscode.window.createOutputChannel("Sessionboxer");
  context.subscriptions.push(log);
  listen(log);
}

function deactivate() {
  if (retry) clearTimeout(retry);
  if (server) server.close();
  server = null;
}

module.exports = { activate, deactivate };
