import type { PolicyChunk } from "./rag.js";
import { sanitizeCopilotText } from "./copilotTextSanitize.js";
type BookingContext = Record<string, unknown>;

function buildContext(chunks: PolicyChunk[]): string {
  const n = chunks.length;
  const header =
    n > 0
      ? `Policy snippets below are numbered [1] through [${n}] — use only these numbers when citing policy.\n\n`
      : "";
  return (
    header +
    chunks
      .map((c, i) => `[${i + 1}] (${c.source}) ${c.text.replace(/\s+/g, " ").slice(0, 1200)}`)
      .join("\n\n")
  );
}

function geminiMaxOutputTokens(): number {
  const n = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || "8192");
  if (!Number.isFinite(n) || n < 256) return 8192;
  return Math.min(16384, Math.floor(n));
}

/** OpenAI-compatible APIs (LM Studio, OpenAI, Groq) — request enough headroom or output truncates mid-sentence. */
function openAiCompatMaxTokens(): number {
  const raw =
    process.env.OPENAI_COMPAT_MAX_TOKENS ||
    process.env.LM_STUDIO_MAX_TOKENS ||
    process.env.OPENAI_MAX_TOKENS ||
    "24576";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 256) return 24576;
  return Math.min(65536, Math.floor(n));
}

function geminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
  );
}

function isGeminiQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes("gemini error 429") || m.includes("quota exceeded");
}

function formatInr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

type FlightOption = {
  code: string;
  fare: string;
  base: number;
  from?: string;
  airportTransferFromHome?: number;
  totalEffectiveCostPerPax?: number;
};

function getFlightOptions(ctx?: BookingContext): FlightOption[] {
  const raw = ctx?.availableFlights;
  if (!Array.isArray(raw)) return [];
  const out: FlightOption[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.code !== "string" || typeof o.fare !== "string" || typeof o.base !== "number") continue;
    out.push({
      code: o.code,
      fare: o.fare,
      base: o.base,
      from: typeof o.from === "string" ? o.from : undefined,
      airportTransferFromHome: typeof o.airportTransferFromHome === "number" ? o.airportTransferFromHome : undefined,
      totalEffectiveCostPerPax: typeof o.totalEffectiveCostPerPax === "number" ? o.totalEffectiveCostPerPax : undefined,
    });
  }
  return out;
}

function getMarketFlightOptions(ctx?: BookingContext): FlightOption[] {
  const raw = ctx?.marketFlightsToDestination;
  if (!Array.isArray(raw)) return [];
  const out: FlightOption[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.code !== "string" || typeof o.fare !== "string" || typeof o.base !== "number") continue;
    out.push({
      code: o.code,
      fare: o.fare,
      base: o.base,
      from: typeof o.from === "string" ? o.from : undefined,
      airportTransferFromHome: typeof o.airportTransferFromHome === "number" ? o.airportTransferFromHome : undefined,
      totalEffectiveCostPerPax: typeof o.totalEffectiveCostPerPax === "number" ? o.totalEffectiveCostPerPax : undefined,
    });
  }
  return out;
}

/** LM Studio (OpenAI-compatible). Active only when `LM_STUDIO_ENABLED=1` (or `true`). Default model: google/gemma-4-e4b. */
export function lmStudioConfig(): { base: string; apiKey: string; model: string } | null {
  const enabled =
    process.env.LM_STUDIO_ENABLED?.trim().toLowerCase() === "true" ||
    process.env.LM_STUDIO_ENABLED === "1";
  if (!enabled) return null;
  const model = process.env.LM_STUDIO_MODEL?.trim() || "google/gemma-4-e4b";
  const base =
    (process.env.LM_STUDIO_BASE_URL?.trim() || "http://127.0.0.1:1234/v1").replace(/\/$/, "") || "http://127.0.0.1:1234/v1";
  return {
    base,
    apiKey: process.env.LM_STUDIO_API_KEY?.trim() || "lm-studio",
    model,
  };
}

/**
 * Google AI Studio / Gemini API — generateContent (v1beta).
 * @see https://ai.google.dev/api/rest/v1beta/models.generateContent
 */
