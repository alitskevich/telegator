"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import {
  addToast,
  createToast,
  dismissToast,
  expireToasts,
  TOAST_TTL_MS,
  type Toast,
} from "../lib/ui/toasts";

/**
 * One place every actionable control reports into.
 *
 * §8.3's tables and §8.2 L780's queue cards are consoles: an operator presses a
 * button, looks back at the rows, and the answer used to be a line of text in a
 * toolbar they may have scrolled away from — or, where a promise was discarded
 * with `void`, nothing at all. A failure that leaves no trace is the one that
 * gets pressed again.
 *
 * The rules about the stack — how many, which one is dropped, what retires on
 * its own — are in `lib/ui/toasts.ts`. This holds the state and draws it.
 */

export interface Toasts {
  /** A result: what the action did, in the operator's terms. Returns its id. */
  readonly report: (text: string) => string;
  /** A failure. It stays until dismissed; see `expireToasts`. Returns its id. */
  readonly reportError: (text: string) => string;
  /**
   * Takes one back down.
   *
   * A control clears its own last failure when it is pressed again: an error
   * that outlived the press it answered would be read as the answer to the new
   * one. An id nothing matches is harmless.
   */
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<Toasts | undefined>(undefined);

/**
 * Deliberately not defaulted to a no-op. A page rendered outside the host would
 * otherwise ship with every one of its reports going nowhere, and every test of
 * it would still pass.
 */
export function useToasts(): Toasts {
  const toasts = useContext(ToastContext);
  if (toasts === undefined) {
    throw new Error("useToasts requires a <ToastHost> above it");
  }
  return toasts;
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const raise = useCallback((kind: Toast["kind"], text: string): string => {
    const toast = createToast(kind, text, Date.now());
    setToasts((current) => addToast(current, toast));

    // One timer per toast, rather than one interval running for the life of the
    // page: a console sits open for hours and would spend that whole time
    // waking up to find nothing to retire. `expireToasts` decides whether this
    // particular toast actually goes — an error never does.
    setTimeout(() => setToasts((current) => expireToasts(current, Date.now())), TOAST_TTL_MS);

    return toast.id;
  }, []);

  const api = useMemo<Toasts>(
    () => ({
      report: (text: string) => raise("ok", text),
      reportError: (text: string) => raise("error", text),
      dismiss: (id: string) => setToasts((current) => dismissToast(current, id)),
    }),
    [raise],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/* Nothing at all while there is nothing to say: an empty landmark in the
          corner is a permanent hole in the page for no reason. */}
      {toasts.length === 0 ? null : (
        <div className="toast-stack">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={toast.kind === "error" ? "toast toast-error" : "toast"}
              // A result is a status — it must not interrupt what the operator
              // is reading. A failure is an alert, because it is the answer to
              // something they just did and they are looking at the table.
              role={toast.kind === "error" ? "alert" : "status"}
            >
              <span className="toast-text">{toast.text}</span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label={`Dismiss: ${toast.text}`}
                onClick={() => setToasts((current) => dismissToast(current, toast.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
