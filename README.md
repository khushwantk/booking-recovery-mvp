# AI Booking Recovery MVP

## Run the project

```bash
cd booking-recovery-mvp
npm install
```

Edit **`server/.env`**: set **`GEMINI_API_KEY`** or **`GOOGLE_API_KEY`** (Google AI Studio) for cloud answers. 
Optional: **LM Studio** (`LM_STUDIO_ENABLED=1`, `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`) or **OpenAI**-compatible fallback — see `server/.env`.

```bash
npm run dev
```

**Open the app:** http://localhost:5174

**A/B experiment (sticky in the browser):** The **first visit** on a browser defaults to **copilot** (Recovery Copilot enabled). Open **http://localhost:5174?exp=control** once to lock the **control** variant (no copilot API), or **?exp=copilot** to force copilot again. That stores **`experiment_variant`** in **`localStorage`**, so later visits on the same browser keep that assignment until you change the query param or clear site data.

**Production build (optional):**

```bash
npm run build
npm start
```

## Architecture & hand-in detail

Detailed **architecture**, **RAG / LLM flow**, **abandonment & copilot triggers**, **resume links**, **MVP → production** notes, and **Mermaid diagrams** are in **[SUBMISSION.md](./SUBMISSION.md)**.

---

## Screenshots


| Screenshot | Description |
|------------|-------------|
| ![Copilot response to Hi](Screenshots/Copilot%20response%20to%20Hi.png) | Copilot greeting / first reply |
| ![Flex vs Saver](Screenshots/Fex%20vs%20Saver.png) | Flex vs Saver style comparison (filename as saved) |
| ![low cost add on](Screenshots/low%20cost%20add%20on%20response.png) | Lower-cost add-on suggestions |
| ![Cheapest total](Screenshots/Cheapest%20total%20for%20my%20current%20selection%20and%20lower%20it.png) | Cheapest total / how to lower cost |
| ![X lower price](Screenshots/X%20is%20showing%20lower%20price.png) | OTA / cheaper elsewhere handling |
| ![customer care](Screenshots/I%20want%20to%20speak%20to%20customer%20care.png) | Customer care / escalation context |
| ![Policy link](Screenshots/Policy%20link.png) | Policy citation / source link |
| ![Resume later](Screenshots/REsume%20later.png) | Resume link flow (filename as saved) |
| ![LM Studio fallback](Screenshots/LM%20Studio%20Fallback%20Model.png) | LM Studio fallback model |
| ![Extra baggage](Screenshots/Extra%20baggage%20and%20misc%20question.png) | Extra baggage / misc question |
| ![Flight delay](Screenshots/Flight%20delay%20response.png) | Flight delay style response |
| ![Misc handling](Screenshots/Misc%20Question%20Handling.png) | Misc question handling |


## Architecture

```mermaid
flowchart LR
  subgraph browser [Browser]
    F[Demo booking funnel]
    C[Recovery Copilot]
  end
  subgraph api [Node API :3040]
    E["/api/events"]
    A[Abandonment scorer]
    Ch["/api/chat"]
    RAG[Policy RAG]
    LLM[LLM router]
    RT["/api/resume/token"]
    RV["/api/resume/verify"]
    M["/api/metrics/summary"]
  end
  P[(Policy .md files)]
  F -->|stage + idle| E
  E --> A
  A -->|suggestAssist| F
  C -->|message + bookingContext| Ch
  Ch --> RAG
  RAG --> P
  Ch --> LLM
  F --> RT
  C --> RT
  RT -->|JWT URL| C
  C --> RV
```


```mermaid
flowchart TD
  subgraph providers [LLM providers]
    G[Gemini API - Google AI Studio]
    LM[LM Studio - OpenAI-compatible]
    OAI[OpenAI-compatible cloud]
    M[Mock heuristics - no API keys]
  end
  Chat[POST /api/chat] --> RAG[RAG: policy chunks]
  RAG --> TryG{Gemini key?}
  TryG -->|yes| G
  G -->|ok| Out[Answer + citations]
  G -->|429 or error| TryLM{LM Studio enabled?}
  TryG -->|no key| TryLM
  TryLM -->|yes| LM
  TryLM -->|no| TryOAI{OPENAI_API_KEY?}
  LM --> Out
  LM -->|fail| TryOAI
  TryOAI -->|yes| OAI
  TryOAI -->|no| M
  OAI --> Out
  M --> Out
```


```mermaid
sequenceDiagram
  participant U as Browser
  participant API as Node API
  participant W as Web /resume
  U->>API: POST /api/resume/token { sessionId, stage }
  API->>U: { url, token, expiresInMinutes }
  U->>W: Open /resume?token=JWT
  W->>API: GET /api/resume/verify?token=
  API->>W: { sessionId, stage, variant }
  W->>U: Redirect to booking flow ?resume=stage
```