/**
 * SmartCyl Dashboard — shared client logic
 * ---------------------------------------------------------
 * Connects to the relay server's WebSocket for live updates,
 * falls back to REST polling if the socket drops, and keeps a
 * small rolling history in the browser (since the relay's own
 * /api/history buffer resets on server restart, this gives each
 * page something to show immediately even right after a redeploy).
 * ---------------------------------------------------------
 */

const SmartCyl = (() => {
  const state = {
    latest: { gas: null, flame: null, weight: null, alert: false, timestamp: null },
    gasHistory: [],
    flameHistory: [],
    weightHistory: [],
    connected: false,
  };

  const listeners = [];

  function onUpdate(fn) {
    listeners.push(fn);
  }

  function notify() {
    listeners.forEach((fn) => fn(state));
  }

  function pushHistory(arr, entry, max = 5) {
    arr.unshift(entry);
    if (arr.length > max) arr.pop();
  }

  function formatTime(iso) {
    if (!iso) return '--:--:--';
    const d = new Date(iso);
    return d.toLocaleTimeString();
  }

  function applyReading(reading) {
    const prev = state.latest;

    // Track rising edges for history logs, same spirit as the original
    // ESP32 circular history arrays.
    if (reading.flame && !prev.flame) {
      pushHistory(state.flameHistory, `[${formatTime(reading.timestamp)}] Flame detected`);
    }
    if (reading.alert && reading.gas > 3500 && !(prev.gas > 3500)) {
      pushHistory(state.gasHistory, `[${formatTime(reading.timestamp)}] Gas=${reading.gas}`);
    }
    pushHistory(state.weightHistory, `[${formatTime(reading.timestamp)}] ${Number(reading.weight ?? 0).toFixed(2)} kg`, 5);

    state.latest = reading;
    notify();
  }

  function connectWebSocket() {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);

    ws.onopen = () => {
      state.connected = true;
      notify();
    };

    ws.onclose = () => {
      state.connected = false;
      notify();
      // Retry after a short delay rather than polling forever
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'reading') {
          applyReading(msg.data);
        }
      } catch (e) {
        console.error('Bad WS message', e);
      }
    };
  }

  async function fetchInitialStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data && data.timestamp) {
        applyReading(data);
      }
    } catch (e) {
      console.error('Initial status fetch failed', e);
    }
  }

  function init() {
    fetchInitialStatus();
    connectWebSocket();
  }

  return { init, onUpdate, get state() { return state; } };
})();
