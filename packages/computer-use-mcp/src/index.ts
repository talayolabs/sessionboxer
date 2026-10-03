#!/usr/bin/env node
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { fingerprint, instrumentTool, reportMcpExecution } from "@sessionboxer/protocol/node-telemetry";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NARRATION_LANGUAGES, NARRATION_VOICES } from "./narration.js";
import { annotateRecording, currentRecording, narrateRecording, recordingTrace, startRecording, stopRecording } from "./recording.js";
import { fillUtilityPlaceholders, hasUtilityPlaceholder } from "./utilities.js";
import {
  click,
  cursorPosition,
  displayFromEnv,
  drag,
  FAST_PACE,
  holdKey,
  key,
  mouseDown,
  mouseMove,
  mouseUp,
  RECORDED_PACE,
  screenshotPng,
  scroll,
  sleep,
  typeText,
  zoomPng,
  type Coordinate,
  type Hand,
  type Region,
} from "./x11.js";

const display = displayFromEnv();

/** While a recording runs, actions slow down to a hand's pace and the pointer's path is traced, so the video shows them happen. */
const hand = (): Hand => (currentRecording() ? { pace: RECORDED_PACE, trace: recordingTrace } : { pace: FAST_PACE });

const coordinate = z
  .array(z.number().int()).length(2)
  .describe(`[x, y] pixel coordinate on the ${display.width}x${display.height} screen, origin top-left`);

const server = new McpServer({ name: "computer-use", version: "0.0.0" });

function registerTool<Shape extends z.ZodRawShape>(name: string, config: { description: string; inputSchema: Shape }, callback: ToolCallback<Shape>) {
  const schemaHash = fingerprint({ name, description: config.description, inputSchema: toJsonSchemaCompat(z.object(config.inputSchema)) });
  return server.registerTool(name, config, instrumentTool(schemaHash, callback, reportMcpExecution("desktop", name)) as unknown as ToolCallback<Shape>);
}

const okText = (text = "OK") => ({ content: [{ type: "text" as const, text }] });
const image = (png: Buffer) => ({ content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] });

registerTool(
  "screenshot",
  {
    description: `Take a screenshot of the whole ${display.width}x${display.height} desktop. Call this before acting and after any action whose result you need to see; other tools only return "OK".`,
    inputSchema: {},
  },
  async () => image(await screenshotPng(display)),
);

registerTool(
  "zoom",
  {
    description: 'Capture a rectangular region of the screen and scale it up to full screen size, to read small text or inspect details. Pass `region`: [x0, y0, x1, y1], the top-left and bottom-right screen corners, not x/y/width/height. Example: {"region":[100,120,500,420]}. Do not use `coordinate` or separate `x`, `y`, `width`, `height` arguments. Coordinates you see in the zoomed image are NOT screen coordinates; map them back through the region.',
    inputSchema: {
      region: z.array(z.number().int()).length(4).describe("Required [x0, y0, x1, y1] screen corners, not a position and size; x1 > x0 and y1 > y0"),
    },
  },
  async ({ region }) => image(await zoomPng(display, region as Region)),
);

registerTool(
  "cursor_position",
  { description: "Return the current [x, y] position of the mouse cursor.", inputSchema: {} },
  async () => {
    const [x, y] = await cursorPosition(display);
    return okText(JSON.stringify({ x, y }));
  },
);

registerTool(
  "mouse_move",
  { description: "Move the mouse cursor to a coordinate without clicking.", inputSchema: { coordinate } },
  async ({ coordinate: c }) => {
    await mouseMove(display, hand(), c as Coordinate);
    return okText();
  },
);

const clickInput = { coordinate: coordinate.optional().describe("Where to click; omitted = current cursor position") };

registerTool("left_click", { description: "Click the left mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, hand(), 1, 1, c as Coordinate | undefined);
  return okText();
});
registerTool("right_click", { description: "Click the right mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, hand(), 3, 1, c as Coordinate | undefined);
  return okText();
});
registerTool("middle_click", { description: "Click the middle mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, hand(), 2, 1, c as Coordinate | undefined);
  return okText();
});
registerTool("double_click", { description: "Double-click the left mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, hand(), 1, 2, c as Coordinate | undefined);
  return okText();
});
registerTool("triple_click", { description: "Triple-click the left mouse button (selects a line/paragraph in most apps).", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, hand(), 1, 3, c as Coordinate | undefined);
  return okText();
});

