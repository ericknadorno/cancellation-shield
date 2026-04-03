# nexo

Cancellation intelligence for hotels. Connects to Mews PMS, scores reservation cancellation risk using a 27-signal model, and recommends overbooking opportunities based on expected value.

## Architecture

Single-page dashboard (`public/index.html`) backed by a lightweight API proxy on Vercel.

- **Frontend** — All scoring, rendering, and Mews data mapping run client-side. No build step.
- **`api/mews.js`** — Stateless proxy to Mews Connector API. Injects auth tokens from env vars, enforces endpoint whitelist.
- **`api/webhook.js`** — Receives Mews `ServiceOrderUpdated` events (placeholder for future live refresh).

## Mews API Endpoints

Read: `configuration/get`, `services/getAll`, `services/getAvailability`, `rates/getAll`, `sources/getAll`, `resources/getAll`, `reservations/getAll`, `customers/getAll`, `payments/getAll`, `orderItems/getAll`, `companionships/getAll`

Write: `serviceOrderNotes/add`, `tasks/add`, `services/updateAvailability`

## Environment Variables

Set in Vercel dashboard:

| Variable | Description |
|---|---|
| `MEWS_CLIENT_TOKEN` | Mews Connector API client token |
| `MEWS_ACCESS_TOKEN` | Mews Connector API access token |
| `MEWS_API_BASE` | API base URL (defaults to demo) |
| `MEWS_CLIENT_NAME` | Client identifier (defaults to `nexo 1.0`) |

## Deploy

Push to `main` — auto-deploys via Vercel.

## The Haus Group
