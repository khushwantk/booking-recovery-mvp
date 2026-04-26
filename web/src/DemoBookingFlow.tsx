import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getExperimentVariant } from "./experiment";
import { RecoveryCopilot } from "./RecoveryCopilot";
import { sendBookingEvent } from "./telemetry";
import type { JourneyStage } from "./telemetry";
import { useIdleMs } from "./useIdleMs";

const SESSION_KEY = "booking_session_id";

function getOrCreateSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing && existing.length >= 8) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, id);
  return id;
}

const STAGES: JourneyStage[] = ["search", "select", "details", "payment", "complete"];

function isStage(s: string | null): s is JourneyStage {
  return s != null && (STAGES as readonly string[]).includes(s);
}

type FlightId = "AI101" | "AI205" | "AI303" | "AI417" | "AI522";
type MealChoice = "standard" | "premium" | "none";
type SeatChoice = "standard" | "legroom";
type BaggageChoice = "cabin" | "checked23";
/** Metro used for “city → departure airport” transfer estimates; aligned with selected Source airport. */
type HomeMetro = "Delhi" | "Mumbai" | "Kolkata" | "Bengaluru" | "Hyderabad" | "Bangkok";
type AirportCode = "DEL" | "BOM" | "CCU" | "BLR" | "HYD" | "BKK";

function homeMetroFromSourceAirport(src: AirportCode): HomeMetro {
  switch (src) {
    case "DEL":
      return "Delhi";
    case "BOM":
      return "Mumbai";
    case "CCU":
      return "Kolkata";
    case "BLR":
      return "Bengaluru";
    case "HYD":
      return "Hyderabad";
    case "BKK":
      return "Bangkok";
  }
}

const FLIGHTS: Record<
  FlightId,
  {
    code: string;
    from: AirportCode;
    to: AirportCode;
    dep: string;
    arr: string;
    duration: string;
    fare: "Saver" | "Flex";
    base: number;
    tag: string;
  }
> = {
  AI101: {
    code: "AI 101",
    from: "DEL",
    to: "BLR",
    dep: "07:10",
    arr: "09:50",
    duration: "2h 40m",
    fare: "Saver",
    base: 5400,
    tag: "Direct · Budget friendly",
  },
  AI205: {
    code: "AI 205",
    from: "BOM",
    to: "BLR",
    dep: "11:20",
    arr: "13:00",
    duration: "1h 40m",
    fare: "Flex",
    base: 6200,
    tag: "Flex fare · Meal included",
  },
  AI303: {
    code: "AI 303",
    from: "CCU",
    to: "BLR",
    dep: "09:45",
    arr: "12:30",
    duration: "2h 45m",
    fare: "Saver",
    base: 5800,
    tag: "Direct · Good value",
  },
  AI417: {
    code: "AI 417",
    from: "DEL",
    to: "BKK",
    dep: "22:30",
    arr: "04:40",
    duration: "4h 40m",
    fare: "Saver",
    base: 9200,
    tag: "International · Red-eye",
  },
  AI522: {
    code: "AI 522",
    from: "BOM",
    to: "BKK",
    dep: "06:55",
    arr: "12:35",
    duration: "4h 10m",
    fare: "Flex",
    base: 10100,
    tag: "International · Flex",
  },
};

const AIRPORTS: { code: AirportCode; city: string }[] = [
  { code: "DEL", city: "Delhi" },
  { code: "BOM", city: "Mumbai" },
  { code: "CCU", city: "Kolkata" },
  { code: "BLR", city: "Bengaluru" },
  { code: "HYD", city: "Hyderabad" },
  { code: "BKK", city: "Bangkok" },
];

function airportLabel(code: AirportCode): string {
  const m = AIRPORTS.find((a) => a.code === code);
  return m ? `${m.city} (${m.code})` : code;
}

type RouteFlight = {
  id: string;
  code: string;
  from: AirportCode;
  to: AirportCode;
  dep: string;
  arr: string;
  duration: string;
  fare: "Saver" | "Flex";
  base: number;
  tag: string;
};

const PRESET_ROUTE_FLIGHTS: RouteFlight[] = (Object.keys(FLIGHTS) as FlightId[]).map((id) => ({ id, ...FLIGHTS[id] }));

function routeSeed(src: AirportCode, dst: AirportCode): number {
  return `${src}-${dst}`.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
}

