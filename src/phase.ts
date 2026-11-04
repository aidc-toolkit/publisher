/**
 * Phase.
 */
export type Phase = "alpha" | "beta" | "prod";

/**
 * Next phase mapping.
 */
export const NEXT_PHASE: Readonly<Record<Phase, Phase | null>> = {
    alpha: "beta",
    beta: "prod",
    prod: null
};

/**
 * Previous phase mapping.
 */
export const PREVIOUS_PHASE: Readonly<Record<Phase, Phase | null>> = {
    alpha: null,
    beta: "alpha",
    prod: "beta"
};

/**
 * Phase state.
 */
export interface PhaseState {
    /**
     * Version the phase was last published.
     */
    version: string;

    /**
     * Date/time the phase was last published.
     */
    dateTime?: Date;
}
