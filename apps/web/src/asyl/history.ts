/**
 * Undo and redo for a map (user ask 2026-10-24): each change the reader makes keeps a copy of the
 * map as it was, up to HISTORY_MAX steps back. A new change after undoing drops what could have
 * been redone, as in any editor.
 */

/** How many steps back: a map is a few hundred nodes, so this many copies stay small. */
export const HISTORY_MAX = 100;

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly max = HISTORY_MAX) {}

  /** Keeps `before`, the state just ahead of a change. */
  record(before: T): void {
    this.past.push(before);
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
  }

  /** The state to go back to, given the one shown now; null when there is none. */
  undo(current: T): T | null {
    const s = this.past.pop();
    if (s === undefined) return null;
    this.future.push(current);
    return s;
  }

  /** The state to go forward to again, given the one shown now; null when there is none. */
  redo(current: T): T | null {
    const s = this.future.pop();
    if (s === undefined) return null;
    this.past.push(current);
    return s;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): { back: number; forward: number } {
    return { back: this.past.length, forward: this.future.length };
  }
}
