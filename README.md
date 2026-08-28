# The War Room

A real-time sealed-bid fantasy football auction built with Node, TypeScript, Express, and Socket.IO.

Each nomination opens one 20-second sealed-bidding window for the entire league.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The first visitor creates the commissioner PIN, manager names, and private manager PINs.

## Deploy

The included `render.yaml` can deploy this repository as a Render Blueprint. Other Node hosts such as Railway or Fly.io can use build command `npm install && npm run build` and start command `npm start`. The server listens on `PORT` automatically.

## Persistent draft state

Set `STATE_FILE=/data/league.json` and attach a persistent volume at `/data`. The app saves every nomination, bid, result, budget, roster, and tiebreak-order change atomically, so deployments and restarts do not reset the draft.
