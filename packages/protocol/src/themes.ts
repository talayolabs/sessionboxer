import { z } from "zod";

// ---------------------------------------------------------------------------
// Color themes (web UI + the VS Code in the Sandbox)
// ---------------------------------------------------------------------------
//
// One palette per theme drives both the UI's CSS variables (`themeCssVariables`) and the
// VS Code color theme the Sandbox image ships (`vscodeTheme`), so the editor in the Code pane
// is drawn in the very same values as the UI around it (ADR-0048).

export const THEME_IDS = [
  "sessionboxer-dark",
  "sessionboxer-light",
  "github-dark",
  "github-light",
  "catppuccin-mocha",
  "catppuccin-latte",
  "solarized-dark",
  "solarized-light",
  "dracula",
  "nord",
  "one-dark",
] as const;
export const ThemeId = z.enum(THEME_IDS);
export type ThemeId = z.infer<typeof ThemeId>;

/** What the UI stores: a theme, or "follow the system" with one theme per scheme. */
export const ThemePreference = z.union([
  z.object({ mode: z.literal("fixed"), theme: ThemeId }),
  z.object({ mode: z.literal("system"), light: ThemeId, dark: ThemeId }),
]);
export type ThemePreference = z.infer<typeof ThemePreference>;

export const DEFAULT_THEME_PREFERENCE: ThemePreference = { mode: "fixed", theme: "sessionboxer-dark" };

export type ThemeColors = {
  /** App background; also inputs. */
  bg: string;
  /** One step deeper: code blocks, the panes' canvas, the editor's background. */
  sunken: string;
  /** Sidebar, panels, buttons, the editor's chrome (side bar, tabs, status bar). */
  panel: string;
  /** Row under the pointer. */
  hover: string;
  /** Selected row. */
  selected: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  /** Text on an accent background. */
  onAccent: string;
  /** The user's bubbles and the active tab/segment. */
  user: string;
  /** The agent's bubbles. */
  agent: string;
  ok: string;
  warn: string;
  error: string;
  scrollbar: string;
};

/** Syntax colors: the same seven roles for highlight.js in the chat and TextMate scopes in VS Code. */
export type ThemeSyntax = {
  comment: string;
  keyword: string;
  /** Functions, classes, types, headings. */
  function: string;
  string: string;
  /** Numbers, literals, meta. */
  number: string;
  /** Variables, parameters, properties, attributes. */
  variable: string;
  /** Tags and selectors. */
  tag: string;
};

export type Theme = {
  id: ThemeId;
  label: string;
  kind: "dark" | "light";
  colors: ThemeColors;
  syntax: ThemeSyntax;
};

const GITHUB_DARK_SYNTAX: ThemeSyntax = {
  comment: "#8b949e",
  keyword: "#ff7b72",
  function: "#d2a8ff",
  string: "#a5d6ff",
  number: "#79c0ff",
  variable: "#ffa657",
  tag: "#7ee787",
};

const GITHUB_LIGHT_SYNTAX: ThemeSyntax = {
  comment: "#6e7781",
  keyword: "#cf222e",
  function: "#8250df",
  string: "#0a3069",
  number: "#0550ae",
  variable: "#953800",
  tag: "#116329",
};

