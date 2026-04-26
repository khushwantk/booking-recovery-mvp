import jwt from "jsonwebtoken";
import type { JourneyStage } from "./journey.js";
import { isJourneyStage } from "./journey.js";

export interface ResumePayload {
  sessionId: string;
  stage: JourneyStage;
  variant: "control" | "copilot";
}

export function signResumeToken(payload: ResumePayload): string {
  const secret = process.env.RESUME_JWT_SECRET;
  if (!secret || secret === "change-me-to-a-long-random-string-for-demo") {
    console.warn("[resume] Using default RESUME_JWT_SECRET — set a strong secret in production.");
  }
  const ttl = Number(process.env.RESUME_TOKEN_TTL_MINUTES || 120);
  return jwt.sign(payload, secret || "dev-secret", { expiresIn: `${ttl}m` });
}

export function verifyResumeToken(token: string): ResumePayload {
  const secret = process.env.RESUME_JWT_SECRET || "dev-secret";
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Invalid token payload");
  }
  const { sessionId, stage, variant } = decoded as Record<string, unknown>;
  if (typeof sessionId !== "string" || typeof stage !== "string" || !isJourneyStage(stage)) {
    throw new Error("Invalid token fields");
  }
  return {
    sessionId,
    stage,
    variant: variant === "control" || variant === "copilot" ? variant : "copilot",
  };
}
