import type { Phase, PhaseState } from "./phase.js";

/**
 * Shared version state.
 */
export interface SharedVersionState {
    /**
     * Beta and production phase states.
     */
    readonly phaseStates: Readonly<Partial<Record<"beta" | "prod", PhaseState>>>;
}

/**
 * Local version state.
 */
export interface LocalVersionState {
    /**
     * Alpha phase state.
     */
    readonly phaseStates: Readonly<Partial<Record<"alpha", PhaseState>>>;
}

/**
 * Version state.
 */
export interface VersionState extends SharedVersionState, LocalVersionState {
    /**
     * Phase states.
     */
    readonly phaseStates: Partial<Record<Phase, PhaseState>>;
}
