# MinePanel

MinePanel is a visual-first prototype for managing local Minecraft servers.

## Run locally

Requirements: Node.js 20 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

Vite prints the local URL, normally `http://localhost:5173`.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

```sh
```

The app runs as a single Vite frontend. All server, player, activity, user and machine values are seeded examples with a persistent `Demo data` label. Start-server, install, destructive, account and settings actions are preview-only or marked `Coming soon`.
