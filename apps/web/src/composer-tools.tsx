import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "./format";
import type { PendingAttachments } from "./attachments-pending";
import { AttachmentPreviewDialog, AttachmentThumb, previewKind } from "./AttachmentPreview";
import { MAX_RECORDING_S, micSupport, startRecording, transcribe, type Recording } from "./speech";
import { cameraSupport } from "./camera";
import { CameraDialog } from "./CameraDialog";

// The attach, camera and dictate controls shared by the Session composer and the New session box.

export function ToolIcon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const TOOL_ICONS = {
  attach: "M10.5 4.5l-4.8 4.8a1.9 1.9 0 0 0 2.7 2.7l5.3-5.3a3.1 3.1 0 0 0-4.4-4.4L3.6 8a4.3 4.3 0 0 0 6.1 6.1L13 10.8",
  mic: "M8 1.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V4A2.5 2.5 0 0 1 8 1.5zM3.5 8a4.5 4.5 0 0 0 9 0M8 12.5v2M5.5 14.5h5",
  camera: "M2 5.5A1.5 1.5 0 0 1 3.5 4h1.7l1-1.5h3.6l1 1.5h1.7A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5zM8 11a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 11z",
};

/** Files carried by a drag or a paste (`null` when there are none, e.g. plain text). */
export function droppedFiles(transfer: DataTransfer | null): File[] | null {
  const files = transfer?.files;
  return files && files.length > 0 ? [...files] : null;
}

/** The mic button: idle, recording (tap again to transcribe), working (clip on its way / downloads / whisper), or the last failure. */
export type Dictation = { kind: "idle" } | { kind: "recording"; startedAt: number } | { kind: "working"; status: string } | { kind: "error"; message: string };

const DICTATION_ERROR_MS = 8000;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function micError(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") return "Microphone access was denied; allow it for this site in the browser.";
    if (e.name === "NotFoundError") return "No microphone was found.";
    if (e.name === "NotReadableError") return "The microphone is in use by another application.";
  }
  return e instanceof Error ? e.message : String(e);
}

export type DictationControl = { dictation: Dictation; now: number; toggle: () => Promise<void> };

/** Record → transcribe (whisper.cpp on the Control Plane) → `appendText`; the recording stops at `MAX_RECORDING_S` and on unmount. */
export function useDictation(appendText: (text: string) => void): DictationControl {
  const [dictation, setDictation] = useState<Dictation>({ kind: "idle" });
  const recordingRef = useRef<Recording | null>(null);
  const [now, setNow] = useState(0);

  const toggle = useCallback(async () => {
    const rec = recordingRef.current;
    if (rec) {
      recordingRef.current = null;
      setDictation({ kind: "working", status: "Preparing the clip\u2026" });
      try {
        const wav = await rec.stop();
        const result = await transcribe(wav, (status) => setDictation((d) => (d.kind === "working" ? { kind: "working", status } : d)));
        if (result.text === "") {
          setDictation({ kind: "error", message: "Nothing was understood in that clip." });
          return;
        }
        appendText(result.text);
        setDictation({ kind: "idle" });
      } catch (e) {
        setDictation({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    const support = micSupport();
    if (!support.ok) {
      setDictation({ kind: "error", message: support.reason });
      return;
    }
    try {
      recordingRef.current = await startRecording();
      setDictation({ kind: "recording", startedAt: Date.now() });
    } catch (e) {
      setDictation({ kind: "error", message: micError(e) });
    }
  }, [appendText]);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    if (dictation.kind !== "recording") return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - dictation.startedAt >= MAX_RECORDING_S * 1000) void toggleRef.current();
    }, 500);
    return () => clearInterval(timer);
  }, [dictation]);

  useEffect(() => {
    if (dictation.kind !== "error") return;
    const timer = setTimeout(() => setDictation((d) => (d.kind === "error" ? { kind: "idle" } : d)), DICTATION_ERROR_MS);
    return () => clearTimeout(timer);
  }, [dictation]);

  // Leaving the screen mid-recording releases the microphone.
  useEffect(
    () => () => {
      recordingRef.current?.cancel();
      recordingRef.current = null;
    },
    [],
  );

  return { dictation, now, toggle };
}

/** Paperclip with its hidden file input. */
export function AttachButton({ disabled, onFiles }: { disabled: boolean; onFiles: (files: Iterable<File>) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button type="button" className="tb" title="Attach files (or drop / paste them here)" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => inputRef.current?.click()}>
        <ToolIcon d={TOOL_ICONS.attach} />
      </button>
    </>
  );
}

