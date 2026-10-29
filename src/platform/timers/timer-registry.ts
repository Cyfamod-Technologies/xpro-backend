import { Injectable } from '@nestjs/common';
import type { RequestTimer } from '@prisma/client';

/**
 * Runs when a timer is due. It must be idempotent: a timer that no longer
 * applies does nothing. A thrown error counts as a failed attempt.
 */
export type TimerHandler = (row: RequestTimer) => Promise<void>;

/** Runs on every timers sweep (60 s) for work that belongs to no request, such as gateway inbox retries. Must not throw for a single bad row. */
export type SweepHandler = (now: Date) => Promise<void>;

@Injectable()
export class TimerRegistry {
  private readonly handlers = new Map<string, TimerHandler>();
  private readonly sweepers: SweepHandler[] = [];

  register(kind: string, handler: TimerHandler): void {
    if (this.handlers.has(kind))
      throw new Error(`Timer handler already registered for kind: ${kind}`);
    this.handlers.set(kind, handler);
  }

  registerSweeper(sweeper: SweepHandler): void {
    this.sweepers.push(sweeper);
  }

  sweepHandlers(): readonly SweepHandler[] {
    return this.sweepers;
  }

  get(kind: string): TimerHandler | undefined {
    return this.handlers.get(kind);
  }
}