function generatedFlightsForRoute(src: AirportCode, dst: AirportCode): RouteFlight[] {
  const seed = routeSeed(src, dst);
  const isIntl = src === "BKK" || dst === "BKK";
  const base0 = isIntl ? 8800 : 3900;
  const delta = isIntl ? 1800 : 1200;
  const durationBase = isIntl ? 210 : 95;
  const d1 = durationBase + (seed % 70);
  const d2 = d1 + 25 + (seed % 35);
  const h1 = Math.floor(d1 / 60);
  const m1 = d1 % 60;
  const h2 = Math.floor(d2 / 60);
  const m2 = d2 % 60;
  const depHourA = 6 + (seed % 8);
  const depHourB = 13 + (seed % 6);

  return [
    {
      id: `GEN-${src}${dst}-S`,
      code: `AI ${400 + (seed % 80)}`,
      from: src,
      to: dst,
      dep: `${String(depHourA).padStart(2, "0")}:${String((seed * 3) % 60).padStart(2, "0")}`,
      arr: `${String((depHourA + Math.floor(d1 / 60)) % 24).padStart(2, "0")}:${String((seed * 3 + m1) % 60).padStart(2, "0")}`,
      duration: `${h1}h ${String(m1).padStart(2, "0")}m`,
      fare: "Saver",
      base: base0 + (seed % 900),
      tag: isIntl ? "International · Budget" : "Domestic · Budget",
    },
    {
      id: `GEN-${src}${dst}-F`,
      code: `AI ${500 + (seed % 70)}`,
      from: src,
      to: dst,
      dep: `${String(depHourB).padStart(2, "0")}:${String((seed * 5) % 60).padStart(2, "0")}`,
      arr: `${String((depHourB + Math.floor(d2 / 60)) % 24).padStart(2, "0")}:${String((seed * 5 + m2) % 60).padStart(2, "0")}`,
      duration: `${h2}h ${String(m2).padStart(2, "0")}m`,
      fare: "Flex",
      base: base0 + delta + (seed % 1200),
      tag: isIntl ? "International · Flex" : "Domestic · Flex",
    },
  ];
}

function allFlightsForRoute(src: AirportCode, dst: AirportCode): RouteFlight[] {
  const preset = PRESET_ROUTE_FLIGHTS.filter((f) => f.from === src && f.to === dst);
  return preset.length > 0 ? preset : generatedFlightsForRoute(src, dst);
}

