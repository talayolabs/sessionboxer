import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { cx } from "./cx";
import { Tip } from "./Tooltip";

/** One choice of a `Select`. */
export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
  /** 16 px mark in front of the label (and in the closed trigger when no `children` are given). */
  icon?: ReactNode;
  /** Muted second line: a description, or the reason when `disabled`. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Heading the option is listed under; consecutive options with the same group share one heading. */
  group?: string;
  /** What type-ahead matches; defaults to `label` when that is a string. */
  textValue?: string;
}

function Chevron() {
  return (
    <svg className="select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A single-choice dropdown in place of the native `<select>`, whose option list the browser draws in its own
 * colours: Radix DropdownMenu with one RadioGroup, so the list is portalled and themed like `.menu`, arrow keys,
 * type-ahead, Enter and Escape work, and the trigger is ours to draw. The trigger shows `children` when given
 * (a logo alone, say), else the current option's icon and label, or `placeholder` muted when nothing matches.
 * Not modal, like `Menu` (ADR-0056).
 */
export function Select<V extends string>({
  value,
  onChange,
  options,
  children,
  placeholder = "Choose…",
  disabled = false,
  "aria-label": ariaLabel,
  tip,
  className,
  menuClassName,
  align = "start",
  title,
}: {
  value: V;
  onChange: (value: V) => void;
  options: ReadonlyArray<SelectOption<V>>;
  /** What the closed control shows instead of the current option's icon + label. */
  children?: ReactNode;
  placeholder?: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
  /** Tooltip on the closed control (the full label of an icon-only trigger). */
  tip?: ReactNode;
  /** Extra classes on the trigger: `field` (full-width form field), `compact` (toolbar), `icon-only`. */
  className?: string;
  menuClassName?: string;
  align?: "start" | "center" | "end";
  title?: string;
}) {
  const current = options.find((o) => o.value === value);
  const trigger = (
    <button type="button" className={cx("select-trigger", className)} disabled={disabled} aria-label={ariaLabel} title={title}>
      {children || (
        <>
          {current?.icon !== undefined && <span className="select-icon">{current.icon}</span>}
          <span className={cx("select-label", !current && "muted")}>{current ? current.label : placeholder}</span>
        </>
      )}
      <Chevron />
    </button>
  );
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{tip ? <Tip text={tip}>{trigger}</Tip> : trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={cx("menu select-menu", menuClassName)} align={align} sideOffset={4} collisionPadding={8} loop>
          <DropdownMenu.RadioGroup value={value} onValueChange={(v) => onChange(v as V)}>
            {options.map((o, i) => {
              const heading = o.group !== undefined && (i === 0 || options[i - 1]?.group !== o.group);
              return (
                <div key={o.value} className="select-group-run">
                  {heading && (
                    <>
                      {i > 0 && <DropdownMenu.Separator className="menu-separator" />}
                      <DropdownMenu.Label className="menu-label">{o.group}</DropdownMenu.Label>
                    </>
                  )}
                  <DropdownMenu.RadioItem
                    className="menu-item select-item"
                    value={o.value}
                    disabled={o.disabled}
                    textValue={o.textValue ?? (typeof o.label === "string" ? o.label : undefined)}
                  >
                    {o.icon !== undefined && <span className="select-icon">{o.icon}</span>}
                    <span className="select-text">
                      <span className="select-label">{o.label}</span>
                      {o.hint !== undefined && <span className="select-hint muted">{o.hint}</span>}
                    </span>
                    <DropdownMenu.ItemIndicator className="select-check" aria-hidden="true">
                      {"\u2713"}
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                </div>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
