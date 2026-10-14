import { recordRunProgress, type HeartbeatJob } from "@trenchscanner/core";

/**
 * Where a long run has got to, written onto its heartbeat as it goes (recordRunProgress) so the
 * admin panel can show it: the stages finished so far with their times, and the step under way.
 *
 * Training is the reason: a run takes about fifteen minutes, and "running for 40 minutes" alone
 * can't tell a slow exam from a run stuck on a database read. Writes are best effort and never
 * awaited by the run - progress is for people watching, not worth slowing or failing a run over.
 */
export class RunProgress {
  private readonly stages: Record<string, number> = {};
  private current: { name: string; startedAt: number } | null = null;

  constructor(
    private readonly job: HeartbeatJob,
    private readonly write: typeof recordRunProgress = recordRunProgress,
  ) {}

  /** Ends the stage under way (if any) and starts `name`. */
  stage(name: string): void {
    this.close();
    this.current = { name, startedAt: Date.now() };
    this.push(name);
  }

  /** A finer step inside the current stage (training's "examining Trees, 5 of 24"). */
  step(detail: string): void {
    this.push(this.current ? `${this.current.name}: ${detail}` : detail);
  }

  /** Ends the last stage; the finished stages' times, for the run's own heartbeat meta. */
  finish(): Record<string, number> {
    this.close();
    return { ...this.stages };
  }

  private close(): void {
    if (!this.current) return;
    this.stages[this.current.name] = Date.now() - this.current.startedAt;
    this.current = null;
  }

  private push(step: string): void {
    void this.write(this.job, { ...this.stages }, step).catch(() => {});
  }
}
