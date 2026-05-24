// Single source of truth for runtime config. Reads env vars + CLI args once.

export const VERSION = "0.2.0";

// Most Claude Code users are on a Max/Pro subscription (flat fee, no per-token
// billing). For them, a dollar burn-rate is misleading. So default behavior:
// show tokens + 5h-block window. Set TOWER_SHOW_USD=1 (or pass --show-usd) for
// API-style cost display.
export const SHOW_USD = (() => {
  const env = (process.env.TOWER_SHOW_USD || "").toLowerCase();
  if (env === "1" || env === "true" || env === "yes") return true;
  return process.argv.includes("--show-usd");
})();

export const PLAN = (process.env.TOWER_PLAN || "max").toLowerCase();

export const DEFAULTS = {
  port: 7777,
  pollMs: 2000,
  // pricing in USD per 1M tokens — Anthropic public prices, March 2026.
  // Only used when SHOW_USD is on. Keep in sync with https://www.anthropic.com/pricing
  pricing: {
    "claude-opus-4-7":     { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-sonnet-4-6":   { input: 3,  output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-5":    { input: 1,  output: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
    // legacy fallbacks
    "claude-3-5-sonnet":   { input: 3,  output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-3-5-haiku":    { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
  // sessions older than this are not loaded from disk
  maxSessionAgeMs: 12 * 60 * 60 * 1000,
  // approval auto-deny timeout — null = never
  approvalTimeoutMs: null,
};

export function priceFor(model) {
  if (!model) return null;
  // Strip date suffix like "-20251001" and bracketed variant tag like "[1m]".
  // Use a non-greedy + char-class to avoid eating through the model name on
  // models that happen to contain other brackets in the future.
  const base = model.replace(/-\d{8}$/, "").replace(/\[[^\]]*\]$/, "");
  return DEFAULTS.pricing[base] || DEFAULTS.pricing[model] || null;
}
