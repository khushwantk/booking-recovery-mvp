import type { ExperimentVariant } from "./experiment";

export type JourneyStage = "search" | "select" | "details" | "payment" | "complete";

export async function sendBookingEvent(
  variant: ExperimentVariant,
  sessionId: string,
  stage: JourneyStage,
  opts?: { idleMs?: number; payload?: Record<string, unknown> }
): Promise<{
  abandonment?: { score: number; signal: string; suggestAssist: boolean };
}> {
  const res = await fetch("/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Experiment-Variant": variant,
    },
    body: JSON.stringify({
      sessionId,
      stage,
      idleMs: opts?.idleMs,
      payload: opts?.payload,
      variant,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `events ${res.status}`);
  }
  return res.json();
}