async function geminiGenerate(
  userMessage: string,
  context: string,
  system: string
): Promise<string> {
  const key = geminiApiKey();
  if (!key) throw new Error("Gemini API key missing");

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
  const base =
    process.env.GEMINI_API_BASE?.replace(/\/$/, "") ||
    "https://generativelanguage.googleapis.com/v1beta";
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: "user",
          parts: [{ text: `CONTEXT:\n${context}\n\nUSER:\n${userMessage}` }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: geminiMaxOutputTokens(),
      },
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini error ${res.status}: ${raw.slice(0, 600)}`);
  }

  const data = JSON.parse(raw) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      finishReason?: string;
    }[];
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  let text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim();
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini returned no text (finishReason: ${reason})`);
  }
  const fr = data.candidates?.[0]?.finishReason;
  if (fr === "MAX_TOKENS") {
    text += `\n\n_(Gemini hit the output token limit. Increase **GEMINI_MAX_OUTPUT_TOKENS** in \`server/.env\`.)_`;
  }
  return text;
}

/**
 * LM Studio / Gemma / newer OpenAI responses often use `message.content` as an array of
 * `{ type: "text", text: "..." }` parts — a plain `.trim()` on `content` yields nothing.
 */
function extractOpenAiMessageText(message: Record<string, unknown> | null | undefined): string {
  if (!message) return "";

  const joinParts = (parts: unknown[]): string => {
    const out: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") out.push(p);
      else if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        if (typeof o.text === "string") out.push(o.text);
        else if (typeof o.content === "string") out.push(o.content);
      }
    }
    return out.join("").trim();
  };

  const c = message.content;
  if (typeof c === "string") {
    const t = c.trim();
    if (t) return t;
  } else if (Array.isArray(c)) {
    const t = joinParts(c);
    if (t) return t;
  } else if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof o.text === "string") {
      const t = o.text.trim();
      if (t) return t;
    }
  }

  // Reasoning models (LM Studio / some Gemma builds) put the visible reply in `reasoning_content`
  // while `content` stays "" until a separate "final" phase — do not return early on empty content.
  for (const key of ["reasoning_content", "reasoning"] as const) {
    const v = message[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const t = joinParts(v);
      if (t) return t;
    }
  }

  if (typeof message.text === "string") return message.text.trim();

  return "";
}

