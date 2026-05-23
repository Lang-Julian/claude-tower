// Shared SSE store. Both card view (app.js) and town view (pixel.js)
// subscribe here — single connection, single state, no duplicate fetches.

const subscribers = new Set();
let lastSnapshot = null;
let connState = "connecting"; // connecting | live | offline

const onState = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  if (lastSnapshot) {
    try { fn(lastSnapshot); } catch (e) { console.warn("subscriber", e); }
  }
  return () => subscribers.delete(fn);
}

export function onConn(fn) {
  onState.add(fn);
  fn(connState);
  return () => onState.delete(fn);
}

function setConn(s) {
  connState = s;
  for (const fn of onState) {
    try { fn(s); } catch (e) { console.warn("conn-sub", e); }
  }
}

let backoff = 1000;
function connect() {
  let es;
  try { es = new EventSource("/api/events"); }
  catch (e) { console.warn("EventSource ctor failed", e); setConn("offline"); scheduleReconnect(); return; }

  es.onopen = () => { setConn("live"); backoff = 1000; };
  es.onerror = () => {
    setConn("offline");
    try { es.close(); } catch {}
    scheduleReconnect();
  };
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type !== "snapshot") return;
      lastSnapshot = data;
      for (const fn of subscribers) {
        try { fn(data); } catch (e) { console.warn("subscriber error", e); }
      }
    } catch (e) { console.warn("bad SSE payload", e); }
  };
}

function scheduleReconnect() {
  setTimeout(() => { backoff = Math.min(backoff * 2, 15000); connect(); }, backoff);
}

connect();

export function getLastSnapshot() { return lastSnapshot; }