export const THEMES: Record<ThemeId, Theme> = {
  "sessionboxer-dark": {
    id: "sessionboxer-dark",
    label: "Sessionboxer Dark",
    kind: "dark",
    colors: {
      bg: "#0f1115",
      sunken: "#0b0d11",
      panel: "#171a21",
      hover: "#1f232d",
      selected: "#23293a",
      border: "#2a2f3a",
      text: "#e6e6e6",
      muted: "#8b93a7",
      accent: "#4f8cff",
      onAccent: "#ffffff",
      user: "#1f2b44",
      agent: "#1b1f27",
      ok: "#3fb950",
      warn: "#d29922",
      error: "#f85149",
      scrollbar: "#3a4150",
    },
    syntax: GITHUB_DARK_SYNTAX,
  },
  "sessionboxer-light": {
    id: "sessionboxer-light",
    label: "Sessionboxer Light",
    kind: "light",
    colors: {
      bg: "#ffffff",
      sunken: "#f3f5f9",
      panel: "#f7f8fa",
      hover: "#eceff4",
      selected: "#e2e7f0",
      border: "#d7dce5",
      text: "#1f2430",
      muted: "#5f6b80",
      accent: "#2f6fe4",
      onAccent: "#ffffff",
      user: "#dbe6fb",
      agent: "#f1f3f7",
      ok: "#1a7f37",
      warn: "#9a6700",
      error: "#cf222e",
      scrollbar: "#c3c9d4",
    },
    syntax: GITHUB_LIGHT_SYNTAX,
  },
  "github-dark": {
    id: "github-dark",
    label: "GitHub Dark",
    kind: "dark",
    colors: {
      bg: "#0d1117",
      sunken: "#010409",
      panel: "#161b22",
      hover: "#1c2128",
      selected: "#21262d",
      border: "#30363d",
      text: "#e6edf3",
      muted: "#8b949e",
      accent: "#58a6ff",
      onAccent: "#ffffff",
      user: "#1a2f4d",
      agent: "#161b22",
      ok: "#3fb950",
      warn: "#d29922",
      error: "#f85149",
      scrollbar: "#484f58",
    },
    syntax: GITHUB_DARK_SYNTAX,
  },
  "github-light": {
    id: "github-light",
    label: "GitHub Light",
    kind: "light",
    colors: {
      bg: "#ffffff",
      sunken: "#f6f8fa",
      panel: "#f6f8fa",
      hover: "#eaeef2",
      selected: "#dde3ea",
      border: "#d0d7de",
      text: "#1f2328",
      muted: "#656d76",
      accent: "#0969da",
      onAccent: "#ffffff",
      user: "#ddf4ff",
      agent: "#f6f8fa",
      ok: "#1a7f37",
      warn: "#9a6700",
      error: "#cf222e",
      scrollbar: "#afb8c1",
    },
    syntax: GITHUB_LIGHT_SYNTAX,
  },
  "catppuccin-mocha": {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    kind: "dark",
    colors: {
      bg: "#1e1e2e",
      sunken: "#181825",
      panel: "#181825",
      hover: "#313244",
      selected: "#45475a",
      border: "#313244",
      text: "#cdd6f4",
      muted: "#a6adc8",
      accent: "#89b4fa",
      onAccent: "#11111b",
      user: "#2c3a5a",
      agent: "#24243a",
      ok: "#a6e3a1",
      warn: "#f9e2af",
      error: "#f38ba8",
      scrollbar: "#585b70",
    },
    syntax: {
      comment: "#6c7086",
      keyword: "#cba6f7",
      function: "#89b4fa",
      string: "#a6e3a1",
      number: "#fab387",
      variable: "#b4befe",
      tag: "#94e2d5",
    },
  },
  "catppuccin-latte": {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    kind: "light",
    colors: {
      bg: "#eff1f5",
      sunken: "#e6e9ef",
      panel: "#e6e9ef",
      hover: "#ccd0da",
      selected: "#bcc0cc",
      border: "#ccd0da",
      text: "#4c4f69",
      muted: "#6c6f85",
      accent: "#1e66f5",
      onAccent: "#ffffff",
      user: "#d6e0fb",
      agent: "#e6e9ef",
      ok: "#40a02b",
      warn: "#df8e1d",
      error: "#d20f39",
      scrollbar: "#acb0be",
    },
    syntax: {
      comment: "#9ca0b0",
      keyword: "#8839ef",
      function: "#1e66f5",
      string: "#40a02b",
      number: "#fe640b",
      variable: "#7287fd",
      tag: "#179299",
    },
  },
  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    kind: "dark",
    colors: {
      bg: "#002b36",
      sunken: "#00212b",
      panel: "#073642",
      hover: "#0f4b5a",
      selected: "#14596a",
      border: "#10404d",
      text: "#93a1a1",
      muted: "#657b83",
      accent: "#268bd2",
      onAccent: "#fdf6e3",
      user: "#123f5a",
      agent: "#063340",
      ok: "#859900",
      warn: "#b58900",
      error: "#dc322f",
      scrollbar: "#586e75",
    },
    syntax: {
      comment: "#586e75",
      keyword: "#859900",
      function: "#268bd2",
      string: "#2aa198",
      number: "#d33682",
      variable: "#b58900",
      tag: "#6c71c4",
    },
  },
  "solarized-light": {
    id: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    colors: {
      bg: "#fdf6e3",
      sunken: "#f5eedb",
      panel: "#eee8d5",
      hover: "#e4ddc4",
      selected: "#d9d2b8",
      border: "#ddd6c1",
      text: "#586e75",
      muted: "#839496",
      accent: "#268bd2",
      onAccent: "#fdf6e3",
      user: "#dbe8f0",
      agent: "#f6efdb",
      ok: "#859900",
      warn: "#b58900",
      error: "#dc322f",
      scrollbar: "#93a1a1",
    },
    syntax: {
      comment: "#93a1a1",
      keyword: "#859900",
      function: "#268bd2",
      string: "#2aa198",
      number: "#d33682",
      variable: "#b58900",
      tag: "#6c71c4",
    },
  },
  dracula: {
    id: "dracula",
    label: "Dracula",
    kind: "dark",
    colors: {
      bg: "#282a36",
      sunken: "#21222c",
      panel: "#21222c",
      hover: "#343746",
      selected: "#44475a",
      border: "#191a21",
      text: "#f8f8f2",
      muted: "#6272a4",
      accent: "#bd93f9",
      onAccent: "#282a36",
      user: "#363a54",
      agent: "#2d2f3d",
      ok: "#50fa7b",
      warn: "#f1fa8c",
      error: "#ff5555",
      scrollbar: "#44475a",
    },
    syntax: {
      comment: "#6272a4",
      keyword: "#ff79c6",
      function: "#50fa7b",
      string: "#f1fa8c",
      number: "#bd93f9",
      variable: "#ffb86c",
      tag: "#8be9fd",
    },
  },
  nord: {
    id: "nord",
    label: "Nord",
    kind: "dark",
    colors: {
      bg: "#2e3440",
      sunken: "#272c36",
      panel: "#3b4252",
      hover: "#434c5e",
      selected: "#4c566a",
      border: "#434c5e",
      text: "#d8dee9",
      muted: "#7b88a1",
      accent: "#88c0d0",
      onAccent: "#2e3440",
      user: "#3f4d66",
      agent: "#353c4a",
      ok: "#a3be8c",
      warn: "#ebcb8b",
      error: "#bf616a",
      scrollbar: "#4c566a",
    },
    syntax: {
      comment: "#616e88",
      keyword: "#81a1c1",
      function: "#88c0d0",
      string: "#a3be8c",
      number: "#b48ead",
      variable: "#8fbcbb",
      tag: "#81a1c1",
    },
  },
  "one-dark": {
    id: "one-dark",
    label: "One Dark",
    kind: "dark",
    colors: {
      bg: "#282c34",
      sunken: "#21252b",
      panel: "#21252b",
      hover: "#2c313a",
      selected: "#3e4451",
      border: "#181a1f",
      text: "#abb2bf",
      muted: "#5c6370",
      accent: "#61afef",
      onAccent: "#282c34",
      user: "#2d3f5c",
      agent: "#2c313a",
      ok: "#98c379",
      warn: "#e5c07b",
      error: "#e06c75",
      scrollbar: "#4b5263",
    },
    syntax: {
      comment: "#5c6370",
      keyword: "#c678dd",
      function: "#61afef",
      string: "#98c379",
      number: "#d19a66",
      variable: "#e06c75",
      tag: "#e5c07b",
    },
  },
};

