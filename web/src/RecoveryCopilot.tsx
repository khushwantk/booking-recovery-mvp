import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExperimentVariant } from "./experiment";
import type { JourneyStage } from "./telemetry";
import { sanitizeCopilotText } from "./copilotTextSanitize";

type Citation = { ref?: number; id: string; source: string };
type Msg = { role: "user" | "assistant"; text: string; citations?: Citation[] };

const API = "";
const COPILOT_WIDE_KEY = "copilot_wide_layout";

const AUTO_NUDGE =
  "You may be hesitating or out of time — ask me about baggage, refunds, seats, or your add-ons. I only answer from our policy snippets. You can also tap “Get resume link” below to finish later.";

function plainTextFromMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .trim();
}

function safePdfSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]+/g, "_").slice(0, 80) || "chat";
}

/** Helvetica / WinAnsi cannot render many Unicode glyphs reliably — substitute so lines measure and draw correctly. */
function asciiSafeForPdf(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u20b9/g, "INR ")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\u2192\u2794]/g, "->");
}

async function downloadCopilotChatPdf(msgs: Msg[], chatId: string) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  const marginBottom = 48;
  const pageH = doc.internal.pageSize.getHeight();
  const pageW = doc.internal.pageSize.getWidth();
  const maxW = pageW - margin * 2;
  let y = margin;

  const ensureRoom = (nextLineHeightPt: number) => {
    if (y + nextLineHeightPt > pageH - marginBottom) {
      doc.addPage();
      y = margin;
    }
  };

  /** Draw one line at (margin, y); advance y. Avoid passing string[] to doc.text — stacking is inconsistent across builds. */
  const drawLine = (line: string, fontSizePt: number, lineHeightPt: number, fontStyle: "normal" | "bold" | "italic") => {
    ensureRoom(lineHeightPt);
    doc.setFont("helvetica", fontStyle);
    doc.setFontSize(fontSizePt);
    doc.text(line, margin, y, { baseline: "top" });
    y += lineHeightPt;
  };

  const drawWrappedParagraph = (text: string, fontSizePt: number, lineHeightPt: number, fontStyle: "normal" | "bold" | "italic") => {
    const raw = asciiSafeForPdf(text).trim();
    if (!raw) return;
    const lines = doc.splitTextToSize(raw, maxW) as string[];
    for (const ln of lines) {
      drawLine(ln, fontSizePt, lineHeightPt, fontStyle);
    }
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  ensureRoom(14);
  doc.text("Recovery Copilot — chat export", margin, y, { baseline: "top" });
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  drawWrappedParagraph(`Chat ID: ${chatId}`, 9, 11.5, "normal");
  drawWrappedParagraph(`Generated: ${new Date().toISOString()}`, 9, 11.5, "normal");
  y += 6;

  for (const m of msgs) {
    const role = m.role === "user" ? "You" : "Assistant";
    const body = asciiSafeForPdf(plainTextFromMarkdown(sanitizeCopilotText(m.text)));

    drawLine(`${role}:`, 9, 12, "bold");

    for (const para of body.split(/\n+/)) {
      const t = para.trim();
      if (t) drawWrappedParagraph(t, 9, 11.5, "normal");
    }

    if (m.citations && m.citations.length > 0) {
      const cite = `Sources: ${m.citations.map((c) => `[${c.ref ?? "?"}] ${c.source}`).join("; ")}`;
      doc.setTextColor(80, 80, 80);
      drawWrappedParagraph(cite, 8, 10.5, "normal");
      doc.setTextColor(0, 0, 0);
    }

    y += 8;
  }

  doc.save(`recovery-copilot-${safePdfSlug(chatId)}.pdf`);
}