function formatInr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export function DemoBookingFlow() {
  const [params] = useSearchParams();
  const variant = useMemo(() => getExperimentVariant(), []);
  const sessionId = useMemo(() => getOrCreateSessionId(), []);
  const idleMs = useIdleMs();
  const idleRef = useRef(idleMs);
  idleRef.current = idleMs;

  const [stage, setStage] = useState<JourneyStage>("search");
  const [hint, setHint] = useState<string>("");
  const [metrics, setMetrics] = useState<string>("");
  /** Bumped to auto-open Recovery Copilot (idle / server risk / resume link). */
  const [assistOpenNonce, setAssistOpenNonce] = useState(0);
  /** Avoid re-firing auto-open on every poll while abandonment stays true. */
  const riskAutoOpenedRef = useRef(false);
  const lastResumeParamRef = useRef<string | null>(null);

  const [trip, setTrip] = useState<"oneway" | "round">("oneway");
  const [sourceAirport, setSourceAirport] = useState<AirportCode>("DEL");
  const [destinationAirport, setDestinationAirport] = useState<AirportCode>("BLR");
  const [departDate, setDepartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [passengers, setPassengers] = useState(1);

  const [flightId, setFlightId] = useState<string | null>(null);
  const [passengerName, setPassengerName] = useState("Priya Sharma");
  const [meal, setMeal] = useState<MealChoice>("standard");
  const [seat, setSeat] = useState<SeatChoice>("standard");
  const [baggage, setBaggage] = useState<BaggageChoice>("cabin");
  const [insurance, setInsurance] = useState(false);
  const [carbonOffset, setCarbonOffset] = useState(false);

  /** Latest server abandonment signal (for payment ancillary nudge, etc.). */
  const [abandonmentSignal, setAbandonmentSignal] = useState<string | null>(null);
  /** Count of add-on changes while on details (sent with telemetry for mid-funnel scoring). */
  const [addOnChangeCount, setAddOnChangeCount] = useState(0);
  const [stepBackCount, setStepBackCount] = useState(0);
  const [itineraryEmail, setItineraryEmail] = useState("");
  const [itinerarySending, setItinerarySending] = useState(false);
  const detailsAddonInitRef = useRef(false);

  useEffect(() => {
    const r = params.get("resume");
    if (!isStage(r)) return;
    setStage(r);
    const key = `${r}:${params.toString()}`;
    if (variant === "copilot" && lastResumeParamRef.current !== key) {
      lastResumeParamRef.current = key;
      setAssistOpenNonce((n) => n + 1);
    }
  }, [params, variant]);

  const homeMetro = useMemo(() => homeMetroFromSourceAirport(sourceAirport), [sourceAirport]);

  const transferToAirportByHome: Record<HomeMetro, Record<AirportCode, number>> = {
    Delhi: { DEL: 500, BOM: 4200, CCU: 3000, BLR: 3800, HYD: 3400, BKK: 11800 },
    Mumbai: { DEL: 4300, BOM: 450, CCU: 3600, BLR: 2500, HYD: 2200, BKK: 10900 },
    Kolkata: { DEL: 3200, BOM: 3800, CCU: 400, BLR: 2800, HYD: 2600, BKK: 9700 },
    Bengaluru: { DEL: 3900, BOM: 2600, CCU: 2900, BLR: 480, HYD: 620, BKK: 11100 },
    Hyderabad: { DEL: 3500, BOM: 2300, CCU: 2700, BLR: 580, HYD: 360, BKK: 10800 },
    Bangkok: { DEL: 12800, BOM: 12100, CCU: 11900, BLR: 10400, HYD: 10250, BKK: 460 },
  };
  const routeFlights = useMemo(() => {
    return allFlightsForRoute(sourceAirport, destinationAirport);
  }, [sourceAirport, destinationAirport]);
  const flight = routeFlights.find((f) => f.id === flightId) || null;
  const marketFlightsToDestination = useMemo(
    () =>
      AIRPORTS.filter((a) => a.code !== destinationAirport)
        .flatMap((a) => allFlightsForRoute(a.code, destinationAirport))
        .map((f) => ({
          id: f.id,
          code: f.code,
          from: f.from,
          to: f.to,
          fare: f.fare,
          base: f.base,
          dep: f.dep,
          arr: f.arr,
          airportTransferFromHome: transferToAirportByHome[homeMetro][f.from],
          totalEffectiveCostPerPax: f.base + transferToAirportByHome[homeMetro][f.from],
        })),
    [destinationAirport, homeMetro]
  );

  /** After first paint on details, count subsequent meal/seat/baggage/extras changes for abandonment. */
  useEffect(() => {
    if (stage !== "details") {
      detailsAddonInitRef.current = false;
      return;
    }
    if (!detailsAddonInitRef.current) {
      detailsAddonInitRef.current = true;
      return;
    }
    setAddOnChangeCount((c) => c + 1);
  }, [meal, seat, baggage, insurance, carbonOffset, stage]);

  useEffect(() => {
    if (sourceAirport === destinationAirport) {
      const fallback = AIRPORTS.find((a) => a.code !== sourceAirport)?.code ?? "BLR";
      setDestinationAirport(fallback);
    }
  }, [sourceAirport, destinationAirport]);

  useEffect(() => {
    if (flightId && !routeFlights.some((f) => f.id === flightId)) {
      setFlightId(null);
    }
  }, [flightId, routeFlights]);

  const pricing = useMemo(() => {
    if (!flight) {
      return { subtotal: 0, lines: [] as { label: string; amount: number }[] };
    }
    const lines: { label: string; amount: number }[] = [];
    const pax = passengers;

    lines.push({
      label: `${flight.code} (${flight.fare}) × ${pax} passenger(s)`,
      amount: flight.base * pax,
    });

    let mealTotal = 0;
    if (meal === "standard") {
      const per =
        flight.fare === "Flex"
          ? 0
          : 450;
      mealTotal = per * pax;
      lines.push({
        label:
          flight.fare === "Flex"
            ? "Standard veg meal (included on Flex)"
            : "Standard veg meal add-on",
        amount: mealTotal,
      });
    } else if (meal === "premium") {
      mealTotal = 650 * pax;
      lines.push({ label: "Premium combo meal", amount: mealTotal });
    } else {
      lines.push({ label: "No meal selected", amount: 0 });
    }

    if (seat === "legroom") {
      lines.push({ label: "Extra legroom seat × " + pax, amount: 800 * pax });
    }

    if (baggage === "checked23") {
      lines.push({ label: "Checked baggage 23 kg (1 bag)", amount: 1200 });
    }

    if (insurance) {
      lines.push({ label: "Travel insurance", amount: 249 });
    }

    if (carbonOffset) {
      lines.push({ label: "Carbon offset", amount: 99 });
    }

    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    return { subtotal, lines };
  }, [flight, passengers, meal, seat, baggage, insurance, carbonOffset]);

  const taxes = useMemo(() => Math.round(pricing.subtotal * 0.05), [pricing.subtotal]);
  const grandTotal = pricing.subtotal + taxes;

  const eventPayload = useMemo(
    () => ({
      trip,
      homeCity: homeMetro,
      sourceAirport,
      destinationAirport,
      departDate,
      passengers,
      flightId,
      flightFare: flight?.fare,
      meal,
      seat,
      baggage,
      insurance,
      carbonOffset,
      grandTotal,
    }),
    [
      trip,
      homeMetro,
      sourceAirport,
      destinationAirport,
      departDate,
      passengers,
      flightId,
      flight?.fare,
      meal,
      seat,
      baggage,
      insurance,
      carbonOffset,
      grandTotal,
    ],
  );

  const copilotContext = useMemo(
    () => ({
      currency: "INR",
      stage,
      route: `${sourceAirport}-${destinationAirport}`,
      homeCity: homeMetro,
      passengers,
      selected: {
        flightId,
        meal,
        seat,
        baggage,
        insurance,
        carbonOffset,
      },
      /** Line items for this itinerary — authoritative for “recalculate” / downgrade questions. */
      pricingLines: pricing.lines.map((l) => ({ label: l.label, amountInr: l.amount })),
      /** Static demo fare rules (matches this UI). Copilot must use these for hypothetical totals. */
      demoPricingRules: {
        mealStandardPerPaxInr: 450,
        mealPremiumPerPaxInr: 650,
        mealIncludedOnFlex: true,
        seatStandardExtraInr: 0,
        seatLegroomPerPaxInr: 800,
        checkedBag23kgOneBagInr: 1200,
        travelInsuranceInr: 249,
        carbonOffsetInr: 99,
        taxesApproxRate: 0.05,
        /** Same formula as the React UI: integer tax, then add — avoids LLM “5% without round” drift. */
        taxesFormula:
          "After you sum line items into `subtotalInr`, demo tax is `Math.round(subtotalInr * 0.05)` (half-up to integer INR), then `grandTotalInr = subtotalInr + taxInr`.",
        note:
          "Standard seat has no extra charge. Only `legroom` adds per-pax seat fee. Standard meal is ₹0 on Flex fare.",
      },
      /**
       * Same three numbers as the details “Estimated total” strip and payment “Total” row (all passengers, not per pax).
       * Copilot must treat these as source of truth for “what do I pay now?” — do not recompute from pricingLines.
       */
      checkoutSubtotalInr: pricing.subtotal,
      checkoutTaxesInr: taxes,
      checkoutGrandTotalInr: grandTotal,
      totals: {
        subtotal: pricing.subtotal,
        taxes,
        grandTotal,
      },
      availableFlights: routeFlights.map((f) => ({
        id: f.id,
        code: f.code,
        from: f.from,
        to: f.to,
        fare: f.fare,
        base: f.base,
        dep: f.dep,
        arr: f.arr,
        airportTransferFromHome: transferToAirportByHome[homeMetro][f.from],
        totalEffectiveCostPerPax: f.base + transferToAirportByHome[homeMetro][f.from],
      })),
      marketFlightsToDestination,
      homeCityToAirportCostEstimate: transferToAirportByHome[homeMetro],
    }),
    [
      stage,
      sourceAirport,
      destinationAirport,
      homeMetro,
      passengers,
      flightId,
      meal,
      seat,
      baggage,
      insurance,
      carbonOffset,
      pricing.lines,
      pricing.subtotal,
      taxes,
      grandTotal,
      routeFlights,
      marketFlightsToDestination,
    ],
  );

  const emitStage = useCallback(
    async (s: JourneyStage) => {
      try {
        const r = await sendBookingEvent(variant, sessionId, s, {
          idleMs: idleRef.current,
          payload: { ...eventPayload, funnelStage: s, addOnChangeCount, stepBackCount },
        });
        const a = r.abandonment;
        setAbandonmentSignal(a?.signal ?? null);
        if (a?.suggestAssist) {
          const where =
            a.signal === "details_hesitation"
              ? "add-ons / traveller step"
              : a.signal === "payment_hesitation"
                ? "payment"
                : "this step";
          setHint(
            `High drop-off risk (${a.signal}, score ${a.score}) on ${where}. Recovery Copilot opens automatically — or use a resume link inside it.`,
          );
          if (variant === "copilot" && !riskAutoOpenedRef.current) {
            riskAutoOpenedRef.current = true;
            setAssistOpenNonce((n) => n + 1);
          }
        } else {
          setHint("");
          riskAutoOpenedRef.current = false;
        }
      } catch {
        setHint("Could not reach API — start the server (default port 3040) or check the Vite proxy target.");
      }
    },
    [variant, sessionId, eventPayload, addOnChangeCount, stepBackCount],
  );

  useEffect(() => {
    void emitStage(stage);
  }, [emitStage, stage]);

  useEffect(() => {
    if (stage !== "payment") return;
    const id = window.setInterval(() => {
      void emitStage("payment");
    }, 5_000);
    return () => window.clearInterval(id);
  }, [emitStage, stage]);

  useEffect(() => {
    if (stage !== "details") return;
    const id = window.setInterval(() => {
      void emitStage("details");
    }, 5_000);
    return () => window.clearInterval(id);
  }, [emitStage, stage]);

  /** Re-score abandonment as soon as idle crosses payment threshold (don’t wait for interval). */
  const prevIdlePaymentRef = useRef(0);
  useEffect(() => {
    if (stage !== "payment") {
      prevIdlePaymentRef.current = idleMs;
      return;
    }
    const idleAlertMs = 10_000;
    const crossed = prevIdlePaymentRef.current < idleAlertMs && idleMs >= idleAlertMs;
    prevIdlePaymentRef.current = idleMs;
    if (crossed) void emitStage("payment");
  }, [stage, idleMs, emitStage]);

  const prevIdleDetailsRef = useRef(0);
  useEffect(() => {
    if (stage !== "details") {
      prevIdleDetailsRef.current = idleMs;
      return;
    }
    const idleAlertMs = 10_000;
    const crossed = prevIdleDetailsRef.current < idleAlertMs && idleMs >= idleAlertMs;
    prevIdleDetailsRef.current = idleMs;
    if (crossed) void emitStage("details");
  }, [stage, idleMs, emitStage]);

  const canAdvance = (): boolean => {
    if (stage === "select") return flightId != null && routeFlights.length > 0;
    if (stage === "details") return passengerName.trim().length >= 2;
    return stage !== "complete";
  };

  const advance = () => {
    if (!canAdvance()) return;
    const idx = STAGES.indexOf(stage);
    if (idx < STAGES.length - 1) setStage(STAGES[idx + 1]!);
  };

  const back = () => {
    const idx = STAGES.indexOf(stage);
    if (idx > 0) {
      setStepBackCount((c) => c + 1);
      setStage(STAGES[idx - 1]!);
    }
  };

  const buildItinerarySummary = useCallback(() => {
    const lines = [
      `Route: ${sourceAirport} → ${destinationAirport} · ${departDate}`,
      `Passenger: ${passengerName} · ${passengers} pax`,
      flight ? `Flight: ${flight.code} (${flight.fare})` : "",
      `Meal: ${meal} · Seat: ${seat} · Baggage: ${baggage}`,
      `Insurance: ${insurance} · Carbon offset: ${carbonOffset}`,
      `Total (demo): ${formatInr(grandTotal)}`,
    ];
    return lines.filter(Boolean).join("\n");
  }, [
    sourceAirport,
    destinationAirport,
    departDate,
    passengerName,
    passengers,
    flight,
    meal,
    seat,
    baggage,
    insurance,
    carbonOffset,
    grandTotal,
  ]);

  const sendItineraryEmail = useCallback(async () => {
    const to = itineraryEmail.trim();
    if (!to) {
      window.alert("Enter an email address to receive the itinerary stub.");
      return;
    }
    setItinerarySending(true);
    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          channel: "email",
          to,
          intent: "itinerary_summary",
          itinerarySummary: buildItinerarySummary(),
        }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || "notify failed");
      window.alert(data.message || "Queued (stub). Check server logs.");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to queue email");
    } finally {
      setItinerarySending(false);
    }
  }, [buildItinerarySummary, itineraryEmail, sessionId]);

  const loadMetrics = async () => {
    const res = await fetch("/api/metrics/summary");
    const j = (await res.json()) as object;
    setMetrics(JSON.stringify(j, null, 2));
  };

  return (
    <div className="layout">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.35rem" }}>Book a flight (demo)</h1>
        {/* <span className="badge">Variant: {variant}</span> */}
      </div>

      {/* <details className="card nav-guide" style={{ marginBottom: "1rem" }}>
        <summary>How to use this demo</summary>
        <div className="ai-role-callout">
          <strong>What the AI is for</strong>
          <p>
            Rules + telemetry spot users who may abandon; the <strong>Recovery Copilot</strong> uses{" "}
            <strong>RAG + Gemini</strong> to answer <em>only from airline policy snippets</em> (baggage, refunds,
            seats, meals) so travellers get agent-like reassurance without leaving the site. It can also issue{" "}
            <strong>resume links</strong> and (stub) <strong>email reminders</strong>—the parts that actually recover
            the booking. The flight UI itself stays classic forms; AI is the safety net at hesitation moments.
          </p>
        </div>
        <ol style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem", color: "#475569", fontSize: "0.9rem" }}>
          <li>
            Go through <strong>search → flights → add-ons → payment → done</strong>. Pick a flight card, then meal /
            seat / baggage / extras.
          </li>
          <li>
            On <strong>add-ons / traveller</strong> or <strong>payment</strong>, stay still ~10s (or toggle several
            add-ons): the API flags <strong>abandonment</strong>, the yellow banner appears, and (with{" "}
            <code>?exp=copilot</code>) <strong>Recovery Copilot opens by itself</strong>.
          </li>
          <li>
            Opening a <strong>resume</strong> link also auto-opens the copilot to welcome the user back.
          </li>
          <li>
            Full UI map: see <code>docs/UI_NAVIGATION.md</code> in the repo.
          </li>
        </ol>
      </details> */}

      {/* <p style={{ marginTop: 0, color: "#475569" }}>
        Interactive choices send telemetry to <code>POST /api/events</code> with your selections and idle time.
      </p> */}

      <div className="steps">
        {STAGES.map((s) => (
          <span
            key={s}
            className={`step ${s === stage ? "active" : ""} ${STAGES.indexOf(s) < STAGES.indexOf(stage) ? "done" : ""}`}
          >
            {s}
          </span>
        ))}
      </div>

      {hint && (
        <div className="card banner-risk">
          {hint}
        </div>
      )}

      <div className="card">
        {stage === "search" && (
          <section className="flow-section">
            <h2 className="flow-heading">Where are you flying?</h2>
            <p className="muted">Generic flight search with source and destination selection</p>
            <div className="chip-row">
              <button
                type="button"
                className={trip === "oneway" ? "chip chip-active" : "chip"}
                onClick={() => setTrip("oneway")}
              >
                One-way
              </button>
              <button
                type="button"
                className={trip === "round" ? "chip chip-active" : "chip"}
                onClick={() => setTrip("round")}
              >
                Round trip
              </button>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Source</span>
                <select value={sourceAirport} onChange={(e) => setSourceAirport(e.target.value as AirportCode)}>
                  {AIRPORTS.map((a) => (
                    <option key={a.code} value={a.code}>
                      {airportLabel(a.code)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Destination</span>
                <select
                  value={destinationAirport}
                  onChange={(e) => setDestinationAirport(e.target.value as AirportCode)}
                >
                  {AIRPORTS.filter((a) => a.code !== sourceAirport).map((a) => (
                    <option key={a.code} value={a.code}>
                      {airportLabel(a.code)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Departure</span>
                <input type="date" value={departDate} onChange={(e) => setDepartDate(e.target.value)} />
              </label>
              <label className="field">
                <span>Passengers</span>
                <select value={passengers} onChange={(e) => setPassengers(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted small">Round-trip return date is not wired in this MVP — pricing stays one-way.</p>
          </section>
        )}

        {stage === "select" && (
          <section className="flow-section">
            <h2 className="flow-heading">Choose your flight</h2>
            <p className="muted">Tap a card. Saver vs Flex mirrors typical airline upsell.</p>
            <div className="flight-grid">
              {routeFlights.map((f) => {
                const sel = flightId === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    className={`flight-card ${sel ? "flight-card-selected" : ""}`}
                    onClick={() => setFlightId(f.id)}
                  >
                    <div className="flight-card-top">
                      <span className="fare-pill">{f.fare}</span>
                      <span className="flight-tag">{f.tag}</span>
                    </div>
                    <div className="flight-code">{f.code}</div>
                    <div className="flight-times">
                      <span>
                        <strong>{f.dep}</strong> {f.from}
                      </span>
                      <span className="flight-dash">{f.duration}</span>
                      <span>
                        <strong>{f.arr}</strong> {f.to}
                      </span>
                    </div>
                    <div className="flight-price">from {formatInr(f.base)} / person</div>
                    <div className="muted small" style={{ marginTop: "0.2rem" }}>
                      + {formatInr(transferToAirportByHome[homeMetro][f.from])} approx city-to-airport travel from{" "}
                      {homeMetro}
                    </div>
                    {sel && <div className="flight-picked">Selected</div>}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {stage === "details" && (
          <section className="flow-section">
            <h2 className="flow-heading">Traveller & add-ons</h2>
            {flight && (
              <p className="muted">
                {flight.code} · {flight.fare} · {departDate}
              </p>
            )}
            <label className="field full">
              <span>Passenger name (as on ID)</span>
              <input
                value={passengerName}
                onChange={(e) => setPassengerName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                autoComplete="name"
              />
            </label>

            <h3 className="subheading">Meal</h3>
            <div className="option-cards">
              <label className={`option-card ${meal === "standard" ? "option-card-on" : ""}`}>
                <input type="radio" name="meal" checked={meal === "standard"} onChange={() => setMeal("standard")} />
                <span className="option-title">Standard veg meal</span>
                <span className="option-desc">
                  {flight?.fare === "Flex" ? "Included on Flex" : "+ " + formatInr(450) + " / person"}
                </span>
              </label>
              <label className={`option-card ${meal === "premium" ? "option-card-on" : ""}`}>
                <input type="radio" name="meal" checked={meal === "premium"} onChange={() => setMeal("premium")} />
                <span className="option-title">Premium combo</span>
                <span className="option-desc">Non-veg or chef special · + {formatInr(650)} / person</span>
              </label>
              <label className={`option-card ${meal === "none" ? "option-card-on" : ""}`}>
                <input type="radio" name="meal" checked={meal === "none"} onChange={() => setMeal("none")} />
                <span className="option-title">No meal</span>
                <span className="option-desc">I’ll eat before the flight · ₹0</span>
              </label>
            </div>

            <h3 className="subheading">Seat</h3>
            <div className="option-cards two">
              <label className={`option-card ${seat === "standard" ? "option-card-on" : ""}`}>
                <input type="radio" name="seat" checked={seat === "standard"} onChange={() => setSeat("standard")} />
                <span className="option-title">Standard</span>
                <span className="option-desc">Included</span>
              </label>
              <label className={`option-card ${seat === "legroom" ? "option-card-on" : ""}`}>
                <input type="radio" name="seat" checked={seat === "legroom"} onChange={() => setSeat("legroom")} />
                <span className="option-title">Extra legroom</span>
                <span className="option-desc">+ {formatInr(800)} / person</span>
              </label>
            </div>

            <h3 className="subheading">Baggage</h3>
            <div className="option-cards two">
              <label className={`option-card ${baggage === "cabin" ? "option-card-on" : ""}`}>
                <input
                  type="radio"
                  name="bag"
                  checked={baggage === "cabin"}
                  onChange={() => setBaggage("cabin")}
                />
                <span className="option-title">Cabin only</span>
                <span className="option-desc">7 kg carry-on per rules</span>
              </label>
              <label className={`option-card ${baggage === "checked23" ? "option-card-on" : ""}`}>
                <input
                  type="radio"
                  name="bag"
                  checked={baggage === "checked23"}
                  onChange={() => setBaggage("checked23")}
                />
                <span className="option-title">+ 23 kg checked</span>
                <span className="option-desc">+ {formatInr(1200)} one bag</span>
              </label>
            </div>

            <h3 className="subheading">Extras</h3>
            <label className="toggle-row">
              <input type="checkbox" checked={insurance} onChange={(e) => setInsurance(e.target.checked)} />
              <span>
                <strong>Travel insurance</strong> — trip cancellation & medical (demo) · + {formatInr(249)}
              </span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={carbonOffset} onChange={(e) => setCarbonOffset(e.target.checked)} />
              <span>
                <strong>Carbon offset</strong> — contribute to climate projects · + {formatInr(99)}
              </span>
            </label>

            <div className="live-total">
              <span>Estimated total</span>
              <strong>{formatInr(grandTotal)}</strong>
              <span className="muted small">incl. ~5% demo taxes</span>
            </div>
          </section>
        )}

        {stage === "payment" && (
          <section className="flow-section">
            <h2 className="flow-heading">Review & pay</h2>
            <div className="payment-trust-banner">
              <strong>Demo checkout</strong> — no card is charged. Tap <strong>Pay now (demo)</strong> once to confirm;
              you can still use <strong>Recovery Copilot</strong> for policy questions or a resume link if you need to
              step away.
            </div>
            <p className="muted">
              {passengerName} · {passengers} pax · {flight?.code}
            </p>
            {abandonmentSignal === "payment_hesitation" && (
              <div className="ancillary-nudge" role="note">
                <strong>Still deciding on add-ons?</strong> Meal, seat, and baggage choices often stay changeable via
                manage-booking for a window after purchase (see policy in Copilot). Skipping extras now can lower your
                total — you can add some services later subject to fare rules.
              </div>
            )}
            <div className="summary-table">
              {pricing.lines.map((row, i) => (
                <div key={i} className="summary-row">
                  <span>{row.label}</span>
                  <span>{formatInr(row.amount)}</span>
                </div>
              ))}
              <div className="summary-row muted">
                <span>Taxes & fees (demo)</span>
                <span>{formatInr(taxes)}</span>
              </div>
              <div className="summary-row summary-total">
                <span>Total</span>
                <span>{formatInr(grandTotal)}</span>
              </div>
            </div>
            <div className="payment-email-row">
              <label className="field full" style={{ marginBottom: 0 }}>
                <span>Email itinerary summary (stub — logs on server)</span>
                <input
                  type="email"
                  value={itineraryEmail}
                  onChange={(e) => setItineraryEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={itinerarySending}
                onClick={() => void sendItineraryEmail()}
              >
                {itinerarySending ? "Sending…" : "Email summary"}
              </button>
            </div>
            <p className="muted small">
              Stay idle on this screen ~10s to simulate hesitation and test abandonment + Copilot auto-open (copilot
              variant).
            </p>
          </section>
        )}

        {stage === "complete" && (
          <section className="flow-section">
            <div className="success-banner">Booking confirmed (demo)</div>
            <p>
              PNR <strong>XB7MQ2</strong> — a confirmation email would be sent in production.
            </p>
            <ul className="recap-list">
              <li>
                <strong>Flight</strong> — {flight?.code} ({flight?.fare}) on {departDate}
              </li>
              <li>
                <strong>Meal</strong> —{" "}
                {meal === "standard" ? "Standard veg" : meal === "premium" ? "Premium combo" : "No meal"}
              </li>
              <li>
                <strong>Seat</strong> — {seat === "legroom" ? "Extra legroom" : "Standard"}
              </li>
              <li>
                <strong>Baggage</strong> — {baggage === "checked23" ? "Cabin + 23 kg checked" : "Cabin only"}
              </li>
              <li>
                <strong>Extras</strong> —{" "}
                {[insurance ? "Insurance" : null, carbonOffset ? "Carbon offset" : null].filter(Boolean).join(", ") ||
                  "None"}
              </li>
              <li>
                <strong>Paid (simulated)</strong> — {formatInr(grandTotal)}
              </li>
            </ul>
          </section>
        )}

        <div className="row footer-actions">
          <button type="button" onClick={back} disabled={stage === "search"}>
            Back
          </button>
          <button
            type="button"
            className="primary"
            onClick={advance}
            disabled={stage === "complete" || !canAdvance()}
          >
            {stage === "search"
              ? "Continue to flights"
              : stage === "select"
                ? "Continue to add-ons"
                : stage === "payment"
                  ? "Pay now (demo)"
                  : stage === "complete"
                    ? "Done"
                    : "Next"}
          </button>
          {/* <button type="button" onClick={() => void loadMetrics()}>
            Refresh metrics JSON
          </button> */}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Session: <code>{sessionId}</code> · Idle: {Math.round(idleMs / 1000)}s
        </p>
      </div>

      {metrics && (
        <div className="card">
          <strong>/api/metrics/summary</strong>
          <pre className="metrics-pre">{metrics}</pre>
        </div>
      )}

      <RecoveryCopilot
        variant={variant}
        sessionId={sessionId}
        stage={stage}
        enabled={variant === "copilot"}
        assistOpenNonce={assistOpenNonce}
        bookingContext={copilotContext}
      />
    </div>
  );
}
