/**
 * SmartCyl MQTT Relay Server
 * ---------------------------------------------------------
 * Purpose: Sits in the cloud, subscribes to the MQTT feed that the
 * ESP32 already publishes to (directly or via ThingSpeak), and
 * re-serves that data over:
 *   - REST:      GET /api/status   (latest reading)
 *                GET /api/history  (recent buffer)
 *   - WebSocket: ws://<host>/ws    (live push on every new reading)
 *
 * The ESP32 NEVER accepts inbound connections. It only publishes
 * outbound to the broker, same as it already does for ThingSpeak.
 * This relay is what makes the dashboard reachable from anywhere
 * without port forwarding, DDNS, or exposing your home network.
 * ---------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const mqtt = require('mqtt');
const { WebSocketServer } = require('ws');
const path = require('path');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'smartcyl/sensors';
const HISTORY_BUFFER_SIZE = parseInt(process.env.HISTORY_BUFFER_SIZE || '200', 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

// How long an alert stays visible on the dashboard after the last time
// the ESP32 reported it as true — this is now the single place that
// controls display duration. Change this value (no firmware re-flash
// needed) to tune how long an alert banner lingers.
const ALERT_HOLD_MS = parseInt(process.env.ALERT_HOLD_MS || '15000', 10);

if (!MQTT_BROKER_URL) {
  console.error('[FATAL] MQTT_BROKER_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ---------- In-memory state ----------
// Last known reading, kept in memory (no DB needed for a final-year project scale).
let latestReading = {
  gas: null,
  flame: null,
  weight: null,
  alert: false,
  gasAlert: false,
  flameAlert: false,
  timestamp: null,
};

// Rolling buffer of recent readings for the /api/history endpoint / graphs.
const history = [];

// Server-side alert hold — the moment (epoch ms) until which each alert
// should still read as "true" on the dashboard, regardless of what the
// most recent raw reading says. Set fresh every time a true alert is
// received; a background tick (below) expires it and pushes an update
// once the hold window passes with no further true readings.
let gasAlertUntil = 0;
let flameAlertUntil = 0;

function pushHistory(reading) {
  history.push(reading);
  if (history.length > HISTORY_BUFFER_SIZE) {
    history.shift();
  }
}

// ---------- Express app ----------
const app = express();
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mqttConnected: mqttClient.connected,
    uptimeSeconds: process.uptime(),
  });
});

app.get('/api/status', (req, res) => {
  res.json(latestReading);
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || HISTORY_BUFFER_SIZE, 10), HISTORY_BUFFER_SIZE);
  res.json(history.slice(-limit));
});

const server = http.createServer(app);

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(reading) {
  const payload = JSON.stringify({ type: 'reading', data: reading });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] client connected, total clients:', wss.clients.size);
  // Send the latest known reading immediately so the dashboard isn't blank
  // while waiting for the next MQTT publish.
  ws.send(JSON.stringify({ type: 'reading', data: latestReading }));

  ws.on('close', () => {
    console.log('[WS] client disconnected, total clients:', wss.clients.size);
  });
});

// ---------- MQTT client ----------
const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  reconnectPeriod: 5000, // auto-retry every 5s if the connection drops
});

mqttClient.on('connect', () => {
  console.log('[MQTT] connected to', MQTT_BROKER_URL);
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.error('[MQTT] subscribe failed:', err.message);
    } else {
      console.log('[MQTT] subscribed to', MQTT_TOPIC);
    }
  });
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] reconnecting...');
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] error:', err.message);
});

/**
 * Parses an incoming MQTT payload into a normalized reading.
 * Handles two payload styles:
 *
 * 1. JSON, if you're publishing straight from the ESP32 to your own
 *    broker (recommended), e.g.:
 *    { "gas": 2950, "flame": 1, "weight": 12.4, "alert": false }
 *
 * 2. ThingSpeak field=value style, if relaying from ThingSpeak's
 *    MQTT broker, e.g. topic "channels/123/subscribe/fields/field1"
 *    with payload "2950"
 */
function parsePayload(topic, payloadBuffer) {
  const raw = payloadBuffer.toString();

  // Try JSON first (own-broker case)
  try {
    const parsed = JSON.parse(raw);
    return {
      gas: parsed.gas ?? latestReading.gas,
      flame: parsed.flame ?? latestReading.flame,
      weight: parsed.weight ?? latestReading.weight,
      alert: parsed.alert ?? latestReading.alert,
      gasAlert: parsed.gasAlert ?? latestReading.gasAlert,
      flameAlert: parsed.flameAlert ?? latestReading.flameAlert,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    // Not JSON — fall through to ThingSpeak field-topic parsing
  }

  // ThingSpeak style: topic ends in fields/field1, field2, field3, field4
  const fieldMatch = topic.match(/fields\/field(\d)/);
  if (fieldMatch) {
    const fieldNum = fieldMatch[1];
    const value = parseFloat(raw);
    const updated = { ...latestReading, timestamp: new Date().toISOString() };
    // Adjust this mapping to match your actual ThingSpeak field order
    if (fieldNum === '1') updated.gas = value;
    if (fieldNum === '2') updated.flame = value;
    if (fieldNum === '3') updated.weight = value;
    if (fieldNum === '4') updated.alert = value === 1;
    return updated;
  }

  // Unknown format — return unchanged with a fresh timestamp
  return { ...latestReading, timestamp: new Date().toISOString() };
}

mqttClient.on('message', (topic, payloadBuffer) => {
  const parsed = parsePayload(topic, payloadBuffer);
  const now = Date.now();

  // A true alert (from the firmware's raw instantaneous state) extends
  // the hold window. This is the ONLY place display duration is decided —
  // one message getting through is enough to guarantee the full hold,
  // regardless of what the ESP32 manages to send afterward.
  if (parsed.gasAlert) gasAlertUntil = now + ALERT_HOLD_MS;
  if (parsed.flameAlert) flameAlertUntil = now + ALERT_HOLD_MS;

  const reading = {
    ...parsed,
    gasAlert: parsed.gasAlert || now < gasAlertUntil,
    flameAlert: parsed.flameAlert || now < flameAlertUntil,
  };
  reading.alert = reading.gasAlert || reading.flameAlert;

  latestReading = reading;
  pushHistory(reading);
  broadcast(reading);
  console.log('[MQTT] message on', topic, '->', reading);
});

// Expire the alert hold even when no new MQTT message arrives — without
// this, a held alert would just stay "true" forever once its window
// passes, since nothing would ever tell connected dashboards it cleared.
setInterval(() => {
  const now = Date.now();
  const gasStillHeld = now < gasAlertUntil;
  const flameStillHeld = now < flameAlertUntil;

  const shouldClearGas = latestReading.gasAlert && !gasStillHeld;
  const shouldClearFlame = latestReading.flameAlert && !flameStillHeld;

  if (shouldClearGas || shouldClearFlame) {
    latestReading = {
      ...latestReading,
      gasAlert: gasStillHeld,
      flameAlert: flameStillHeld,
      alert: gasStillHeld || flameStillHeld,
      timestamp: new Date().toISOString(),
    };
    pushHistory(latestReading);
    broadcast(latestReading);
    console.log('[HOLD] alert window expired ->', latestReading);
  }
}, 1000);

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`[HTTP] SmartCyl relay listening on port ${PORT}`);
  console.log(`  REST:      GET /api/status , GET /api/history`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
});
