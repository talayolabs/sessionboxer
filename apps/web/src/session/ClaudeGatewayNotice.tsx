import type { PublicSettings, Session } from "@sessionboxer/protocol";
import { api } from "../api";
import { ClaudeApiLoginOutput, useClaudeApiLogin } from "../settings/ClaudeApiLogin";
import type { Runner } from "../SessionView";

/**
 * The Claude API gateway refused the Session's credential (the login behind the credential command
 * expired, ADR-0090). Offers the configured login command, run on the Control Plane's machine with
 * its output followed here (a device code, an SSO URL to open), and the way around: this Session
 * straight to Anthropic.
 */
export function ClaudeGatewayNotice({ session, settings, run }: { session: Session; settings: PublicSettings | null; run: Runner }) {
  const login = useClaudeApiLogin();
  const running = login.state?.running === true;
  const loginCommand = settings?.claudeApi.loginCommand ?? "";
  return (
    <div className="banner banner-warn claude-gateway-notice" role="alert">
      <div className="row">
        <span>
          The Claude API gateway rejected this Session&apos;s credential: the login behind the credential command has probably expired.
          {loginCommand === "" ? " Log in again on the Control Plane's machine and send the prompt again, or set a login command in Settings → Providers → Claude API." : " Run the login command, then send the prompt again."}
        </span>
        {loginCommand !== "" && (
          <button type="button" disabled={running} onClick={() => void login.start()}>
            {running ? "Running login command…" : "Run login command"}
          </button>
        )}
        <button type="button" className="link" onClick={() => void run(() => api.updateSession(session.id, { settings: { claudeGateway: false } }))}>
          Use Anthropic directly for this Session
        </button>
      </div>
      <ClaudeApiLoginOutput login={login} />
    </div>
  );
}