const QUICK_PROMPTS: { label: string; message: string }[] = [
  { label: "Cheapest total?", message: "What is the cheapest total for my current selections and how can I lower it?" },
  { label: "Refund rules?", message: "What are the refund and change rules for my current fare type?" },
  { label: "Flex vs Saver?", message: "What does Flex include compared to Saver on this booking?" },
  { label: "Baggage at counter?", message: "Can I add extra baggage at the airport counter?" },
  { label: "Save on add-ons", message: "Suggest lower-cost add-on choices for this booking." },
  {
    label: "Speak to a human?",
    message: "When should I call customer care instead of self-service, and what information should I have ready?",
  },
];

export function RecoveryCopilot(props: {
  variant: ExperimentVariant;
  sessionId: string;
  stage: JourneyStage;
  enabled: boolean;
  /** Increment when abandonment fires or user returns via resume link — panel opens. */
  assistOpenNonce: number;
  bookingContext?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState(() => `cc-${crypto.randomUUID()}`);
  const [lastUncertain, setLastUncertain] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      text: "Hi — I can explain baggage, refunds, seats, payments, and help you finish booking. What would you like to know?",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [resumeHint, setResumeHint] = useState<string | null>(null);
  const [wideLayout, setWideLayout] = useState(() => {
    try {
      return localStorage.getItem(COPILOT_WIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const lastProcessedNonce = useRef(0);

  const toggleWideLayout = useCallback(() => {
    setWideLayout((w) => {
      const next = !w;
      try {
        localStorage.setItem(COPILOT_WIDE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!props.enabled || props.assistOpenNonce === 0) return;
    if (props.assistOpenNonce === lastProcessedNonce.current) return;
    lastProcessedNonce.current = props.assistOpenNonce;
    setOpen(true);
    setMsgs((m) => {
      const already = m.some((msg) => msg.role === "assistant" && msg.text.includes("You may be hesitating"));
      if (already) return m;
      return [...m, { role: "assistant", text: AUTO_NUDGE }];
    });
  }, [props.assistOpenNonce, props.enabled]);

  const send = useCallback(
    async (forcedText?: string) => {
      const text = (forcedText ?? input).trim();
      if (!text || loading) return;
      if (!forcedText) setInput("");
      setMsgs((m) => [...m, { role: "user", text }]);
      setLoading(true);
      setLastUncertain(false);
      try {
        const res = await fetch(`${API}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Experiment-Variant": props.variant,
          },
          body: JSON.stringify({
            sessionId: props.sessionId,
            chatId,
            message: text,
            variant: props.variant,
            bookingContext: props.bookingContext,
          }),
        });
        const data = (await res.json()) as {
          answer?: string;
          error?: string;
          citations?: Citation[];
          chatId?: string;
          uncertain?: boolean;
        };
        if (!res.ok) throw new Error(data.error || "chat failed");
        if (data.chatId) setChatId(data.chatId);
        setLastUncertain(Boolean(data.uncertain));
        setMsgs((m) => [...m, { role: "assistant", text: data.answer || "", citations: data.citations || [] }]);
      } catch (e) {
        setMsgs((m) => [
          ...m,
          { role: "assistant", text: e instanceof Error ? e.message : "Something went wrong." },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [chatId, input, loading, props.bookingContext, props.sessionId, props.variant],
  );

  const createResumeLink = useCallback(async () => {
    setResumeHint(null);
    const res = await fetch(`${API}/api/resume/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Experiment-Variant": props.variant,
      },
      body: JSON.stringify({
        sessionId: props.sessionId,
        stage: props.stage,
        variant: props.variant,
      }),
    });
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok) throw new Error(data.error || "resume token failed");
    setResumeHint(data.url || null);
    return data.url as string;
  }, [props.sessionId, props.stage, props.variant]);

  const emailStub = useCallback(async () => {
    try {
      const url = resumeHint || (await createResumeLink());
      const email = window.prompt("Email for demo resume link (optional):")?.trim();
      if (!email) return;
      await fetch(`${API}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: props.sessionId,
          channel: "email",
          to: email,
          resumeUrl: url,
          intent: "resume_reminder",
          itinerarySummary: `Chat ID: ${chatId}`,
        }),
      });
      alert("Demo: notification logged on server (see README).");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    }
  }, [chatId, createResumeLink, props.sessionId, resumeHint]);

  const saveChatPdf = useCallback(() => {
    void downloadCopilotChatPdf(msgs, chatId).catch((e) =>
      alert(e instanceof Error ? e.message : "Could not create PDF"),
    );
  }, [chatId, msgs]);

  if (!props.enabled) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          className="primary copilot-launcher"
          onClick={() => setOpen(true)}
        >
          Recovery Copilot
        </button>
      )}
      {open && (
        <div
          className={`copilot${wideLayout ? " copilot--wide" : ""}`}
          role="dialog"
          aria-label="Recovery copilot"
        >
          <header>
            <div className="copilot-header-main">
              <span>Recovery Copilot</span>
              <span className="copilot-chat-id" title="Quote this Chat ID if you call customer care">
                Chat ID: {chatId}
              </span>
            </div>
            <div className="copilot-header-actions">
              <button
                type="button"
                className="copilot-layout-toggle"
                onClick={toggleWideLayout}
                aria-pressed={wideLayout}
                title={wideLayout ? "Use compact copilot panel" : "Use half-screen width for easier reading"}
              >
                {wideLayout ? "Compact" : "Half screen"}
              </button>
              <button
                type="button"
                style={{ background: "transparent", border: "none", color: "#fff" }}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </header>
          {lastUncertain && (
            <div className="copilot-uncertain-banner">
              Last reply flagged for human follow-up — save PDF and share your Chat ID with care if needed.
            </div>
          )}
          <div className="messages">
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role === "user" ? "user" : ""}`}>
                {m.role === "assistant" ? (
                  <>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        table: ({ children }) => (
                          <div className="copilot-table-scroll">
                            <table>{children}</table>
                          </div>
                        ),
                      }}
                    >
                      {sanitizeCopilotText(m.text)}
                    </ReactMarkdown>
                    {m.citations && m.citations.length > 0 && (
                      <div style={{ marginTop: "0.45rem", fontSize: "0.78rem", color: "#475569" }}>
                        Sources:{" "}
                        {m.citations.map((c, idx) => (
                          <span key={`${c.id}-${idx}`}>
                            <a
                              href={`/policies/${encodeURIComponent(c.source)}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ marginRight: "0.4rem" }}
                            >
                              [{c.ref ?? idx + 1}] {c.source}
                            </a>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  m.text
                )}
              </div>
            ))}
            {loading && <div className="msg">Thinking…</div>}
          </div>
          <div className="copilot-chips" aria-label="Suggested questions">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q.label}
                type="button"
                className="copilot-chip"
                disabled={loading}
                onClick={() => void send(q.message)}
              >
                {q.label}
              </button>
            ))}
          </div>
          <footer>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about cheapest option, baggage, refunds…"
              onKeyDown={(e) => e.key === "Enter" && void send()}
            />
            <button type="button" className="primary" disabled={loading} onClick={() => void send()}>
              Send
            </button>
          </footer>
          <div className="copilot-actions">
            <button
              type="button"
              onClick={() => void createResumeLink().catch((e) => alert(e instanceof Error ? e.message : String(e)))}
            >
              Get resume link
            </button>
            <button type="button" onClick={() => void emailStub()}>
              Email resume (stub)
            </button>
            <button type="button" className="secondary" onClick={saveChatPdf}>
              Save chat as PDF
            </button>
          </div>
          {resumeHint && (
            <div style={{ padding: "0 0.75rem 0.75rem", fontSize: "0.8rem", wordBreak: "break-all" }}>
              <strong>Resume:</strong> <a href={resumeHint}>{resumeHint}</a>
            </div>
          )}
        </div>
      )}
    </>
  );
}
