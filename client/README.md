# Catch Typing client

## Run

```sh
npm install
npm run dev
```

The client connects to `ws://<current-host>:8080` by default. Copy `.env.example` to `.env` and set `VITE_WS_URL` when the game server lives elsewhere.

`npm run build` creates the production bundle in `dist/`.
