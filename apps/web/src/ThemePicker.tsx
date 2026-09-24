import { THEMES, THEME_IDS, type Theme, type ThemeId, type ThemePreference } from "@sessionboxer/protocol";
import { readThemePreference, setThemePreference, useTheme } from "./theme";

/** A theme's look in four strokes: background, panel, accent and text. */
function Swatch({ theme }: { theme: Theme }) {
  const c = theme.colors;
  return (
    <span className="theme-swatch" style={{ background: c.bg, borderColor: c.border }} aria-hidden>
      <span style={{ background: c.panel }} />
      <span style={{ background: c.accent }} />
      <span style={{ background: c.text }} />
    </span>
  );
}

/**
 * Color theme of this browser (ADR-0048): one fixed theme, or a light and a dark one that
 * follow the system's setting. The change applies at once here and to the VS Code of every
 * Session whose Code pane is shown; nothing to save.
 */
export function ThemeFieldset() {
  const active = useTheme();
  const pref = readThemePreference();
  const pick = (theme: ThemeId) => setThemePreference({ mode: "fixed", theme });
  const followSystem = (on: boolean) => {
    if (on) {
      setThemePreference({
        mode: "system",
        light: active.kind === "light" ? active.id : "sessionboxer-light",
        dark: active.kind === "dark" ? active.id : "sessionboxer-dark",
      });
    } else pick(active.id);
  };
  const setSystem = (patch: Partial<Extract<ThemePreference, { mode: "system" }>>) => {
    if (pref.mode !== "system") return;
    setThemePreference({ ...pref, ...patch });
  };
  return (
    <fieldset className="choice">
      <legend>Color theme</legend>
      <p className="muted">
        A preference of this browser, applied at once. The VS Code in the Code pane takes the same colors: a Session&apos;s editor
        follows the theme of whoever has its Code pane open.
      </p>
      <div className="theme-grid" role="radiogroup" aria-label="Color theme">
        {THEME_IDS.map((id) => {
          const t = THEMES[id];
          const selected = pref.mode === "fixed" ? pref.theme === id : active.id === id;
          return (
            <button
              type="button"
              key={id}
              role="radio"
              aria-checked={selected}
              className={`theme-card${selected ? " selected" : ""}`}
              onClick={() => (pref.mode === "system" ? setSystem(t.kind === "light" ? { light: id } : { dark: id }) : pick(id))}
              title={pref.mode === "system" ? `Use in ${t.kind} mode` : undefined}
            >
              <Swatch theme={t} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
      <label className="check">
        <input type="checkbox" checked={pref.mode === "system"} onChange={(e) => followSystem(e.target.checked)} />
        Follow the system&apos;s light or dark setting
      </label>
      {pref.mode === "system" && (
        <div className="row">
          <label>
            In light mode
            <select value={pref.light} onChange={(e) => setSystem({ light: e.target.value as ThemeId })}>
              {THEME_IDS.filter((id) => THEMES[id].kind === "light").map((id) => (
                <option key={id} value={id}>
                  {THEMES[id].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            In dark mode
            <select value={pref.dark} onChange={(e) => setSystem({ dark: e.target.value as ThemeId })}>
              {THEME_IDS.filter((id) => THEMES[id].kind === "dark").map((id) => (
                <option key={id} value={id}>
                  {THEMES[id].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </fieldset>
  );
}
