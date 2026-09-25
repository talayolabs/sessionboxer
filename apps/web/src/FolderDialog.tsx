import { useEffect, useRef, useState } from "react";
import type { HostDirListing } from "@sessionboxer/protocol";
import { api } from "./api";
import { Modal } from "./ui";

/**
 * Folder picker for the "copy a host directory" Workspace Source. Browsers do not
 * reveal host paths, so this walks the Control Plane host's filesystem through
 * `GET /api/host/dirs` (directory names only), starting at `initialPath` or home.
 */
export function FolderDialog({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<HostDirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState(initialPath);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const seq = useRef(0);

  const load = (path: string | undefined) => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .hostDirs(path)
      .then((l) => {
        if (my !== seq.current) return;
        setListing(l);
        setPathInput(l.path);
        setHighlighted(null);
      })
      .catch((e: unknown) => {
        if (my !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (my === seq.current) setLoading(false);
      });
  };

  const initial = useRef(initialPath);
  useEffect(() => {
    load(initial.current.trim() || undefined);
  }, []);

  const join = (name: string) => (listing ? `${listing.path === "/" ? "" : listing.path}/${name}` : name);
  const chosen = listing ? (highlighted ? join(highlighted) : listing.path) : null;

  return (
    <Modal className="folder-dialog" title="Choose a host folder" onClose={onClose}>
      <form
        className="folder-path"
        onSubmit={(e) => {
          e.preventDefault();
          load(pathInput);
        }}
      >
        <button
          type="button"
          className="small"
          title="Parent folder"
          disabled={!listing?.parent || loading}
          onClick={() => listing?.parent && load(listing.parent)}
        >
          {"\u2191"}
        </button>
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          spellCheck={false}
          aria-label="Folder path"
          placeholder="/absolute/path"
        />
        <button type="submit" className="small" disabled={loading}>
          Go
        </button>
      </form>
      {error && <div className="banner banner-error">{error}</div>}
      <ul className="list-box folder-list" aria-busy={loading}>
        {listing && listing.dirs.length === 0 && !error && <li className="empty">No subfolders</li>}
        {listing?.dirs.map((name) => (
          <li key={name}>
            <button
              type="button"
              className={`folder-entry${highlighted === name ? " active" : ""}`}
              aria-pressed={highlighted === name}
              onClick={() => setHighlighted(name)}
              onDoubleClick={() => load(join(name))}
            >
              <span className="folder-icon" aria-hidden>
                {"\u25B8"}
              </span>
              {name}
            </button>
          </li>
        ))}
      </ul>
      <div className="folder-footer muted">
        {chosen && (
          <>
            <span className="folder-chosen">{chosen}</span>
            {!highlighted && <span>{listing?.git ? " (git repository)" : ""}</span>}
          </>
        )}
        <span className="folder-hint">Click to pick, double-click to open</span>
      </div>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!chosen || loading} onClick={() => chosen && onSelect(chosen)}>
          Select
        </button>
      </div>
    </Modal>
  );
}
