import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type PolicyResponse = { file: string; content: string; error?: string };

export function PolicyPage() {
  const { file = "" } = useParams();
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string>("");

  const title = useMemo(() => file.replace(/\.md$/i, "").replace(/-/g, " "), [file]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setContent("");

    void (async () => {
      try {
        const res = await fetch(`/api/policies/${encodeURIComponent(file)}`);
        const data = (await res.json()) as PolicyResponse;
        if (!res.ok) {
          throw new Error(data.error || "Policy not found");
        }
        if (!active) return;
        setContent(data.content || "");
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Unable to load policy");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [file]);

  return (
    <div className="layout">
      <div className="card policy-shell">
        <div className="policy-top">
          <div>
            <div className="badge" style={{ marginBottom: "0.35rem" }}>
              Policy Reference
            </div>
            <h1 className="policy-title">{title || "Policy document"}</h1>
            <p className="muted small" style={{ margin: 0 }}>
              File: <code>{file}</code>
            </p>
          </div>
          <Link to="/" className="policy-back-link">
            Back to booking
          </Link>
        </div>

        {loading && <p className="muted">Loading policy document...</p>}
        {error && <div className="card banner-risk">Could not load policy: {error}</div>}
        {!loading && !error && (
          <article className="policy-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </article>
        )}
      </div>
    </div>
  );
}

