import "dotenv/config";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { isJourneyStage, JOURNEY_STAGES } from "./journey.js";
import { scoreAbandonment } from "./abandonment.js";
import {
  appendEvent,
  getSession,
  metricsSummary,
  recordChatTurn,
  recordResumeVerification,
  type ExperimentVariant,
} from "./store.js";
import { escalationFooter, stripUncertainTag } from "./chatEscalation.js";
import { listPolicyFiles, readPolicyFile, retrievePolicyChunks } from "./rag.js";
import { chatCompletion } from "./llm.js";
import { signResumeToken, verifyResumeToken } from "./resumeToken.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

function parseVariant(header: string | undefined, bodyVariant?: string): ExperimentVariant {
  const v = (header || bodyVariant || "copilot").toLowerCase();
  if (v === "control") return "control";
  return "copilot";
}

const eventSchema = z.object({
  sessionId: z.string().min(8),
  stage: z.string(),
  idleMs: z.number().optional(),
  payload: z.record(z.unknown()).optional(),
  variant: z.enum(["control", "copilot"]).optional(),
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, stages: JOURNEY_STAGES });
});

app.post("/api/events", (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { sessionId, stage, idleMs, payload } = parsed.data;
  if (!isJourneyStage(stage)) {
    return res.status(400).json({ error: `Invalid stage. Use one of: ${JOURNEY_STAGES.join(", ")}` });
  }
  const variant = parseVariant(req.header("x-experiment-variant"), parsed.data.variant);
  const ev = appendEvent({ sessionId, stage, idleMs, payload, variant });
  const session = getSession(sessionId);
  const abandon = scoreAbandonment(session);
  res.json({ ok: true, eventId: ev.id, abandonment: abandon });
});

app.post("/api/chat", async (req, res) => {
  const schema = z.object({
    sessionId: z.string().optional(),
    /** Client-generated copilot conversation id (e.g. cc-uuid). */
    chatId: z.string().min(6).max(120).optional(),
    message: z.string().min(1).max(4000),
    variant: z.enum(["control", "copilot"]).optional(),
    bookingContext: z.record(z.unknown()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const variant = parseVariant(req.header("x-experiment-variant"), parsed.data.variant);
  if (variant === "control") {
    return res.status(403).json({ error: "Copilot disabled for control variant" });
  }
  const { message, bookingContext } = parsed.data;
  const sid = parsed.data.sessionId?.trim() || "na";
  const clientChatId = parsed.data.chatId?.trim();
  const chatId =
    clientChatId && clientChatId.length >= 6 ? clientChatId : `cc-srv-${sid.slice(0, 8)}-${Date.now().toString(36)}`;

  const chunks = retrievePolicyChunks(message);
  try {
    const result = await chatCompletion(message, chunks, bookingContext, chatId);
    const stripped = stripUncertainTag(result.answer);
    let answer = stripped.text;
    const uncertain = stripped.uncertain;
    if (uncertain) answer = `${answer.trimEnd()}${escalationFooter(chatId)}`;

    const citedIdx = new Set<number>();
    for (const m of answer.matchAll(/\[(\d+)\]/g)) {
      const idx = Number(m[1]) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < chunks.length) citedIdx.add(idx);
    }
    /** `ref` matches POLICY_CONTEXT snippet numbers in the answer ([1]…[n]); do not renumber in the UI. */
    const citations =
      citedIdx.size > 0
        ? Array.from(citedIdx)
            .sort((a, b) => a - b)
            .map((i) => ({ ref: i + 1, id: chunks[i]!.id, source: chunks[i]!.source }))
        : [];
    recordChatTurn(parsed.data.sessionId);
    res.json({
      answer,
      model: result.model,
      citations,
      usedChunkIds: result.usedChunks,
      chatId,
      uncertain,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    res.status(502).json({ error: msg });
  }
});

app.post("/api/resume/token", (req, res) => {
  const schema = z.object({
    sessionId: z.string().min(8),
    stage: z.string(),
    variant: z.enum(["control", "copilot"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { sessionId, stage } = parsed.data;
  if (!isJourneyStage(stage)) {
    return res.status(400).json({ error: `Invalid stage` });
  }
  const variant = parseVariant(req.header("x-experiment-variant"), parsed.data.variant);
  const token = signResumeToken({ sessionId, stage, variant });
  const webOrigin = process.env.WEB_PUBLIC_ORIGIN || "http://localhost:5174";
  const url = `${webOrigin.replace(/\/$/, "")}/resume?token=${encodeURIComponent(token)}`;
  res.json({ token, url, expiresInMinutes: Number(process.env.RESUME_TOKEN_TTL_MINUTES || 120) });
});

app.get("/api/resume/verify", (req, res) => {
  const token = req.query.token;
  if (typeof token !== "string" || !token) {
    return res.status(400).json({ error: "token query required" });
  }
  try {
    const payload = verifyResumeToken(token);
    if (!isJourneyStage(payload.stage)) {
      return res.status(400).json({ error: "Invalid stage in token" });
    }
    recordResumeVerification(payload.sessionId);
    res.json(payload);
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
  }
});

const notifyLog: {
  ts: number;
  channel: string;
  sessionId: string;
  to?: string;
  resumeUrl?: string;
  intent?: string;
  itinerarySummary?: string;
}[] = [];

app.post("/api/notify", (req, res) => {
  const schema = z.object({
    sessionId: z.string(),
    channel: z.enum(["email", "sms", "whatsapp"]),
    to: z.string().optional(),
    resumeUrl: z.string().url().optional(),
    intent: z.enum(["resume_reminder", "itinerary_summary"]).optional(),
    itinerarySummary: z.string().max(8000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  notifyLog.push({
    ts: Date.now(),
    ...parsed.data,
  });
  res.json({
    ok: true,
    message: "Notification queued (stub). Wire your provider here.",
    queued: notifyLog.length,
  });
});

app.get("/api/metrics/summary", (_req, res) => {
  res.json(metricsSummary());
});

app.get("/api/policies", (_req, res) => {
  res.json({ files: listPolicyFiles() });
});

app.get("/api/policies/:file", (req, res) => {
  const file = req.params.file;
  const content = readPolicyFile(file);
  if (!content) return res.status(404).json({ error: "policy file not found" });
  res.json({ file, content });
});

app.get("/api/session/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "unknown session" });
  res.json({ session, abandonment: scoreAbandonment(session) });
});

const port = Number(process.env.PORT || 3040);
app.listen(port, () => {
  console.log(`Booking recovery API listening on http://localhost:${port}`);
});
