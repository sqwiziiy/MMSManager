# MMSManager

MMSManager (Mentality Minecraft Server Manager) is a local-first management UI. The project includes **real read-only metrics for the Linux computer running the app** and stores those readings locally. Minecraft servers, players, mods, worlds, backups and server performance remain explicitly labeled **DEMO**; the app does not connect to or change them.

## Run locally

Requirements: Node.js 22.13 or newer and pnpm 10 or newer.

```sh
pnpm install
pnpm dev
```

The frontend is available at `http://127.0.0.1:5173` and the read-only API at `http://127.0.0.1:4174/api/v1/health`. Both bind to loopback only. Keep the browser on the `127.0.0.1` frontend URL so API requests use Vite's local proxy.

If those ports are already occupied, choose available loopback ports for both services before starting:

```sh
MMSMANAGER_WEB_PORT=5183 MMSMANAGER_API_PORT=4183 pnpm dev
```

## Local data

The SQLite database is created outside this repository at `${XDG_STATE_HOME:-$HOME/.local/state}/mmsmanager/mmsmanager.sqlite`. Override the directory with `MMSMANAGER_DATA_DIR` (use a dedicated private directory). The app sets restrictive directory/database permissions, enables SQLite WAL mode, and applies versioned Drizzle migrations on startup.

Dates use `MMSMANAGER_TIME_ZONE`, which defaults to the host's configured timezone. Set a valid IANA zone such as `Europe/Paris` before the first run if you want a fixed calendar timezone. Keep it stable while collecting history. Raw samples are retained for 7 days, minute rollups for 90 days, and daily rollups are retained until a cleanup policy is configured.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
