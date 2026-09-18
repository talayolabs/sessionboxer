import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PROMPT_ATTACHMENTS, MAX_UPLOAD_BYTES, type PromptAttachment } from "@sessionboxer/protocol";
import { api } from "./api";

/** A file picked for the next prompt: uploading into the Sandbox, stored there, or failed. */
export type PendingAttachment = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  state: { kind: "uploading"; progress: number } | { kind: "ready"; attachment: PromptAttachment } | { kind: "error"; message: string };
};

export type PendingAttachments = {
  items: PendingAttachment[];
  /** Starts uploading the files right away; refused while the Sandbox is not live. */
  add: (files: Iterable<File>) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Every item is stored in the Sandbox (and there is at least one). */
  ready: boolean;
  uploading: boolean;
  /** The stored files, in the order they were added. */
  attachments: PromptAttachment[];
};

let nextId = 0;

/** Uploads files for the Session's next prompt as they are picked, keeping their state for the chips. */
export function usePendingAttachments(sessionId: string, live: boolean, onError: (message: string) => void): PendingAttachments {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const count = useRef(0);
  count.current = items.length;
  const controllers = useRef(new Map<string, AbortController>());

  // Switching Sessions drops the list (files stay in the previous box's uploads folder).
  useEffect(() => {
    return () => {
      for (const c of controllers.current.values()) c.abort();
      controllers.current.clear();
      setItems([]);
    };
  }, [sessionId]);

  const patch = useCallback((id: string, state: PendingAttachment["state"]) => {
    setItems((cur) => cur.map((a) => (a.id === id ? { ...a, state } : a)));
  }, []);

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
      const fresh = picked.map((file): PendingAttachment => {
        const id = `u${++nextId}`;
        const mimeType = file.type || "application/octet-stream";
        if (file.size > MAX_UPLOAD_BYTES) {
          return { id, name: file.name, size: file.size, mimeType, state: { kind: "error", message: `over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` } };
        }
        const controller = new AbortController();
        controllers.current.set(id, controller);
        api
          .upload(sessionId, file, (progress) => patch(id, { kind: "uploading", progress }), controller.signal)
          .then((attachment) => patch(id, { kind: "ready", attachment }))
          .catch((e: unknown) => {
            if (e instanceof DOMException && e.name === "AbortError") return;
            patch(id, { kind: "error", message: e instanceof Error ? e.message : String(e) });
          })
          .finally(() => controllers.current.delete(id));
        return { id, name: file.name, size: file.size, mimeType, state: { kind: "uploading", progress: 0 } };
      });
      count.current += fresh.length;
      setItems((cur) => [...cur, ...fresh]);
    },
    [sessionId, live, onError, patch],
  );

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    setItems((cur) => cur.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    setItems([]);
  }, []);

  const attachments = items.flatMap((a) => (a.state.kind === "ready" ? [a.state.attachment] : []));
  return {
    items,
    add,
    remove,
    clear,
    ready: items.length > 0 && attachments.length === items.length,
    uploading: items.some((a) => a.state.kind === "uploading"),
    attachments,
  };
}
