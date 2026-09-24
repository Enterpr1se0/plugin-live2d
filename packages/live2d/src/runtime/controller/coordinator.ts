import type { SemanticParameterLayer } from "../semantic";
import type { BlendMode } from "../semantic/types";
import type { SystemPriority, ConflictEntry } from "./types";

interface QueuedWrite {
  parameter: string;
  value: number;
  blendMode: BlendMode;
  source: string;
  priority: SystemPriority;
}

/**
 * Applies the queued parameter writes from inside the engine's own update.
 *
 * The engine saves the current parameter values as a baseline every frame
 * (`CubismModel.saveParameters` / `saveParam`) and restores that baseline at the
 * end of the same frame (`loadParameters` / `loadParam`). A write made after the
 * restore therefore becomes part of the next frame's baseline, which made an
 * `add` write - relative to the current value - stack on top of its own previous
 * result until the parameter reached its limit.
 *
 * Writing from the engine's `beforeModelUpdate` event instead - after the
 * baseline was saved and before the model is rendered with the parameters -
 * keeps a write visible for that frame only: an `add` is applied on top of the
 * engine's current value and is dropped when the engine restores its baseline,
 * so no bookkeeping of previous contributions is needed.
 */
export class ParameterCoordinator {
  private queue = new Map<string, QueuedWrite[]>();
  private conflictLog: ConflictEntry[] = [];
  private semanticLayer: SemanticParameterLayer;
  private maxLogSize: number;

  constructor(
    semanticLayer: SemanticParameterLayer,
    options: { maxLogSize?: number } = {},
  ) {
    this.semanticLayer = semanticLayer;
    this.maxLogSize = options.maxLogSize ?? 50;
  }

  /**
   * Drop pending writes.
   *
   * Must be called when the model changes: pending writes were queued against
   * the previous model's parameters.
   */
  reset(): void {
    this.queue.clear();
  }

  /**
   * Queue a parameter write. Writes are not applied until flush() is called.
   */
  queueWrite(
    parameter: string,
    value: number,
    blendMode: BlendMode,
    source: string,
    priority: SystemPriority,
  ): void {
    const list = this.queue.get(parameter) ?? [];
    list.push({ parameter, value, blendMode, source, priority });
    this.queue.set(parameter, list);
  }

  /**
   * Resolve all queued writes, detect conflicts, and apply to the semantic
   * layer. Driven by the engine's `beforeModelUpdate` event, so the values are
   * part of that frame's render and are dropped by the engine afterwards.
   */
  flush(): void {
    for (const [parameter, writes] of this.queue) {
      this.resolveParameter(parameter, writes);
    }
    this.queue.clear();
  }

  /**
   * Write an absolute value, temporarily detaching the coordinator so that the
   * write is not re-queued.
   */
  private applyAbsolute(parameter: string, value: number): void {
    this.semanticLayer.setCoordinator(undefined);
    try {
      this.semanticLayer.setSemantic(parameter, value, "override");
    } finally {
      this.semanticLayer.setCoordinator(this);
    }
  }

  /**
   * Get the current conflict log.
   */
  getConflictLog(): ConflictEntry[] {
    return [...this.conflictLog];
  }

  /**
   * Clear the conflict log.
   */
  clearConflictLog(): void {
    this.conflictLog = [];
  }

  private resolveParameter(parameter: string, writes: QueuedWrite[]): void {
    // Single pass: pick the highest-priority override and sum every add.
    // (filter/filter/reduce/reduce allocated four arrays per parameter per frame.)
    let winner: QueuedWrite | null = null;
    let addSum = 0;
    let hasAdd = false;

    for (const write of writes) {
      if (write.blendMode === "override") {
        // Lower priority number wins; on a tie keep the first one queued.
        if (winner === null || write.priority < winner.priority) {
          winner = write;
        }
      } else {
        addSum += write.value;
        hasAdd = true;
      }
    }

    if (winner === null) {
      // Only relative writes: stack them on the engine's current value. The
      // engine drops them when it restores its baseline, so they never
      // accumulate across frames.
      const current = this.semanticLayer.getSemantic(parameter) ?? 0;
      this.applyAbsolute(parameter, current + addSum);
      return;
    }

    // Resolve override conflicts: lowest priority number wins (MANUAL=1 is highest)
    for (const write of writes) {
      if (write !== winner && write.blendMode === "override") {
        this.logConflict(parameter, winner, write);
      }
    }

    // Adds don't conflict, they accumulate on top of the winning override.
    this.applyAbsolute(parameter, hasAdd ? winner.value + addSum : winner.value);
  }

  private logConflict(
    parameter: string,
    winner: QueuedWrite,
    loser: QueuedWrite,
  ): void {
    this.conflictLog.push({
      timestamp: Date.now(),
      parameter,
      winningSystem: winner.source,
      losingSystem: loser.source,
      winningValue: winner.value,
      losingValue: loser.value,
    });

    // Trim log to max size
    if (this.conflictLog.length > this.maxLogSize) {
      this.conflictLog.shift();
    }
  }
}
