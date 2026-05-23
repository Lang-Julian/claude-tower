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

apply(read(KEY) === "cards" ? "cards" : "town");

btnTown.addEventListener("click", () => apply("town"));
btnCards.addEventListener("click", () => apply("cards"));

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.key === "v") apply(body.dataset.view === "town" ? "cards" : "town");
});
