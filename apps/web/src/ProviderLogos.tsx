import { PROVIDERS, PROVIDER_LABELS, type Provider, type PublicSettings } from "@sessionboxer/protocol";
import { PROVIDER_BLURB } from "./providers";
import { ProviderIcon } from "./ProviderIcon";
import { providerTokenSet } from "./providers";

/** Four big buttons, one per Provider, marked when a login is already stored. */
export function ProviderLogos({
  settings,
  onPick,
  size = 40,
}: {
  settings: PublicSettings;
  onPick: (provider: Provider) => void;
  size?: number;
}) {
  return (
    <div className="provider-logos">
      {PROVIDERS.map((p) => {
        const set = providerTokenSet(settings, p);
        return (
          <button
            key={p}
            type="button"
            className={`provider-logo${set ? " connected" : ""}`}
            onClick={() => onPick(p)}
            title={PROVIDER_BLURB[p]}
          >
            <ProviderIcon provider={p} size={size} />
            <span className="provider-logo-name">{PROVIDER_LABELS[p]}</span>
            <span className={`provider-logo-state ${set ? "ok" : "muted"}`}>
              {set ? "connected" : "not connected"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
