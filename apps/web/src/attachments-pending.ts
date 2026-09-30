import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PROMPT_ATTACHMENTS, MAX_UPLOAD_BYTES, type PromptAttachment, type StagedUpload } from "@sessionboxer/protocol";
import { api } from "./api";

/** A file picked for the next prompt: uploading, stored (as `A`: in the Sandbox, or staged on the Control Plane), or failed. */
export type PendingAttachment<A = PromptAttachment> = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** Object URL of the picked file, for the chip's thumbnail and the preview; revoked when the item goes. */
  url: string;
  state: { kind: "uploading"; progress: number } | { kind: "ready"; attachment: A } | { kind: "error"; message: string };
};

export type PendingAttachments<A = PromptAttachment> = {
  items: PendingAttachment<A>[];
  /** Starts uploading the files right away; refused while the target is not live. */
  add: (files: Iterable<File>) => void;
  remove: (id: string) => void;
  /** Swaps the file of an item for another (an edited image), keeping its place; uploads it right away. */
  replace: (id: string, file: File) => void;
  clear: () => void;
  /** Every item is stored (and there is at least one). */
  ready: boolean;
  uploading: boolean;
  /** The stored files, in the order they were added. */
  attachments: A[];
};

export type Uploader<A> = (file: File, onProgress: (frac: number) => void, signal: AbortSignal) => Promise<A>;

let nextId = 0;

/** Uploads files for the Session's next prompt into its Sandbox as they are picked, keeping their state for the chips. */
export function usePendingAttachments(sessionId: string, live: boolean, onError: (message: string) => void): PendingAttachments {
  const upload = useCallback<Uploader<PromptAttachment>>((file, onProgress, signal) => api.upload(sessionId, file, onProgress, signal), [sessionId]);
  return usePendingUploads(sessionId, live, onError, upload);
}

/** Files for a Session that does not exist yet: staged on the Control Plane, named by id on the create request; dropped when the screen is left. */
export function useStagedAttachments(onError: (message: string) => void): PendingAttachments<StagedUpload> {
  return usePendingUploads("new", true, onError, api.stageUpload, api.unstageUpload);
}

function usePendingUploads<A>(key: string, live: boolean, onError: (message: string) => void, upload: Uploader<A>, discard?: (stored: A) => void): PendingAttachments<A> {
  const [items, setItems] = useState<PendingAttachment<A>[]>([]);
  const count = useRef(0);
  count.current = items.length;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const controllers = useRef(new Map<string, AbortController>());

  // Switching Sessions drops the list (files stay in the previous box's uploads folder; staged ones are deleted).
  useEffect(() => {
    return () => {
      for (const c of controllers.current.values()) c.abort();
      controllers.current.clear();
      for (const a of itemsRef.current) {
        URL.revokeObjectURL(a.url);
        if (a.state.kind === "ready") discard?.(a.state.attachment);
      }
      setItems([]);
    };
  }, [key, discard]);

  const patch = useCallback((id: string, state: PendingAttachment<A>["state"]) => {
    setItems((cur) => cur.map((a) => (a.id === id ? { ...a, state } : a)));
  }, []);

  /** The item for a file, its upload started (unless the file is too large). */
  const start = useCallback(
    (id: string, file: File): PendingAttachment<A> => {
      const mimeType = file.type || "application/octet-stream";
      const url = URL.createObjectURL(file);
      if (file.size > MAX_UPLOAD_BYTES) {
        return { id, name: file.name, size: file.size, mimeType, url, state: { kind: "error", message: `over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` } };
      }
      const controller = new AbortController();
      controllers.current.set(id, controller);
      upload(file, (progress) => patch(id, { kind: "uploading", progress }), controller.signal)
        .then((attachment) => patch(id, { kind: "ready", attachment }))
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          patch(id, { kind: "error", message: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => controllers.current.delete(id));
      return { id, name: file.name, size: file.size, mimeType, url, state: { kind: "uploading", progress: 0 } };
    },
    [upload, patch],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      if (!live) {
        onError("Files can only be attached while the Sandbox is running.");
        return;
      }
      const picked = [...files];
      if (picked.length === 0) return;
      const room = MAX_PROMPT_ATTACHMENTS - count.current;
      if (picked.length > room) {
        onError(`At most ${MAX_PROMPT_ATTACHMENTS} files per message.`);
        picked.splice(Math.max(0, room));
      }
      const fresh = picked.map((file) => start(`u${++nextId}`, file));
      count.current += fresh.length;
      setItems((cur) => [...cur, ...fresh]);
    },
    [start, live, onError],
  );

  const replace = useCallback(
    (id: string, file: File) => {
      if (!live) {
        onError("Files can only be attached while the Sandbox is running.");
        return;
      }
      const old = itemsRef.current.find((a) => a.id === id);
      if (!old) return;
      controllers.current.get(id)?.abort();
      URL.revokeObjectURL(old.url);
      if (old.state.kind === "ready") discard?.(old.state.attachment);
      const fresh = start(id, file);
      setItems((cur) => cur.map((a) => (a.id === id ? fresh : a)));
    },
    [start, live, onError, discard],
  );

  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      const gone = itemsRef.current.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      if (gone?.state.kind === "ready") discard?.(gone.state.attachment);
      setItems((cur) => cur.filter((a) => a.id !== id));
    },
    [discard],
  );

  const clear = useCallback(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    for (const a of itemsRef.current) URL.revokeObjectURL(a.url);
    setItems([]);
  }, []);

  const attachments = items.flatMap((a) => (a.state.kind === "ready" ? [a.state.attachment] : []));
  return {
    items,
    add,
    remove,
    replace,
    clear,
    ready: items.length > 0 && attachments.length === items.length,
    uploading: items.some((a) => a.state.kind === "uploading"),
    attachments,
  };
}
