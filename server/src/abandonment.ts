import type { SessionState } from "./store.js";

export type AbandonmentSignal = "idle" | "payment_hesitation" | "details_hesitation" | "low";

/** Idle time (ms) after which we treat the user as at risk of abandoning (demo-friendly). */
export const IDLE_ALERT_MS = 10_000;

/**
 * Lightweight rules engine for MVP propensity (no ML dependency).
 * Mid-funnel: details + idle, heavy add-on toggling, or step-backs raise score.
 */
export function scoreAbandonment(session: SessionState | undefined): {
  score: number;
  signal: AbandonmentSignal;
  suggestAssist: boolean;
} {
  if (!session) {
    return { score: 0, signal: "low", suggestAssist: false };
  }

  let score = 0;
  if (session.maxIdleMs > IDLE_ALERT_MS) score += 40;
  if (session.lastStage === "payment") score += 35;
  if (session.lastStage === "details") score += 22;
  if (session.lastStage === "select") score += 10;
  if (session.eventCount > 8) score += 12;

  if (session.lastStage === "details" && session.maxIdleMs > IDLE_ALERT_MS) score += 8;
  if (session.lastStage === "details" && session.addOnChangeCount >= 3) score += 18;
  if (
    session.stepBackCount >= 1 &&
    (session.lastStage === "details" || session.lastStage === "select")
  ) {
    score += 12;
  }

  const signal: AbandonmentSignal =
    session.maxIdleMs > IDLE_ALERT_MS && session.lastStage === "payment"
      ? "payment_hesitation"
      : session.maxIdleMs > IDLE_ALERT_MS && session.lastStage === "details"
        ? "details_hesitation"
        : session.maxIdleMs > IDLE_ALERT_MS
          ? "idle"
          : "low";

  return {
    score: Math.min(100, score),
    signal,
    suggestAssist: score >= 40,
  };
}
