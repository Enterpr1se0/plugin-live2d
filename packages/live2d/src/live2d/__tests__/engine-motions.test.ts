import { describe, expect, it, vi } from "vitest";
import { DISABLED_IDLE_GROUP, haltEngineMotions } from "../engine-motions";

const createMotionManager = (idleGroup: string) => ({
  groups: { idle: idleGroup },
  stopAllMotions: vi.fn(),
});

describe("haltEngineMotions", () => {
  it("stops motions and makes the idle group unplayable", () => {
    const motionManager = createMotionManager("Idle");

    haltEngineMotions({ motionManager });

    expect(motionManager.stopAllMotions).toHaveBeenCalledTimes(1);
    // Stopping alone is not enough: the engine re-requests the idle motion on
    // the next frame, so the group has to point somewhere empty.
    expect(motionManager.groups.idle).toBe(DISABLED_IDLE_GROUP);
    expect(motionManager.groups.idle).not.toBe("Idle");
  });

  it("keeps the Cubism 2 group name convention working too", () => {
    const motionManager = createMotionManager("idle");

    haltEngineMotions({ motionManager });

    expect(motionManager.groups.idle).toBe(DISABLED_IDLE_GROUP);
  });

  it("stops parallel motion managers (Cubism 2.1 .mtn)", () => {
    const first = { stopAllMotions: vi.fn() };
    const second = { stopAllMotions: vi.fn() };

    haltEngineMotions({ parallelMotionManager: [first, second] });

    expect(first.stopAllMotions).toHaveBeenCalledTimes(1);
    expect(second.stopAllMotions).toHaveBeenCalledTimes(1);
  });

  it("tolerates missing internal models and managers", () => {
    expect(() => haltEngineMotions(undefined)).not.toThrow();
    expect(() => haltEngineMotions({})).not.toThrow();
    expect(() => haltEngineMotions({ motionManager: {} })).not.toThrow();
    expect(() => haltEngineMotions({ parallelMotionManager: [] })).not.toThrow();
  });
});
