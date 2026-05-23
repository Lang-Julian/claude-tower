// Shared CLI formatting helpers. Plain ANSI, no deps.
// Colour is disabled automatically when stdout is not a TTY (pipes, files, CI).

const USE_COLOR =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

export const COLORS = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

export function color(text, code) {
  if (!USE_COLOR) return String(text);
  const c = typeof code === "number" ? code : COLORS[code] ?? 0;
  return `\x1b[${c}m${text}\x1b[0m`;
}

export const c = {
  bold: (t) => color(t, "bold"),
  dim: (t) => color(t, "dim"),
  red: (t) => color(t, "red"),
  green: (t) => color(t, "green"),
  yellow: (t) => color(t, "yellow"),
  blue: (t) => color(t, "blue"),
  magenta: (t) => color(t, "magenta"),
  cyan: (t) => color(t, "cyan"),
  gray: (t) => color(t, "gray"),
};

// Strip ANSI for width calculations.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleWidth(s) {
  return String(s).replace(ANSI_RE, "").length;
}

export function pad(s, width, align = "left") {
  const str = String(s);
  const diff = width - visibleWidth(str);
  if (diff <= 0) return str;
  const fill = " ".repeat(diff);
  return align === "right" ? fill + str : str + fill;
}

export function truncate(s, width) {
  const str = String(s ?? "");
  if (visibleWidth(str) <= width) return str;
  if (width <= 1) return "…";
  // Conservative: assume no ansi in input we truncate.
  return str.slice(0, width - 1) + "…";
}

/**
 * Render a table of rows with optional headers.
 * @param {Array<Array<string|number>>} rows
 * @param {Array<string>} headers
 * @param {{ aligns?: Array<'left'|'right'>, maxWidth?: number }} opts
 */
export function table(rows, headers = [], opts = {}) {
  const aligns = opts.aligns || [];
  if (!rows.length && !headers.length) return "";
  const cols = headers.length || rows[0].length;
  const widths = new Array(cols).fill(0);
  const all = headers.length ? [headers, ...rows] : rows;
  for (const r of all) {
    for (let i = 0; i < cols; i++) {
      const w = visibleWidth(r[i] ?? "");
      if (w > widths[i]) widths[i] = w;
    }
  }
  const lines = [];
  if (headers.length) {
    lines.push(
      headers
        .map((h, i) => c.dim(pad(h.toUpperCase(), widths[i], aligns[i])))
        .join("  "),
    );
  }
  for (const r of rows) {
    lines.push(
      r
        .map((cell, i) => pad(cell ?? "", widths[i], aligns[i]))
        .join("  "),
    );
  }
  return lines.join("\n");
}

export function humanAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function humanBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${u[i]}`;
}

export function box(text, opts = {}) {
  const lines = String(text).split("\n");
  const width = Math.max(...lines.map(visibleWidth));
  const top = "┌" + "─".repeat(width + 2) + "┐";
  const bot = "└" + "─".repeat(width + 2) + "┘";
  const body = lines
    .map((l) => "│ " + l + " ".repeat(width - visibleWidth(l)) + " │")
    .join("\n");
  return [top, body, bot].join("\n");
}

// Map session status → coloured label.
export function statusLabel(status) {
  switch (status) {
    case "thinking":         return c.cyan("thinking");
    case "needs_input":      return c.yellow("needs_input");
    case "needs_permission": return c.red("needs_perm");
    case "running":          return c.green("running");
    case "idle":             return c.dim("idle");
    case "stopped":          return c.dim("stopped");
    case "archived":         return c.dim("archived");
    default:                 return status || "—";
  }
}
