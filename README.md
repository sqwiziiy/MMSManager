# MMSManager

MMSManager is a local-first workspace for Minecraft server operators. The interface includes real, read-only metrics from the Linux host running the app and a persistent machine history. Server and Minecraft data remains clearly marked `DEMO`; the app does not read or change Minecraft servers or files.

## Run locally

Requirements: Node.js 22.13 or newer and pnpm 10 or newer.

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The API binds to `127.0.0.1:4174`; `/api/v1/health` exposes only the minimum setup/availability status. The API prints the bootstrap-token file path on first launch. Read that file in the local terminal and enter its one-time key at `/setup` to create the first administrator. The key expires after 30 minutes and is consumed once. No default account or password is created.

After setup, sign in with the account you created. An administrator can add local users and choose Administrator or Member roles. Profiles, settings, audit events and sessions persist in SQLite. An administrator recovery command is available from an interactive local terminal:

```sh
pnpm --filter @minepanel/api auth:recover -- <username>
```

It requires a typed confirmation and hidden password input, and revokes existing sessions for that administrator.

The web app and API listen on IPv4 loopback only. Keep the browser at the `127.0.0.1` URL so requests use Vite's local proxy. If the default ports are occupied, select another loopback pair:

```sh
MMSMANAGER_WEB_PORT=5183 MMSMANAGER_API_PORT=4183 pnpm dev
```

## Local data and security

The database lives outside the repository at `${XDG_STATE_HOME:-$HOME/.local/state}/mmsmanager/mmsmanager.sqlite`. Set `MMSMANAGER_DATA_DIR` to use a different private data directory. App-owned directories use mode `0700`; the database, bootstrap credential file and stored avatars use mode `0600`. Avatar images are validated and re-encoded as WebP outside the web root.

Passwords are stored as salted Argon2id hashes. Sessions use HttpOnly, SameSite cookies with CSRF and same-origin checks, idle and absolute expiry, server-side authorization, and rate limits. The supported development server is loopback HTTP; do not expose it to LAN or the public internet.

`MMSMANAGER_TIME_ZONE` sets the collector's IANA timezone and defaults to the host timezone. Keep it stable while collecting history. Raw telemetry samples are retained for 7 days, minute rollups for 90 days, and daily rollups remain until a cleanup policy is configured.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Current boundaries

- Machine metrics and history are real, read-only measurements from this local Linux host when available. The app does not inspect other machines.
- Minecraft servers, players, mods, logs, backups, worlds, Java inventory and server performance remain labeled `DEMO` or `Preview`.
- Server creation is a preview wizard. Console, moderation, file, install, server lifecycle and notification actions are disabled or marked `Coming soon`; no real server operation is performed.
- User creation, roles, profile, password, avatar and workspace/personal settings are backed by the local SQLite workspace. They do not control Minecraft permissions or server access.
- No Java discovery, Minecraft file/process access, RCON, SSH, remote host, LAN API, arbitrary shell endpoint or login backend outside the local workspace is included.
