import { useSyncExternalStore } from "react";
import { printQueue } from "./printer";
import type { QueuedJob } from "./print-queue";

/** The print queue's jobs, re-rendering on every change. */
export function usePrintJobs(): readonly QueuedJob[] {
  return useSyncExternalStore(printQueue.subscribe, printQueue.jobs);
}

/** One job by id, or null once it is dismissed. */
export function usePrintJob(id: string | null): QueuedJob | null {
  const jobs = usePrintJobs();
  return id ? jobs.find((j) => j.id === id) ?? null : null;
}
