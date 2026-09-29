# Vaami Mini Call Log Service

A browser voice agent with saved transcripts and latency samples. Built with React,
Cloudflare Pages, Workers, D1 and a local Pipecat bot.

- Frontend: https://vaaami-project.pages.dev
- Call API: https://vaami-call-log-api-production.mehraaditya777.workers.dev
- Deployment runs: https://github.com/gamea333/vaaami_project/actions

The bot and its HTTPS tunnel must be running to make calls. Reading saved history
only needs Pages and the Worker. Local and production D1 contain separate records.

## Architecture

```text
Browser (React / Pages)
  |-- GET /calls, /calls/:id --> Worker --> D1
  |-- authenticated HTTPS signaling --> tunnel --> local FastAPI bot
  `-- WebRTC audio <--------------------------------------> Pipecat
                                                Deepgram STT
                                                Groq LLM
                                                Cartesia TTS
                                                     |
                          finalized transcript/metrics --POST /calls--> Worker
```

D1 is the only persistent database. The local bot retains active sessions and
unfinished saves in memory. No raw audio is recorded. Uploads use a private Bearer
token; the demo code authorizes starting a call, and a separate random per-session
token protects its controls. The UI marks a call saved only after read-back verification.

## Prerequisites

Node.js 22.12+ (CI uses Node 22), Python 3.12, uv, Git, and provider accounts.
On Windows, run the bot under Ubuntu WSL2. A microphone and headphones are useful.
For deployment: Cloudflare, GitHub CLI, Wrangler (installed with npm), cloudflared.

## Local setup

1. Run `npm ci` in the repository root.
2. Copy `bot/.env.example` to `bot/.env`, `apps/api/.dev.vars.example` to
   `apps/api/.dev.vars`, and `apps/web/.env.example` to `apps/web/.env`.
3. In bot/.env enter DEEPGRAM_API_KEY, GROQ_API_KEY, CARTESIA_API_KEY,
   CARTESIA_VOICE_ID, and a private DEMO_ACCESS_CODE.
4. Generate a strong random CALLS_INGEST_TOKEN in apps/api/.dev.vars. Run
   `npm run configure:bot --workspace=@vaami/api` to synchronize it and the local
   Worker URL with the bot and frontend. On Windows this finds the WSL adapter.
5. Apply the local schema: `npm run db:migrate --workspace=@vaami/api`.
6. Install bot dependencies:

```powershell
wsl -d Ubuntu --cd /mnt/c/Dev/vaami_ai/bot -- .venv/bin/uv sync --locked
```

For a fresh checkout without an existing .venv/uv, install uv first and run
`uv sync --locked` inside the bot directory under Linux/WSL.

Run each service in a separate terminal:

```powershell
npm run dev:api
npm run dev:web
wsl -d Ubuntu --cd /mnt/c/Dev/vaami_ai/bot -- .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 7860
```

Open http://127.0.0.1:5173. Enter the demo code, optionally remember it on your own
device, start a short call, end it, wait for verified saving, then open History.
Use only one bot process, without --reload. Do not start duplicate servers on an
occupied port. Restart a service after changing its environment settings.

Optional invented local data: `npm run demo:seed --workspace=@vaami/api`.

## Configuration

| Location | Values | Visibility |
| --- | --- | --- |
| bot/.env | Provider keys, voice/model IDs, demo code, ingestion token, API URL, allowed origins, limits, optional STUN_SERVER_URL | Private local file |
| apps/api/.dev.vars | Local ingestion token and local API address | Private local file |
| Worker secret | CALLS_INGEST_TOKEN | Cloudflare secret |
| apps/web/.env | VITE_API_BASE_URL, VITE_BOT_BASE_URL, optional VITE_STUN_URL | Public build-time configuration |
| GitHub Actions secret | CLOUDFLAREAPI | Cloudflare deployment token |
| GitHub Actions variables | VITE_API_BASE_URL, VITE_BOT_BASE_URL, PAGES_URL | Public deployment URLs |

Never put private credentials in VITE variables. Optional remembered demo access
uses this browser's localStorage, scoped by frontend origin and bot URL; it is not
an encrypted vault. Use Forget saved code to clear it.

## Deployment and GitHub Actions

`.github/workflows/deploy.yml` runs on pushes to main, pull requests and manual
workflow dispatch. Checks install locked dependencies, typecheck, test the
frontend and Worker, build the frontend, and run offline bot tests. Only main
can deploy. Deployments are serialized and are not canceled mid-migration.

Deployment order: validate settings -> production D1 migrations -> Worker ->
frontend build -> Pages Direct Upload -> read-only API/D1/CORS/Pages smoke tests.
Speech providers are never called by CI. A Pages failure can leave the already
deployed Worker updated: this is an ordered workflow, not an atomic cross-service
transaction. Keep migrations backward-compatible.

The `production` environment in apps/api/wrangler.jsonc has its own D1 binding,
Worker name, Pages origin and observability. Top-level configuration is local.

One-time setup for another account:

1. Run `npx wrangler login`, create a D1 database, and update the production
   account ID and database ID in wrangler.jsonc and the workflow.
2. Create a Pages Direct Upload project; update the workflow project name and
   allowed origin if using a different name.
3. Provision the matching bot ingestion secret without committing it:
   `npx wrangler secret put CALLS_INGEST_TOKEN --env production --config apps/api/wrangler.jsonc`.
4. Add GitHub secret CLOUDFLAREAPI, scoped to the target account with Workers
   Scripts Edit, D1 Edit, Cloudflare Pages Edit, and Account Settings Read.
5. Add the three public URL variables in the table above and push to main.

To point the local bot at production:

```powershell
node scripts/configure-production.mjs https://vaami-call-log-api-production.mehraaditya777.workers.dev https://vaaami-project.pages.dev
```

This preserves provider keys and changes the call upload URL, allowed frontend
origin and STUN setting. Confirm no unfinished save before restarting the bot.
The production Worker must hold the same CALLS_INGEST_TOKEN as this bot.
The local configure:bot command switches the upload URL back to local development.

## Local bot HTTPS tunnel

Run cloudflared in a separate terminal:

```powershell
cloudflared tunnel --url http://127.0.0.1:7860 --no-autoupdate
```

If using the downloaded local executable on this machine, replace `cloudflared`
with `.\.tools\cloudflared.exe`. The generated https://...trycloudflare.com URL
is temporary. Update GitHub variable VITE_BOT_BASE_URL when it changes, then use
Actions -> Check and deploy -> Run workflow on main to rebuild Pages. Keep both
bot and tunnel running throughout the demo. A named tunnel/domain is a future
option for a stable address.

The tunnel transports HTTP signaling, not WebRTC media. Optional STUN discovers
public candidates and is enabled for the deployed demo. Restrictive NAT/firewalls
or remote networks may require TURN, which is not configured. An HTTPS health
check does not prove audible WebRTC connectivity; test on the actual demo machine.

## API and storage

- POST /calls: authenticated validated upload; same ID/content is idempotent,
  changed content returns 409.
- GET /calls?limit=20&offset=0: newest-first paginated summaries.
- GET /calls/:id: metadata, ordered transcript and captured metrics.
- GET /health: service liveness. The deployment smoke test also reads D1.

Tables: calls, transcripts, call_metrics. Parameterized queries and atomic batch
writes prevent injection and partial saves. UTC timestamps are displayed in the
viewer's local timezone. Metrics are milliseconds; missing data is Not captured.
Overlapping samples are not summed into invented end-to-end latency.

History reads are public demo endpoints. CORS is browser policy, not user
ownership/authentication. Do not use this prototype for confidential conversations.

## Observability

Cloudflare -> Workers & Pages -> vaami-call-log-api-production -> Observability.
Generate a list/detail request and inspect structured logs. Logs include request
ID, call ID where applicable, route, status and elapsed milliseconds. They omit
credentials and transcripts. X-Request-ID is returned in API responses.
CLI alternative: `npx wrangler tail --env production --config apps/api/wrangler.jsonc`.

## Tests

```powershell
npm run typecheck
npm run build
npm run test --workspace=@vaami/web
npm run test --workspace=@vaami/api
wsl -d Ubuntu --cd /mnt/c/Dev/vaami_ai/bot -- .venv/bin/python -m pytest -q
```

Tests use fake providers. `bot/smoke_persistence.py` additionally writes a clearly
labeled synthetic call to the configured Worker, intentionally loses its first
success acknowledgement and verifies an idempotent retry. It uses no speech credits.
Production smoke checks in scripts/smoke-deployment.mjs are read-only.

Local browser voice/text and saved-call history were user-confirmed. Deployment
HTTP checks and a green workflow do not replace a real live-URL microphone,
interruption, save and detail-refresh acceptance check.

## Decisions, limits and improvements

SmallWebRTC avoids a paid transport account. Groq handles text generation; Cartesia
handles speech. A local bot matches the assignment but limits availability and
network reachability. Hash routing keeps static Pages refreshes simple. A shared
demo access code and single active session keep this a bounded demo.

Defaults: 120 seconds/call, 30 seconds idle, eight LLM requests, 512 completion
tokens/reply and 1200 reserved TTS characters/call. Attempts reserve 120 seconds
from a 600-second run budget. Restarting the process resets that budget. These
limits do not measure or guarantee provider account balances.

Save retries are bounded; failed payloads remain in memory and can be recovered
from the frontend before restarting. A process crash can lose unsaved data.
Other limits: public history, temporary tunnel URL, no TURN, no raw audio archive,
SDK bundle-size warning, and optional latency availability.

Improvements: durable save outbox, per-user access control, retention/deletion,
stable bot hosting/TURN, stronger shared rate limits, and bundle splitting.

## Code map

- apps/web/src/App.tsx: navigation and live call controls.
- apps/web/src/History.tsx: list/detail loading, errors, transcript and metrics.
- apps/web/src/lib/voice.ts: signaling, audio playback, cleanup and save recovery.
- apps/api/src/index.ts: routes, auth, CORS and structured logging.
- apps/api/src/validation.ts and db.ts: contract checks and D1 queries.
- bot/server.py and session.py: session control and lifecycle.
- bot/pipeline.py and guards.py: voice pipeline and credit limits.
- bot/persistence.py and api_client.py: frozen payload, bounded retry/read-back.
- .github/workflows/deploy.yml: checks and production deployment sequence.

Personal phase notes and the assignment PDF are intentionally excluded from Git.
All instructions needed to run the submitted project are in this README and bot/README.md.
