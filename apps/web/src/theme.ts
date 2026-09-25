import { useEffect, useState } from "react";
import { DEFAULT_THEME_PREFERENCE, THEMES, ThemePreference, themeAnsi, themeCssVariables, vscodeCssVariables, type Theme } from "@sessionboxer/protocol";

// The color theme is a preference of this browser (localStorage), applied as CSS custom
// properties on <html> before React renders (main.tsx) and again whenever it changes; the
// Code pane forwards the same theme to the VS Code in the box (ADR-0048).

const STORAGE_KEY = "sessionboxer.theme";
const EVENT = "sessionboxer:theme";

export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return ThemePreference.parse(JSON.parse(raw));
  } catch {
    // Unknown or corrupt: fall back to the default.
  }
  return DEFAULT_THEME_PREFERENCE;
}

const systemDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function resolveTheme(pref: ThemePreference): Theme {
  if (pref.mode === "fixed") return THEMES[pref.theme];
  return THEMES[systemDark?.matches ? pref.dark : pref.light];
}

let current: Theme = resolveTheme(readThemePreference());

export function currentTheme(): Theme {
  return current;
}

function apply(theme: Theme) {
  current = theme;
  const root = document.documentElement;
  for (const vars of [themeCssVariables(theme), vscodeCssVariables(theme)]) {
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(`--${name}`, value);
  }
  root.style.colorScheme = theme.kind;
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.colors.bg);
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Applies the stored preference; call once before the first render, then it follows the system scheme on its own. */
export function initTheme() {
  apply(resolveTheme(readThemePreference()));
  systemDark?.addEventListener("change", () => apply(resolveTheme(readThemePreference())));
}

export function setThemePreference(pref: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  apply(resolveTheme(pref));
}

/** The theme in effect, re-rendering when it changes. */
/** The theme in effect; re-renders on every preference change (also ones that resolve to the same theme). */
export function useTheme(): Theme {
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return current;
}

/** xterm.js theme for a Sessionboxer theme. */
export function xtermTheme(theme: Theme) {
  const c = theme.colors;
  return {
    background: c.sunken,
    foreground: c.text,
    cursor: c.text,
    cursorAccent: c.sunken,
    selectionBackground: c.user,
    selectionInactiveBackground: c.selected,
    ...themeAnsi(theme),
  };
}

/** Mermaid `themeVariables` for a Sessionboxer theme (with `theme: "base"`). */
export function mermaidThemeVariables(theme: Theme) {
  const c = theme.colors;
  return {
    darkMode: theme.kind === "dark",
    background: c.sunken,
    primaryColor: c.user,
    primaryTextColor: c.text,
    primaryBorderColor: c.accent,
    secondaryColor: c.panel,
    secondaryTextColor: c.text,
    secondaryBorderColor: c.border,
    tertiaryColor: c.hover,
    tertiaryTextColor: c.text,
    tertiaryBorderColor: c.border,
    lineColor: c.muted,
    textColor: c.text,
    mainBkg: c.user,
    nodeBorder: c.accent,
    clusterBkg: c.panel,
    clusterBorder: c.border,
    titleColor: c.text,
    edgeLabelBackground: c.panel,
    noteBkgColor: c.agent,
    noteTextColor: c.text,
    noteBorderColor: c.border,
    actorBkg: c.panel,
    actorBorder: c.border,
    actorTextColor: c.text,
    signalColor: c.text,
    signalTextColor: c.text,
    labelBoxBkgColor: c.panel,
    labelBoxBorderColor: c.border,
    labelTextColor: c.text,
    loopTextColor: c.text,
    activationBkgColor: c.hover,
    activationBorderColor: c.border,
    sequenceNumberColor: c.onAccent,
    fontFamily: "inherit",
  };
}
