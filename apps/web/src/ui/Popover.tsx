import { useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Popover as RadixPopover } from "radix-ui";
import { cx } from "./cx";

/**
 * A floating panel anchored to its trigger (Radix Popover): portalled over iframes and canvases, flipped to
 * stay in the viewport, Escape closes it and focus returns to the trigger. Not modal. `stayOpen` keeps it up
 * while the user works elsewhere (a clipboard panel next to a remote desktop); it then closes only through
 * its trigger, its own controls or Escape typed inside it.
 */
export function Popover({
  trigger,
  children,
  className,
  align = "end",
  side = "bottom",
  stayOpen = false,
  onOpenAutoFocus,
  ...root
}: {
  trigger: ReactElement;
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  stayOpen?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
} & Pick<ComponentProps<typeof RadixPopover.Root>, "open" | "defaultOpen" | "onOpenChange">) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <RadixPopover.Root modal={false} {...root}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={content}
          className={cx("popover", className)}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
          onOpenAutoFocus={onOpenAutoFocus}
          onInteractOutside={stayOpen ? (e) => e.preventDefault() : undefined}
          onEscapeKeyDown={
            stayOpen
              ? (e) => {
                  if (!(e.target instanceof Node && content.current?.contains(e.target))) e.preventDefault();
                }
              : undefined
          }
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
