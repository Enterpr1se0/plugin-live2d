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
 * Bookkeeping for `add` writes, which are relative to the engine baseline.
 *
 * The engine saves the current parameter values as its baseline every frame
 * (`CubismModel.saveParameters` / `saveParam`) and restores them at the end of
 * the same frame, so anything written after the engine update is baked into the
 * next frame's baseline. Without tracking our own contribution, every frame
 * would add on top of the previous frame's result and the parameter would drift
 * to its limit within a few frames.
 *
 * Note: while a motion is fading in the engine blends on top of our leftover
 * (`values = values * (1 - weight) + motion * weight`), so the recovered baseline
 * is only approximate for the duration of that fade. Once the fade completes
 * (weight 1) the motion overwrites the parameter and we take the engine value.
 */
interface AppliedAdd {
  /** Contribution applied last frame, relative to the engine baseline. */
  contribution: number;
  /** Absolute value actually written, read back after writing. */
  written: number;
}

export class ParameterCoordinator {
  private queue = new Map<string, QueuedWrite[]>();
  private conflictLog: ConflictEntry[] = [];
  private semanticLayer: SemanticParameterLayer;
  private maxLogSize: number;
  private appliedAdds = new Map<string, AppliedAdd>();

  constructor(
    semanticLayer: SemanticParameterLayer,
    options: { maxLogSize?: number } = {},
  ) {
    this.semanticLayer = semanticLayer;
    this.maxLogSize = options.maxLogSize ?? 50;
  }

  /**
   * Drop pending writes and add bookkeeping.
   *
   * Must be called when the model changes: pending writes were queued against
   * the previous model, and the tracked contributions describe its parameters.
   */
  reset(): void {
    this.queue.clear();
    this.appliedAdds.clear();
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
   * Resolve all queued writes, detect conflicts, and apply to semantic layer.
   * Should be called once per frame after all subsystems have queued writes.
   */
  flush(): void {
    this.releaseStaleContributions();

    for (const [parameter, writes] of this.queue) {
      this.resolveParameter(parameter, writes);
    }
    this.queue.clear();
  }

  /**
   * Release `add` contributions of parameters that were not written this frame.
   *
   * Because the engine absorbs our writes into its baseline (see
   * {@link AppliedAdd}), a contribution does not disappear when its writer stops:
   * it has to be subtracted explicitly. Parameters the engine rewrote this frame
   * are left alone, since the engine already took them over.
   */
  private releaseStaleContributions(): void {
    for (const [parameter, record] of this.appliedAdds) {
      if (this.queue.has(parameter)) continue;

      this.appliedAdds.delete(parameter);
      if (record.contribution === 0) continue;

      const current = this.semanticLayer.getSemantic(parameter);
      if (current === undefined || record.written !== current) continue;

      this.applyAbsolute(parameter, current - record.contribution);
    }
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
        // Lower priority number wins; on a tie keep the first one queued
        // (same as the original `reduce((a, b) => (a.priority <= b.priority ? a : b))`).
        if (winner === null || write.priority < winner.priority) {
          winner = write;
        }
      } else {
        addSum += write.value;
        hasAdd = true;
      }
    }

    // Resolve override conflicts: lowest priority number wins (MANUAL=1 is highest)
    let finalValue = 0;
    let hasOverride = false;

    if (winner !== null) {
      hasOverride = true;
      finalValue = winner.value;

      // Log conflicts from other override sources
      for (const write of writes) {
        if (write !== winner && write.blendMode === "override") {
          this.logConflict(parameter, winner, write);
        }
      }
    }

    // Sum all add outputs (adds don't conflict, they accumulate)
    if (hasAdd) {
      finalValue = hasOverride ? finalValue + addSum : addSum;
    }

    // The engine absorbs our writes into its baseline, so an `add` cannot be
    // applied on top of the current value: subtract our own previous
    // contribution first to recover the engine baseline.
    const current = this.semanticLayer.getSemantic(parameter) ?? 0;
    let engineBaseline = current;

    if (hasOverride) {
      // `override` is absolute, it takes the parameter over; stop tracking adds.
      this.appliedAdds.delete(parameter);
    } else {
      const previous = this.appliedAdds.get(parameter);
      // `written === current` means the engine did not touch this parameter
      // this frame, so our previous write is still in place.
      if (previous && previous.written === current) {
        engineBaseline = current - previous.contribution;
      }
    }

    this.applyAbsolute(
      parameter,
      hasOverride ? finalValue : engineBaseline + finalValue,
    );

    if (!hasOverride) {
      // Read the value back: `setSemantic` clamps it and Float32Array storage
      // rounds it, so only the stored value can be compared exactly next frame.
      const written = this.semanticLayer.getSemantic(parameter);
      if (written !== undefined) {
        const record = this.appliedAdds.get(parameter);
        if (record) {
          record.contribution = written - engineBaseline;
          record.written = written;
        } else {
          this.appliedAdds.set(parameter, {
            contribution: written - engineBaseline,
            written,
          });
        }
      }
    }
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
