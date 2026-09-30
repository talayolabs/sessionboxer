/**
 * The camera button: a photo or a short video from the device's camera, or a recording of the screen,
 * attached to the prompt like a picked file. `getUserMedia` for the live preview, `getDisplayMedia` for
 * the screen, a canvas for the still, `MediaRecorder` for the clip.
 * Needs a secure context like the microphone; without one the button falls back to the browser's own
 * capture picker (`<input capture>`), which phones answer with their camera app.
 */

/** A clip stops itself here; a prompt attachment is meant to show something, not to be a film. */
export const MAX_VIDEO_S = 5 * 60;

export type CameraSupport = { ok: true } | { ok: false; reason: string };

export function cameraSupport(): CameraSupport {
  if (typeof window === "undefined") return { ok: false, reason: "no window" };
  if (!window.isSecureContext) return { ok: false, reason: "The camera needs https or localhost; open Sessionboxer through its tunnel or on this machine." };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "This browser has no camera access (getUserMedia)." };
  return { ok: true };
}

export function cameraError(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") return "Camera access was denied; allow it for this site in the browser.";
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") return "No camera was found.";
    if (e.name === "NotReadableError" || e.name === "AbortError") return "The camera is in use by another application.";
  }
  return e instanceof Error ? e.message : String(e);
}

export type Facing = "user" | "environment";

/** Opens the camera (with the microphone when `audio`, for a clip); the caller stops the tracks. */
export function openCamera(facing: Facing, audio: boolean, deviceId?: string): Promise<MediaStream> {
  const video: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: facing };
  video.width = { ideal: 1920 };
  video.height = { ideal: 1080 };
  return navigator.mediaDevices.getUserMedia({ video, audio: audio ? { echoCancellation: true, noiseSuppression: true } : false });
}

/** Whether the browser lets a page record the screen (desktop browsers do; phones mostly do not). */
export function canCaptureScreen(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && canRecordVideo();
}

/**
 * The screen, window or tab the user picks in the browser's own dialog, with the microphone for
 * narration when it can be had (system audio is left out: the browsers disagree on it, and the
 * recording is meant to carry what the user says about the screen). The caller stops the tracks.
 */
export async function openScreen(): Promise<MediaStream> {
  const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    for (const t of mic.getAudioTracks()) display.addTrack(t);
  } catch {
    // No microphone, or it was refused: the screen alone.
  }
  return display;
}

export function screenError(e: unknown): string {
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) return "Nothing was shared; choose a screen, window or tab to record.";
  return cameraError(e);
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** The cameras the browser knows of; labels are empty until a stream was granted once. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}

function pickVideoMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const t of ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export function canRecordVideo(): boolean {
  return typeof MediaRecorder !== "undefined";
}

export interface ClipRecording {
  stop: () => Promise<Blob>;
  cancel: () => void;
}

/** Records the stream until `stop`; the Blob is what the browser produced (mp4 or webm, whichever it records). */
export function startClip(stream: MediaStream): ClipRecording {
  const mimeType = pickVideoMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : {});
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start(1000);
  return {
    stop: async () => {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      const clip = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
      if (clip.size === 0) throw new Error("Nothing was recorded.");
      return clip;
    },
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

/** The current frame of the preview as a JPEG, at the camera's own resolution. */
export function snapPhoto(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return Promise.reject(new Error("The camera has not produced a frame yet."));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("This browser cannot draw the picture (canvas)."));
  ctx.drawImage(video, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be encoded."))), "image/jpeg", 0.92);
  });
}

function stamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

function extensionFor(mimeType: string): string {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "video/mp4") return "mp4";
  if (type === "video/quicktime") return "mov";
  if (type === "video/webm") return "webm";
  return type.startsWith("video/") ? "webm" : "bin";
}

export type CaptureKind = "photo" | "video" | "screen";

/** `photo-20260930-113800.jpg`, `video-20260930-113812.webm`, `screen-….webm`: the name the agent will see under uploads/. */
export function captureFile(blob: Blob, kind: CaptureKind): File {
  const type = blob.type || (kind === "photo" ? "image/jpeg" : "video/webm");
  return new File([blob], `${kind}-${stamp()}.${extensionFor(type)}`, { type: type.split(";")[0]?.trim() || type, lastModified: Date.now() });
}
