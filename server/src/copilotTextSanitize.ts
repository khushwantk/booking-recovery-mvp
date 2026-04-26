/**
 * Normalizes assistant text so chat + PDF render reliably (strip emoji / ZW / bidi, fix headings).
 * Keep in sync with web/src/copilotTextSanitize.ts
 */

/** Paragraphs that look like LM “reasoning” / planning, not passenger-facing copy. */
function isReasoningParagraph(para: string): boolean {
  const first =
    para
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (!first) return true;
  const patterns: RegExp[] = [
    /^The user is asking\b/i,
    /^The user asked\b/i,
    /^The user wants\b/i,
    /^I need to (use|check|compare|analyze|look|determine|summarize|start|reread|build)\b/i,
    /^I must\b/i,
    /^I will (structure|compare|start|use|analyze|look|draft)\b/i,
    /^I'll (use|start|check|compare|analyze|look)\b/i,
    /^Let me (check|analyze|review|use|look|start)\b/i,
    /^First, I\b/i,
    /^Based on BOOKING_CONTEXT\b/i,
    /^Based on the (BOOKING_|context|provided)\b/i,
    /^Looking at BOOKING\b/i,
    /^Looking at (your|the)\s+current\b/i,
    /^\*\*Step\s*\d+/i,
    /^Step\s*\d+[:.]\s*(Analyze|Determine|Structure|State|Compare|Address|Review|Break)\b/i,
    /^Current selected items\b/i,
    /^Current pricing lines\b/i,
    /^I('m| am) (going to|building|drafting)\b/i,
    /^To answer (this|your) question\b/i,
    /^Here is my (approach|plan|analysis|thinking)\b/i,
    /^Here's how I('ll| will)\b/i,
    /^I should (mention|compare|check|note|start)\b/i,
    /^We need to\b/i,
    /^My (approach|plan|thinking)\b/i,
    /^I have to\b/i,
    /^Now I (will|'ll|need to)\b/i,
  ];
  if (patterns.some((re) => re.test(first))) return true;
  if (
    /^\*{0,2}Optimization opportunities:?\*{0,2}\s*$/i.test(first) &&
    para.replace(/\s/g, "").length < 45
  ) {
    return true;
  }
  return false;
}

/**
 * Removes chain-of-thought blocks (common when the API only fills `reasoning_content`).
 */
function stripReasoningMonologue(text: string): string {
  const raw = text.trim();
  if (!raw) return raw;
  const paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const kept = paras.filter((p) => !isReasoningParagraph(p));
  let out = kept.join("\n\n").trim();
  if (out.length >= 28) return out;

  const lines = raw.split(/\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!.trim();
    if (/^[-*•]\s+\S/.test(ln) && !/^\*\*Step\b/i.test(ln)) {
      start = i;
      break;
    }
    if (
      /^\d+\.\s+/.test(ln) &&
      !/^\d+\.\s*(State|Compare|Analyze|Structure|Address|Review|Determine|Break)\b/i.test(ln)
    ) {
      start = i;
      break;
    }
    if (/^(Here are|You can|To save|Ways to|Tips?:|Try switching|Consider |Your (cheapest|current))\b/i.test(ln)) {
      start = i;
      break;
    }
  }
  if (start >= 0) return lines.slice(start).join("\n").trim();
  return out.length > 0 ? out : raw;
}

export function sanitizeCopilotText(text: string): string {
  let t = stripReasoningMonologue(text).normalize("NFKC");
  t = t.replace(/\uFE0F/g, "");
  t = t.replace(/[\u200B-\u200D\u2060-\u2064\uFEFF]/g, "");
  t = t.replace(/[\u202A-\u202E]/g, "");
  t = t.replace(/\p{Extended_Pictographic}/gu, "");
  t = t.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
  t = t.replace(/^#{1,6}\s*$/gm, "");
  t = t.replace(/^\*{2,3}\s*$/gm, "");
  return t.trimEnd();
}
