// View toggle: switches body[data-view] between "town" and "cards".
// Persists in localStorage. Default = "town".

const KEY = "claude-control-view";
const body = document.body;
const btnTown = document.getElementById("viewTown");
const btnCards = document.getElementById("viewCards");

function apply(view) {
  body.dataset.view = view;
  btnTown.setAttribute("aria-pressed", view === "town" ? "true" : "false");
  btnCards.setAttribute("aria-pressed", view === "cards" ? "true" : "false");
  try { localStorage.setItem(KEY, view); } catch {}
  window.dispatchEvent(new CustomEvent(`view:${view}`));
}

const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
apply(saved === "cards" ? "cards" : "town");

btnTown.addEventListener("click", () => apply("town"));
btnCards.addEventListener("click", () => apply("cards"));

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.key === "v") apply(body.dataset.view === "town" ? "cards" : "town");
});
