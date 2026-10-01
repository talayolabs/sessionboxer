import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { WorkspaceFs } from "../packages/sandbox-daemon/dist/workspace-fs.js";
import { serveRawFile } from "../packages/sandbox-daemon/dist/raw-files.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vite = await createServer({ configFile: false, root: new URL("../apps/web", import.meta.url).pathname, server: { middlewareMode: true }, appType: "custom" });
after(() => vite.close());
const { findAttachments, workspacePath, rawFileUrl } = await vite.ssrLoadModule("/src/attachment-paths.ts");
const { parseFileRef } = await vite.ssrLoadModule("/src/file-links.ts");
const report = "sessionboxer/.audit-output/2026-10-01-complete/report.md";
const skill = "sessionboxer/.devin/skills/analyzing-tool-telemetry/SKILL.md";

for (const prefix of ["/workspace/", "file:///workspace/", "file://localhost/workspace/"]) {
  test(`Markdown labels do not become root attachments: ${prefix}`, () => {
    const text = `[report.md](${prefix}${report}) and [SKILL.md](${prefix}${skill})`;
    assert.deepEqual(findAttachments(text).map((a) => a.path), [report, skill]);
  });
}

test("reference links, images and duplicate destinations use the destination, not the caption", () => {
  const text = `[report.md][doc]\n\n[doc]: file:///workspace/${report}\n\n![chart.png](/workspace/repo/charts/chart.svg)\n\n[again](/workspace/${report})`;
  assert.deepEqual(findAttachments(text).map((a) => a.path), [report, "repo/charts/chart.svg"]);
});

test("external links, anchors and code examples never produce bogus label attachments", () => {
  const text = "[report.md](https://example.com/report.md) [other.pdf](#section)\n\n```md\n[demo.md](/workspace/not-created.md)\n```";
  assert.deepEqual(findAttachments(text), []);
});

test("workspace URLs preserve hidden directories, spaces, Unicode and filenames with parentheses", () => {
  assert.equal(workspacePath("file:///workspace/repo/.reports/My%20report%20(1).md#L2"), "repo/.reports/My report (1).md");
  assert.equal(workspacePath("file:///workspace/repo/r%C3%A9sum%C3%A9.md"), "repo/résumé.md");
  assert.deepEqual(findAttachments("[report](<file:///workspace/repo/My%20report%20(1).md>)").map((a) => a.path), ["repo/My report (1).md"]);
});

test("relative links honor the document directory and query/line fragments are not part of filenames", () => {
  assert.deepEqual(findAttachments("[details](../report.md#section)", "repo/docs").map((a) => a.path), ["repo/report.md"]);
  assert.equal(workspacePath("./report.md?download=1#L5", "repo"), "repo/report.md");
});

test("local Windows and macOS file URLs resolve to the same workspace boundary", () => {
  assert.equal(workspacePath("file:///C:/workspace/repo/report.md"), "repo/report.md");
  assert.equal(workspacePath("file:///Users/agent/workspace/repo/report.md"), "repo/report.md");
  assert.equal(workspacePath("C:\\workspace\\repo\\report.md"), "repo/report.md");
});

test("URLs outside the workspace, remote file hosts, invalid escapes and traversal are rejected", () => {
  for (const path of ["file:///etc/passwd", "file://remote/workspace/report.md", "file:///workspace/%2e%2e/etc/passwd", "file:///workspace/..%2f../etc/passwd", "file:///workspace/%ZZ.md", "file:///workspace/a%00.md", "file:///D:/other/report.md", "javascript:alert(1)", "//remote/report.md"]) {
    assert.equal(workspacePath(path), null, path);
  }
  assert.deepEqual(findAttachments("[report.md](file:///etc/report.md)"), []);
});

test("file URLs with snippet lines open the correct file and line in Code", () => {
  assert.deepEqual(parseFileRef(`file:///workspace/${report}#L12-L15`), { path: report, line: 12 });
  assert.deepEqual(parseFileRef("file:///workspace/repo/src/My%20file.ts#L8C3"), { path: "repo/src/My file.ts", line: 8, column: 3 });
  assert.equal(parseFileRef("file:///etc/private.ts"), null);
});

test("existing prose, native paths and raw citation attachment discovery keep working", () => {
  assert.deepEqual(findAttachments(`Report: /workspace/${report}`).map((a) => a.path), [report]);
  assert.deepEqual(findAttachments(`<ref_file file="/workspace/${skill}" />`).map((a) => a.path), [skill]);
  assert.deepEqual(findAttachments('<ref_snippet file="/workspace/repo/My report.md" lines="1-4" />').map((a) => a.path), ["repo/My report.md"]);
  assert.deepEqual(findAttachments("Video: `./recordings/demo.mp4`").map((a) => a.path), ["recordings/demo.mp4"]);
});

test("React Markdown preserves safe file URLs until resolution, while rejecting unsafe schemes", async () => {
  const { Markdown } = await vite.ssrLoadModule("/src/Markdown.tsx");
  const { AttachmentSession } = await vite.ssrLoadModule("/src/Attachments.tsx");
  const { OpenFile } = await vite.ssrLoadModule("/src/FileLink.tsx");
  const text = `[report.md](file:///workspace/${report}) [unsafe](javascript:alert%281%29)`;
  const element = createElement(AttachmentSession.Provider, { value: "fixture" }, createElement(Markdown, { text, attachments: true }));
  const html = renderToStaticMarkup(element);
  assert.ok(html.includes(rawFileUrl("fixture", report)));
  assert.ok(!html.includes("path=report.md"));
  assert.ok(!html.includes('href="file:'));
  assert.ok(!html.includes('href="javascript:'));
  const withCode = createElement(OpenFile.Provider, { value: () => {} }, element);
  assert.ok(renderToStaticMarkup(withCode).includes(`Open ${report} in Remote VS Code`));
});

test("resolved attachment URLs pass HEAD and GET through the real workspace file handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "sessionboxer-attachments-"));
  await mkdir(join(root, "repo/.reports"), { recursive: true });
  await writeFile(join(root, "repo/.reports/report.md"), "# Fixture report\n");
  const server = createHttpServer((req, res) => void serveRawFile(new WorkspaceFs(root), req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const [attachment] = findAttachments("[report.md](file:///workspace/repo/.reports/report.md)");
    const url = `http://127.0.0.1:${server.address().port}/fs/raw?path=${encodeURIComponent(attachment.path)}`;
    assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
    assert.equal(await (await fetch(url)).text(), "# Fixture report\n");
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
