# nexo

Cancellation intelligence for hotels. Connects to Mews PMS production API, scores reservation cancellation risk using a 27-signal model, and recommends overbooking opportunities based on expected value.

## Architecture

Single-page dashboard (`index.html`) backed by a stateless API proxy on Vercel.

- **Frontend** — All scoring, rendering, and Mews data mapping run client-side. No build step.
- **`api/mews.js`** — Stateless proxy to Mews Connector API. Injects auth tokens from env vars, enforces endpoint whitelist, strips protected fields from client params, includes timeout and structured logging.
- **`api/webhook.js`** — Receives Mews `ServiceOrderUpdated` events (placeholder for future live refresh).

## Mews API Endpoints

Read: `configuration/get`, `services/getAll`, `services/getAvailability`, `rates/getAll`, `sources/getAll`, `resources/getAll`, `reservations/getAll/2023-06-06`, `customers/getAll`, `payments/getAll`, `orderItems/getAll`, `companionships/getAll`

Write (mutates production data): `serviceOrderNotes/add`, `tasks/add`, `services/updateAvailability`

## Environment Variables (Vercel)

| Variable | Required | Description |
|---|---|---|
| `MEWS_CLIENT_TOKEN` | Yes | Mews Connector API client token |
| `MEWS_ACCESS_TOKEN_HQ` | Yes | Access token — HQ Portfolio property |
| `MEWS_ACCESS_TOKEN_ALEGRIA` | Yes | Access token — Alegria property |
| `MEWS_ACCESS_TOKEN_SBI` | Yes | Access token — Santa Barbara I property |
| `MEWS_ACCESS_TOKEN_SBII` | Yes | Access token — Santa Barbara II property |
| `MEWS_API_BASE` | No | API base URL (defaults to `https://api.mews.com/api/connector/v1`) |
| `MEWS_CLIENT_NAME` | No | Client identifier (defaults to `Cancellation Shield 1.0`) |
| `MEWS_ACCESS_TOKEN` | No | Legacy single-property fallback token |
| `ALLOWED_ORIGINS` | No | Comma-separated list of allowed CORS origins |

## Deploy

Push to `main` — auto-deploys via Vercel. **All writes hit production Mews.**

## Multi-Property

The system discovers configured properties via env var presence (`MEWS_ACCESS_TOKEN_*`). Each property is fetched sequentially with its own access token. Reservation data is concatenated across all properties.

## The Haus Group
