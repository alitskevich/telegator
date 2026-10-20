"use client";

import { useRef, useState } from "react";
import { useToasts } from "./ToastHost";

/**
 * One server action, wired to a button: in flight, and reported when it lands.
 *
 * Every actionable control in §8.3's tables and §8.2 L780's queue cards ends in
 * a server action, and each used to handle its own answer — a `notice` beside
 * the button, a `role="alert"` paragraph, or a discarded promise that said
 * nothing at all. Three things follow from awaiting it in one place instead.
 *
 * 1. **The button reports that it is working, and refuses a second press.** §8.4
 *    L814's "Scrape now" invokes the deployed function and waits for its
 *    summary, which §3.1 L205 lets poll ten channels; §7.5 gives that function a
 *    reserved concurrency of 1, so a second invoke does not run twice as fast —
 *    it queues behind the first. A button that looks idle throughout is what
 *    makes an operator press it again.
 * 2. **The result is announced**, in the operator's terms rather than as a
 *    number next to a control they have already scrolled past.
 * 3. **A failure is announced too, and stays** until it is dismissed or until
 *    this control is pressed again — an error that outlived the press it
 *    answered would be read as the answer to the new one. Next redacts a server
 *    action's message in production, so the text is often generic, but "it
 *    failed" is the fact that was missing entirely.
 */
export interface Action<A extends readonly unknown[]> {
  readonly running: boolean;
  readonly run: (...args: A) => void;
}

export interface ActionOptions<A extends readonly unknown[], T> {
  /**
   * The success toast. It is given the arguments as well as the result, because
   * what an operator needs told is usually which row it happened to — the
   * action itself answers `void`.
   *
   * Omit it for an action whose effect is already on screen.
   */
  readonly describe?: (result: T, ...args: A) => string;
  /** What to say when the failure carries no message of its own. */
  readonly failure: string;
  /** Anything else the answer settles — clearing a selection, holding a payload. */
  readonly onDone?: (result: T, ...args: A) => void;
}

export function useAction<A extends readonly unknown[], T>(
  action: (...args: A) => Promise<T>,
  options: ActionOptions<A, T>,
): Action<A> {
  const toasts = useToasts();
  const [running, setRunning] = useState(false);
  /** The last failure this control raised, so it can take it back down. */
  const lastFailure = useRef<string | undefined>(undefined);

  const run = (...args: A) => {
    if (running) return;
    setRunning(true);

    if (lastFailure.current !== undefined) {
      toasts.dismiss(lastFailure.current);
      lastFailure.current = undefined;
    }

    action(...args)
      .then((result) => {
        options.onDone?.(result, ...args);
        const text = options.describe?.(result, ...args);
        if (text !== undefined) toasts.report(text);
      })
      .catch((cause: unknown) => {
        lastFailure.current = toasts.reportError(
          cause instanceof Error ? cause.message : options.failure,
        );
      })
      .finally(() => setRunning(false));
  };

  return { running, run };
}
