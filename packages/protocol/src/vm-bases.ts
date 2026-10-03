// ---------------------------------------------------------------------------
// The shared base disks of the QEMU Environments (`/api/windows`, `/api/macos`): installed once,
// every `qemu-windows` / `qemu-macos` Session's VM disk is an overlay on one of them.
// ---------------------------------------------------------------------------

import { z } from "zod";

/**
 * `GET /api/windows`: the shared Windows base disk every `qemu-windows` Session's VM starts from
 * (ADR-0057). Installed once from Microsoft's media by `POST /api/windows/install` (a long
 * unattended install); a Session cannot be created while it is `missing`.
 */
export const WindowsBaseStatus = z.object({
  state: z.enum(["missing", "installing", "ready", "error"]),
  /** The Windows edition the base was (or is being) installed with, a `WindowsSettings.version` code. */
  version: z.string().nullable(),
  /** Bytes the base disk takes on this machine (0 until installed). */
  sizeBytes: z.number(),
  /** ISO 8601, while `installing`. */
  startedAt: z.string().nullable(),
  /** The last lines the installer printed, while `installing` or after an `error`. */
  log: z.array(z.string()),
  error: z.string().nullable(),
  /** Sessions whose VM disk builds on this base; it cannot be reinstalled while there are any. */
  sessions: z.number().int().nonnegative(),
});
export type WindowsBaseStatus = z.infer<typeof WindowsBaseStatus>;

/**
 * `GET /api/macos`: the shared macOS base disk every `qemu-macos` Session's VM starts from
 * (ADR-0059). Unlike Windows, macOS has no unattended installer: `POST /api/macos/install` boots
 * Apple's Recovery in a VM (`installing`), then the user installs macOS and creates the account by
 * hand in the VM's screen (`setup`); once the guest answers on SSH the Control Plane finishes the
 * base (`finishing`) and shuts the VM down (`ready`).
 */
export const MacosBaseStatus = z.object({
  state: z.enum(["missing", "installing", "setup", "finishing", "ready", "error"]),
  /**
   * Whether the base carries the toolchain the Agent needs in the guest (Node, git, uv, the Provider
   * CLIs; ADR-0061). False for a base installed before that: "Reprovision" adds it in place.
   */
  toolchain: z.boolean(),
  /** While `installing`/`setup`/`finishing`: this run only reprovisions an existing base (no Recovery, no Setup Assistant). */
  reprovisioning: z.boolean(),
  /** The macOS release the base was (or is being) installed with, a `MacosSettings.version` code. */
  version: z.string().nullable(),
  /** Bytes the base disk takes on this machine (0 until installed). */
  sizeBytes: z.number(),
  /** ISO 8601, while `installing`, `setup` or `finishing`. */
  startedAt: z.string().nullable(),
  /** The last lines the VM container printed, while installing or after an `error`. */
  log: z.array(z.string()),
  error: z.string().nullable(),
  /** Sessions whose VM disk builds on this base; it cannot be reinstalled while there are any. */
  sessions: z.number().int().nonnegative(),
  /**
   * While `setup`: the account the user must create in the guest, so the Sandbox can log in over
   * SSH later, and where the VM's screen is (`GET /api/macos/screen`, a noVNC websocket).
   */
  setup: z
    .object({
      user: z.string(),
      password: z.string(),
      /** The steps left, as shown in Global settings. */
      steps: z.array(z.string()),
    })
    .nullable(),
});
export type MacosBaseStatus = z.infer<typeof MacosBaseStatus>;
