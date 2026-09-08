"use server";

import { revalidatePath } from "next/cache";
import { systemClock } from "../lib/clock";
import {
  exportTable as exportTableCore,
  publishPending as publishPendingCore,
  replayDlq as replayDlqCore,
  republishMessage as republishMessageCore,
  runScraper as runScraperCore,
  type TriggerDeps,
} from "../lib/dashboard/triggers";
import {
  authContext,
  functions,
  lambda,
  messages,
  publishQueue,
  sources,
  targets,
} from "./context";

/**
 * §8.4 L814-812. Thin wrappers: the role gates, the input validation and the
 * write-then-enqueue ordering all live in `lib/dashboard/triggers.ts`.
 */

async function deps(): Promise<TriggerDeps> {
  return {
    auth: await authContext(),
    clock: systemClock,
    lambda,
    functions,
    messages,
    sources,
    targets,
    publishQueue,
    revalidate: revalidatePath,
  };
}

export async function runScraper(): Promise<{ processed: number }> {
  return runScraperCore(await deps());
}

export async function replayDlq(input: unknown): Promise<{ replayed: number }> {
  return replayDlqCore(input, await deps());
}

export async function republishMessage(input: unknown): Promise<void> {
  await republishMessageCore(input, await deps());
}

/** R53 — "Publish now": runs the deployed publish stage over the pending backlog. */
export async function publishPending(
  input: unknown,
): Promise<{ published: number; failed: number }> {
  return publishPendingCore(input, await deps());
}

export async function exportTable(input: unknown): Promise<string> {
  return exportTableCore(input, await deps());
}
