import type { FormEvent, ReactNode } from "react";
import { Dialog } from "radix-ui";
import { cx } from "./cx";

/**
 * The one modal shell (Radix Dialog): a backdrop that closes on click, a centred `.modal.panel` with a
 * title as its `<h2>`, Escape to close, focus trapped inside and given back to the opener, the page behind
 * marked inert for assistive tech. Rendered while mounted: the caller conditionally renders it, and
 * `onClose` is where it asks to go away (Escape, backdrop, the Radix close paths).
 *
 * `dismissible={false}` while a request is in flight keeps Escape and the backdrop from closing it; the
 * caller's own buttons decide. `onSubmit` makes the modal a `<form>`.
 */
export function Modal({
  title,
  titleClassName,
  description,
  className,
  dismissible = true,
  onClose,
  onSubmit,
  children,
}: {
  title: ReactNode;
  /** Extra classes on the `<h2>`; `large` for a wizard-style heading. */
  titleClassName?: string;
  /** Read out with the title; rendered as the paragraph under it. */
  description?: ReactNode;
  /** Feature class(es) on the `.modal.panel` root (width, layout). */
  className?: string;
  dismissible?: boolean;
  onClose: () => void;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const guard = (e: Event) => {
    if (!dismissible) e.preventDefault();
  };
  const body = (
    <>
      <Dialog.Title className={cx("modal-title", titleClassName)}>{title}</Dialog.Title>
      {description !== undefined && <Dialog.Description className="muted small-text">{description}</Dialog.Description>}
      {children}
    </>
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop">
          <Dialog.Content
            className={cx("modal panel", className)}
            onEscapeKeyDown={guard}
            onPointerDownOutside={guard}
            onInteractOutside={guard}
            {...(description === undefined ? { "aria-describedby": undefined } : {})}
            asChild={onSubmit !== undefined}
          >
            {onSubmit ? <form onSubmit={onSubmit}>{body}</form> : body}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
