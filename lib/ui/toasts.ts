/**
 * What a toast is, and the four rules about a stack of them.
 *
 * Every actionable control in §8.3's tables and §8.2 L780's queue cards ends in
 * a server action, and until now each reported into a `notice` of its own — a
 * line next to the button, in a toolbar the operator may have scrolled past, or
 * nothing at all where the promise was discarded. One place answers all of them.
 *
 * The rules live here rather than in the provider because they are decisions,
 * not rendering: which toast is dropped when the stack is full, and which
 * retires on its own. `components/ToastHost.tsx` is the wrapper that holds them.
 */

export type ToastKind = "ok" | "error";

export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly text: string;
  /** When it was raised, by the same clock `expireToasts` is asked about. */
  readonly raisedAt: number;
}

/** Four fits the corner without covering the table it reports on. */
export const TOAST_LIMIT = 4;

/** Long enough to read a summary after looking back from the table. */
export const TOAST_TTL_MS = 6_000;

/** Ids are per-session and only ever compared, so a counter is enough. */
let sequence = 0;

/**
 * Stamps a toast with its id.
 *
 * Separate from `addToast` so the caller keeps the id: a control that reports a
 * failure has to be able to take that failure back down when it is pressed
 * again — see `useAction`.
 */
export function createToast(kind: ToastKind, text: string, raisedAt: number): Toast {
  sequence += 1;
  return { id: `toast-${sequence}`, kind, text, raisedAt };
}

/**
 * The newest first: it is the answer to the press the operator just made, and a
 * stack that appended would put it wherever the previous answers ended.
 */
export function addToast(toasts: readonly Toast[], toast: Toast): Toast[] {
  const next = [toast, ...toasts];

  if (next.length <= TOAST_LIMIT) return next;

  /**
   * Over the limit, and something has to go. The oldest *success* goes first:
   * an error is the one thing an operator must not miss, and a burst of
   * successful presses would otherwise push a failure off the screen before it
   * was read. Only if every toast is an error does the oldest error go.
   */
  const oldestSuccess = next.map((entry) => entry.kind).lastIndexOf("ok");
  const drop = oldestSuccess === -1 ? next.length - 1 : oldestSuccess;
  return next.filter((_, index) => index !== drop);
}

/**
 * Retires what has had its time.
 *
 * Errors are exempt: a failure is the answer to something the operator just
 * did, and one that vanishes on its own is one they can miss entirely by
 * looking at the table instead of the corner. It goes when it is dismissed.
 *
 * The same array comes back when nothing expired, so a host polling this on a
 * timer does not re-render the page every tick.
 */
export function expireToasts(toasts: readonly Toast[], now: number): readonly Toast[] {
  const kept = toasts.filter(
    (toast) => toast.kind === "error" || now - toast.raisedAt < TOAST_TTL_MS,
  );
  return kept.length === toasts.length ? toasts : kept;
}

/** Dismissal by id. An id nothing matches returns the same array, as above. */
export function dismissToast(toasts: readonly Toast[], id: string): readonly Toast[] {
  const kept = toasts.filter((toast) => toast.id !== id);
  return kept.length === toasts.length ? toasts : kept;
}