/** OpenAI-compatible chat completions (OpenAI, LM Studio, Groq, etc.). */
async function chatCompletionsOpenAIFormat(
  userMessage: string,
  combinedContext: string,
  system: string,
  cfg: { base: string; apiKey: string; model: string }
): Promise<string> {
  const res = await fetch(`${cfg.base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: openAiCompatMaxTokens(),
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `CONTEXT:\n${combinedContext}\n\nUSER:\n${userMessage}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM error ${res.status}: ${err.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: {
      message?: Record<string, unknown>;
      text?: string;
      finish_reason?: string;
    }[];
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  const choice0 = data.choices?.[0];
  const msg = choice0?.message;
  let text = extractOpenAiMessageText(msg);
  if (!text && typeof choice0?.text === "string") {
    text = choice0.text.trim();
  }

  const finish = choice0?.finish_reason;
  if (text && finish === "length") {
    text += `\n\n_(This reply hit the **completion token** limit (\`finish_reason: length\`). Set **OPENAI_COMPAT_MAX_TOKENS** (e.g. \`32768\` or \`65536\`) in \`server/.env\` and restart the API. In **LM Studio**, also raise the model’s **Server → Context Length / Max Tokens (Output)** if it caps below your env. If it still truncates, lower **RAG_TOP_K** or shorten policy snippets — the model’s **total** context may be full.)_`;
  }

  if (!text) {
    const dbg =
      msg != null
        ? JSON.stringify(msg).slice(0, 400)
        : JSON.stringify({ choicesLen: data.choices?.length ?? 0 }).slice(0, 200);
    console.warn("[llm] OpenAI-compatible empty assistant text; first choice message:", dbg);
    throw new Error(
      "LLM returned no assistant text (LM Studio: check `message.content` vs `reasoning_content`; empty string content now falls back to reasoning. If both empty, paste Server log line.)"
    );
  }

  return text;
}

async function openaiCompatibleChat(
  userMessage: string,
  combinedContext: string,
  system: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI API key missing");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  return chatCompletionsOpenAIFormat(userMessage, combinedContext, system, { base, apiKey, model });
}

/**
 * Mock assistant when no API key — still uses retrieved chunks for transparency.
 */
export function mockAnswer(userMessage: string, chunks: PolicyChunk[], bookingContext?: BookingContext): string {
  const msg = userMessage.toLowerCase();
  const flights = getFlightOptions(bookingContext);
  const marketFlights = getMarketFlightOptions(bookingContext);

  if (/bangkok|bkk/.test(msg) && /live in|i live in|from my city|including travel|reach airport/.test(msg)) {
    const pool = marketFlights.length > 0 ? marketFlights : flights;
    if (pool.length > 0) {
      const sorted = [...pool].sort(
        (a, b) => (a.totalEffectiveCostPerPax ?? a.base) - (b.totalEffectiveCostPerPax ?? b.base)
      );
      const best = sorted[0]!;
      const second = sorted[1];
      const bestTotal = best.totalEffectiveCostPerPax ?? best.base;
      const secondTotal = second ? (second.totalEffectiveCostPerPax ?? second.base) : 0;
      const transfer = best.airportTransferFromHome ?? 0;
      return [
        `Considering city-to-airport travel + fare, your best option is **${best.code} (${best.from} departure)**.`,
        `- Flight fare: **${formatInr(best.base)}**`,
        `- Approx travel to departure airport: **${formatInr(transfer)}**`,
        `- Effective total: **${formatInr(bestTotal)} per passenger**`,
        second
          ? `Compared with next option ${second.code}, you save about **${formatInr(secondTotal - bestTotal)} per passenger**.`
          : "",
      ].join("\n");
    }
  }

  if (
    /\b(travel )?agents?\b/.test(msg) ||
    /\bota\b/.test(msg) ||
    /another (website|site|portal|app)/.test(msg) ||
    /\belsewhere\b/.test(msg) ||
    /offering cheaper|cheaper than (here|this|you)|lower quote|beat your price|third[- ]party|shop(ping)? around/i.test(
      msg
    )
  ) {
    return [
      "If another **agent, OTA, or site** claims a lower price, compare the **full offer** (fare family, baggage, seat, meals, change/refund rules, taxes in INR) — headline fares often omit add-ons.",
      "",
      "**Booking direct on this path** keeps control in **manage-booking**, keeps disruption and schedule updates aligned with the airline, and you can use **Resume** here if you need to pause.",
      "",
      "I can clarify what **your current selections** already include. For comparing a written quote line-by-line, official **customer care** (see policy contact snippet) can help — quote your **Chat ID** if the app shows one.",
    ].join("\n");
  }

  if (/cheap|cheaper|lowest|budget|save money|low fare/.test(msg)) {
    if (flights.length > 0) {
      const hasDoorToDoor = flights.some((f) => typeof f.totalEffectiveCostPerPax === "number");
      const sorted = [...flights].sort((a, b) => {
        const aa = hasDoorToDoor ? (a.totalEffectiveCostPerPax ?? a.base) : a.base;
        const bb = hasDoorToDoor ? (b.totalEffectiveCostPerPax ?? b.base) : b.base;
        return aa - bb;
      });
      const cheapest = sorted[0]!;
      const alt = sorted[1];
      const cheapestCost = hasDoorToDoor ? (cheapest.totalEffectiveCostPerPax ?? cheapest.base) : cheapest.base;
      const altCost = alt ? (hasDoorToDoor ? (alt.totalEffectiveCostPerPax ?? alt.base) : alt.base) : 0;
      const savings = alt ? altCost - cheapestCost : 0;
      return [
        `Yes — your cheapest option here is **${cheapest.code} (${cheapest.fare})** at **${formatInr(cheapest.base)} per passenger**.`,
        hasDoorToDoor
          ? `Including approx city-to-airport transfer, effective cost is about **${formatInr(cheapestCost)} per passenger**.`
          : "",
        alt
          ? `That is about **${formatInr(savings)} cheaper** than ${alt.code} in the current options.`
          : "This is the only fare option I can see right now.",
        "",
        "To keep total lower, choose:",
        "- `No meal` or `Standard meal`",
        "- `Standard seat`",
        "- `Cabin only` baggage",
        "- Skip optional extras like insurance/carbon offset",
      ].join("\n");
    }
    return "I can help compare fare options, but I do not have live flight prices in this context. Please pick the lower Saver fare card in the flight step.";
  }

  if (/baggage|bag\b/.test(msg) && /counter|airport/.test(msg)) {
    return [
      "You can usually add extra checked baggage at the airport counter, subject to operational limits and check-in cutoff.",
      "Counter/airport rates are normally higher than pre-booked baggage rates.",
      "",
      "Best value tip: add baggage during booking or via manage-booking before web check-in closes.",
    ].join("\n");
  }

  const topics = chunks.map((c) => c.source.replace(".md", "")).join(", ");
  return [
    "I can help with both booking choices and policy questions.",
    "",
    `I matched your message (“${userMessage.slice(0, 120)}${userMessage.length > 120 ? "…" : ""}”) to our policy excerpts on: **${topics || "general policy"}**.`,
    "",
    "Try asking:",
    "- “Which is the cheapest option in this screen?”",
    "- “If I choose no meal and cabin-only, what is better for budget?”",
    "- “Can I change or refund this fare?”",
    "",
    "When Gemini, LM Studio, or OpenAI is configured, you’ll get richer natural-language answers with citations.",
    "",
    "Tip: I can handle baggage allowance, refunds, seat upgrades, and cheapest-option guidance.",
  ].join("\n");
}

/**
 * Models sometimes emit LaTeX arrows or $ before amounts. BOOKING_CONTEXT is always INR.
 */
function normalizeCopilotAnswer(text: string): string {
  const cleaned = sanitizeCopilotText(text);
  return cleaned
    .replace(/\$\s*\\rightarrow\s*\$/g, "→")
    .replace(/\$\s*\\Rightarrow\s*\$/g, "→")
    .replace(/\$\s*\\to\s*\$/g, "→")
    .replace(/\\rightarrow\b/g, "→")
    .replace(/\\Rightarrow\b/g, "→")
    .replace(/\\to\b/g, "→")
    .replace(/\$(?=\s*[\d,])/g, "₹");
}

export async function chatCompletion(
  userMessage: string,
  chunks: PolicyChunk[],
  bookingContext?: BookingContext,
  copilotChatId?: string
): Promise<{ answer: string; model: string; usedChunks: string[] }> {
  const policyContext = buildContext(chunks);
  const bookingCtx = bookingContext ? JSON.stringify(bookingContext, null, 2) : "{}";
  const cid = (copilotChatId && copilotChatId.trim()) || "cc-unknown";
  const combinedContext = `COPILOT_CHAT_ID: ${cid}\n(Passengers may quote this if they call customer care.)\n\nBOOKING_CONTEXT:\n${bookingCtx}\n\nPOLICY_CONTEXT:\n${policyContext}`;
  const system = `You are an airline booking recovery assistant for an airline checkout flow.

Use these sources together:
0) COPILOT_CHAT_ID in CONTEXT — reference it only when you tell the user to save the chat or call care (same id appears in the app).
1) BOOKING_CONTEXT: current on-screen fare options, selected add-ons, totals, pricingLines, demoPricingRules.
2) POLICY_CONTEXT: snippets may cover refunds/changes, baggage, seats/meals/insurance/upgrades, check-in and airport timing, contact and care (phone, chat ID, grievance), booking FAQs (payment, infants, accessibility, disruption). Read relevant snippets before saying a topic is not covered.
3) marketFlightsToDestination and homeCityToAirportCostEstimate when the user asks about alternative origins or door-to-door cost.

Rules:
- For price/comparison/cheapest/add-on optimization questions, use BOOKING_CONTEXT first.
- For "I live in X, what's cheapest to destination Y including reaching airport?" use marketFlightsToDestination + transfer estimates.
- For rules/policy questions, use POLICY_CONTEXT. Cite **only** snippet numbers that appear in POLICY_CONTEXT for this request: **[1]** through **[n]** where **n** equals the number of snippets shown (same numbers as in CONTEXT). Never invent **[n]** beyond that range.
- **Mirror BOOKING_CONTEXT.selected exactly** (meal, seat, baggage, insurance, carbonOffset). If seat is standard, there is **no** separate standard-seat fee — only legroom adds demoPricingRules.seatLegroomPerPaxInr per passenger. If meal is none, standard, or premium, describe only that tier.
- **Current checkout total (must match the UI):** Use **checkoutGrandTotalInr**, **checkoutTaxesInr**, and **checkoutSubtotalInr** when present (same values as **totals.grandTotal**, **totals.taxes**, **totals.subtotal**). For “what is my total?” or “how much do I pay?”, quote those fields **verbatim** — they already include the app’s tax rounding. Do **not** replace them by re-summing **pricingLines** or by doing subtotal×0.05 without rounding tax to a whole INR first (the app uses **Math.round** on tax; skipping that causes mismatches vs the screen).
- **pricingLines** is the line-item breakdown for the current booking. For **hypothetical** “if you switched to X” totals only: rebuild subtotal from **demoPricingRules** + **passengers**, then apply **demoPricingRules.taxesFormula** (integer-rounded tax, then add). Label hypotheticals as estimates. Do **not** say the breakdown is missing when pricingLines exists, and do **not** ask the user to confirm before recalculating hypotheticals — give the demo numbers directly.
- If policy detail is missing, clearly say what is known vs unknown, then give a practical next action.
- Avoid generic “contact support” unless truly necessary.
- Be concise and actionable.

Travel agents, OTAs, or “cheaper elsewhere” (direct-channel narrative):
- When the user says an **agent**, **another site/OTA**, or **someone else** is offering a **lower price** or “better deal”, stay factual and professional. Do **not** insult third parties or claim they are dishonest without evidence.
- **Anchor to BOOKING_CONTEXT**: explain what **this** booking path includes today (fare type, **pricingLines**, add-ons, taxes) so the user can compare **apples to apples** (Saver vs Flex, baggage, seat, change/refund rules, insurance). If you lack their external quote details, say what to check on their quote (fare family, baggage kg, change fees, add-ons, currency, date/time).
- **Why direct booking matters (generic, demo-safe framing)**: completing on the airline site keeps the booking under the airline’s **manage-booking** and disruption workflows; you already have **policy-grounded answers** and a **resume link** here so they can finish without losing context. Optionally mention that third-party bookings can still be valid, but **comparison** should include total cost and **flexibility** (refund/change) not headline fare alone — only where policy snippets support it, cite with **[n]**.
- **Gentle conversion**: invite them to finish on this screen if the total still works for them, or to use **official customer care** (from policy contact snippet) with **Chat ID** if they need a human to review fare rules or a written quote — do not invent fares or promises outside CONTEXT.

Uncertainty (required behaviour):
- If after using CONTEXT you still cannot answer safely, or the user needs a human decision, add **one final line** containing exactly: [[UNCERTAIN]] (nothing else on that line). Put your best partial guidance **above** that line. The app will then show demo care instructions; do not invent a different phone number in the body — policy snippet for contact lists the demo number.

Formatting (mandatory):
- **Voice:** Write **only** what the traveller should read — concise, second person (“you/your”) where natural. Do **not** include planning, meta lines (“The user is asking…”, “I need to…”, “Let me check…”), numbered “Step 1/2/3” workflows, or raw field–value dumps copied from BOOKING_CONTEXT. Put recommendations in plain sentences or short bullets.
- All fares and totals in BOOKING_CONTEXT are **Indian Rupees (INR)**. Write them as **₹12,280**, **INR 12,280**, or **Rs. 12,280**. Do **not** use **$** or USD for those numbers.
- Use plain text or markdown only: for routes use **→** or the word **to** (e.g. DEL → BKK). Do **not** use LaTeX (no $\\rightarrow$, no $...$ math wrappers).
- Do **not** start lines with Markdown heading syntax (#, ##, ###). In chat, that renders as huge titles. Use normal paragraphs; use **bold** sparingly for emphasis only.`;

  const usedChunks = chunks.map((c) => c.id);
  const lm = lmStudioConfig();
  const hasGemini = Boolean(geminiApiKey());
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (!hasGemini && !hasOpenAi && !lm) {
    return {
      answer: mockAnswer(userMessage, chunks, bookingContext),
      model: "mock",
      usedChunks,
    };
  }

  if (hasGemini) {
    try {
      const answer = await geminiGenerate(userMessage, combinedContext, system);
      const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
      return { answer: normalizeCopilotAnswer(answer), model: `google:${model}`, usedChunks };
    } catch (geminiErr) {
      if (lm) {
        try {
          const answer = await chatCompletionsOpenAIFormat(userMessage, combinedContext, system, lm);
          return { answer: normalizeCopilotAnswer(answer), model: `lm-studio:${lm.model}`, usedChunks };
        } catch {
          /* try OpenAI then mock */
        }
      }
      if (hasOpenAi) {
        try {
          const answer = await openaiCompatibleChat(userMessage, combinedContext, system);
          const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
          return { answer: normalizeCopilotAnswer(answer), model: `openai:${model} (after-gemini-fail)`, usedChunks };
        } catch {
          /* fall through */
        }
      }
      if (isGeminiQuotaError(geminiErr)) {
        const noteParts = [
          "Note: Gemini hit a quota/rate limit (HTTP 429).",
          lm ? "LM Studio was configured but unreachable — check that the server is running and `LM_STUDIO_BASE_URL` matches LM Studio’s **Local Server** URL." : "",
          "This answer uses local grounded fallback text.",
        ].filter(Boolean);
        return {
          answer: [mockAnswer(userMessage, chunks, bookingContext), "", noteParts.join(" ")].join("\n"),
          model: "mock (gemini-quota-fallback)",
          usedChunks,
        };
      }
      throw geminiErr;
    }
  }

  if (lm) {
    const answer = await chatCompletionsOpenAIFormat(userMessage, combinedContext, system, lm);
    return { answer: normalizeCopilotAnswer(answer), model: `lm-studio:${lm.model}`, usedChunks };
  }

  const answer = await openaiCompatibleChat(userMessage, combinedContext, system);
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  return { answer: normalizeCopilotAnswer(answer), model: `openai:${model}`, usedChunks };
}
