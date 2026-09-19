import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PAIR_FRAGMENT_KEY } from "@sessionboxer/protocol";
import { UNAUTHORIZED_EVENT, api } from "./api";

type Gate = { state: "checking" } | { state: "in" } | { state: "out"; notice: string | null };

/** `#pair=<code>[&next=<hash path>]` from a pairing link, else null. */
function pairingFragment(hash: string): { code: string; next: string } | null {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith(`${PAIR_FRAGMENT_KEY}=`)) return null;
  const params = new URLSearchParams(raw);
  const code = params.get(PAIR_FRAGMENT_KEY) ?? "";
  if (code === "") return null;
  const next = params.get("next") ?? "/";
  return { code, next: next.startsWith("/") ? next : `/${next}` };
}

// One login attempt per page load, whatever remounts the gate (React's StrictMode runs effects twice in development).
let startup: Promise<boolean> | null = null;

function loggedInAtStartup(): Promise<boolean> {
  startup ??= (async () => {
    const pairing = pairingFragment(location.hash);
    // The code is one-use; take it out of the URL before anything can reload with it.
    if (pairing) history.replaceState(null, "", `${location.pathname}${location.search}#${pairing.next}`);
    const { principal } = await api.me();
    if (principal) return true;
    if (!pairing) return false;
    await api.pairRedeem({ code: pairing.code, name: "" });
    return true;
  })();
  return startup;
}

/**
 * Nothing behind it renders until this browser holds a device cookie: a pairing link logs it in
 * on the spot, otherwise the access token is asked for. A 401 from any later request drops back
 * to the login screen.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    loggedInAtStartup().then(
      (ok) => {
        if (!cancelled) setGate(ok ? { state: "in" } : { state: "out", notice: null });
      },
      (e: unknown) => {
        if (!cancelled) setGate({ state: "out", notice: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setGate((g) => (g.state === "in" ? { state: "out", notice: "This browser is no longer logged in (the device was revoked or the token changed)." } : g));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const loggedIn = useCallback(() => setGate({ state: "in" }), []);

  if (gate.state === "checking") return <div className="login-screen" aria-busy="true" />;
  if (gate.state === "out") return <Login notice={gate.notice} onLoggedIn={loggedIn} />;
  return <>{children}</>;
}

function Login({ notice, onLoggedIn }: { notice: string | null; onLoggedIn: () => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    api
      .login({ token: token.trim(), name: name.trim() })
      .then(onLoggedIn)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="login-screen">
      <form className="panel login" onSubmit={submit}>
        <h1>Sessionboxer</h1>
        {notice && <div className="banner banner-warn">{notice}</div>}
        <label>
          Access token
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the Control Plane's access token"
            spellCheck={false}
          />
        </label>
        <label>
          Name this device (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Julian's phone" maxLength={80} />
        </label>
        {error && <div className="banner banner-error">{error}</div>}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || token.trim() === ""}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </div>
        <p className="muted small-text">
          The token is printed when the Control Plane starts and by <code>sessionboxer token</code> on the machine running it. From a browser that is
          already logged in, Settings → Devices makes a one-time QR code that logs this one in without the token. This browser stays logged in until
          the device is revoked there.
        </p>
      </form>
    </div>
  );
}
