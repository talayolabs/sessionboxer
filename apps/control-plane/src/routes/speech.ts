// Speech to text: the browser posts a 16 kHz mono WAV clip, whisper.cpp on this machine answers with the text.
import { type Hono } from "hono";
import { SPEECH_CLIP_MAX_BYTES, SPEECH_LANGUAGE_PATTERN, SpeechModel } from "@sessionboxer/protocol";
import { HttpError } from "../sessions.js";
import { deleteModel } from "../speech.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerSpeechRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { speech, settings } = deps;
  api.get("/speech", async (c) => c.json(await speech.status(settings.get().speech)));
  api.post("/speech/prepare", async (c) => c.json(await speech.prepare(settings.get().speech)));
  api.post("/speech/transcribe", async (c) => {
    const tooLarge = new HttpError(413, `The clip is larger than ${Math.round(SPEECH_CLIP_MAX_BYTES / 1024 / 1024)} MB.`);
    if (Number(c.req.header("content-length") ?? 0) > SPEECH_CLIP_MAX_BYTES) throw tooLarge;
    const wav = Buffer.from(await c.req.arrayBuffer());
    if (wav.length > SPEECH_CLIP_MAX_BYTES) throw tooLarge;
    const language = c.req.query("language")?.trim() ?? "";
    if (language && !SPEECH_LANGUAGE_PATTERN.test(language)) throw new HttpError(400, "language must be a two-letter code or auto");
    return c.json(await speech.transcribe(wav, settings.get().speech, language || null));
  });
  api.delete("/speech/models/:name", (c) => {
    deleteModel(SpeechModel.parse(c.req.param("name")), settings.get().speech);
    return c.body(null, 204);
  });
}
