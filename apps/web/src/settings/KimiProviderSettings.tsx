import { useRef } from "react";
import type { PublicSettings } from "@sessionboxer/protocol";
import { CopyCommand } from "../CopyCommand";
import { Caption } from "../ui";
import type { Setter } from "./shared";

export function KimiProviderSettings({ settings, value, setValue, forget, setForget }: {
  settings: PublicSettings; value: string; setValue: Setter<string>; forget: boolean; setForget: Setter<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const stored = settings.providerSecretsSet.kimi.KIMI_LOGIN && !forget;
  const login = settings.kimiLogin;
  const change = (text: string) => { setValue(text); setForget(false); };
  return (
    <div className="ss-card">
      <label>
        <span className="label-row">
          <Caption help={<>
            <p>Run <code>kimi login</code>, then paste or import <code>~/.kimi/credentials/kimi-code.json</code>.
              Or use Connect a Provider → Sign in with Kimi CLI for browser device sign-in.</p>
            <p>API-key-only use is unsupported until Kimi&apos;s ACP server honours it. Kimi CLI 1.52.0 requires a Kimi Code OAuth login.</p>
            <p>On Linux, the credential directory stays on tmpfs, outside Snapshots; Windows uses the guest credential store. Refreshed tokens flow back to Settings. QEMU · macOS is unavailable: no macOS x86_64 build.</p>
            <CopyCommand command="kimi login" />
            <CopyCommand command="cat ~/.kimi/credentials/kimi-code.json" />
          </>}>Kimi CLI login</Caption>
          <span className="muted">{stored ? "stored" : "not set"}</span>
          <button type="button" className="link" onClick={() => input.current?.click()}>Import kimi-code.json…</button>
          {stored && <button type="button" className="link danger" onClick={() => { setValue(""); setForget(true); }}>Forget</button>}
        </span>
        <textarea className="mono" rows={3} value={value} onChange={(e) => change(e.target.value)}
          placeholder={stored ? "Leave empty to keep the stored login" : 'Paste the whole kimi-code.json from `kimi login`'}
          autoComplete="off" spellCheck={false} />
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void file.text().then(change);
          e.target.value = "";
        }} />
        {stored && login && <span className="muted">Kimi Code OAuth{login.expiresAt ? `, token valid until ${new Date(login.expiresAt).toLocaleString()}` : ""}</span>}
        {forget && <span className="muted">The Kimi login will be removed on Save.</span>}
      </label>
    </div>
  );
}
