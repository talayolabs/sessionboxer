import { useRef } from "react";
import type { CopilotLogin, PublicSettings } from "@sessionboxer/protocol";
import { CopyCommand } from "../CopyCommand";
import { Caption } from "../ui";
import type { Setter } from "./shared";

/** One line about the stored GitHub Copilot login (ADR-0082), from its metadata only. */
export function describeCopilotLogin(login: CopilotLogin): string {
  const token = login.tokenKind === "pat" ? "fine-grained GitHub token" : login.tokenKind === "oauth" ? "GitHub OAuth token" : "GitHub token";
  const what = login.kind === "config" ? `config.json of \`copilot login\` (${token})` : token;
  return login.login ? `${what}, ${login.login}` : what;
}

/** Global settings → Providers → GitHub Copilot: paste or import the login, with the help popover and "Forget". */
export function CopilotLoginCard({
  settings,
  login,
  setLogin,
  forget,
  setForget,
}: {
  settings: PublicSettings;
  login: string;
  setLogin: Setter<string>;
  forget: boolean;
  setForget: Setter<boolean>;
}) {
  const stored = settings.providerSecretsSet.copilot.COPILOT_LOGIN;
  const loginSet = stored && !forget;
  const fileRef = useRef<HTMLInputElement>(null);
  const importFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setLogin(text);
      setForget(false);
    });
  };
  return (
    <>
      <label>
        <Caption
          help={
            <>
              <p>
                GitHub Copilot CLI runs on your Copilot subscription (Free, Pro, Pro+, Business or Enterprise with the CLI enabled). Sign in
                with GitHub Copilot above, or paste a GitHub token with the <em>Copilot Requests</em> permission (github.com &rarr; Settings
                &rarr; Developer settings &rarr; Fine-grained tokens), or log in with Copilot on your own machine and paste or import{" "}
                <code>~/.copilot/config.json</code> (put <code>{"{ \"storeTokenPlaintext\": true }"}</code> in{" "}
                <code>~/.copilot/settings.json</code> first, else the token goes to the OS keychain). The Sandbox keeps the login in memory
                only and hands the token to the Agent as <code>COPILOT_GITHUB_TOKEN</code>. The token of a GitHub connector does not work: it
                lacks the Copilot Requests permission.
              </p>
              <CopyCommand command="copilot login" />
              <CopyCommand command="cat ~/.copilot/config.json" />
            </>
          }
        >
          GitHub Copilot: login (config.json or GitHub token){" "}
          {loginSet ? (
            <span className="ok">(set{settings.copilotLogin && !forget ? `: ${describeCopilotLogin(settings.copilotLogin)}` : ""})</span>
          ) : (
            <span className="warn">(not set)</span>
          )}
        </Caption>
        <textarea
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={login}
          onChange={(e) => {
            setLogin(e.target.value);
            if (e.target.value.trim()) setForget(false);
          }}
          placeholder={loginSet ? "Leave empty to keep the current login" : "Paste the contents of ~/.copilot/config.json, or a GitHub token"}
        />
      </label>
      <div className="field-hint">
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            importFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()}>
          Import config.json…
        </button>
        {stored && (
          <label className="check">
            <input
              type="checkbox"
              checked={forget}
              onChange={(e) => {
                setForget(e.target.checked);
                if (e.target.checked) setLogin("");
              }}
            />{" "}
            Forget the stored login
          </label>
        )}
      </div>
    </>
  );
}
