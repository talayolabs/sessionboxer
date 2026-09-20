import { useEffect, useState } from "react";

/** Below this width the shell is the phone one: drawer sidebar, bottom tabs, one pane at a time. */
export const MOBILE_QUERY = "(max-width: 800px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Keeps `--app-height` on the root at the visual viewport's height, which is what shrinks when a
 * phone's keyboard opens (iOS leaves the layout viewport alone). The shell is sized by it, so the
 * composer stays above the keyboard.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;
    const apply = () => {
      const full = window.innerHeight;
      // Only a keyboard shrinks the visual viewport by a lot; pinch-zoom is left alone.
      const h = vv.scale > 1.01 ? full : Math.round(vv.height);
      root.style.setProperty("--app-height", `${h}px`);
      root.style.setProperty("--keyboard-height", `${Math.max(0, full - h)}px`);
      if (h < full) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--keyboard-height");
    };
  }, []);
}
