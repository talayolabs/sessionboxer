#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { E2eError, e2eCall, type E2eMethod } from "./e2e.js";
import { NARRATION_LANGUAGES, NARRATION_VOICES } from "./narration.js";
import { annotateRecording, currentRecording, narrateRecording, startRecording, stopRecording } from "./recording.js";
import {
  click,
  cursorPosition,
  displayFromEnv,
  drag,
  holdKey,
  key,
  mouseDown,
  mouseMove,
  mouseUp,
  screenshotPng,
  scroll,
  sleep,
  typeText,
  zoomPng,
  type Coordinate,
  type Region,
} from "./x11.js";

const display = displayFromEnv();

const coordinate = z
  .tuple([z.number().int(), z.number().int()])
  .describe(`[x, y] pixel coordinate on the ${display.width}x${display.height} screen, origin top-left`);

const server = new McpServer({ name: "computer-use", version: "0.0.0" });

const okText = (text = "OK") => ({ content: [{ type: "text" as const, text }] });
const image = (png: Buffer) => ({ content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] });

server.registerTool(
  "screenshot",
  {
    description: `Take a screenshot of the whole ${display.width}x${display.height} desktop. Call this before acting and after any action whose result you need to see; other tools only return "OK".`,
    inputSchema: {},
  },
  async () => image(await screenshotPng(display)),
);

server.registerTool(
  "zoom",
  {
    description: "Capture a rectangular region of the screen and scale it up to full screen size, to read small text or inspect details. Coordinates you see in the zoomed image are NOT screen coordinates; map them back through the region.",
    inputSchema: {
      region: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]).describe("[x0, y0, x1, y1] of the region, top-left and bottom-right corners in screen coordinates"),
    },
  },
  async ({ region }) => image(await zoomPng(display, region as Region)),
);

server.registerTool(
  "cursor_position",
  { description: "Return the current [x, y] position of the mouse cursor.", inputSchema: {} },
  async () => {
    const [x, y] = await cursorPosition(display);
    return okText(JSON.stringify({ x, y }));
  },
);

server.registerTool(
  "mouse_move",
  { description: "Move the mouse cursor to a coordinate without clicking.", inputSchema: { coordinate } },
  async ({ coordinate: c }) => {
    await mouseMove(display, c as Coordinate);
    return okText();
  },
);

const clickInput = { coordinate: coordinate.optional().describe("Where to click; omitted = current cursor position") };

server.registerTool("left_click", { description: "Click the left mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, 1, 1, c as Coordinate | undefined);
  return okText();
});
server.registerTool("right_click", { description: "Click the right mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, 3, 1, c as Coordinate | undefined);
  return okText();
});
server.registerTool("middle_click", { description: "Click the middle mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, 2, 1, c as Coordinate | undefined);
  return okText();
});
server.registerTool("double_click", { description: "Double-click the left mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, 1, 2, c as Coordinate | undefined);
  return okText();
});
server.registerTool("triple_click", { description: "Triple-click the left mouse button (selects a line/paragraph in most apps).", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await click(display, 1, 3, c as Coordinate | undefined);
  return okText();
});

server.registerTool(
  "left_click_drag",
  {
    description: "Press the left button at start_coordinate, move to coordinate, release.",
    inputSchema: { start_coordinate: coordinate, coordinate },
  },
  async ({ start_coordinate, coordinate: c }) => {
    await drag(display, start_coordinate as Coordinate, c as Coordinate);
    return okText();
  },
);

server.registerTool("left_mouse_down", { description: "Press and hold the left mouse button (pair with left_mouse_up).", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await mouseDown(display, 1, c as Coordinate | undefined);
  return okText();
});
server.registerTool("left_mouse_up", { description: "Release the left mouse button.", inputSchema: clickInput }, async ({ coordinate: c }) => {
  await mouseUp(display, 1, c as Coordinate | undefined);
  return okText();
});

server.registerTool(
  "type",
  {
    description: "Type a string of text at the current focus, as a keyboard would. Use `key` for shortcuts and special keys.",
    inputSchema: { text: z.string().min(1) },
  },
  async ({ text }) => {
    await typeText(display, text);
    return okText();
  },
);

server.registerTool(
  "key",
  {
    description: 'Press a key or key combination using xdotool key names, e.g. "Return", "Escape", "ctrl+s", "alt+Tab", "super", "ctrl+shift+t", "Page_Down". Separate multiple sequential presses with spaces.',
    inputSchema: { text: z.string().min(1) },
  },
  async ({ text }) => {
    await key(display, text);
    return okText();
  },
);

server.registerTool(
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

server.registerTool(
  "scroll",
  {
    description: "Scroll the mouse wheel at a coordinate.",
    inputSchema: {
      coordinate: coordinate.optional(),
      scroll_direction: z.enum(["up", "down", "left", "right"]),
      scroll_amount: z.number().int().min(1).max(50).default(3).describe("Number of wheel clicks"),
    },
  },
  async ({ coordinate: c, scroll_direction, scroll_amount }) => {
    await scroll(display, scroll_direction, scroll_amount, c as Coordinate | undefined);
    return okText();
  },
);

server.registerTool(
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

server.registerTool(
  "start_recording",
  {
    description:
      "Start recording the desktop to an .mp4 video (H.264) until stop_recording is called. Use it to show the user a feature in motion; mention the returned path in your reply and the user gets a player for it. While recording, call annotate_recording before each step so the video carries captions of what is happening. One recording at a time.",
    inputSchema: {
      path: z.string().optional().describe("Output file under /workspace, ending in .mp4; default recordings/<timestamp>.mp4"),
      fps: z.number().int().min(1).max(30).default(15).describe("Frames per second"),
    },
  },
  async ({ path, fps }) => okText(JSON.stringify(await startRecording(display, path, fps))),
);

server.registerTool(
  "annotate_recording",
  {
    description:
      "Add a caption to the running desktop recording at this moment: one short sentence saying what you are about to do or what the screen now shows (e.g. 'Submitting the form with an empty email'). It stays on screen until the next annotation. Call it right before each step; captions are burned into the video and written as a subtitle track when the recording stops.",
    inputSchema: { text: z.string().min(1).max(300).describe("Caption text, one short sentence") },
  },
  async ({ text }) => okText(JSON.stringify(annotateRecording(text))),
);

server.registerTool(
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

server.registerTool(
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

server.registerTool(
  "recording_status",
  { description: "Whether a desktop recording is running, since when, and how many captions it has.", inputSchema: {} },
  async () => okText(JSON.stringify(currentRecording() ?? { recording: false })),
);

// --- End-to-end verification runs (ADR-0044) -------------------------------------------------
// The Control Plane opens a run after a user turn and asks for the `e2e-verification` skill; these
// tools fill the run in (Daemon → Control Plane) so the user's Verification pane follows along.

const e2eTool = async (method: E2eMethod, params: unknown) => {
  try {
    return okText(JSON.stringify(await e2eCall(method, params)));
  } catch (e) {
    if (e instanceof E2eError) return { isError: true as const, content: [{ type: "text" as const, text: e.message }] };
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
