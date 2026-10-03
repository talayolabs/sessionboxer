import { Caption } from "../ui";
import type { Setter } from "./shared";

/** Global settings → Auto QA: the end-to-end verification default. */
export function AutoQaSettings({
  e2eVerify,
  setE2eVerify,
}: {
  e2eVerify: boolean;
  setE2eVerify: Setter<boolean>;
}) {
  return (
    <section className="ss-section">
      <h3>Auto QA</h3>
      <label className="check switch">
        <input type="checkbox" checked={e2eVerify} onChange={(e) => setE2eVerify(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
        <Caption
          help={
            <p>
              After a completed turn the Agent gets a hidden follow-up: it looks at what changed, plans 2–5 test cases (up to 10 for a very
              large change), runs them on the Sandbox desktop while recording, fixes and reruns what fails (3 attempts per case), and posts the
              video. Turns that only answer are recorded as skipped. It costs a second turn of model time after each of yours. Default for new
              Sessions; each Session can override it in its settings or from the Auto QA pane.
            </p>
          }
        >
          Verify each turn end to end
        </Caption>
      </label>
    </section>
  );
}