/**
 * Camera: a photo or a video from the device, into the attachment list. With a secure page the dialog
 * shows the live preview; without one (plain http over the LAN) the browser's capture picker takes over,
 * which on a phone is its camera app.
 */
export function CameraButton({ disabled, onFiles }: { disabled: boolean; onFiles: (files: Iterable<File>) => void }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const support = cameraSupport();
  return (
    <>
      {!support.ok && (
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          capture="environment"
          hidden
          onChange={(e) => {
            if (e.target.files) onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      )}
      <button
        type="button"
        className="tb"
        title={support.ok ? "Camera: take a photo or record a video to attach" : `Camera: take a photo or record a video to attach. ${support.reason}`}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (support.ok ? setOpen(true) : inputRef.current?.click())}
      >
        <ToolIcon d={TOOL_ICONS.camera} />
      </button>
      {open && <CameraDialog onCapture={(file) => onFiles([file])} onClose={() => setOpen(false)} />}
    </>
  );
}

export function MicButton({ control, disabled }: { control: DictationControl; disabled: boolean }) {
  const { dictation, now, toggle } = control;
  return (
    <button
      type="button"
      className={`tb mic${dictation.kind === "recording" ? " rec" : ""}${dictation.kind === "working" ? " busy" : ""}`}
      title={dictation.kind === "recording" ? "Stop recording and transcribe" : "Dictate: tap to record, tap again to add the text (whisper.cpp on your machine)"}
      aria-pressed={dictation.kind === "recording"}
      disabled={disabled || dictation.kind === "working"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void toggle()}
    >
      <ToolIcon d={TOOL_ICONS.mic} />
      {dictation.kind === "recording" && <span className="mic-time">{clock(Math.max(0, Math.floor((now - dictation.startedAt) / 1000)))}</span>}
    </button>
  );
}

/** What the mic is doing, under the editor; nothing while idle. */
export function DictationLine({ dictation }: { dictation: Dictation }) {
  if (dictation.kind === "idle") return null;
  return (
    <div className={`dictation-line${dictation.kind === "error" ? " error" : ""}`} role="status">
      {dictation.kind === "recording" ? (
        <>
          <span className="rec-dot" aria-hidden="true" />
          {"Recording\u2026 tap the microphone again to transcribe"}
        </>
      ) : dictation.kind === "working" ? (
        dictation.status
      ) : (
        dictation.message
      )}
    </div>
  );
}

/** The picked files as chips with their upload state; nothing while there are none. */
export function AttachList<A>({ attachments }: { attachments: PendingAttachments<A> }) {
  const files = attachments.items;
  const [openId, setOpenId] = useState<string | null>(null);
  const open = files.find((f) => f.id === openId) ?? null;
  const openKind = open ? previewKind(open.name, open.mimeType) : null;
  if (files.length === 0) return null;
  return (
    <>
      <ul className="attach-list" aria-label="Attached files">
        {files.map((f) => {
          const kind = previewKind(f.name, f.mimeType);
          const label = (
            <>
              <AttachmentThumb kind={kind} url={f.url} name={f.name} />
              <span className="attach-name">{f.name}</span>
            </>
          );
          return (
            <li key={f.id} className={`attach-chip ${f.state.kind}`} title={f.state.kind === "error" ? f.state.message : `${f.mimeType} \u00b7 ${formatBytes(f.size)}`}>
              {f.state.kind === "uploading" && <span className="attach-bar" style={{ width: `${Math.round(f.state.progress * 100)}%` }} />}
              {kind ? (
                <button type="button" className="attach-open" title={`Preview ${f.name}`} onClick={() => setOpenId(f.id)}>
                  {label}
                </button>
              ) : (
                <span className="attach-open">{label}</span>
              )}
              <span className="attach-meta">
                {f.state.kind === "uploading" ? `${Math.round(f.state.progress * 100)}%` : f.state.kind === "error" ? f.state.message : formatBytes(f.size)}
              </span>
              <button type="button" className="attach-remove" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => attachments.remove(f.id)}>
                {"\u00d7"}
              </button>
            </li>
          );
        })}
      </ul>
      {open && openKind && <AttachmentPreviewDialog item={open} kind={openKind} onClose={() => setOpenId(null)} />}
    </>
  );
}
