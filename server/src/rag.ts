import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICIES_DIR = path.join(__dirname, "..", "policies");

export interface PolicyChunk {
  id: string;
  source: string;
  text: string;
}

let cache: PolicyChunk[] | null = null;

/** Broaden recall for common traveller phrases (lexical RAG MVP). */
function expandQueryForRetrieval(query: string): string {
  const q = query.trim();
  let extra = "";
  const add = (s: string) => {
    extra += ` ${s}`;
  };
  if (/refund|cancel|void|money back|rebook|reschedul/i.test(q)) add("refund cancellation changes saver flex statutory");
  if (/baggage|luggage|suitcase|check.?in bag|cabin bag|lost bag|damage/i.test(q))
    add("baggage checked cabin excess airport counter lost damaged");
  if (/meal|food|veg|non.?veg|special meal/i.test(q)) add("meals pre-booked airport purchase cutoff");
  if (/seat|legroom|window|aisle|upgrade/i.test(q)) add("seat selection preferred legroom upgrade");
  if (/insurance|carbon|offset|wifi|lounge/i.test(q)) add("insurance value add-ons carbon offset");
  if (/check.?in|boarding pass|counter|airport|arrive|late|delay/i.test(q))
    add("web check-in airport reporting cutoff disruption");
  if (/infant|child|minor|wheelchair|assistance|pet|group|name|spell/i.test(q))
    add("infant child accessibility special assistance group booking name correction");
  if (/pay|payment|declined|card|upi|failed|charge/i.test(q)) add("payment declined itinerary confirmation");
  if (/human|agent|call|phone|executive|care|helpline|complaint|grievance|chat id|pdf/i.test(q))
    add("customer care toll-free grievance chat transcript phone contact");
  if (/travel agent|\bota\b|third party|elsewhere|cheaper than|quoted lower|direct booking|commission/i.test(q))
    add("customer care direct channel manage booking cross-sell ancillary");
  if (/cheap|save|budget|lowest|fare|saver|flex|compare/i.test(q)) add("fare types saver flex changes refundable");
  return `${q}${extra}`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function loadPolicies(): PolicyChunk[] {
  if (cache) return cache;
  const chunks: PolicyChunk[] = [];
  if (!fs.existsSync(POLICIES_DIR)) {
    cache = [];
    return cache;
  }
  const files = fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const full = path.join(POLICIES_DIR, file);
    const text = fs.readFileSync(full, "utf8");
    const parts = text.split(/\n##+\s+/);
    parts.forEach((part, i) => {
      const trimmed = part.trim();
      if (!trimmed) return;
      chunks.push({
        id: `${file}#${i}`,
        source: file,
        text: trimmed,
      });
    });
  }
  cache = chunks;
  return chunks;
}

function retrievalTopK(): number {
  const n = Number(process.env.RAG_TOP_K || "6");
  if (!Number.isFinite(n)) return 6;
  return Math.min(10, Math.max(4, Math.floor(n)));
}

/**
 * Simple lexical overlap scorer — swap for embeddings + pgvector in production.
 */
export function retrievePolicyChunks(query: string, topK = retrievalTopK()): PolicyChunk[] {
  const chunks = loadPolicies();
  const expanded = expandQueryForRetrieval(query);
  const qTokens = new Set(tokenize(expanded));
  const k = Math.min(topK, chunks.length) || topK;
  if (qTokens.size === 0) return chunks.slice(0, k);

  const scored = chunks.map((c) => {
    const ct = tokenize(c.text);
    let overlap = 0;
    for (const t of ct) {
      if (qTokens.has(t)) overlap += 1;
    }
    const norm = overlap / Math.sqrt(ct.length + 1);
    return { c, score: norm };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.c);
}

export function listPolicyFiles(): string[] {
  if (!fs.existsSync(POLICIES_DIR)) return [];
  return fs
    .readdirSync(POLICIES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

export function readPolicyFile(file: string): string | null {
  if (!/^[a-z0-9._-]+\.md$/i.test(file)) return null;
  const full = path.join(POLICIES_DIR, file);
  if (!full.startsWith(POLICIES_DIR)) return null;
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}
