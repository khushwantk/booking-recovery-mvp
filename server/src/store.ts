import type { JourneyStage } from "./journey.js";

export type ExperimentVariant = "control" | "copilot";

export interface BookingEvent {
  id: string;
  sessionId: string;
  stage: JourneyStage;
  idleMs?: number;
  payload?: Record<string, unknown>;
  variant: ExperimentVariant;
  ts: number;
}

export interface SessionState {
  sessionId: string;
  variant: ExperimentVariant;
  lastStage: JourneyStage | null;
  lastTs: number;
  eventCount: number;
  maxIdleMs: number;
  paymentEntered: boolean;
  completed: boolean;
  /** Stages this session has ever emitted an event for */
  visitedStages: Partial<Record<JourneyStage, boolean>>;
  /** Max add-on edit count reported by client (details-step churn). */
  addOnChangeCount: number;
  /** Max step-back count from client. */
  stepBackCount: number;
  /** Successful POST /api/chat completions (assistant replies). */
  chatTurns: number;
  /** Successful GET /api/resume/verify with valid token. */
  resumeVerifications: number;
}

const events: BookingEvent[] = [];
const sessions = new Map<string, SessionState>();

function newSession(sessionId: string, variant: ExperimentVariant): SessionState {
  return {
    sessionId,
    variant,
    lastStage: null,
    lastTs: Date.now(),
    eventCount: 0,
    maxIdleMs: 0,
    paymentEntered: false,
    completed: false,
    visitedStages: {},
    addOnChangeCount: 0,
    stepBackCount: 0,
    chatTurns: 0,
    resumeVerifications: 0,
  };
}

export function appendEvent(ev: Omit<BookingEvent, "id" | "ts">): BookingEvent {
  const full: BookingEvent = {
    ...ev,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    ts: Date.now(),
  };
  events.push(full);

  let s = sessions.get(ev.sessionId);
  if (!s) {
    s = newSession(ev.sessionId, ev.variant);
    sessions.set(ev.sessionId, s);
  }
  s.eventCount += 1;
  s.lastStage = ev.stage;
  s.lastTs = full.ts;
  if (ev.idleMs != null) s.maxIdleMs = Math.max(s.maxIdleMs, ev.idleMs);
  if (ev.stage === "payment") s.paymentEntered = true;
  if (ev.stage === "complete") s.completed = true;
  s.visitedStages = { ...s.visitedStages, [ev.stage]: true };

  const p = ev.payload;
  if (p && typeof p === "object") {
    const ac = p.addOnChangeCount;
    if (typeof ac === "number" && ac >= 0) s.addOnChangeCount = Math.max(s.addOnChangeCount, ac);
    const sb = p.stepBackCount;
    if (typeof sb === "number" && sb >= 0) s.stepBackCount = Math.max(s.stepBackCount, sb);
  }

  return full;
}

export function recordChatTurn(sessionId: string | undefined): void {
  if (!sessionId) return;
  const s = sessions.get(sessionId);
  if (s) s.chatTurns += 1;
}

export function recordResumeVerification(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) s.resumeVerifications += 1;
}

export function getRecentEvents(limit = 500): BookingEvent[] {
  return events.slice(-limit);
}

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

type VariantMetrics = {
  sessions: number;
  reachedSelect: number;
  reachedDetails: number;
  paymentEntered: number;
  completed: number;
  chatTurns: number;
  resumeVerifications: number;
};

export function metricsSummary() {
  const byVariant: Record<ExperimentVariant, VariantMetrics> = {
    control: {
      sessions: 0,
      reachedSelect: 0,
      reachedDetails: 0,
      paymentEntered: 0,
      completed: 0,
      chatTurns: 0,
      resumeVerifications: 0,
    },
    copilot: {
      sessions: 0,
      reachedSelect: 0,
      reachedDetails: 0,
      paymentEntered: 0,
      completed: 0,
      chatTurns: 0,
      resumeVerifications: 0,
    },
  };

  for (const s of sessions.values()) {
    const b = byVariant[s.variant];
    b.sessions += 1;
    if (s.visitedStages.select) b.reachedSelect += 1;
    if (s.visitedStages.details) b.reachedDetails += 1;
    if (s.paymentEntered) b.paymentEntered += 1;
    if (s.completed) b.completed += 1;
    b.chatTurns += s.chatTurns;
    b.resumeVerifications += s.resumeVerifications;
  }

  const funnelRates = (m: VariantMetrics) => ({
    selectToPayment: m.reachedSelect > 0 ? m.paymentEntered / m.reachedSelect : 0,
    paymentToComplete: m.paymentEntered > 0 ? m.completed / m.paymentEntered : 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    uniqueSessions: sessions.size,
    byVariant: {
      control: { ...byVariant.control, funnelRates: funnelRates(byVariant.control) },
      copilot: { ...byVariant.copilot, funnelRates: funnelRates(byVariant.copilot) },
    },
  };
}
