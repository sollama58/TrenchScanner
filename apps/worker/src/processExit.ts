import type { HeartbeatJob } from "@trenchscanner/core";

/**
 * How the worker ends itself when it decides it needs a fresh process: a run past its deadline
 * (scheduler.ts) or a pipeline stall (pipelineWatchJob.ts). Both used to call process.exit(1)
 * outright, which skipped the shutdown index.ts runs on SIGTERM - every other run in flight was
 * cut mid-write with no heartbeat saying so, and the connection pool was never closed. They now
 * go through that same shutdown, which index.ts registers here at startup.
 *
 * A module of its own so both callers can reach the shutdown without importing index.ts (which
 * starts the worker on import).
 */
export interface RestartRequest {
  /** Why the process is ending - logged by the shutdown. */
  reason: string;
  /**
   * A job whose heartbeat already says what happened (the deadline exit writes "passed its
   * deadline" first): its hung run is not re-stamped as interrupted over that.
   */
  keepHeartbeatOf?: HeartbeatJob;
}

type Shutdown = (code: number, request: RestartRequest) => Promise<void>;

let registered: Shutdown | undefined;

/** Called once by index.ts with its graceful shutdown (undefined unregisters it - for tests). */
export function registerShutdown(shutdown: Shutdown | undefined): void {
  registered = shutdown;
}

/**
 * Ends the process with exit code 1 so the platform starts a fresh one, through the registered
 * shutdown when there is one. Nothing registered (tests, a script importing a job) exits at once,
 * as before. A shutdown that throws still exits.
 */
export function exitForRestart(request: RestartRequest): void {
  const shutdown = registered;
  if (shutdown) void shutdown(1, request).catch(() => process.exit(1));
  else process.exit(1);
}
