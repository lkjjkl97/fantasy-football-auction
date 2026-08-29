# The War Room

A real-time sealed-bid fantasy football auction built with Node, TypeScript, Express, and Socket.IO.

Each nomination opens one 30-second sealed-bidding window for the entire league.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The first visitor creates the commissioner PIN, manager names, and private manager PINs.

## Deploy

The included `render.yaml` can deploy this repository as a Render Blueprint. Other Node hosts such as Railway or Fly.io can use build command `npm install && npm run build` and start command `npm start`. The server listens on `PORT` automatically.

### Vercel

Import the GitHub repository with the Express framework preset. Add an Upstash Redis integration and expose either `KV_REST_API_URL` / `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. Also add a long random `SESSION_SECRET`. Leave the output directory blank. The Vercel build uses HTTP polling and Redis-backed state so every browser sees the same auction.

## Persistent draft state

Set `STATE_FILE=/data/league.json` and attach a persistent volume at `/data`. The app saves every nomination, bid, result, budget, roster, and tiebreak-order change atomically, so deployments and restarts do not reset the draft.
