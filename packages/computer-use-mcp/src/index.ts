#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { currentRecording, startRecording, stopRecording } from "./recording.js";
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

server.registerTool(
  "start_recording",
  {
    description: "Start recording the desktop to an .mp4 video (H.264) until stop_recording is called. Use it to show the user a feature in motion; mention the returned path in your reply and the user gets a player for it. One recording at a time.",
    inputSchema: {
      path: z.string().optional().describe("Output file under /workspace, ending in .mp4; default recordings/<timestamp>.mp4"),
      fps: z.number().int().min(1).max(30).default(15).describe("Frames per second"),
    },
  },
  async ({ path, fps }) => okText(JSON.stringify(await startRecording(display, path, fps))),
);

server.registerTool(
  "stop_recording",
  {
    description: "Stop the running desktop recording and finalize the .mp4; returns its path, duration and size.",
    inputSchema: {},
  },
  async () => okText(JSON.stringify(await stopRecording())),
);

server.registerTool(
  "recording_status",
  { description: "Whether a desktop recording is running, and since when.", inputSchema: {} },
  async () => okText(JSON.stringify(currentRecording() ?? { recording: false })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
