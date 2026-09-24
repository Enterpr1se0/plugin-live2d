import { SemanticParameterLayer } from "../semantic";
import { FilterPipeline } from "../filters";
import { MotionLayerSystem } from "../motion";
import { ProceduralAnimationSystem } from "../procedural";
import { BehaviorFSM } from "../behavior";
import { registerBuiltInStates } from "../behavior";
import { EmotionTimeline } from "../emotion";
import { EMOTION_REGISTRY } from "../emotion";
import type { Live2DModel } from "untitled-pixi-live2d-engine";
import type { Ticker } from "pixi.js";
import type {
  ControllerConfig,
  ControllerState,
  ConflictEntry,
  TransitionOptions,
} from "./types";
import { ParameterCoordinator } from "./coordinator";

/**
 * The part of the engine's `InternalModel` the runtime relies on.
 *
 * `InternalModel` is an `EventEmitter` that emits `beforeModelUpdate` right
 * before the model is updated with its parameters applied, which is where the
 * runtime flushes its parameter writes.
 */
interface EngineInternalModel {
  on(event: "beforeModelUpdate", handler: () => void): unknown;
  off(event: "beforeModelUpdate", handler: () => void): unknown;
}

export class Live2dRuntimeController {
  private semanticLayer: SemanticParameterLayer;
  private filterPipeline: FilterPipeline;
  private proceduralSystem?: ProceduralAnimationSystem;
  private motionLayerSystem?: MotionLayerSystem;
  private behaviorFSM?: BehaviorFSM;
  private emotionTimeline?: EmotionTimeline;
  private config: ControllerConfig & { enabled: boolean; filterQuality: "low" | "medium" | "high" };
  private coordinator: ParameterCoordinator;
  private transitionHistory: Array<{
    from: string;
    to: string;
    timestamp: number;
  }> = [];
  private _tickerCallbacks: Array<() => void> = [];

  constructor(config: ControllerConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      behaviorFSM: config.behaviorFSM,
      emotionTimeline: config.emotionTimeline,
      motionLayers: config.motionLayers,
      proceduralAnimation: config.proceduralAnimation,
      filterQuality: config.filterQuality ?? "high",
    };