/** Name of the theme inside VS Code (the `workbench.colorTheme` value), as the shipped extension registers it. */
export function vscodeThemeLabel(theme: Theme): string {
  return theme.id.startsWith("sessionboxer-") ? theme.label : `${theme.label} (Sessionboxer)`;
}

/** Folder name of the theme extension under openvscode-server's `extensions/`. */
export const VSCODE_THEMES_EXTENSION = "sessionboxer-themes";

/**
 * The files of the VS Code extension that contributes one color theme per Sessionboxer theme
 * (relative path → content): `package.json` plus `themes/<id>.json`. Written into the Sandbox
 * image at build time and again into every Sandbox by the Control Plane, like the Daemon.
 */
export function vscodeThemeExtensionFiles(): Record<string, string> {
  const themes = Object.values(THEMES);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name: VSCODE_THEMES_EXTENSION,
        displayName: "Sessionboxer themes",
        description: "The color themes of the Sessionboxer UI, for the VS Code in the Code pane.",
        version: "0.0.1",
        publisher: "sessionboxer",
        license: "MIT",
        engines: { vscode: "^1.90.0" },
        categories: ["Themes"],
        contributes: {
          themes: themes.map((t) => ({
            label: vscodeThemeLabel(t),
            uiTheme: t.kind === "dark" ? "vs-dark" : "vs",
            path: `./themes/${t.id}.json`,
          })),
        },
      },
      null,
      2,
    )}\n`,
  };
  for (const t of themes) files[`themes/${t.id}.json`] = `${JSON.stringify(vscodeTheme(t), null, 2)}\n`;
  return files;
}

/** The CSS custom properties (without `--`) the web UI is drawn with. */
export function themeCssVariables(theme: Theme): Record<string, string> {
  const c = theme.colors;
  const s = theme.syntax;
  return {
    bg: c.bg,
    sunken: c.sunken,
    panel: c.panel,
    hover: c.hover,
    selected: c.selected,
    border: c.border,
    text: c.text,
    muted: c.muted,
    accent: c.accent,
    "on-accent": c.onAccent,
    user: c.user,
    agent: c.agent,
    ok: c.ok,
    warn: c.warn,
    error: c.error,
    scrollbar: c.scrollbar,
    "syn-comment": s.comment,
    "syn-keyword": s.keyword,
    "syn-function": s.function,
    "syn-string": s.string,
    "syn-number": s.number,
    "syn-variable": s.variable,
    "syn-tag": s.tag,
  };
}

/** `#rrggbb` + alpha (0..1) → `#rrggbbaa`. */
function alpha(hex: string, a: number): string {
  return `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** The 16 ANSI colors a terminal drawn in this theme uses (xterm.js in the UI, VS Code's terminal). */
export function themeAnsi(theme: Theme): {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
} {
  const c = theme.colors;
  const s = theme.syntax;
  const dark = theme.kind === "dark";
  return {
    black: dark ? c.selected : c.text,
    red: c.error,
    green: c.ok,
    yellow: c.warn,
    blue: c.accent,
    magenta: s.keyword,
    cyan: s.string,
    white: dark ? c.text : c.selected,
    brightBlack: c.muted,
    brightRed: c.error,
    brightGreen: c.ok,
    brightYellow: c.warn,
    brightBlue: c.accent,
    brightMagenta: s.keyword,
    brightCyan: s.string,
    brightWhite: dark ? "#ffffff" : c.bg,
  };
}

/**
 * A VS Code color theme (the JSON a theme extension contributes) drawn from the palette:
 * the workbench in the UI's panel/sunken/border colors, tokens in the seven syntax roles.
 */
export function vscodeTheme(theme: Theme): Record<string, unknown> {
  const c = theme.colors;
  const s = theme.syntax;
  const ansi = themeAnsi(theme);
  const colors: Record<string, string> = {
    focusBorder: c.accent,
    foreground: c.text,
    descriptionForeground: c.muted,
    disabledForeground: c.muted,
    errorForeground: c.error,
    "icon.foreground": c.text,
    "widget.shadow": "#00000066",
    "widget.border": c.border,
    "selection.background": alpha(c.accent, 0.4),
    "textLink.foreground": c.accent,
    "textLink.activeForeground": c.accent,
    "textCodeBlock.background": c.bg,
    "textBlockQuote.background": c.panel,
    "textBlockQuote.border": c.border,
    "textPreformat.foreground": c.text,
    "textPreformat.background": c.bg,
    "textSeparator.foreground": c.border,

    "editor.background": c.sunken,
    "editor.foreground": c.text,
    "editorLineNumber.foreground": c.muted,
    "editorLineNumber.activeForeground": c.text,
    "editorCursor.foreground": c.text,
    "editor.selectionBackground": c.user,
    "editor.inactiveSelectionBackground": alpha(c.user, 0.6),
    "editor.selectionHighlightBackground": alpha(c.accent, 0.25),
    "editor.wordHighlightBackground": alpha(c.accent, 0.2),
    "editor.wordHighlightStrongBackground": alpha(c.accent, 0.3),
    "editor.findMatchBackground": alpha(c.warn, 0.45),
    "editor.findMatchHighlightBackground": alpha(c.warn, 0.25),
    "editor.lineHighlightBackground": alpha(c.hover, 0.6),
    "editor.lineHighlightBorder": "#00000000",
    "editor.rangeHighlightBackground": alpha(c.hover, 0.5),
    "editorWhitespace.foreground": c.border,
    "editorIndentGuide.background1": c.border,
    "editorIndentGuide.activeBackground1": c.muted,
    "editorRuler.foreground": c.border,
    "editorBracketMatch.background": alpha(c.accent, 0.2),
    "editorBracketMatch.border": c.accent,
    "editorBracketHighlight.foreground1": s.number,
    "editorBracketHighlight.foreground2": s.function,
    "editorBracketHighlight.foreground3": s.variable,
    "editorGutter.background": c.sunken,
    "editorGutter.addedBackground": c.ok,
    "editorGutter.modifiedBackground": c.warn,
    "editorGutter.deletedBackground": c.error,
    "editorOverviewRuler.border": c.border,
    "editorError.foreground": c.error,
    "editorWarning.foreground": c.warn,
    "editorInfo.foreground": c.accent,
    "editorHint.foreground": c.muted,
    "editorLink.activeForeground": c.accent,
    "editorCodeLens.foreground": c.muted,
    "editorInlayHint.background": c.panel,
    "editorInlayHint.foreground": c.muted,
    "editorWidget.background": c.panel,
    "editorWidget.border": c.border,
    "editorWidget.foreground": c.text,
    "editorSuggestWidget.background": c.panel,
    "editorSuggestWidget.border": c.border,
    "editorSuggestWidget.foreground": c.text,
    "editorSuggestWidget.selectedBackground": c.selected,
    "editorSuggestWidget.highlightForeground": c.accent,
    "editorHoverWidget.background": c.panel,
    "editorHoverWidget.border": c.border,
    "editorStickyScroll.background": c.sunken,
    "editorStickyScroll.shadow": "#00000066",
    "editorGroup.border": c.border,
    "editorGroup.dropBackground": alpha(c.accent, 0.2),
    "editorGroupHeader.tabsBackground": c.panel,
    "editorGroupHeader.tabsBorder": c.border,
    "editorGroupHeader.noTabsBackground": c.panel,
    "editorPane.background": c.sunken,
    "diffEditor.insertedTextBackground": alpha(c.ok, 0.15),
    "diffEditor.removedTextBackground": alpha(c.error, 0.15),
    "diffEditor.insertedLineBackground": alpha(c.ok, 0.1),
    "diffEditor.removedLineBackground": alpha(c.error, 0.1),
    "merge.currentHeaderBackground": alpha(c.ok, 0.4),
    "merge.incomingHeaderBackground": alpha(c.accent, 0.4),
    "minimap.background": c.sunken,
    "minimap.selectionHighlight": c.user,
    "scrollbar.shadow": "#00000066",
    "scrollbarSlider.background": alpha(c.scrollbar, 0.6),
    "scrollbarSlider.hoverBackground": alpha(c.scrollbar, 0.85),
    "scrollbarSlider.activeBackground": c.scrollbar,

    "tab.activeBackground": c.sunken,
    "tab.activeForeground": c.text,
    "tab.inactiveBackground": c.panel,
    "tab.inactiveForeground": c.muted,
    "tab.unfocusedActiveForeground": c.muted,
    "tab.border": c.border,
    "tab.activeBorderTop": c.accent,
    "tab.unfocusedActiveBorderTop": c.border,
    "tab.hoverBackground": c.hover,
    "tab.lastPinnedBorder": c.border,
    "breadcrumb.background": c.sunken,
    "breadcrumb.foreground": c.muted,
    "breadcrumb.focusForeground": c.text,
    "breadcrumb.activeSelectionForeground": c.text,
    "breadcrumbPicker.background": c.panel,

    "sideBar.background": c.panel,
    "sideBar.foreground": c.text,
    "sideBar.border": c.border,
    "sideBarTitle.foreground": c.text,
    "sideBarSectionHeader.background": c.panel,
    "sideBarSectionHeader.foreground": c.text,
    "sideBarSectionHeader.border": c.border,
    "activityBar.background": c.panel,
    "activityBar.foreground": c.text,
    "activityBar.inactiveForeground": c.muted,
    "activityBar.border": c.border,
    "activityBar.activeBorder": c.accent,
    "activityBarBadge.background": c.accent,
    "activityBarBadge.foreground": c.onAccent,
    "activityBarTop.foreground": c.text,
    "activityBarTop.inactiveForeground": c.muted,
    "activityBarTop.activeBorder": c.accent,
    "statusBar.background": c.panel,
    "statusBar.foreground": c.muted,
    "statusBar.border": c.border,
    "statusBar.noFolderBackground": c.panel,
    "statusBar.debuggingBackground": c.warn,
    "statusBar.debuggingForeground": c.onAccent,
    "statusBar.focusBorder": c.accent,
    "statusBarItem.hoverBackground": c.hover,
    "statusBarItem.activeBackground": c.selected,
    "statusBarItem.remoteBackground": c.accent,
    "statusBarItem.remoteForeground": c.onAccent,
    "statusBarItem.prominentBackground": c.selected,
    "statusBarItem.prominentForeground": c.text,
    "statusBarItem.errorBackground": c.error,
    "statusBarItem.errorForeground": c.onAccent,
    "statusBarItem.warningBackground": c.warn,
    "statusBarItem.warningForeground": c.onAccent,
    "titleBar.activeBackground": c.panel,
    "titleBar.activeForeground": c.text,
    "titleBar.inactiveBackground": c.panel,
    "titleBar.inactiveForeground": c.muted,
    "titleBar.border": c.border,
    "menubar.selectionBackground": c.hover,
    "menu.background": c.panel,
    "menu.foreground": c.text,
    "menu.selectionBackground": c.hover,
    "menu.selectionForeground": c.text,
    "menu.separatorBackground": c.border,
    "menu.border": c.border,
    "commandCenter.background": c.bg,
    "commandCenter.border": c.border,
    "commandCenter.foreground": c.muted,
    "commandCenter.activeBackground": c.hover,

    "panel.background": c.sunken,
    "panel.border": c.border,
    "panelTitle.activeBorder": c.accent,
    "panelTitle.activeForeground": c.text,
    "panelTitle.inactiveForeground": c.muted,
    "panelInput.border": c.border,
    "panelSectionHeader.background": c.panel,
    "terminal.background": c.sunken,
    "terminal.foreground": c.text,
    "terminal.border": c.border,
    "terminal.selectionBackground": c.user,
    "terminalCursor.foreground": c.text,
    "terminal.ansiBlack": ansi.black,
    "terminal.ansiRed": ansi.red,
    "terminal.ansiGreen": ansi.green,
    "terminal.ansiYellow": ansi.yellow,
    "terminal.ansiBlue": ansi.blue,
    "terminal.ansiMagenta": ansi.magenta,
    "terminal.ansiCyan": ansi.cyan,
    "terminal.ansiWhite": ansi.white,
    "terminal.ansiBrightBlack": ansi.brightBlack,
    "terminal.ansiBrightRed": ansi.brightRed,
    "terminal.ansiBrightGreen": ansi.brightGreen,
    "terminal.ansiBrightYellow": ansi.brightYellow,
    "terminal.ansiBrightBlue": ansi.brightBlue,
    "terminal.ansiBrightMagenta": ansi.brightMagenta,
    "terminal.ansiBrightCyan": ansi.brightCyan,
    "terminal.ansiBrightWhite": ansi.brightWhite,

    "input.background": c.bg,
    "input.border": c.border,
    "input.foreground": c.text,
    "input.placeholderForeground": c.muted,
    "inputOption.activeBorder": c.accent,
    "inputOption.activeBackground": alpha(c.accent, 0.3),
    "inputValidation.errorBackground": alpha(c.error, 0.2),
    "inputValidation.errorBorder": c.error,
    "inputValidation.warningBackground": alpha(c.warn, 0.2),
    "inputValidation.warningBorder": c.warn,
    "inputValidation.infoBackground": alpha(c.accent, 0.2),
    "inputValidation.infoBorder": c.accent,
    "dropdown.background": c.bg,
    "dropdown.listBackground": c.panel,
    "dropdown.border": c.border,
    "dropdown.foreground": c.text,
    "checkbox.background": c.bg,
    "checkbox.border": c.border,
    "checkbox.foreground": c.text,
    "button.background": c.accent,
    "button.foreground": c.onAccent,
    "button.hoverBackground": c.accent,
    "button.border": c.accent,
    "button.secondaryBackground": c.selected,
    "button.secondaryForeground": c.text,
    "button.secondaryHoverBackground": c.hover,
    "badge.background": c.accent,
    "badge.foreground": c.onAccent,
    "progressBar.background": c.accent,
    "toolbar.hoverBackground": c.hover,
    "toolbar.activeBackground": c.selected,

    "list.hoverBackground": c.hover,
    "list.hoverForeground": c.text,
    "list.activeSelectionBackground": c.selected,
    "list.activeSelectionForeground": c.text,
    "list.inactiveSelectionBackground": c.selected,
    "list.inactiveSelectionForeground": c.text,
    "list.focusBackground": c.selected,
    "list.focusOutline": c.accent,
    "list.highlightForeground": c.accent,
    "list.errorForeground": c.error,
    "list.warningForeground": c.warn,
    "list.dropBackground": alpha(c.accent, 0.2),
    "tree.indentGuidesStroke": c.border,
    "tree.tableColumnsBorder": c.border,
    "quickInput.background": c.panel,
    "quickInput.foreground": c.text,
    "quickInputList.focusBackground": c.selected,
    "quickInputTitle.background": c.panel,
    "pickerGroup.border": c.border,
    "pickerGroup.foreground": c.accent,
    "keybindingLabel.background": c.bg,
    "keybindingLabel.border": c.border,
    "keybindingLabel.bottomBorder": c.border,
    "keybindingLabel.foreground": c.text,

    "notifications.background": c.panel,
    "notifications.foreground": c.text,
    "notifications.border": c.border,
    "notificationCenterHeader.background": c.panel,
    "notificationCenterHeader.foreground": c.text,
    "notificationLink.foreground": c.accent,
    "notificationsErrorIcon.foreground": c.error,
    "notificationsWarningIcon.foreground": c.warn,
    "notificationsInfoIcon.foreground": c.accent,
    "banner.background": c.selected,
    "banner.foreground": c.text,
    "banner.iconForeground": c.accent,

    "gitDecoration.addedResourceForeground": c.ok,
    "gitDecoration.modifiedResourceForeground": c.warn,
    "gitDecoration.deletedResourceForeground": c.error,
    "gitDecoration.untrackedResourceForeground": c.ok,
    "gitDecoration.ignoredResourceForeground": c.muted,
    "gitDecoration.conflictingResourceForeground": c.error,
    "gitDecoration.submoduleResourceForeground": c.muted,
    "problemsErrorIcon.foreground": c.error,
    "problemsWarningIcon.foreground": c.warn,
    "problemsInfoIcon.foreground": c.accent,
    "settings.headerForeground": c.text,
    "settings.modifiedItemIndicator": c.accent,
    "settings.dropdownBackground": c.bg,
    "settings.dropdownBorder": c.border,
    "settings.textInputBackground": c.bg,
    "settings.textInputBorder": c.border,
    "settings.checkboxBackground": c.bg,
    "settings.checkboxBorder": c.border,
    "settings.focusedRowBackground": c.hover,
    "settings.rowHoverBackground": alpha(c.hover, 0.6),
    "welcomePage.background": c.sunken,
    "welcomePage.tileBackground": c.panel,
    "welcomePage.tileBorder": c.border,
    "welcomePage.progress.background": c.bg,
    "welcomePage.progress.foreground": c.accent,
    "walkThrough.embeddedEditorBackground": c.bg,
    "debugToolBar.background": c.panel,
    "debugToolBar.border": c.border,
    "peekView.border": c.accent,
    "peekViewEditor.background": c.bg,
    "peekViewResult.background": c.panel,
    "peekViewResult.selectionBackground": c.selected,
    "peekViewTitle.background": c.panel,
    "peekViewTitleLabel.foreground": c.text,
    "peekViewTitleDescription.foreground": c.muted,
    "sash.hoverBorder": c.accent,
    "symbolIcon.classForeground": s.function,
    "symbolIcon.functionForeground": s.function,
    "symbolIcon.methodForeground": s.function,
    "symbolIcon.variableForeground": s.variable,
    "symbolIcon.propertyForeground": s.variable,
    "symbolIcon.fieldForeground": s.variable,
    "symbolIcon.keywordForeground": s.keyword,
    "symbolIcon.stringForeground": s.string,
    "symbolIcon.numberForeground": s.number,
    "symbolIcon.constantForeground": s.number,
    "symbolIcon.enumeratorForeground": s.tag,
    "symbolIcon.interfaceForeground": s.tag,
    "symbolIcon.typeParameterForeground": s.tag,
  };

  const tokenColors = [
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: s.comment, fontStyle: "italic" } },
    {
      scope: [
        "keyword",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.operator.logical.python",
        "keyword.other.unit",
        "storage",
        "storage.type",
        "storage.modifier",
        "variable.language",
        "punctuation.definition.template-expression",
      ],
      settings: { foreground: s.keyword },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call.generic",
        "entity.name.class",
        "entity.name.type",
        "entity.other.inherited-class",
        "support.class",
        "support.type",
        "entity.name.namespace",
        "entity.name.section",
        "meta.decorator",
        "entity.name.function.decorator",
      ],
      settings: { foreground: s.function },
    },
    {
      scope: ["string", "string.regexp", "punctuation.definition.string", "constant.other.symbol", "constant.character.escape"],
      settings: { foreground: s.string },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant", "keyword.other.unit", "meta.preprocessor", "entity.name.label"],
      settings: { foreground: s.number },
    },
    {
      scope: [
        "variable",
        "variable.other",
        "variable.parameter",
        "variable.other.property",
        "variable.other.object.property",
        "support.variable",
        "support.type.property-name",
        "meta.object-literal.key",
        "entity.other.attribute-name",
        "entity.other.attribute-name.id",
        "entity.other.attribute-name.class",
        "support.type.property-name.json",
        "punctuation.definition.variable",
      ],
      settings: { foreground: s.variable },
    },
    {
      scope: ["entity.name.tag", "punctuation.definition.tag", "entity.name.selector", "entity.other.attribute-name.pseudo-class", "entity.other.attribute-name.pseudo-element", "support.type.vendored.property-name", "keyword.other.DML"],
      settings: { foreground: s.tag },
    },
    { scope: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: c.text } },
    { scope: ["markup.heading", "markup.heading entity.name", "punctuation.definition.heading"], settings: { foreground: s.number, fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.underline.link", "string.other.link"], settings: { foreground: c.accent } },
    { scope: ["markup.inline.raw", "markup.fenced_code.block", "markup.raw.block"], settings: { foreground: s.string } },
    { scope: ["markup.quote"], settings: { foreground: c.muted, fontStyle: "italic" } },
    { scope: ["markup.list punctuation.definition.list.begin"], settings: { foreground: s.variable } },
    { scope: ["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"], settings: { foreground: c.ok } },
    { scope: ["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"], settings: { foreground: c.error } },
    { scope: ["markup.changed", "punctuation.definition.changed"], settings: { foreground: c.warn } },
    { scope: ["meta.diff.range", "meta.diff.index", "meta.separator"], settings: { foreground: s.function } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: c.error } },
    { scope: ["invalid.deprecated"], settings: { foreground: c.warn, fontStyle: "underline" } },
  ];

  const semanticTokenColors: Record<string, string> = {
    namespace: s.function,
    class: s.function,
    interface: s.tag,
    enum: s.tag,
    enumMember: s.number,
    typeParameter: s.tag,
    type: s.function,
    function: s.function,
    method: s.function,
    decorator: s.function,
    variable: s.variable,
    "variable.readonly": s.number,
    parameter: s.variable,
    property: s.variable,
    keyword: s.keyword,
    string: s.string,
    number: s.number,
    comment: s.comment,
  };

  return {
    $schema: "vscode://schemas/color-theme",
    name: vscodeThemeLabel(theme),
    type: theme.kind,
    semanticHighlighting: true,
    semanticTokenColors,
    colors,
    tokenColors,
  };
}
