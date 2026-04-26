/**
 * Instrumented booking funnel stages (Option A telemetry contract).
 */
export const JOURNEY_STAGES = [
  "search",
  "select",
  "details",
  "payment",
  "complete",
] as const;

export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export function isJourneyStage(s: string): s is JourneyStage {
  return (JOURNEY_STAGES as readonly string[]).includes(s);
}
