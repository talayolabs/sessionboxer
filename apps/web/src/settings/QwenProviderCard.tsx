import { useRef } from "react";
import type { PublicSettings } from "@sessionboxer/protocol";
import { CopyCommand } from "../CopyCommand";
import { Caption } from "../ui";
import { describeQwenOauth } from "./provider-login-labels";
import type { Setter } from "./shared";

/** Global settings → Providers → Qwen Code (ADR-0083): the oauth_creds.json field and the OPENAI_* key lines. */
export function QwenProviderCard({
  settings,
  auth,
  setAuth,
  forgetAuth,
  setForgetAuth,
  apiKeys,
  setApiKeys,
  forgetApiKeys,
  setForgetApiKeys,
}: {
  settings: PublicSettings;
  auth: string;
  setAuth: Setter<string>;
  forgetAuth: boolean;
  setForgetAuth: Setter<boolean>;
  apiKeys: string;
  setApiKeys: Setter<string>;
  forgetApiKeys: boolean;
  setForgetApiKeys: Setter<boolean>;
}) {
  const authSet = settings.providerSecretsSet.qwen.QWEN_OAUTH_JSON && !forgetAuth;
  const apiKeysSet = settings.providerSecretsSet.qwen.QWEN_API_KEYS && !forgetApiKeys;
  const fileRef = useRef<HTMLInputElement>(null);
  const importAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setAuth(text);
      setForgetAuth(false);
    });
  };
  const keyNames = settings.qwenLogin?.apiKeyNames ?? [];
  return (
    <>
      <label>
        <Caption
          help={
            <>
              <p>
                Qwen Code (Alibaba) runs on a free qwen.ai account: start <code>qwen</code> on your own machine, <code>/auth</code> &rarr; Qwen OAuth,
                then paste or import the file it writes, <code>~/.qwen/oauth_creds.json</code> (the Sandbox keeps it in memory only; refreshed tokens
                flow back here). Or, below, give it any OpenAI-compatible endpoint instead (DashScope, ModelScope, OpenRouter, a local server).
              </p>
              <CopyCommand command="qwen" />
              <CopyCommand command="cat ~/.qwen/oauth_creds.json" />
            </>
          }
        >
          Qwen Code: login (oauth_creds.json){" "}
          {authSet ? (
            <span className="ok">(set{settings.qwenLogin && !forgetAuth ? `: ${describeQwenOauth(settings.qwenLogin)}` : ""})</span>
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
            if (e.target.value.trim()) setForgetAuth(false);
          }}
          placeholder={authSet ? "Leave empty to keep the current login" : "Paste the contents of ~/.qwen/oauth_creds.json"}
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
          Import oauth_creds.json…
        </button>
        {settings.providerSecretsSet.qwen.QWEN_OAUTH_JSON && (
          <label className="check">
            <input
              type="checkbox"
              checked={forgetAuth}
              onChange={(e) => {
                setForgetAuth(e.target.checked);
                if (e.target.checked) setAuth("");
              }}
            />{" "}
            Forget the stored login
          </label>
        )}
      </div>
      <label>
        <Caption
          help={
            <p>
              An OpenAI-compatible endpoint for Qwen Code, one <code>NAME=value</code> line each: <code>OPENAI_API_KEY</code>,{" "}
              <code>OPENAI_MODEL</code> and <code>OPENAI_BASE_URL</code> (DashScope: <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code>{" "}
              with <code>qwen3-coder-plus</code>; ModelScope, OpenRouter or a local server likewise). They reach the qwen process in the Sandbox as
              its environment only: never the container, a snapshot or the logs. Saving replaces the whole list; a stored Qwen OAuth login is used
              instead of them while both are set.
            </p>
          }
        >
          Qwen Code: OpenAI-compatible endpoint (NAME=value lines){" "}
          {apiKeysSet ? (
            <span className="ok">(set{keyNames.length > 0 && !forgetApiKeys ? `: ${keyNames.join(", ")}` : ""})</span>
          ) : (
            <span className="warn">(not set)</span>
          )}
        </Caption>
        <textarea
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={apiKeys}
          onChange={(e) => {
            setApiKeys(e.target.value);
            if (e.target.value.trim()) setForgetApiKeys(false);
          }}
          placeholder={apiKeysSet ? "Leave empty to keep the current keys" : "OPENAI_API_KEY=sk-…\nOPENAI_MODEL=qwen3-coder-plus\nOPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1"}
        />
      </label>
      {settings.providerSecretsSet.qwen.QWEN_API_KEYS && (
        <div className="field-hint">
          <label className="check">
            <input
              type="checkbox"
              checked={forgetApiKeys}
              onChange={(e) => {
                setForgetApiKeys(e.target.checked);
                if (e.target.checked) setApiKeys("");
              }}
            />{" "}
            Forget the stored keys
          </label>
        </div>
      )}
    </>
  );
}
