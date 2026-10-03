// The shared Windows and macOS base disks behind the QEMU Sandboxes.
import { type Hono } from "hono";
import { bridgeDesktop } from "../desktop-proxy.js";
import { log } from "../log.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerVmBaseRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { windows, macos, upgradeWebSocket } = deps;
  /** The shared Windows base disk (ADR-0057): its state, and installing / cancelling / deleting it. */
  api.get("/windows", (c) => c.json(windows.status()));
  api.post("/windows/install", async (c) => c.json(await windows.install()));
  api.post("/windows/cancel", async (c) => c.json(await windows.cancelInstall()));
  api.delete("/windows", async (c) => c.json(await windows.removeBase()));

  /** The shared macOS base disk (ADR-0059): its state, installing / cancelling / deleting it, and its screen while it installs. */
  api.get("/macos", (c) => c.json(macos.status()));
  api.post("/macos/install", async (c) => c.json(await macos.install()));
  api.post("/macos/cancel", async (c) => c.json(await macos.cancelInstall()));
  api.post("/macos/reprovision", async (c) => c.json(await macos.reprovision()));
  api.delete("/macos", async (c) => c.json(await macos.removeBase()));
  api.get(
    "/macos/screen",
    upgradeWebSocket(async () => {
      const target = await macos.screenUrl();
      return {
        onOpen(_evt, ws) {
          if (!ws.raw) return;
          bridgeDesktop(ws.raw, target, log);
        },
        onError(err) {
          log(`macos screen ws error: ${String(err)}`);
        },
      };
    }),
  );
}
