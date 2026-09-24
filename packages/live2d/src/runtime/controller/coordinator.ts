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
 * An `override` that outlives the frame it was written in.
 *
 * The engine restores its own baseline at the end of every update, so a write
 * applied from `beforeModelUpdate` only lasts for the frame it was made in (see
 * {@link ParameterCoordinator.flush}). An `override` is meant to stay in effect
 * until another writer takes the parameter over — a manual devtools slider, for
 * instance, keeps its value after the user lets go of it — so the last resolved
 * value of every overridden parameter is re-applied on the frames its writer is
 * silent.
 *
 * `add` writes are deliberately not held: they are contributions for a single
 * frame, which is what keeps them from accumulating across frames.
 */
interface HeldOverride {
  /** Absolute value the parameter was left at, including any `add` of that frame. */
  value: number;
  /** Writer that produced it, kept for debugging. */
  source: string;
  priority: SystemPriority;
}

export class ParameterCoordinator {
  private queue = new Map<string, QueuedWrite[]>();
  private conflictLog: ConflictEntry[] = [];
  private semanticLayer: SemanticParameterLayer;
  private maxLogSize: number;
  private overrides = new Map<string, HeldOverride>();

  constructor(
    semanticLayer: SemanticParameterLayer,
    options: { maxLogSize?: number } = {},
  ) {
    this.semanticLayer = semanticLayer;
    this.maxLogSize = options.maxLogSize ?? 50;
  }

  /**
   * Drop pending writes and held overrides.
   *
   * Must be called when the model changes: both describe the parameters of the
   * previous model.
   */
  reset(): void {
    this.queue.clear();
    this.overrides.clear();
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
   * Resolve the writes queued for this frame and apply them to the engine.
   *
   * Must be called from the engine's `beforeModelUpdate` event. The engine emits
   * it after it saved its baseline and applied its own updates (blink, focus,
   * breathing, physics, pose) and right before it updates the model
   * (`Cubism4InternalModel.update`, `CubismLegacyInternalModel.update`), then
   * restores its baseline at the end of the same update. A write applied there is
   * rendered in the current frame and dropped with the restore, so the value the
   * engine holds at flush time is always its own: `add` can be applied on top of
   * it directly and nothing has to be remembered about previous frames.
   */
  flush(): void {
    const writtenThisFrame = new Set(this.queue.keys());

    for (const [parameter, writes] of this.queue) {
      this.resolveParameter(parameter, writes);
    }
    this.queue.clear();

    this.reapplyOverrides(writtenThisFrame);
  }

  /**
   * Keep held overrides in effect on the frames their writer is silent, since the
   * engine dropped them with its baseline.
   */
  private reapplyOverrides(writtenThisFrame: ReadonlySet<string>): void {
    for (const [parameter, held] of this.overrides) {
      if (writtenThisFrame.has(parameter)) continue;
      this.applyAbsolute(parameter, held.value);
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

    if (winner !== null) {
      // `override` is absolute, so it takes the parameter over: the result is
      // remembered and re-applied on the frames this writer is silent.
      const resolved = hasAdd ? winner.value + addSum : winner.value;

      for (const write of writes) {
        if (write !== winner && write.blendMode === "override") {
          this.logConflict(parameter, winner, write);
        }
      }

      this.overrides.set(parameter, {
        value: resolved,
        source: winner.source,
        priority: winner.priority,
      });
      this.applyAbsolute(parameter, resolved);
      return;
    }

    // `add` only: relative to what the parameter holds right now, which is the
    // engine's own value for this frame (or a held override that is still in
    // effect). Adds are not remembered, so a writer that stops writing simply
    // leaves the parameter to the engine again.
    const base =
      this.overrides.get(parameter)?.value ??
      this.semanticLayer.getSemantic(parameter) ??
      0;

    this.applyAbsolute(parameter, base + addSum);
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
