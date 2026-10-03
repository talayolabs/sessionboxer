import { useState } from "react";

/**
 * The Install / Cancel / Delete buttons' state for a shared base disk (Windows, macOS): one call in flight at a
 * time, its error, and the two-step Delete confirmation, which any call resets.
 */
export function useBaseDiskAction<S>(onStatus: (status: S) => void) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = async (call: () => Promise<S>) => {
    setWorking(true);
    setError(null);
    try {
      onStatus(await call());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setConfirmDelete(false);
    }
  };
  return { error, working, confirmDelete, setConfirmDelete, act };
}
