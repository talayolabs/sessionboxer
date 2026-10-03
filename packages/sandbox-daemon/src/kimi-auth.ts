import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthFile } from "./auth-file.js";

export const KIMI_AGENT_ENV = { KIMI_CLI_NO_AUTO_UPDATE: "1", KIMI_SHARE_DIR: "" };

/** Kimi atomically replaces its OAuth file; link the directory so even temporary files stay on tmpfs. */
export class KimiAuth {
  private readonly auth: AuthFile;
  private current = "";
  private marker: Record<string, string> = {};

  constructor(home: string, tmpfs: string, log: (message: string) => void, onChanged: (json: string) => void) {
    const dir = join(home, ".kimi");
    const target = join(tmpfs, "kimi-credentials");
    const link = join(dir, "credentials");
    mkdirSync(dir, { recursive: true });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    let linked = false;
    try {
      linked = lstatSync(link).isSymbolicLink() && readlinkSync(link) === target;
    } catch { /* First start. */ }
    if (!linked) {
      if (existsSync(link) && !lstatSync(link).isSymbolicLink()) cpSync(link, target, { recursive: true });
      rmSync(link, { recursive: true, force: true });
      symlinkSync(target, link, "dir");
    }
    this.auth = new AuthFile("kimi", join(link, "kimi-code.json"), tmpfs, log, (json) => {
      this.current = json;
      onChanged(json);
    }, true);
    const config = join(dir, "config.toml");
    // A pasted OAuth file lacks the non-secret model config that `kimi login` also writes.
    if (!existsSync(config)) writeFileSync(config, KIMI_CONFIG);
  }

  close(): void { this.auth.close(); }

  set(login: string): Record<string, string> {
    this.auth.set(login);
    if (login !== this.current) this.marker = login ? { SESSIONBOXER_KIMI_LOGIN: randomUUID() } : {};
    this.current = login;
    return this.marker;
  }
}

const KIMI_CONFIG = `default_model = "kimi-for-coding"
default_yolo = true
telemetry = false
[providers.kimi]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""
[providers.kimi.oauth]
storage = "file"
key = "oauth/kimi-code"
[models.kimi-for-coding]
provider = "kimi"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
`;
