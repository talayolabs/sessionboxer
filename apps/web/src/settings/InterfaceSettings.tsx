import { useCallback, useEffect, useState } from "react";
import { SPEECH_MODELS, SPEECH_MODEL_INFO, type PublicSettings, type SpeechModel, type SpeechStatus } from "@sessionboxer/protocol";
import { api } from "../api";
import { formatMb } from "../format";
import { ThemeFieldset } from "../ThemePicker";
import { Caption, Select } from "../ui";
import type { Setter } from "./shared";

/** What is on disk for dictation (whisper-cli and models), with a download-now button and per-model removal. */
function SpeechAssets({ selected, saved }: { selected: SpeechModel; saved: SpeechModel }) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const refresh = useCallback(() => {
    api.speechStatus().then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);
  const downloading = status !== null && (status.engine.state === "downloading" || status.model.state === "downloading");
  useEffect(() => {
    if (!downloading && !working) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [downloading, working, refresh]);
  const prepare = async () => {
    setWorking(true);
    setError(null);
    try {
      setStatus(await api.speechPrepare());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      refresh();
    }
  };
  const remove = async (model: SpeechModel) => {
    setError(null);
    try {
      await api.speechDeleteModel(model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  if (!status) return error ? <p className="error">{error}</p> : <p className="muted">Checking what is downloaded…</p>;
  const engine =
    status.engine.state === "ready"
      ? `whisper-cli ${status.engine.version ?? ""} ready`
      : status.engine.state === "downloading"
        ? "downloading whisper-cli…"
        : status.engine.state === "error"
          ? `whisper-cli: ${status.engine.error ?? "unavailable"}`
          : "whisper-cli not downloaded yet";
  const model =
    status.model.state === "ready"
      ? `model ${status.model.name} ready`
      : status.model.state === "downloading"
        ? `downloading model ${status.model.name}… ${status.model.total > 0 ? Math.floor((100 * status.model.received) / status.model.total) : 0}%`
        : status.model.state === "error"
          ? `model ${status.model.name}: ${status.model.error ?? "failed"}`
          : `model ${status.model.name} not downloaded yet (${formatMb(SPEECH_MODEL_INFO[status.model.name].bytes)})`;
  const ready = status.engine.state === "ready" && status.model.state === "ready";
  return (
    <div className="speech-assets">
      <p className={status.engine.state === "error" || status.model.state === "error" ? "error" : "muted"}>
        {engine} · {model}
        {status.busy > 0 && ` · transcribing ${status.busy} clip${status.busy === 1 ? "" : "s"}`}
      </p>
      <div className="row">
        {!ready && (
          <button type="button" className="small" disabled={working || downloading} onClick={() => void prepare()}>
            {downloading || working ? "Downloading…" : "Download now"}
          </button>
        )}
        {selected !== saved && <span className="muted">Save to switch to {SPEECH_MODEL_INFO[selected].label}; it is downloaded on the first dictation.</span>}
        {status.downloaded
          .filter((m) => m !== status.model.name)
          .map((m) => (
            <button key={m} type="button" className="small" title={`Delete ggml-${m}.bin from this machine`} onClick={() => void remove(m)}>
              Delete {SPEECH_MODEL_INFO[m].label} ({formatMb(SPEECH_MODEL_INFO[m].bytes)})
            </button>
          ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Global settings → Interface: the theme of this browser and dictation. */
export function InterfaceSettings({
  settings,
  speechModel,
  setSpeechModel,
  speechLanguage,
  setSpeechLanguage,
}: {
  settings: PublicSettings;
  speechModel: SpeechModel;
  setSpeechModel: Setter<SpeechModel>;
  speechLanguage: string;
  setSpeechLanguage: Setter<string>;
}) {
  return (
    <section className="ss-section">
      <h3>
        <Caption help={<p>How this browser shows Sessionboxer and how you talk to it. The theme is a preference of this browser; dictation runs on the machine the Control Plane runs on.</p>}>
          Interface
        </Caption>
      </h3>
      <div id="settings-theme">
        <ThemeFieldset />
      </div>
      <h4 className="ss-sub" id="settings-dictation">
        <Caption
          help={
            <p>
              The microphone button in the composer records a clip in the browser and whisper.cpp transcribes it on this machine, offline:
              nothing leaves it (phones paired through a tunnel send the clip here). whisper-cli and the model are downloaded once, on first use
              or with the button below. Detecting the language is slower and takes one language per clip.
            </p>
          }
        >
          Dictation
        </Caption>
      </h4>
      <div className="row">
        <label>
          Model
          <Select<SpeechModel>
            value={speechModel}
            onChange={setSpeechModel}
            aria-label="Dictation model"
            options={SPEECH_MODELS.map((m) => ({
              value: m,
              label: `${SPEECH_MODEL_INFO[m].label} (${formatMb(SPEECH_MODEL_INFO[m].bytes)})`,
              hint: SPEECH_MODEL_INFO[m].note,
            }))}
          />
        </label>
        <label>
          Language
          <Select<string>
            value={speechLanguage}
            onChange={setSpeechLanguage}
            aria-label="Dictation language"
            options={[
              { value: "auto", label: "Detect (slower, one language per clip)" },
              { value: "en", label: "English" },
              { value: "es", label: "Spanish" },
              { value: "pt", label: "Portuguese" },
              { value: "fr", label: "French" },
              { value: "de", label: "German" },
              { value: "it", label: "Italian" },
              { value: "ca", label: "Catalan" },
              { value: "nl", label: "Dutch" },
              { value: "pl", label: "Polish" },
              { value: "ru", label: "Russian" },
              { value: "uk", label: "Ukrainian" },
              { value: "tr", label: "Turkish" },
              { value: "ja", label: "Japanese" },
              { value: "zh", label: "Chinese" },
              { value: "ko", label: "Korean" },
              { value: "hi", label: "Hindi" },
              { value: "ar", label: "Arabic" },
            ]}
          />
        </label>
      </div>
      <SpeechAssets selected={speechModel} saved={settings.speech.model} />
    </section>
  );
}
