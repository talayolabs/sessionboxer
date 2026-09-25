import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Slot, Tooltip } from "radix-ui";

/** Once, at the top of the app: shared open delay and the "skip the delay when moving between tips" window. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={300}>
      {children}
    </Tooltip.Provider>
  );
}

/**
 * A hover/focus tip on one control, replacing `title=` where the control is a stable part of the chrome
 * (icon buttons, pane toolbars). Keep `title=` on things that re-render on every keystroke and on text.
 * Empty `text` renders the child alone. Works as another primitive's `asChild` trigger (a menu's, say):
 * the props that one hands down go through to the child.
 */
export function Tip({
  text,
  side = "bottom",
  children,
  ...trigger
}: {
  text: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
} & Omit<ComponentProps<typeof Tooltip.Trigger>, "asChild" | "children">) {
  if (!text) return <Slot.Root {...trigger}>{children}</Slot.Root>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild {...trigger}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
