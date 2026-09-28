import type { ReactNode } from "react";
import { Popover } from "./Popover";

/**
 * A small "?" that opens the explanation of the control next to it in a popover: the form shows only the
 * caption, the detail is one click away. `<Field label="CPUs" help="…">` puts one after a caption.
 */
export function Help({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  return (
    <Popover
      className="help-popover"
      align="start"
      trigger={
        <button type="button" className="help" aria-label={label}>
          ?
        </button>
      }
    >
      <div className="help-body">{children}</div>
    </Popover>
  );
}

/** A caption with an optional "?" after it, for use inside a `<label>` or above a group. */
export function Caption({ children, help }: { children: ReactNode; help?: ReactNode }) {
  return (
    <span className="caption">
      {children}
      {help !== undefined && help !== null && <Help>{help}</Help>}
    </span>
  );
}
