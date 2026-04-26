import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

const SESSION_KEY = "booking_session_id";

export function ResumePage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [status, setStatus] = useState("Verifying resume link…");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setStatus("Missing token.");
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/resume/verify?token=${encodeURIComponent(token)}`);
        const data = (await res.json()) as {
          sessionId?: string;
          stage?: string;
          variant?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || "verify failed");
        if (data.sessionId) localStorage.setItem(SESSION_KEY, data.sessionId);
        if (data.variant === "control" || data.variant === "copilot") {
          localStorage.setItem("experiment_variant", data.variant);
        }
        setStatus(`Resuming at stage: ${data.stage}`);
        setTimeout(() => {
          nav(`/?resume=${encodeURIComponent(String(data.stage || "search"))}`);
        }, 600);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Invalid link");
      }
    })();
  }, [nav, params]);

  return (
    <div className="layout">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Resume booking</h1>
        <p>{status}</p>
        <Link to="/">Back to demo</Link>
      </div>
    </div>
  );
}
