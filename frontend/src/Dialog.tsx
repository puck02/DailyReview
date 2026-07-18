import { KeyboardEvent, ReactNode, RefObject, useEffect, useRef } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

type DialogProps = {
  ariaLabel: string;
  backdropClassName: string;
  panelClassName: string;
  onClose: () => void;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
};

export function Dialog({
  ariaLabel,
  backdropClassName,
  panelClassName,
  onClose,
  children,
  initialFocusRef
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const target = initialFocusRef?.current || panelRef.current?.querySelector<HTMLElement>(focusableSelector) || panelRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previouslyFocused.current?.focus({ preventScroll: true });
    };
  }, [initialFocusRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;

    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
    if (!focusable.length) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={backdropClassName}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
      onKeyDown={handleKeyDown}
    >
      <div ref={panelRef} className={panelClassName} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
