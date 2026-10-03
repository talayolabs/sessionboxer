import type { AutomationLimits } from "@sessionboxer/protocol";
import type { Setter } from "../settings/shared";
import { clamp } from "./form-model";

export function LimitsStep({ limits, setLimits, enabled, setEnabled, isPr }: {
  limits: AutomationLimits;
  setLimits: Setter<AutomationLimits>;
  enabled: boolean;
  setEnabled: Setter<boolean>;
  isPr: boolean;
}) {
  return (
    <section className="automation-step">
      <h3>
        <span className="automation-step-n">3</span> Limits
      </h3>
      <div className="row">
        <label>
          Sessions at once
          <input type="number" min={1} max={20} value={limits.maxConcurrent} onChange={(e) => setLimits({ ...limits, maxConcurrent: clamp(e.target.value, 1, 20, 2) })} />
        </label>
        <label>
          Runs per day
          <input type="number" min={1} max={1000} value={limits.maxRunsPerDay} onChange={(e) => setLimits({ ...limits, maxRunsPerDay: clamp(e.target.value, 1, 1000, 20) })} />
        </label>
        <label>
          Time limit per run (minutes)
          <input type="number" min={1} max={1440} value={limits.timeoutMinutes} onChange={(e) => setLimits({ ...limits, timeoutMinutes: clamp(e.target.value, 1, 1440, 360) })} />
        </label>
      </div>
      {isPr && (
        <div className="row">
          <label>
            Runs per PR per day
            <input type="number" min={1} max={100} value={limits.maxRunsPerPrPerDay} onChange={(e) => setLimits({ ...limits, maxRunsPerPrPerDay: clamp(e.target.value, 1, 100, 4) })} />
          </label>
          <label>
            Quiet period after a push (seconds)
            <input type="number" min={0} max={3600} value={limits.debounceSeconds} onChange={(e) => setLimits({ ...limits, debounceSeconds: clamp(e.target.value, 0, 3600, 120) })} />
          </label>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
    </section>
  );
}
