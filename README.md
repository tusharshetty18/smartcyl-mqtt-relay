# SmartCyl MQTT Relay Server

A small Node.js server that gives your SmartCyl dashboard **full remote access**
without port forwarding, DDNS, or exposing your ESP32's web server to the
internet.

## How it fits into your architecture

```
[ESP32] --publishes--> [MQTT Broker] --subscribes--> [This Relay] --serves--> [Dashboard, anywhere]
```

The ESP32 only ever makes **outbound** connections (same as it already does
for ThingSpeak). This relay sits in the cloud, subscribes to that same feed,
and re-serves it as:

- `GET /api/status` — latest sensor reading (JSON)
- `GET /api/history?limit=N` — recent readings buffer
- `GET /health` — uptime + MQTT connection status
- `ws://<host>/ws` — live push on every new reading
- `/` — a minimal test dashboard (`public/index.html`) to confirm the pipeline works

## Two ways to feed it MQTT data

**Option A — Relay from ThingSpeak's MQTT broker (uses what you already have)**
Set in `.env`:
```
MQTT_BROKER_URL=mqtts://mqtt3.thingspeak.com:8883
MQTT_USERNAME=<ThingSpeak MQTT Client ID>
MQTT_PASSWORD=<ThingSpeak MQTT API Key>
MQTT_TOPIC=channels/<CHANNEL_ID>/subscribe/fields/+
```
Get these from your ThingSpeak account under **Devices → MQTT**.

**Option B — Relay from your own broker (ESP32 publishes directly, cuts out ThingSpeak as middleman for live data)**
Use a free broker like [HiveMQ Cloud](https://www.hivemq.com/mqtt-cloud-broker/) and have your ESP32's
`PubSubClient` publish JSON like:
```json
{ "gas": 2950, "flame": 0, "weight": 14.2, "alert": false }
```
to a topic (e.g. `smartcyl/sensors`), then set:
```
MQTT_BROKER_URL=mqtts://<your-hivemq-host>:8883
MQTT_USERNAME=<broker username>
MQTT_PASSWORD=<broker password>
MQTT_TOPIC=smartcyl/sensors
```
This is the cleaner long-term option — Option A depends on ThingSpeak's MQTT bridge staying up.

## Local setup

```bash
npm install
cp .env.example .env
# edit .env with your broker details
npm start
```
Visit `http://localhost:3000` to see the test dashboard update live.

## Deploying so it's reachable from anywhere

Any free-tier Node host works. Recommended, in order of ease:

1. **Render** (render.com) — connect your GitHub repo, set env vars in the
   dashboard, free tier sleeps after inactivity but wakes on request.
2. **Railway** (railway.app) — similar flow, usage-based free credits.
3. **Fly.io** — more setup (a `fly.toml`), but faster cold starts.

Steps (Render, as example):
1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect the repo
3. Build command: `npm install` · Start command: `npm start`
4. Add the same variables from `.env.example` under Render's Environment tab
5. Deploy — you get a public URL like `https://smartcyl-relay.onrender.com`

Your dashboard (hosted anywhere — even a static GitHub Pages site) then
points its WebSocket/fetch calls at that public URL instead of the ESP32's
local IP, and it works from anywhere with no router config.

## Wiring into your existing 4-page dashboard

Replace any local ESP32 fetch/WebSocket calls in your frontend JS with the
relay's public URL, e.g.:

```js
// before (local-only):
const ws = new WebSocket('ws://192.168.1.105/ws');

// after (works from anywhere):
const ws = new WebSocket('wss://smartcyl-relay.onrender.com/ws');
```

Same pattern for the history page: fetch `https://smartcyl-relay.onrender.com/api/history`
instead of calling the ESP32 or ThingSpeak's API directly.

## Notes for your report / viva

- This relay pattern (device publishes out, cloud service relays in) is the
  same approach used by commercial IoT platforms (AWS IoT Core, Azure IoT Hub)
  — you're implementing a simplified version of it.
- No inbound ports are ever opened on your home network, which is the
  security-relevant point worth mentioning if asked about attack surface.
- `HISTORY_BUFFER_SIZE` keeps things in memory only — fine for a demo/project
  scale; a production version would persist to a database.
