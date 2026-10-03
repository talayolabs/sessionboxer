import type { PublicSettings } from "@sessionboxer/protocol";
import { Devices } from "../Devices";
import type { Runner } from "../SessionView";

/** Global settings → Devices and remote access. */
export function DevicesSettings({
  settings,
  onStored,
  run,
}: {
  settings: PublicSettings;
  onStored: (s: PublicSettings) => void;
  run: Runner;
}) {
  return (
    <section className="ss-section">
      <Devices remote={settings.remote} tunnels={settings.tunnels} onStored={onStored} run={run} />
    </section>
  );
}