    this.semanticLayer = new SemanticParameterLayer();
    this.coordinator = new ParameterCoordinator(this.semanticLayer);
    this.semanticLayer.setCoordinator(this.coordinator);
    this.filterPipeline = new FilterPipeline({
      quality: this.config.filterQuality,
    });
  }

  /**
   * Initialize all runtime subsystems after a Live2D model is loaded.
   */
  initialize(model: Live2DModel, ticker: Ticker): void {
    if (!this.config.enabled) return;

    // 1. Semantic parameter detection
    this.semanticLayer.detectFromModel(model);
    // Drop anything queued against the previous model, and the add
    // contributions that describe its parameters.
    this.coordinator.reset();

    // 2. Motion layer system
    if (this.config.motionLayers?.enabled !== false) {
      this.motionLayerSystem = new MotionLayerSystem(
        this.semanticLayer,
        this.config.motionLayers,
      );
    }

    // 3. Procedural animation system
    this.proceduralSystem = new ProceduralAnimationSystem(
      this.semanticLayer,
      this.config.proceduralAnimation,
    );

    if (this.motionLayerSystem) {
      this.proceduralSystem.setOutputCallback((params) => {
        const parameters: Record<
          string,
          { value: number; blendMode?: "override" | "add" }
        > = {};
        for (const { semantic, value, blendMode } of params) {
          parameters[semantic] = { value, blendMode };
        }
        this.motionLayerSystem?.setPhysicsParameters(parameters);
      });
    }

    this.proceduralSystem.attachTo(ticker);

    // 4. Motion layer ticker
    if (this.motionLayerSystem) {
      const motionTicker = () => {
        this.motionLayerSystem?.update(Math.min(ticker.deltaMS, 100));
      };
      ticker.add(motionTicker);
      this._tickerCallbacks.push(() => ticker.remove(motionTicker));
    }

    // 5. Behavior FSM
    if (this.config.behaviorFSM?.enabled !== false) {
      this.behaviorFSM = new BehaviorFSM(
        {
          motionLayerSystem: this.motionLayerSystem,
          filterPipeline: this.filterPipeline,
          semanticLayer: this.semanticLayer,
          proceduralSystem: this.proceduralSystem,
        },
        this.config.behaviorFSM,
      );
      registerBuiltInStates((state) => this.behaviorFSM!.registerState(state));
      this.behaviorFSM.initialize();
    }

    // 6. Emotion timeline
    if (this.config.emotionTimeline?.enabled !== false) {
      this.emotionTimeline = new EmotionTimeline(
        {
          semanticLayer: this.semanticLayer,
          filterPipeline: this.filterPipeline,
          motionLayerSystem: this.motionLayerSystem,
        },
        this.config.emotionTimeline,
      );

      for (const [name, profile] of Object.entries(EMOTION_REGISTRY)) {
        this.emotionTimeline.registerEmotion(name, profile);
      }

      const emotionTicker = () => {
        this.emotionTimeline?.update();
      };
      ticker.add(emotionTicker);
      this._tickerCallbacks.push(() => ticker.remove(emotionTicker));
    }

    // 7. Apply parameter writes from the engine's `beforeModelUpdate` event.
    //
    // The engine saves its parameter baseline after applying motions and restores
    // it at the end of the same update (`saveParameters`/`loadParameters`, and
    // `saveParam`/`loadParam` for Cubism 2). `beforeModelUpdate` fires after the
    // engine's own updates (blink, focus, breathing, physics, pose) and right
    // before the model is updated, so a write made there is rendered in the
    // current frame and dropped with the restore: the baseline never absorbs our
    // writes and `add` needs no bookkeeping. This also keeps manual effects
    // overriding engine values instead of being overwritten by them.
    const internalModel = this.extractInternalModel(model);
    if (internalModel) {
      const onBeforeModelUpdate = () => this.coordinator.flush();
      internalModel.on("beforeModelUpdate", onBeforeModelUpdate);
      this._tickerCallbacks.push(() => {
        internalModel.off("beforeModelUpdate", onBeforeModelUpdate);
      });
    }

    // Attach filter pipeline to model
    this.filterPipeline.attachTo(model);
  }

  /**
   * Unified transition API — trigger FSM state, emotion, and/or filter atomically.
   */
  transitionTo(options: TransitionOptions): void {
    if (!this.config.enabled) return;

    const { fsm, emotion, filter, duration } = options;

    if (fsm && this.behaviorFSM) {
      const from = this.behaviorFSM.getCurrentState() ?? "none";
      const success = this.behaviorFSM.transitionTo(fsm);
      if (success) {
        this.transitionHistory.push({
          from,
          to: fsm,
          timestamp: Date.now(),
        });
        // Keep only last 10
        if (this.transitionHistory.length > 10) {
          this.transitionHistory.shift();
        }
      }
    }

    if (emotion && this.emotionTimeline) {
      this.emotionTimeline.transitionTo(emotion, { duration });
    }

    if (filter) {
      this.filterPipeline.applyPreset(filter);
    }
  }

  /**
   * Get composite state snapshot for DevTools display.
   */
  getState(): ControllerState {
    return {
      fsmState: this.behaviorFSM?.getCurrentState() ?? null,
      emotion: this.emotionTimeline?.getCurrentEmotion() ?? null,
      isTransitioning: this.emotionTimeline?.isTransitioning() ?? false,
      transitionProgress: this.getTransitionProgress(),
      activeFilters: this.getActiveFilterDetails(),
      motionLayers: this.getMotionLayerStatuses(),
      proceduralModules: this.getProceduralModuleStatuses(),
    };
  }

  /**
   * Get the conflict log for DevTools display.
   */
  getConflictLog(): ConflictEntry[] {
    return this.coordinator.getConflictLog();
  }

  /**
   * Get transition history for DevTools display.
   */
  getTransitionHistory(): Array<{ from: string; to: string; timestamp: number }> {
    return [...this.transitionHistory];
  }

  /**
   * Clear the conflict log.
   */
  clearConflictLog(): void {
    this.coordinator.clearConflictLog();
  }

  /**
   * Get current semantic parameter values for DevTools display.
   */
  getSemanticParameters(): Array<{ name: string; value: number | undefined }> {
    const profile = this.semanticLayer.getCapabilityProfile();
    const result: Array<{ name: string; value: number | undefined }> = [];
    for (const name of profile.detected.keys()) {
      result.push({ name, value: this.semanticLayer.getSemantic(name) });
    }
    return result;
  }

  // ── Subsystem accessors ─────────────────────────────────────────

  getSemanticLayer(): SemanticParameterLayer {
    return this.semanticLayer;
  }

  getFilterPipeline(): FilterPipeline {
    return this.filterPipeline;
  }

  getProceduralSystem(): ProceduralAnimationSystem | undefined {
    return this.proceduralSystem;
  }

  getMotionLayerSystem(): MotionLayerSystem | undefined {
    return this.motionLayerSystem;
  }

  getBehaviorFSM(): BehaviorFSM | undefined {
    return this.behaviorFSM;
  }

  getEmotionTimeline(): EmotionTimeline | undefined {
    return this.emotionTimeline;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  destroy(ticker?: Ticker): void {
    // Remove ticker callbacks
    for (const remove of this._tickerCallbacks) {
      remove();
    }
    this._tickerCallbacks = [];

    this.proceduralSystem?.detach(ticker);
    this.emotionTimeline?.destroy();
    this.filterPipeline.detach();
  }

  // ── Private helpers ─────────────────────────────────────────────

  private extractInternalModel(
    model: Live2DModel,
  ): EngineInternalModel | undefined {
    const record = model as unknown as Record<string, unknown>;
    return record.internalModel as EngineInternalModel | undefined;
  }

  private getTransitionProgress(): number {
    return this.emotionTimeline?.getTransitionProgress() ?? 0;
  }

  private getActiveFilterDetails(): Array<{ id: string; name: string; type: string; intensity: number }> {
    return this.filterPipeline.getActiveEffects().map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      intensity: e.intensity,
    }));
  }

  private getMotionLayerStatuses(): Array<{
    name: string;
    state: string;
    weight: number;
    priority: number;
  }> {
    if (!this.motionLayerSystem) return [];
    return this.motionLayerSystem.getLayerStatuses().map((s) => ({
      name: s.name,
      state: s.state,
      weight: s.weight,
      priority: s.priority,
    }));
  }

  private getProceduralModuleStatuses(): Array<{
    name: string;
    enabled: boolean;
  }> {
    return this.proceduralSystem?.getModuleStatuses() ?? [];
  }
}
