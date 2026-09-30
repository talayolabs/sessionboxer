import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk";
import type { PromptAttachment } from "@sessionboxer/protocol";

/** Anthropic's per-image API limit; larger images are only referenced by path. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Text files up to this size ride along as embedded context (roughly 16k tokens); larger ones by path. */
const MAX_INLINE_TEXT_BYTES = 64 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The ACP prompt for a user message with attachments: the text plus a list of the files' paths
 * in the Sandbox (so tools can reach every file), and, where the Agent accepts them, the files
 * themselves — images as image blocks, small text files as embedded resources.
 */
export async function promptBlocks(
  text: string,
  attachments: PromptAttachment[],
  workspace: string,
  caps: PromptCapabilities,
  log: (msg: string) => void,
  /** The path the Agent knows the file by when it runs on another machine (a Windows VM); the local one when not given. */
  agentPath?: (rel: string) => string,
): Promise<{ text: string; blocks: ContentBlock[] }> {
  if (attachments.length === 0) return { text, blocks: [] };

  const root = resolve(workspace);
  const lines: string[] = [];
  const blocks: ContentBlock[] = [];
  for (const a of attachments) {
    const abs = resolve(root, a.path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      log(`attachment ${a.path} escapes the workspace; sent by path only`);
      lines.push(`- ${a.path} (${a.mimeType}, ${formatBytes(a.size)})`);
      continue;
    }
    const inline = await inlineBlock(abs, a, caps, log);
    if (inline) blocks.push(inline);
    const shown = agentPath ? agentPath(a.path) : abs;
    lines.push(`- ${shown} (${a.mimeType}, ${formatBytes(a.size)})${inline ? inline.type === "image" ? " — shown to you below" : " — contents included below" : ""}`);
  }

  const intro = text.trim() === "" ? "" : `${text}\n\n`;
  const header = `${intro}The user attached ${attachments.length === 1 ? "this file" : "these files"} (saved on your machine; use the paths with your tools):\n${lines.join("\n")}`;
  const media = attachments.some((a) => a.mimeType.startsWith("video/") || a.mimeType.startsWith("audio/"));
  return { text: media ? `${header}\n\n${MEDIA_HINT}` : header, blocks };
}

/**
 * What to do with a video or audio attachment (a screen recording with narration, a clip filmed with
 * the camera, a voice note): the model cannot watch it, so it is told the way through — the
 * `sessionboxer` MCP's `transcribe_media` for the words with their times, ffmpeg for the frames.
 */
const MEDIA_HINT = [
  "For a video or audio file: transcribe it first with the `transcribe_media` tool of the `sessionboxer` MCP (speech to text with timestamps).",
  "Read the transcript as the user's instructions. Whenever the speaker refers to something on screen (\"this button\", \"here\", \"look at this error\"), extract the frame at that time with ffmpeg",
  "(`ffmpeg -ss <seconds> -i <file> -frames:v 1 <out>.png`) and look at the image to see what is meant; a few frames spread over the clip show what it is about when nobody speaks.",
  "Do not guess the content of the video from its name.",
].join(" ");

async function inlineBlock(abs: string, a: PromptAttachment, caps: PromptCapabilities, log: (msg: string) => void): Promise<ContentBlock | null> {
  const uri = `file://${abs}`;
  try {
    if (caps.image && INLINE_IMAGE_TYPES.has(a.mimeType) && a.size <= MAX_INLINE_IMAGE_BYTES) {
      const data = await fs.readFile(abs);
      return { type: "image", data: data.toString("base64"), mimeType: a.mimeType, uri };
    }
    if (caps.embeddedContext && a.size <= MAX_INLINE_TEXT_BYTES && !a.mimeType.startsWith("image/")) {
      const data = await fs.readFile(abs);
      const text = asText(data);
      if (text !== null) return { type: "resource", resource: { uri, mimeType: a.mimeType, text } };
    }
  } catch (e) {
    log(`could not inline ${a.path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

/** The bytes as a string when they are valid UTF-8 without NUL bytes (i.e. a text file), else `null`. */
function asText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
