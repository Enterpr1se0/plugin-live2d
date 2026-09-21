/**
 * Keeps the engine's own motions stopped.
 *
 * The runtime drives idle behaviour itself (behaviour FSM, procedural modules
 * and motion layers), so the engine's motions must not run. Stopping them once
 * is not enough: `MotionManager.update()` re-requests the idle motion on the
 * very next frame (`shouldRequestIdleMotion()` → `startRandomMotion(groups.idle)`),
 * and because motions write absolute parameter values they overwrite the
 * runtime's writes every frame.
 */

/**
 * Group name that no model defines. Pointing `groups.idle` at it makes the
 * engine's automatic idle request find nothing to play.
 */
export const DISABLED_IDLE_GROUP = "__live2d-disabled-idle__";

interface EngineMotionManager {
  stopAllMotions?: () => void;
  /** Only the primary manager has groups; parallel managers (Cubism 2.1) do not. */
  groups?: { idle: string };
}

interface EngineInternalModel {
  motionManager?: EngineMotionManager;
  parallelMotionManager?: EngineMotionManager[];
}

export function haltEngineMotions(
  internal: EngineInternalModel | undefined,
): void {
  if (!internal) return;

  haltMotionManager(internal.motionManager);

  // Parallel motion managers (e.g. for Cubism 2.1 .mtn files) have no idle group.
  for (const manager of internal.parallelMotionManager ?? []) {
    haltMotionManager(manager);
  }
}

function haltMotionManager(manager: EngineMotionManager | undefined): void {
  if (typeof manager?.stopAllMotions !== "function") return;

  manager.stopAllMotions();

  if (manager.groups && typeof manager.groups.idle === "string") {
    manager.groups.idle = DISABLED_IDLE_GROUP;
  }
}
