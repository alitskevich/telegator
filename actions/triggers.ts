"use server";

import { revalidatePath } from "next/cache";
import {
  exportTable as exportTableCore,
  replayDlq as replayDlqCore,
  republishMessage as republishMessageCore,
  runScraper as runScraperCore,
  type TriggerDeps,
} from "../lib/dashboard/triggers.js";
import { authContext, functions, lambda, messages, publishQueue, sources } from "./context.js";

/**
 * §8.4 L752-755. Thin wrappers: the role gates, the input validation and the
 * write-then-enqueue ordering all live in `lib/dashboard/triggers.ts`.
 */

async function deps(): Promise<TriggerDeps> {
  return {
    auth: await authContext(),
    lambda,
    functions,
    messages,
    sources,
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

export async function exportTable(input: unknown): Promise<string> {
  return exportTableCore(input, await deps());
}
