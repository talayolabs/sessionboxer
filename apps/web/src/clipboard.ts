/** Writes `text` (and, when given, its HTML rendering) to the clipboard; the copy-event route
 *  covers pages without the async API (plain http on a LAN host). */
export async function writeClipboard(text: string, html?: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (html && clipboard?.write && typeof ClipboardItem !== "undefined") {
    await clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    return;
  }
  if (!html && clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
    if (html) e.clipboardData?.setData("text/html", html);
  };
  document.addEventListener("copy", onCopy);
  try {
    if (!document.execCommand("copy")) throw new Error("copy command failed");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

/** Saves `text` as a file named `name` (the browser's download). */
export function downloadText(name: string, text: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
