// ---------------------------------------------------------------------------
// Code pane (UI <-> Control Plane <-> Daemon). VS Code runs inside the Sandbox as
// `openvscode-server` on the loopback interface, started on demand by the Daemon; its
// HTTP and WebSocket traffic is reverse-proxied under `CODE_PATH` on the Daemon port and
// again by the Control Plane under `/api/sessions/:id/code`, which is what the iframe loads.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { ThemeId } from "./themes.js";

export const CODE_PATH = "/code";

export const CodeServerStatus = z.object({
  state: z.enum(["stopped", "starting", "running", "failed"]),
  /** Server version (`openvscode-server --version` first line) once known. */
  version: z.string().nullable(),
  /** Why the last start failed, for the UI. */
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
});
export type CodeServerStatus = z.infer<typeof CodeServerStatus>;

/** A place in a Workspace file to show in the Code pane: a path in the chat the user clicked. */
export const CodeOpenParams = z.object({
  /** Workspace-relative (`src/a.ts`) or absolute under `/workspace`. */
  path: z.string().min(1),
  /** 1-based. */
  line: z.number().int().positive().optional(),
  /** 1-based; only with `line`. */
  column: z.number().int().positive().optional(),
});
export type CodeOpenParams = z.infer<typeof CodeOpenParams>;

/** The Sessionboxer theme the Session's VS Code should use (ADR-0048); the Daemon sets `workbench.colorTheme`. */
export const CodeThemeParams = z.object({ theme: ThemeId });
export type CodeThemeParams = z.infer<typeof CodeThemeParams>;

/** `codeStart` params: the theme to have in place before the first window connects. */
export const CodeStartParams = z.object({ theme: ThemeId.optional() });
export type CodeStartParams = z.infer<typeof CodeStartParams>;
