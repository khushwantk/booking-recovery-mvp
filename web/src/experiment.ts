export type ExperimentVariant = "control" | "copilot";

const STORAGE_KEY = "experiment_variant";

/**
 * Sticky assignment: URL `?exp=control|copilot` overrides once; first visit defaults to **copilot**
 * (use `?exp=control` to opt into the control bucket for A/B demos).
 */
export function getExperimentVariant(): ExperimentVariant {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("exp");
  if (fromUrl === "control" || fromUrl === "copilot") {
    localStorage.setItem(STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing === "control" || existing === "copilot") return existing;
  const v: ExperimentVariant = "copilot";
  localStorage.setItem(STORAGE_KEY, v);
  return v;
}

export function experimentHeaders(variant: ExperimentVariant): HeadersInit {
  return { "X-Experiment-Variant": variant };
}
