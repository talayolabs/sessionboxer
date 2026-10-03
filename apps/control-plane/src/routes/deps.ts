// What the route handlers close over: the services index.ts constructs once. Instances, never
// factories — a handler must not build its own.
import type { createNodeWebSocket } from "@hono/node-ws";
import type { PublicSettings, Settings, UpdateSettingsRequest } from "@sessionboxer/protocol";
import type { Auth } from "../auth.js";
import type { Automations } from "../automations.js";
import type { Connectors } from "../connectors.js";
import type { Db } from "../db.js";
import type { SandboxDocker } from "../docker.js";
import type { FollowedPrs } from "../followed-prs.js";
import type { MacosVms } from "../macos.js";
import type { ProviderLogins } from "../provider-login.js";
import type { PushNotifier } from "../push.js";
import type { SessionManager } from "../sessions.js";
import type { Speech } from "../speech.js";
import type { Tunnels } from "../tunnels.js";
import type { WindowsVms } from "../windows.js";

/** The live Settings: `index.ts` owns the variable; `set` also writes the config file. */
export interface SettingsStore {
  get(): Settings;
  set(next: Settings): void;
}

export interface RouteDeps {
  db: Db;
  docker: SandboxDocker;
  sessions: SessionManager;
  automations: Automations;
  followedPrs: FollowedPrs;
  auth: Auth;
  push: PushNotifier;
  windows: WindowsVms;
  macos: MacosVms;
  speech: Speech;
  tunnels: Tunnels;
  connectors: Connectors;
  providerLogins: ProviderLogins;
  settings: SettingsStore;
  publicSettings: () => Promise<PublicSettings>;
  /** Stores a Settings change and pushes what changed to the live Sessions. */
  applySettings: (update: UpdateSettingsRequest) => Promise<void>;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
}
