import type { Recipe } from "./provider-login.js";
import { describeKimiLogin, normalizeKimiLogin } from "./kimi-login.js";

export function kimiLoginRecipe(noBrowser: Record<string, string>): Recipe {
  return {
    bin: ["kimi"],
    args: ["login"],
    env: { ...noBrowser, KIMI_CLI_NO_AUTO_UPDATE: "1", KIMI_SHARE_DIR: "" },
    isLoginUrl: (u) => u.hostname === "www.kimi.com" && u.pathname === "/code/authorize_device",
    code: "page",
    prompt: null,
    userCode: (text) => /[?&]user_code=([A-Z0-9]+-[A-Z0-9]+)/i.exec(text)?.[1] ?? null,
    rejected: () => null,
    files: [".kimi/credentials/kimi-code.json"],
    result: (_output, file) => {
      try {
        const login = normalizeKimiLogin(file ?? "");
        return describeKimiLogin(login) ? { login, account: null } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ kimi: { KIMI_LOGIN: login } }),
  };
}
