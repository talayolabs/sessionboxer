import { useEffect, useState } from "react";
import type { SandboxImageSelector, SandboxImageStatus } from "@sessionboxer/protocol";
import { api } from "./api";
import { formatMb } from "./format";

/**
 * Where the selected Sandbox image stands on the Sessionboxer machine (ADR-0088): a Provider's for
 * a Linux Session or sign-in, `base` for a Windows/macOS one. Nothing while it is here; a progress
 * line while it downloads; the reason and a retry when it is missing or the pull failed. Polls
 * until the image is ready and drops answers that arrive after the selection changed.
 */
export function SandboxImageBanner({ selector }: { selector: SandboxImageSelector }) {
  const [status, setStatus] = useState<SandboxImageStatus | null>(null);
  const [working, setWorking] = useState(false);
  const settled = status?.state === "ready";
  useEffect(() => {
    setStatus(null);
    let cancelled = false;
    const poll = () => api.sandboxImage(selector).then((s) => !cancelled && setStatus(s), () => undefined);
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selector]);
  useEffect(() => {
    if (!settled) return;
    // Pulled once: nothing left to poll for until the selection changes.
    setWorking(false);
  }, [settled]);
  if (!status || status.state === "ready" || status.state === "checking") return null;
  if (status.state === "pulling") {
    const progress = status.total > 0 ? ` ${formatMb(status.received)} of ${formatMb(status.total)}` : "";
    return (
      <div className="banner banner-warn">
        Downloading the Sandbox image <code>{status.image}</code>{progress}. Happens once per version and Provider (a few GB); Sessions start once it is here.
      </div>
    );
  }
  const pull = () => {
    setWorking(true);
    api.sandboxImagePull(selector).then(setStatus, () => undefined).finally(() => setWorking(false));
  };
  if (status.state === "missing" && status.error === null) {
    return (
      <div className="banner banner-warn">
        The Sandbox image <code>{status.image}</code> is not on this machine yet; the first Session downloads it (a few GB).{" "}
        <button type="button" className="link" onClick={pull} disabled={working}>
          {working ? "Starting…" : "Download now"}
        </button>
      </div>
    );
  }
  return (
    <div className="banner banner-error">
      {status.state === "missing" ? status.error : `The Sandbox image could not be downloaded: ${status.error}`}{" "}
      {status.state === "error" && (
        <button type="button" className="link" onClick={pull} disabled={working}>
          {working ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
