import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type Rectangle,
} from "electron";
import { dockerSocketCandidates, findDockerEngine } from "./docker.js";
import { Server, SERVER_URL, healthy, logFile, loginUrl } from "./server.js";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const ICON = fileURLToPath(new URL("../icons/icon.png", import.meta.url));
/** Cookies, service worker and storage of the web UI live here, apart from any other Electron session. */
const PARTITION = "persist:sessionboxer";
/** What the web UI may ask the window for; everything else (geolocation, camera, USB…) is refused. */
const PERMISSIONS = new Set(["notifications", "media", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "pointerLock"]);
/** Install Docker for macOS, Windows and Linux, with the engine to pick on each. */
const DOCKER_DOCS = "https://sessionboxer.talayolabs.com/#docker";
const AUTOSTART_FILE = path.join(app.getPath("appData"), "autostart", "sessionboxer.desktop");

type Prefs = { bounds?: Rectangle; trayHintShown?: boolean };

const PREFS_FILE = path.join(app.getPath("userData"), "desktop.json");

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, "utf8")) as Prefs;
  } catch {
    return {};
  }
}

function writePrefs(patch: Prefs): void {
  mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), ...patch }, null, 2));
}

const server = new Server(SERVER_URL);
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(server.url).origin;
  } catch {
    return false;
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

// --- Start at login: Electron's login item on macOS/Windows, an XDG autostart entry on Linux. ---

function startsAtLogin(): boolean {
  return process.platform === "linux" ? existsSync(AUTOSTART_FILE) : app.getLoginItemSettings().openAtLogin;
}

function setStartsAtLogin(on: boolean): void {
  if (process.platform !== "linux") return app.setLoginItemSettings({ openAtLogin: on });
  if (!on) return rmSync(AUTOSTART_FILE, { force: true });
  const exec = process.env.APPIMAGE ?? process.execPath;
  mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
  writeFileSync(
    AUTOSTART_FILE,
    ["[Desktop Entry]", "Type=Application", "Name=Sessionboxer", `Exec="${exec}"`, "Icon=sessionboxer", "X-GNOME-Autostart-enabled=true", ""].join("\n"),
  );
}

// --- Window ---

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...(readPrefs().bounds ?? { width: 1280, height: 860 }),
    minWidth: 480,
    minHeight: 360,
    title: "Sessionboxer",
    ...(process.platform === "linux" ? { icon: ICON } : {}),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  w.once("ready-to-show", () => w.show());
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
    if (!readPrefs().trayHintShown) {
      writePrefs({ trayHintShown: true });
      notify("Sessionboxer keeps running", `The server and your Sessions stay up in the ${process.platform === "darwin" ? "menu bar" : "tray"}; quit from there to stop them.`);
    }
  });
  let saveBounds: NodeJS.Timeout | undefined;
  const remember = (): void => {
    clearTimeout(saveBounds);
    saveBounds = setTimeout(() => {
      if (!w.isDestroyed() && !w.isMaximized() && !w.isFullScreen()) writePrefs({ bounds: w.getBounds() });
    }, 500);
  };
  w.on("resize", remember);
  w.on("move", remember);
  // Same-origin pop-ups (a Session's Code or Desktop in its own window) stay inside; anything else goes to the default browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (sameOrigin(url) || url.startsWith("file:")) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  return w;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function loadStarting(error?: string): void {
  if (!win || win.isDestroyed()) return;
  void win.loadFile(path.join(ASSETS, "starting.html"), error === undefined ? {} : { query: { error } });
}

async function loadApp(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const ses = session.fromPartition(PARTITION);
  const res = await ses.fetch(`${server.url}/api/auth/me`).catch(() => null);
  const me = res?.ok ? ((await res.json()) as { principal: unknown }) : null;
  await win.loadURL(me?.principal ? server.url : await loginUrl(server.url));
}

// --- Tray ---

