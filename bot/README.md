# Local voice bot: SmallWebRTC

The PDF allows SmallWebRTC or Daily. We use **SmallWebRTC**, so no Daily account,
API key, credit card, or paid transport room is required. Pipecat and aiortc exchange
audio directly between the browser and local Python process.

Required in bot/.env:
- DEEPGRAM_API_KEY
- GROQ_API_KEY
- CARTESIA_API_KEY
- CARTESIA_VOICE_ID
- DEMO_ACCESS_CODE (already generated locally)
- CALLS_INGEST_TOKEN (synchronized from the Worker by configure:bot)
- CALLS_API_BASE_URL (configured to reach the Worker from the bot)

Model defaults: DEEPGRAM_MODEL=nova-3, GROQ_MODEL=openai/gpt-oss-20b,
CARTESIA_MODEL=sonic-3.6. This phase supports contextual voice conversation.
See ../docs/PHASE_2.md for voice/credit controls and ../docs/PHASE_4.md for current
startup, automatic saving, retry and recovery. Start the Worker before testing saves.
Run npm run configure:bot --workspace=@vaami/api from the root to set up local uploads.

From PowerShell in the repository root:

```powershell
wsl -d Ubuntu --cd /mnt/c/Dev/vaami_ai/bot -- .venv/bin/uv sync --locked
wsl -d Ubuntu --cd /mnt/c/Dev/vaami_ai/bot -- .venv/bin/python check_runtime.py
wsl -d Ubuntu --cd /mnt/c/Dev/vaami_ai/bot -- .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 7860
```

Start the frontend separately with npm run dev:web and open http://127.0.0.1:5173.
Enter the demo access code, start a call, allow microphone access, and listen.
Restart the bot after changing .env.

On a fresh Ubuntu install, create .venv with python3 -m venv .venv, install
uv==0.12.19 using .venv/bin/python -m pip install, then run uv sync --locked.
Never run the Linux .venv through Windows Python.

Control endpoints:
- GET /health: readiness names only.
- POST /sessions: authenticated with the demo code; reserves one session.
- POST /sessions/:id/offer: authenticated SDP offer/answer exchange.
- PATCH /sessions/:id/offer: authenticated ICE candidate updates.
- GET /sessions/:id: session status, temporary transcript, metrics, and reserved usage.
- POST /sessions/:id/end: release the peer and bot.

Session routes use a random control token returned at creation. Credentials are
HTTP authorization headers, never query parameters. The server allows one call,
expires sessions that never send an offer, and stops calls after two minutes by default, or 30 seconds of user inactivity.
The greeting is generated after the browser readiness handshake. Later speech
requires a user turn. Deepgram may connect during pipeline startup before readiness.

For deployment, HTTPS signaling through Cloudflare Tunnel does not relay media.
Our default ICE configuration is local-only (no external servers). Across networks,
STUN and possibly TURN are needed; test the actual demo network early. WSL's
network adapter/firewall can also affect Windows-browser-to-WSL media connectivity.
An audible browser call and the deployed Pages path remain separate acceptance
checks. Local signaling tests do not prove those routes work.

To troubleshoot: 401 means wrong demo code; 503 means missing settings; 502 means
failed WebRTC negotiation; 429 means the run budget is exhausted. If setup succeeds but audio does not connect, investigate
ICE/network routing. A bot failure after connection may indicate provider credentials, model access, or quota.
Tests use fake providers; the real local WebRTC handshake test consumes no speech
credits.


Use one bot process/worker, without --reload. The default 600-second reservation
budget permits five 120-second call attempts, including abandoned attempts.
A process restart resets this in-memory budget: review provider usage first.
Do not run an automatic restart loop. All limits are listed in .env.example.

Connected calls now save after cleanup, using one frozen payload and bounded retries.
A failed save stays in process memory; retry it before restarting. On browser refresh,
re-enter the demo code and use Recover unfinished save. A process crash/restart can
lose unsaved work. The frontend declares saved only after Worker read-back matches.

## Phase 6 deployment

See the root README for GitHub Actions, production D1/Worker configuration and
HTTPS tunneling. `node scripts/configure-production.mjs <worker-url> <pages-url>`
(run from the repository root) updates bot/.env for production while preserving
keys. Restart only after finishing/recovering pending calls. STUN_SERVER_URL is
optional; production setup selects stun:stun.cloudflare.com:3478. STUN does not
relay media or guarantee connectivity across restrictive networks. The default
empty value keeps local-only ICE. TURN remains unconfigured.
