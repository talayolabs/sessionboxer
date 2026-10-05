import { useEffect, useRef, useState } from "react";
import {
  PROVIDER_LABELS,
  type Provider,
  type ProviderHostLogin,
  type ProviderLoginFlow,
  type PublicSettings,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { ProviderIcon } from "./ProviderIcon";
import { SandboxImageBanner } from "./SandboxImageBanner";
import { providerSignsInFromBrowser } from "./providers";

const POLL_MS = 1000;

/**
 * "Sign in with …" for a Provider login (ADR-0058): the Control Plane runs the Provider CLI's
 * browser login (on its machine, or in a throwaway container), the sign-in page opens in this
 * browser (where the user is likely signed in already), and whatever code the flow needs goes
 * the way the CLI wants it: pasted back here (Claude Code, Devin), typed into the page (Codex),
 * or none at all (Cursor).
 */
export function ProviderSignIn({
  provider,
  connected,
  onStored,
}: {
  provider: Provider;
  connected: boolean;
  /** Settings as the Control Plane stored them once the login landed. */
  onStored: (s: PublicSettings) => void;
}) {
  const [flow, setFlow] = useState<ProviderLoginFlow | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<ProviderHostLogin | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const onStoredRef = useRef(onStored);
  onStoredRef.current = onStored;
  const label = PROVIDER_LABELS[provider];
  const browser = providerSignsInFromBrowser(provider);

  useEffect(() => {
    let cancelled = false;
    setHost(null);
    api
      .providerHostLogin(provider)
      .then((h) => !cancelled && setHost(h))
      .catch(() => !cancelled && setHost(null));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const pending = flow !== null && flow.status !== "done" && flow.status !== "error";
  useEffect(() => {
    if (!flow || !pending) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await api.providerLogin(flow.id);
        if (cancelled) return;
        setFlow(next);
        if (next.status === "done") onStoredRef.current(await api.settings());
      } catch (e) {
        if (!cancelled) {
          setFlow(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [flow, pending]);

  // The URL arrives a few seconds after the click (the CLI has to start), so the tab it opens is
  // not a popup the browser can attribute to the click; keep the link visible as well.
  useEffect(() => {
    if (!flow?.url || flow.status !== "awaiting_code" || opened === flow.id) return;
    setOpened(flow.id);
    window.open(flow.url, "_blank", "noopener");
  }, [flow, opened]);

  // Leaving mid-flow kills the CLI so the stale login is not left waiting.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  useEffect(
    () => () => {
      const f = flowRef.current;
      if (f && f.status !== "done" && f.status !== "error") void api.providerLoginCancel(f.id).catch(() => undefined);
    },
    [],
  );

  const call = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    call(async () => {
      setCode("");
      setFlow(await api.providerLoginStart(provider));
    });
  const submit = () =>
    call(async () => {
      if (!flow) return;
      setFlow(await api.providerLoginCode(flow.id, code.trim()));
      setCode("");
    });
  const cancel = () =>
    call(async () => {
      if (flow) await api.providerLoginCancel(flow.id);
      setFlow(null);
    });
  const importHost = () =>
    call(async () => {
      onStoredRef.current(await api.providerImportHostLogin(provider));
      setFlow(null);
    });

  const codeReady = flow?.status === "awaiting_code" && code.trim() !== "" && !busy;

  return (
    <div className="provider-signin">
      {!pending && (
        <div className="provider-signin-row">
          {host?.signIn === false ? (
            <span className="muted">{label} has no sign-in from the browser: make the login with its CLI on your machine and paste it below.</span>
          ) : browser ? (
            <button type="button" className="connector-button primary" onClick={() => void start()} disabled={busy}>
              <ProviderIcon provider={provider} size={14} />
              {connected ? `Sign in with ${label} again` : `Sign in with ${label}`}
            </button>
          ) : (
            <span className="muted">{label} signs in from its own terminal (<code>/login</code>); paste or import what it wrote below.</span>
          )}
          {host?.importable && (
            <button type="button" onClick={() => void importHost()} disabled={busy}>
              Use this machine&apos;s {label} login
            </button>
          )}
          {host?.account && (
            <span className="muted">
              {label} on the Sessionboxer machine: signed in as <strong>{host.account}</strong>
            </span>
          )}
        </div>
      )}
      {flow?.status === "starting" && (
        <>
          <p className="muted">Starting {label}&apos;s CLI…</p>
          <SandboxImageBanner selector={provider} />
        </>
      )}
      {flow?.status === "awaiting_code" && flow.url && (
        <div className="connector-device">
          <p>
            <a href={flow.url} target="_blank" rel="noopener noreferrer">
              Open the {label} sign-in page
            </a>{" "}
            (it should have opened in a new tab)
            {flow.pasteCode
              ? ", sign in there, then paste the code it shows:"
              : flow.userCode
                ? ", sign in there and enter this code when it asks:"
                : " and sign in there; this page continues by itself."}
          </p>
          {flow.userCode && <code className="connector-code">{flow.userCode}</code>}
          {flow.pasteCode && (
            <div className="connector-code-row">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (codeReady) void submit();
                }}
                placeholder="Code from the sign-in page"
              />
              <button type="button" className="primary" onClick={() => void submit()} disabled={!codeReady}>
                Continue
              </button>
            </div>
          )}
          {!flow.pasteCode && <p className="muted">Waiting for the sign-in to finish…</p>}
        </div>
      )}
      {flow?.status === "exchanging" && <p className="muted">Redeeming the code…</p>}
      {pending && (
        <button type="button" className="link" onClick={() => void cancel()} disabled={busy}>
          Cancel
        </button>
      )}
      {flow?.status === "done" && (
        <p className="connector-done ok">
          Signed in{flow.account ? ` as ${flow.account}` : ""}; the {label} login is stored. Sessions can use {label} now.
        </p>
      )}
      {flow?.status === "error" && <p className="error">{flow.error}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