function statusLine(): string {
  const s = server.state;
  switch (s.kind) {
    case "starting":
      return "Starting the server…";
    case "running":
      return s.mode === "attached" ? `Using the Sessionboxer already running at ${server.url}` : `Serving ${server.url}`;
    case "stopped":
      return `Server stopped${s.code === null ? "" : ` (exit code ${s.code})`}`;
    case "failed":
      return "Server failed to start";
  }
}

function trayMenu(): Menu {
  const running = server.state.kind === "running";
  const idle = server.state.kind === "stopped" || server.state.kind === "failed";
  const items: MenuItemConstructorOptions[] = [
    { label: "Open Sessionboxer", click: showWindow },
    { label: "Open in browser", enabled: running, click: () => void shell.openExternal(server.url) },
    { type: "separator" },
    { label: statusLine(), enabled: false },
    { label: "Restart server", visible: idle, click: () => void startServer() },
    { label: "Show server log", visible: server.managed, click: () => shell.showItemInFolder(logFile()) },
    { type: "separator" },
    { label: "Start at login", type: "checkbox", checked: startsAtLogin(), click: (item) => setStartsAtLogin(item.checked) },
    { label: "Quit Sessionboxer", click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(items);
}

function refreshTray(): void {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  tray.setToolTip(`Sessionboxer — ${statusLine()}`);
}

function createTray(): Tray {
  const t = new Tray(nativeImage.createFromPath(path.join(ASSETS, "tray.png")));
  t.on("click", () => {
    if (process.platform === "darwin") return;
    showWindow();
  });
  t.on("double-click", showWindow);
  return t;
}

// --- Server lifecycle ---

/** Asks for Docker until an engine appears (or the user quits); the Control Plane cannot boot without one. */
async function requireDocker(): Promise<{ DOCKER_HOST?: string } | null> {
  const install =
    process.platform === "darwin"
      ? "Install OrbStack or Docker Desktop for Mac, open it once and wait until it says it is running, then Try again."
      : process.platform === "win32"
        ? "Install Docker Desktop with the WSL 2 engine and start it, then Try again."
        : "Install Docker Engine (https://get.docker.com), make sure your user can run `docker`, then Try again.";
  for (let attempt = 0; ; attempt++) {
    const engine = findDockerEngine();
    if (engine) return engine.env;
    const looked = `Looked at DOCKER_HOST (unset) and ${dockerSocketCandidates().join(", ")}.`;
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "Docker is required",
      message: attempt === 0 ? "Sessionboxer runs each Session in a Docker container, and no Docker engine was found on this machine." : "Still no Docker engine on this machine.",
      detail: `${install}\n\n${looked}`,
      buttons: ["Get Docker", "Try again", "Quit"],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) void shell.openExternal(DOCKER_DOCS);
    if (response === 2) return null;
  }
}

async function startServer(): Promise<void> {
  loadStarting();
  let env: NodeJS.ProcessEnv = {};
  if (!(await healthy(server.url))) {
    const docker = await requireDocker();
    if (docker === null) return app.quit();
    env = docker;
  }
  await server.start(env);
  const s = server.state;
  if (s.kind === "running") return loadApp();
  if (s.kind === "failed") loadStarting(s.message);
}

// --- App ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("com.talayolabs.sessionboxer");
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    // The server keeps running; the tray is the app now.
  });
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    tray?.setToolTip("Sessionboxer — stopping the server…");
    win?.close();
    server.stop().finally(() => app.exit(0));
  });

  server.onChange((state) => {
    refreshTray();
    if (state.kind === "stopped" && !quitting) notify("Sessionboxer's server stopped", `Exit code ${state.code ?? "unknown"}. Open the tray menu to restart it or read its log.`);
  });

  // `ready` fires only once this module has finished evaluating, so it cannot be awaited at the top level (Electron's ESM caveat).
  void app.whenReady().then(() => {
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const camera = permission === "media" && "mediaTypes" in details && details.mediaTypes?.includes("video") === true;
      callback(sameOrigin(details.requestingUrl) && PERMISSIONS.has(permission) && !camera);
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => sameOrigin(origin) && PERMISSIONS.has(permission));
    tray = createTray();
    refreshTray();
    win = createWindow();
    return startServer();
  });
}
