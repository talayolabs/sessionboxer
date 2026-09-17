import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { mediaKind, type FsChange, type FsEntry, type FsReadResult, type Session } from "@sessionboxer/protocol";
import { api, onFsChanged } from "./api";
import { AttachmentCard } from "./Attachments";
import { dirOf } from "./attachment-paths";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";
import { languageFor, monaco } from "./monaco";

type Listing = { entries: FsEntry[] } | { error: string } | "loading";

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Media files get the same inline viewer as chat attachments; other binaries a notice. */
function BinaryPreview({ sessionId, path }: { sessionId: string; path: string }) {
  const kind = mediaKind(path);
  if (!kind) return <div className="desktop-overlay">Binary or large file, not shown as text.</div>;
  return (
    <div className="file-preview">
      <AttachmentCard sessionId={sessionId} attachment={{ path, name: nameOf(path), kind }} />
    </div>
  );
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isLive(session: Session): boolean {
  return session.status === "idle" || session.status === "running";
}

/** Workspace file tree + Monaco editor for one Session. Last write wins; the watcher keeps us honest. */
export function Files({ session }: { session: Session }) {
  const live = isLive(session);
  const [dirs, setDirs] = useState<Map<string, Listing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<FsReadResult | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [diskNotice, setDiskNotice] = useState<"changed" | "deleted" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Markdown / Mermaid files open rendered; Edit switches to the editor (the preview follows the draft).
  const [view, setView] = useState<"preview" | "edit">("preview");

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((prev) => (prev.get(path) ? prev : new Map(prev).set(path, "loading")));
      try {
        const res = await api.fsList(session.id, path);
        setDirs((prev) => new Map(prev).set(path, { entries: res.entries }));
      } catch (e) {
        setDirs((prev) => new Map(prev).set(path, { error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [session.id],
  );

  const loadFile = useCallback(
    async (path: string) => {
      try {
        const res = await api.fsRead(session.id, path);
        setFile(res);
        setDraft(res.content ?? "");
        setDirty(false);
        setDiskNotice(null);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [session.id],
  );

  // Fresh state per Session; whenever its Sandbox comes (back) up, reload the tree and the open file
  // (Stop/Resume keeps the selection).
  const openRef = useRef(openPath);
  openRef.current = openPath;
  const lastSession = useRef<string | null>(null);
  useEffect(() => {
    const sameSession = lastSession.current === session.id;
    lastSession.current = session.id;
    if (!sameSession) {
      setOpenPath(null);
      setFile(null);
      setDraft("");
      setDirty(false);
      setDiskNotice(null);
      setError(null);
    }
    setDirs(new Map());
    setExpanded(new Set([""]));
    if (!live) return;
    void loadDir("");
    if (sameSession && openRef.current) void loadFile(openRef.current);
  }, [session.id, live, loadDir, loadFile]);

  // React to writes made by the Agent (or anyone else inside the Sandbox).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  useEffect(
    () =>
      onFsChanged((sessionId, changes: FsChange[]) => {
        if (sessionId !== session.id) return;
        const touchedDirs = new Set<string>();
        for (const c of changes) {
          touchedDirs.add(parentOf(c.path));
          if (c.kind === "deleted" && c.isDir) {
            setDirs((prev) => {
              const next = new Map(prev);
              for (const k of next.keys()) if (k === c.path || k.startsWith(`${c.path}/`)) next.delete(k);
              return next;
            });
          }
          const open = openRef.current;
          if (open && (c.path === open || (c.isDir && c.kind === "deleted" && open.startsWith(`${c.path}/`)))) {
            if (c.kind === "deleted") setDiskNotice("deleted");
            else if (dirtyRef.current) setDiskNotice("changed");
            else void loadFile(open);
          }
        }
        for (const d of touchedDirs) if (dirsRef.current.has(d)) void loadDir(d);
      }),
    [session.id, loadDir, loadFile],
  );

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs.has(path)) void loadDir(path);
      }
      return next;
    });
  };

  const openFile = (path: string) => {
    if (path === openPath) return;
    if (dirty && !confirm(`Discard unsaved changes to ${nameOf(openPath ?? "")}?`)) return;
    setOpenPath(path);
    setFile(null);
    void loadFile(path);
  };

  const save = useCallback(async () => {
    if (!openPath || !file || file.binary || file.truncated) return;
    setSaving(true);
    try {
      const res = await api.fsWrite(session.id, openPath, draft);
      setFile({ ...file, size: res.size, mtime: res.mtime, content: draft });
      setDirty(false);
      setDiskNotice(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [openPath, file, draft, session.id]);

  const saveRef = useRef(save);
  saveRef.current = save;
  const onMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
  };

  const editable = Boolean(file && !file.binary && !file.truncated && live);
  const docKind = openPath ? mediaKind(openPath) : null;
  const previewable = editable && (docKind === "markdown" || docKind === "mermaid");
  const showPreview = previewable && view === "preview";

  return (
    <div className="files">
      <div className="file-tree">
        <div className="file-tree-header">
          <span>Workspace</span>
          <span className="spacer" />
          <button className="small" onClick={() => void loadDir("")} disabled={!live} title="Refresh">
            ↻
          </button>
        </div>
        <div className="file-tree-body">
          {live ? (
            <TreeDir path="" depth={0} dirs={dirs} expanded={expanded} openPath={openPath} onToggle={toggleDir} onOpen={openFile} />
          ) : (
            <div className="muted pad">Sandbox is {session.status}; files are available while it runs.</div>
          )}
        </div>
      </div>
      <div className="editor">
        <div className="editor-toolbar">
          {openPath ? (
            <>
              <span className="editor-path" title={openPath}>
                {openPath}
                {dirty ? " •" : ""}
              </span>
              {file && <span className="muted">{file.size} B</span>}
              <span className="spacer" />
              {previewable && (
                <span className="segmented small">
                  <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>
                    Preview
                  </button>
                  <button className={view === "edit" ? "active" : ""} onClick={() => setView("edit")}>
                    Edit
                  </button>
                </span>
              )}
              <button onClick={() => void save()} disabled={!editable || !dirty || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <span className="muted">Select a file</span>
          )}
        </div>
        {error && (
          <div className="banner banner-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {diskNotice === "changed" && (
          <div className="banner banner-warn">
            This file changed on disk while you have unsaved edits.
            <button className="small" onClick={() => openPath && void loadFile(openPath)}>
              Reload (discard mine)
            </button>
            <button className="small" onClick={() => void save()}>
              Overwrite with mine
            </button>
          </div>
        )}
        {diskNotice === "deleted" && <div className="banner banner-warn">This file was deleted on disk. Saving will recreate it.</div>}
        <div className="editor-body">
          {openPath && file && (file.binary || file.truncated) && <BinaryPreview sessionId={session.id} path={openPath} />}
          {openPath && showPreview && (
            <div className="file-preview file-document">
              {docKind === "mermaid" ? <Mermaid code={draft} /> : <Markdown text={draft} base={dirOf(openPath)} />}
            </div>
          )}
          {openPath && file && !file.binary && !file.truncated && !showPreview && (
            <Editor
              path={`${session.id}/${openPath}`}
              language={languageFor(nameOf(openPath))}
              value={draft}
              theme="vs-dark"
              onMount={onMount}
              onChange={(v) => {
                setDraft(v ?? "");
                setDirty((v ?? "") !== (file.content ?? ""));
              }}
              options={{
                readOnly: !editable,
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
              }}
            />
          )}
          {openPath && !file && !error && <div className="desktop-overlay muted">Loading…</div>}
        </div>
      </div>
    </div>
  );
}

function TreeDir({
  path,
  depth,
  dirs,
  expanded,
  openPath,
  onToggle,
  onOpen,
}: {
  path: string;
  depth: number;
  dirs: Map<string, Listing>;
  expanded: Set<string>;
  openPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const listing = dirs.get(path);
  if (!listing || listing === "loading") return <div className="tree-row muted" style={{ paddingLeft: 12 + depth * 14 }}>…</div>;
  if ("error" in listing) return <div className="tree-row warn" style={{ paddingLeft: 12 + depth * 14 }}>{listing.error}</div>;
  if (listing.entries.length === 0 && path === "") return <div className="tree-row muted" style={{ paddingLeft: 12 }}>Empty workspace</div>;
  return (
    <>
      {listing.entries.map((e) => {
        const child = path ? `${path}/${e.name}` : e.name;
        if (e.type === "dir") {
          const open = expanded.has(child);
          return (
            <div key={child}>
              <div className="tree-row tree-dir" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => onToggle(child)}>
                <span className="tree-caret">{open ? "▾" : "▸"}</span>
                {e.name}
              </div>
              {open && <TreeDir path={child} depth={depth + 1} dirs={dirs} expanded={expanded} openPath={openPath} onToggle={onToggle} onOpen={onOpen} />}
            </div>
          );
        }
        return (
          <div
            key={child}
            className={`tree-row tree-file${child === openPath ? " active" : ""}${e.type !== "file" ? " muted" : ""}`}
            style={{ paddingLeft: 12 + depth * 14 + 14 }}
            onClick={() => e.type === "file" && onOpen(child)}
            title={child}
          >
            {e.name}
          </div>
        );
      })}
    </>
  );
}
