import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_VIDEO_S, cameraError, canRecordVideo, captureFile, listCameras, openCamera, snapPhoto, startClip, stopStream, type ClipRecording, type Facing } from "./camera";
import { formatBytes } from "./format";
import { Modal } from "./ui";

type Mode = "photo" | "video";
type Captured = { kind: Mode; blob: Blob; url: string };

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Live preview from the camera; **Take photo** or **Record** / **Stop**, then the result to look at,
 * **Retake** or **Attach** — which hands a File to the composer's attachment list, like a picked file.
 */
export function CameraDialog({ onCapture, onClose }: { onCapture: (file: File) => void; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("photo");
  const [facing, setFacing] = useState<Facing>("environment");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ clip: ClipRecording; startedAt: number } | null>(null);
  const [now, setNow] = useState(0);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const recordingRef = useRef<ClipRecording | null>(null);
  const capturedRef = useRef<Captured | null>(null);
  capturedRef.current = captured;

  // One stream per (mode, camera): the microphone joins only for a clip.
  useEffect(() => {
    let current: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    setStream(null);
    openCamera(facing, mode === "video", deviceId)
      .then(async (s) => {
        if (cancelled) {
          stopStream(s);
          return;
        }
        current = s;
        setStream(s);
        setCameras(await listCameras());
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(cameraError(e));
      });
    return () => {
      cancelled = true;
      stopStream(current);
    };
  }, [mode, facing, deviceId]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
  }, [stream, captured]);

  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - recording.startedAt >= MAX_VIDEO_S * 1000) void stopRef.current();
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  // Leaving the dialog releases the camera and drops whatever was not attached.
  useEffect(
    () => () => {
      recordingRef.current?.cancel();
      if (capturedRef.current) URL.revokeObjectURL(capturedRef.current.url);
    },
    [],
  );

  const keep = (kind: Mode, blob: Blob) => {
    if (capturedRef.current) URL.revokeObjectURL(capturedRef.current.url);
    setCaptured({ kind, blob, url: URL.createObjectURL(blob) });
  };

  const takePhoto = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      keep("photo", await snapPhoto(el));
    } catch (e) {
      setError(cameraError(e));
    }
  };

  const startVideo = () => {
    if (!stream) return;
    try {
      const clip = startClip(stream);
      recordingRef.current = clip;
      setRecording({ clip, startedAt: Date.now() });
    } catch (e) {
      setError(cameraError(e));
    }
  };

  const stopVideo = useCallback(async () => {
    const clip = recordingRef.current;
    if (!clip) return;
    recordingRef.current = null;
    setRecording(null);
    try {
      keep("video", await clip.stop());
    } catch (e) {
      setError(cameraError(e));
    }
  }, []);
  const stopRef = useRef(stopVideo);
  stopRef.current = stopVideo;

  const retake = () => {
    if (captured) URL.revokeObjectURL(captured.url);
    setCaptured(null);
  };

  const attach = () => {
    if (!captured) return;
    onCapture(captureFile(captured.blob, captured.kind));
    onClose();
  };

  const switchCamera = () => {
    if (cameras.length > 1) {
      const i = cameras.findIndex((c) => c.deviceId === (deviceId ?? stream?.getVideoTracks()[0]?.getSettings().deviceId));
      setDeviceId(cameras[(i + 1) % cameras.length]?.deviceId);
    } else {
      setDeviceId(undefined);
      setFacing((f) => (f === "user" ? "environment" : "user"));
    }
  };

  const mirrored = !deviceId && facing === "user";
  const busy = recording !== null;
  const canSwitch = cameras.length > 1 || cameras.length === 0;
  const elapsed = recording ? Math.max(0, Math.floor((now - recording.startedAt) / 1000)) : 0;

  return (
    <Modal className="camera-dialog" title={captured ? (captured.kind === "photo" ? "Your photo" : "Your video") : "Camera"} dismissible={!busy} onClose={onClose}>
      {!captured && (
        <div className="segmented small camera-modes" role="tablist" aria-label="What to capture">
          <button type="button" role="tab" aria-selected={mode === "photo"} disabled={busy} onClick={() => setMode("photo")}>
            Photo
          </button>
          <button type="button" role="tab" aria-selected={mode === "video"} disabled={busy || !canRecordVideo()} title={canRecordVideo() ? undefined : "This browser cannot record video (MediaRecorder)."} onClick={() => setMode("video")}>
            Video
          </button>
        </div>
      )}
      <div className="camera-stage">
        {captured ? (
          captured.kind === "photo" ? (
            <img src={captured.url} alt="The photo just taken" />
          ) : (
            <video src={captured.url} controls autoPlay playsInline />
          )
        ) : (
          <>
            <video ref={videoRef} className={mirrored ? "mirrored" : undefined} muted autoPlay playsInline aria-label="Camera preview" />
            {!stream && !error && <div className="camera-overlay muted">Starting the camera\u2026</div>}
            {error && <div className="camera-overlay error">{error}</div>}
            {recording && (
              <div className="camera-rec" role="status">
                <span className="rec-dot" aria-hidden="true" />
                {clock(elapsed)}
              </div>
            )}
          </>
        )}
      </div>
      <div className="actions camera-actions">
        {captured ? (
          <>
            <span className="muted small-text">{formatBytes(captured.blob.size)}</span>
            <span className="spacer" />
            <button type="button" onClick={retake}>
              Retake
            </button>
            <button type="button" className="primary" onClick={attach}>
              Attach
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={switchCamera} disabled={busy || !stream || !canSwitch} title="Switch camera">
              Switch camera
            </button>
            <span className="spacer" />
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {mode === "photo" ? (
              <button type="button" className="primary" onClick={() => void takePhoto()} disabled={!stream}>
                Take photo
              </button>
            ) : recording ? (
              <button type="button" className="primary stop" onClick={() => void stopVideo()}>
                Stop
              </button>
            ) : (
              <button type="button" className="primary" onClick={startVideo} disabled={!stream}>
                Record
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
