// View toggle: switches body[data-view] between "town" and "cards".

import { read, write } from "/storage.js";

const KEY = "view";
const body = document.body;
const btnTown = document.getElementById("viewTown");
const btnCards = document.getElementById("viewCards");

function apply(view) {
  body.dataset.view = view;
  btnTown.setAttribute("aria-pressed", view === "town" ? "true" : "false");
  btnCards.setAttribute("aria-pressed", view === "cards" ? "true" : "false");
  write(KEY, view);
  window.dispatchEvent(new CustomEvent(`view:${view}`));
}

// Narrow viewport (e.g. iPhone over LAN with --mobile): the town view
// scales sprite art poorly under ~600px. Auto-switch to cards. We don't
// persist this — once the window grows again, the user's saved choice wins.
const NARROW_MQ = window.matchMedia("(max-width: 600px)");
const stored = read(KEY) === "cards" ? "cards" : "town";
const initial = NARROW_MQ.matches ? "cards" : stored;
apply(initial);
// On narrow viewports, swallow attempts to set "town" so the manual toggle
// also routes to cards. Save the user's intent without persisting.
NARROW_MQ.addEventListener?.("change", (e) => {
  if (e.matches && body.dataset.view === "town") apply("cards");
});

btnTown.addEventListener("click", () => apply("town"));
btnCards.addEventListener("click", () => apply("cards"));

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.key === "v") apply(body.dataset.view === "town" ? "cards" : "town");
});