registerTool(
  "left_click_drag",
  {
    description: "Press the left button at start_coordinate, move to coordinate, release.",
    inputSchema: { start_coordinate: coordinate, coordinate },
  },
  async ({ start_coordinate, coordinate: c }) => {
    await drag(display, hand(), start_coordinate as Coordinate, c as Coordinate);
    return okText();
  },
);

registerTool("left_mouse_down", { description: "Press and hold the left mouse button (pair with left_mouse_up).", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await mouseDown(display, hand(), 1, c as Coordinate | undefined);
  return okText();
});
registerTool("left_mouse_up", { description: "Release the left mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await mouseUp(display, hand(), 1, c as Coordinate | undefined);
  return okText();
});

registerTool(
  "type",
  {
    description:
      "Type a string of text at the current focus, as a keyboard would. Use `key` for shortcuts and special keys. `${util:<utility>.<credential>}` (or `.otp` for a one-time code) is replaced by that Utility's credential as it is typed (see .sessionboxer/utilities.json); you never see the value.",
    inputSchema: { text: z.string().min(1) },
  },
  async ({ text }) => {
    const filled = await fillUtilityPlaceholders(text);
    await typeText(display, hand(), filled);
    if (hasUtilityPlaceholder(text)) return okText(filled === text ? "OK (a ${util:…} placeholder was typed as written: no such Utility or credential is enabled)" : "OK (Utility credentials filled in)");
    return okText();
  },
);

registerTool(
  "key",
  {
    description: 'Press a key or key combination using xdotool key names. Pass the required `text` argument, not `key`. Example: {"text":"ctrl+s"}. Other key names include "Return", "Escape", "alt+Tab", "super", "ctrl+shift+t", "Page_Down". Separate multiple sequential presses with spaces.',
    inputSchema: { text: z.string().min(1).describe("Required xdotool key name or combination, e.g. Return or ctrl+s; separate sequential presses with spaces") },
  },
  async ({ text }) => {
    await key(display, text);
    return okText();
  },
);

registerTool(
  "hold_key",
  {
    description: "Hold a key or combination down for a duration in seconds, then release.",
    inputSchema: { text: z.string().min(1), duration: z.number().positive().max(30) },
  },
  async ({ text, duration }) => {
    await holdKey(display, text, duration);
    return okText();
  },
);

registerTool(
  "scroll",
  {
    description: 'Scroll the mouse wheel. Required `scroll_direction`: up, down, left or right. Optional `scroll_amount`: 1-50 wheel clicks (default 3), and `coordinate`: [x, y] (omitted = current cursor position). Example: {"scroll_direction":"down","scroll_amount":3,"coordinate":[640,360]}. Use `scroll_direction` and `scroll_amount`, not `direction` and `amount`.',
    inputSchema: {
      coordinate: coordinate.optional().describe("Optional [x, y] screen position to move to before scrolling; omitted = current cursor position"),
      scroll_direction: z.enum(["up", "down", "left", "right"]).describe("Required direction of scrolling: up, down, left or right"),
      scroll_amount: z.number().int().min(1).max(50).default(3).describe("Optional number of wheel clicks, 1-50; default 3, not a pixel distance"),
    },
  },
  async ({ coordinate: c, scroll_direction, scroll_amount }) => {
    await scroll(display, hand(), scroll_direction, scroll_amount, c as Coordinate | undefined);
    return okText();
  },
);

registerTool(
  "wait",
  {
    description: "Wait for a number of seconds (for pages to load, animations to finish; default 2), then return a screenshot.",
    inputSchema: { duration: z.number().positive().max(60).default(2) },
  },
  async ({ duration }) => {
    await sleep(duration * 1000);
    return image(await screenshotPng(display));
  },
);

const narrationSchema = {
  narration_language: z
    .enum(NARRATION_LANGUAGES as [string, ...string[]])
    .optional()
    .describe("Language the captions are written in (default en); picks the voice unless narration_voice is given"),
  narration_voice: z
    .enum(NARRATION_VOICES as [string, ...string[]])
    .optional()
    .describe("Kokoro voice; the first letter is the language (a en-US, b en-GB, e es, f fr, h hi, i it, p pt-BR), the second f/m"),
  narration_speed: z.number().min(0.7).max(1.5).default(1).describe("Speaking rate multiplier"),
};

