import type { ComponentProps, ReactElement, ReactNode } from "react";
import { ContextMenu as RadixContextMenu, DropdownMenu } from "radix-ui";
import { cx } from "./cx";

/**
 * A dropdown under its trigger (Radix DropdownMenu): opens on click, closes on a pick, a click elsewhere or
 * Escape (focus back on the trigger), arrow keys and type-ahead move between the items. The list is portalled
 * to <body> and flipped when it would leave the viewport. Not modal: the page keeps scrolling and reacting
 * behind it (ADR-0056 on why).
 */
export function Menu({
  trigger,
  children,
  className,
  align = "start",
  ...root
}: {
  /** The button that opens the menu; gets aria-haspopup/aria-expanded and a data-state. */
  trigger: ReactElement;
  children: ReactNode;
  /** Extra classes on the .menu list (a width, a feature name). */
  className?: string;
  align?: "start" | "center" | "end";
} & Pick<ComponentProps<typeof DropdownMenu.Root>, "open" | "defaultOpen" | "onOpenChange">) {
  return (
    <DropdownMenu.Root modal={false} {...root}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={cx("menu", className)} align={align} sideOffset={4} collisionPadding={8} loop>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One choice; `onSelect` fires on click or Enter/Space, after which the menu closes. */
export function MenuItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cx("menu-item", className)} {...props} />;
}

/**
 * A right-click (or long-press) menu at the pointer (Radix ContextMenu), same look and keyboard as `Menu`.
 * The trigger is the element the user right-clicks on; `onCloseAutoFocus` decides where focus goes after.
 */
export function ContextMenu({
  trigger,
  children,
  className,
  onOpenChange,
  onCloseAutoFocus,
}: {
  trigger: ReactElement;
  children: ReactNode;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <RadixContextMenu.Root modal={false} onOpenChange={onOpenChange}>
      <RadixContextMenu.Trigger asChild>{trigger}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content className={cx("menu", className)} collisionPadding={8} loop onCloseAutoFocus={onCloseAutoFocus}>
          {children}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}

export function ContextMenuItem({ className, ...props }: ComponentProps<typeof RadixContextMenu.Item>) {
  return <RadixContextMenu.Item className={cx("menu-item", className)} {...props} />;
}
