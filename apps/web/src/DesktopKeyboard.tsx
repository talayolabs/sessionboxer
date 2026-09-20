import { useCallback, useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";

// X11 keysyms (keysymdef.h) for the keys that have no character.
const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  End: 0xff57,
  Delete: 0xffff,
  Shift_L: 0xffe1,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
} as const;

const SPECIAL: Record<string, { keysym: number; code: string }> = {
  Backspace: { keysym: XK.BackSpace, code: "Backspace" },
  Tab: { keysym: XK.Tab, code: "Tab" },
  Enter: { keysym: XK.Return, code: "Enter" },
  Escape: { keysym: XK.Escape, code: "Escape" },
  Home: { keysym: XK.Home, code: "Home" },
  End: { keysym: XK.End, code: "End" },
  ArrowLeft: { keysym: XK.Left, code: "ArrowLeft" },
  ArrowUp: { keysym: XK.Up, code: "ArrowUp" },
  ArrowRight: { keysym: XK.Right, code: "ArrowRight" },
  ArrowDown: { keysym: XK.Down, code: "ArrowDown" },
  Delete: { keysym: XK.Delete, code: "Delete" },
};

type Modifier = "ctrl" | "alt" | "shift" | "super";
const MODIFIERS: Array<{ id: Modifier; label: string; keysym: number; code: string }> = [
  { id: "ctrl", label: "Ctrl", keysym: XK.Control_L, code: "ControlLeft" },
  { id: "alt", label: "Alt", keysym: XK.Alt_L, code: "AltLeft" },
  { id: "shift", label: "Shift", keysym: XK.Shift_L, code: "ShiftLeft" },
  { id: "super", label: "Super", keysym: XK.Super_L, code: "MetaLeft" },
];

/** A character's keysym: Latin-1 is the keysym itself, everything else the Unicode keysym range. */
function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x100 ? cp : 0x01000000 | cp;
}

// The textarea keeps some spaces so a soft keyboard's Backspace changes its value (the keydown of
// virtual keyboards is often "Unidentified"); typing is read as the diff between two values, which
// also gets autocorrect right (it rewrites the word: backspaces, then the new letters).
const BUFFER = " ".repeat(16);

/**
 * On-screen keyboard for the touch Desktop: a focusable input that brings up the phone's keyboard
 * and relays what is typed to the box through noVNC, plus the keys a phone keyboard lacks.
 * Modifiers are sticky: tap Ctrl, then a key, and Ctrl is released with it.
 */
export function DesktopKeyboard({ rfb, disabled, onClose }: { rfb: () => RFB | null; disabled: boolean; onClose: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [held, setHeld] = useState<Set<Modifier>>(() => new Set());
  const heldRef = useRef(held);
  heldRef.current = held;

  const press = useCallback(
    (keysym: number, code: string | null) => {
      const client = rfb();
      if (!client) return;
      client.sendKey(keysym, code, true);
      client.sendKey(keysym, code, false);
      const mods = heldRef.current;
      if (mods.size > 0) {
        for (const m of MODIFIERS) if (mods.has(m.id)) client.sendKey(m.keysym, m.code, false);
        setHeld(new Set());
      }
    },
    [rfb],
  );

  const toggleModifier = (m: (typeof MODIFIERS)[number]) => {
    const client = rfb();
    if (!client) return;
    const next = new Set(heldRef.current);
    if (next.delete(m.id)) client.sendKey(m.keysym, m.code, false);
    else {
      next.add(m.id);
      client.sendKey(m.keysym, m.code, true);
    }
    setHeld(next);
    input.current?.focus();
  };

  const last = useRef(BUFFER);
  const resetBuffer = () => {
    const el = input.current;
    if (!el) return;
    el.value = BUFFER;
    last.current = BUFFER;
    el.setSelectionRange(BUFFER.length, BUFFER.length);
  };

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    resetBuffer();
    el.focus();
    const onInput = () => {
      const prev = last.current;
      const next = el.value;
      let common = 0;
      while (common < prev.length && common < next.length && prev[common] === next[common]) common++;
      for (let i = common; i < prev.length; i++) press(XK.BackSpace, "Backspace");
      for (const ch of next.slice(common)) {
        if (ch === "\n" || ch === "\r") press(XK.Return, "Enter");
        else press(charKeysym(ch), null);
      }
      last.current = next;
      // Composition (autocorrect) rewrites the current word, so the value is only reset between words.
      if (next.length < 8 || next.length > 200 || next.endsWith(" ") || next.endsWith("\n")) resetBuffer();
    };
    el.addEventListener("input", onInput);
    return () => el.removeEventListener("input", onInput);
  }, [press]);

  // Hardware keyboards (and some soft ones) report real keys here; a handled key never changes the value.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const special = SPECIAL[e.key];
    if (special) {
      e.preventDefault();
      press(special.keysym, special.code);
      return;
    }
    if (e.key.length === 1 && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      press(charKeysym(e.key), e.code || null);
    }
  };

  // Release what is still held when the bar goes away.
  useEffect(() => {
    return () => {
      const client = rfb();
      if (!client) return;
      for (const m of MODIFIERS) if (heldRef.current.has(m.id)) client.sendKey(m.keysym, m.code, false);
    };
  }, [rfb]);

  return (
    <div className="desktop-keyboard" role="toolbar" aria-label="Desktop keyboard">
      <textarea
        ref={input}
        className="desktop-keyboard-input"
        aria-label="Type here to send keys to the desktop"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.preventDefault()}
        onBlur={resetBuffer}
      />
      <div className="desktop-keyboard-keys">
        {MODIFIERS.map((m) => (
          <button key={m.id} type="button" className={held.has(m.id) ? "active" : ""} aria-pressed={held.has(m.id)} disabled={disabled} onClick={() => toggleModifier(m)}>
            {m.label}
          </button>
        ))}
        <button type="button" disabled={disabled} onClick={() => press(XK.Escape, "Escape")}>
          Esc
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.Tab, "Tab")}>
          Tab
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.Return, "Enter")} aria-label="Enter">
          {"\u23ce"}
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.BackSpace, "Backspace")} aria-label="Backspace">
          {"\u232b"}
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.Left, "ArrowLeft")} aria-label="Left">
          {"\u2190"}
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.Up, "ArrowUp")} aria-label="Up">
          {"\u2191"}
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.Down, "ArrowDown")} aria-label="Down">
          {"\u2193"}
        </button>
        <button type="button" disabled={disabled} onClick={() => press(XK.Right, "ArrowRight")} aria-label="Right">
          {"\u2192"}
        </button>
        <button type="button" disabled={disabled} onClick={() => input.current?.focus()} title="Bring the phone keyboard back">
          Type
        </button>
        <span className="spacer" />
        <button type="button" onClick={onClose} aria-label="Hide keyboard">
          {"\u00d7"}
        </button>
      </div>
    </div>
  );
}
