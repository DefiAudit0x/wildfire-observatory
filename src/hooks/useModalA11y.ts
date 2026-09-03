import { useEffect, useRef } from "react";

/**
 * W-H3: shared modal accessibility trap.
 *
 * The SOS modal (the most safety-critical surface in the app) used to be a
 * bare fullscreen overlay: no role="dialog", no aria-modal, no focus trap,
 * no Escape — a keyboard/screen-reader user could Tab straight into the
 * background page while believing they were still in the emergency flow.
 *
 * This hook gives EVERY modal one consistent contract:
 *   - the overlay element gets role="dialog" + aria-modal="true" (caller
 *     sets the attributes; this hook supplies the BEHAVIOR);
 *   - focus moves to the first focusable element inside on open;
 *   - Tab / Shift+Tab cycle INSIDE the modal (focus trap);
 *   - Escape fires onCancel (unless suppressed via `suppressEscapeRef` —
 *     the SOS recording step must not be cancellable by a stray keystroke);
 *   - on unmount, focus returns to the element that was focused before the
 *     modal opened.
 *
 * The subscription is keyed on `enabled` ONLY: the latest onCancel /
 * suppressEscape values are read through refs, so a step change inside the
 * modal never tears the trap down (which would yank focus mid-recording).
 */
export function useModalA11y<T extends HTMLElement = HTMLElement>(opts: {
  enabled?: boolean;
  onCancel?: () => void;
  /** When true, Escape is ignored (e.g. irreversible emergency steps). */
  suppressEscape?: boolean;
} = {}) {
  const { enabled = true } = opts;
  const overlayRef = useRef<T | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!enabled) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const focusFirst = () => {
      const root = overlayRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus({ preventScroll: true });
    };
    // After paint so the node is mounted.
    const raf = requestAnimationFrame(focusFirst);

    const onKeyDown = (e: KeyboardEvent) => {
      const { onCancel, suppressEscape } = optsRef.current;
      if (e.key === "Escape") {
        if (suppressEscape) return;
        e.stopPropagation();
        onCancel?.();
        return;
      }
      if (e.key !== "Tab") return;
      const root = overlayRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!root.contains(active)) {
        // Focus escaped the modal (browser quirk / programmatic move) — pull it back.
        e.preventDefault();
        first.focus({ preventScroll: true });
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the trigger so the next Tab continues from where
      // the user was — and screen readers re-announce the page context.
      const prev = restoreFocusRef.current;
      if (prev && document.contains(prev)) {
        try {
          prev.focus({ preventScroll: true });
        } catch {
          // element may have unmounted meanwhile — nothing to restore
        }
      }
      restoreFocusRef.current = null;
    };
  }, [enabled]);

  return overlayRef;
}