registerTool(
  "start_recording",
  {
    description:
      "Start recording the desktop to an .mp4 video (H.264) until stop_recording is called. Use it to show the user a feature in motion; mention the returned path in your reply and the user gets a player for it. While recording, call annotate_recording before each step so the video carries captions of what is happening. One recording at a time.",
    inputSchema: {
      path: z.string().optional().describe("Output file under /workspace, ending in .mp4; default recordings/<timestamp>.mp4"),
      fps: z.number().int().min(1).max(60).default(30).describe("Frames per second (30 shows the pointer travel and typing smoothly; 60 for animations)"),
    },
  },
  async ({ path, fps }) => okText(JSON.stringify(await startRecording(display, path, fps, await cursorPosition(display)))),
);

registerTool(
  "annotate_recording",
  {
    description:
      "Add a caption to the running desktop recording at this moment: one short sentence saying what you are about to do or what the screen now shows (e.g. 'Submitting the form with an empty email'). It stays on screen until the next annotation. Call it right before each step; captions are burned into the video and written as a subtitle track when the recording stops.",
    inputSchema: { text: z.string().min(1).max(300).describe("Caption text, one short sentence") },
  },
  async ({ text }) => okText(JSON.stringify(annotateRecording(text))),
);

registerTool(
  "stop_recording",
  {
    description:
      "Stop the running desktop recording and finalize the .mp4; returns its path, duration, size and the captions with their final times. By default the video is condensed: stretches where nothing changes on screen are cut to a short hold each, so waiting (page loads, builds) does not pad the video while every state stays readable. Captions from annotate_recording are burned into a band under the desktop and saved as a .vtt subtitle file next to the video. Narration: the captions can also be spoken (local TTS) into an audio track; the user's Settings decide when that happens by itself (`narration.added`), is skipped, or must be asked about first (`narration.pending` with the estimated extra processing time: ask the user, and call narrate_recording if they want it). Pass narration_language matching the language you wrote the captions in.",
    inputSchema: {
      condense: z.boolean().default(true).describe("Collapse static stretches; false keeps the real timing (for animations or performance demos)"),
      hold_seconds: z.number().min(0.5).max(10).default(1.5).describe("How long a static stretch stays on screen after condensing"),
      captions: z
        .enum(["both", "burn", "track", "none"])
        .default("both")
        .describe("What to do with annotations: burn them into the frames, write a .vtt subtitle track, both, or drop them"),
      narrate: z.boolean().optional().describe("Force narration on or off for this video, e.g. because the user just asked for it; omit to follow the user's Settings"),
      ...narrationSchema,
    },
  },
  async ({ condense, hold_seconds, captions, narrate, narration_language, narration_voice, narration_speed }) =>
    okText(
      JSON.stringify(
        await stopRecording({
          condense,
          holdSeconds: hold_seconds,
          captions,
          narrate,
          narration: { language: narration_language, voice: narration_voice, speed: narration_speed },
        }),
      ),
    ),
);

registerTool(
  "narrate_recording",
  {
    description:
      "Add spoken narration (local TTS of its captions) to a finished recording, when stop_recording reported `narration.pending` and the user agreed, or when the user asks for narration afterwards. Rewrites the .mp4 in place with an audio track; steps shorter than their sentence hold their last frame, so the video may get slightly longer, and the returned captions/.vtt carry the new times. Mention the path again so the user gets the narrated player.",
    inputSchema: {
      path: z.string().describe("The recording's path, as returned by stop_recording"),
      ...narrationSchema,
    },
  },
  async ({ path, narration_language, narration_voice, narration_speed }) =>
    okText(JSON.stringify(await narrateRecording(path, { language: narration_language, voice: narration_voice, speed: narration_speed }))),
);

registerTool(
  "recording_status",
  { description: "Whether a desktop recording is running, since when, and how many captions it has.", inputSchema: {} },
  async () => okText(JSON.stringify(currentRecording() ?? { recording: false })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
