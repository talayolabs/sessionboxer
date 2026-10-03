import { useRef } from "react";
import type { PublicSettings } from "@sessionboxer/protocol";
import { CopyCommand } from "../CopyCommand";
import { Caption } from "../ui";
import { describeOpenCodeLogin } from "./provider-login-labels";
import type { Setter } from "./shared";

/** Global settings → Providers → OpenCode (ADR-0076): the auth.json / OpenCode Zen key field with its import and Forget. */
export function OpenCodeProviderCard({
  settings,
  auth,
  setAuth,
  forget,
  setForget,
}: {
  settings: PublicSettings;
  auth: string;
  setAuth: Setter<string>;
  forget: boolean;
  setForget: Setter<boolean>;
}) {
  const authSet = settings.providerSecretsSet.opencode.OPENCODE_AUTH_JSON && !forget;
  const fileRef = useRef<HTMLInputElement>(null);
  const importAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setAuth(text);
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
              OpenCode runs on the model providers you log into with its CLI on your own machine (Anthropic with a Claude Pro/Max login,
              OpenAI with ChatGPT, OpenCode Zen, Google, API keys…): paste or import the file it writes (the Sandbox keeps it in memory
              only; refreshed tokens flow back here), or paste an OpenCode Zen API key from opencode.ai/auth.
            </p>
            <CopyCommand command="opencode auth login" />
            <CopyCommand command="cat ~/.local/share/opencode/auth.json" />
          </>
        }
      >
        OpenCode: login (auth.json or OpenCode Zen API key){" "}
        {authSet ? (
          <span className="ok">(set{settings.opencodeLogin && !forget ? `: ${describeOpenCodeLogin(settings.opencodeLogin)}` : ""})</span>
        ) : (
          <span className="warn">(not set)</span>
        )}
      </Caption>
      <textarea
        rows={3}
        spellCheck={false}
        autoComplete="off"
        value={auth}
        onChange={(e) => {
          setAuth(e.target.value);
          if (e.target.value.trim()) setForget(false);
        }}
        placeholder={authSet ? "Leave empty to keep the current login" : "Paste the contents of OpenCode's auth.json, or an OpenCode Zen API key"}
      />
    </label>
    <div className="field-hint">
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          importAuth(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button type="button" onClick={() => fileRef.current?.click()}>
        Import auth.json…
      </button>
      {settings.providerSecretsSet.opencode.OPENCODE_AUTH_JSON && (
        <label className="check">
          <input
            type="checkbox"
            checked={forget}
            onChange={(e) => {
              setForget(e.target.checked);
              if (e.target.checked) setAuth("");
            }}
          />{" "}
          Forget the stored login
        </label>
      )}
    </div>
    </>
  );
}
