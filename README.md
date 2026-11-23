# MMSManager

MMSManager is a local-first workspace for Minecraft server operators. It includes real, read-only metrics from the Linux host, persistent machine history, an authenticated local server-folder inventory, and an explicit Java version scan. Fictional server cards and sample data remain clearly marked; an imported folder remains read only and unmanaged.

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

The local server registry is stored in the same SQLite database. The app-managed root defaults to `${MMSMANAGER_DATA_DIR}/servers` (mode `0700`); set `MMSMANAGER_SERVER_ROOT` to choose another local root. `MMSMANAGER_IMPORT_ROOTS` is an optional colon-separated allowlist of existing folders. Without it, only subdirectories of the managed root may be imported. Import inspection reads immediate directory entries and bounded `server.properties`/`eula.txt` files only; it does not write to the selected server folder. Imported servers stay unmanaged.

An administrator can explicitly scan known local Java locations or check a custom executable from Machine settings. Each check calls only `java -version` with no shell, a short timeout and an output limit. A normal page read does not run Java. No Minecraft process is launched by the inventory scan.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Current boundaries

- Machine metrics and history are real, read-only measurements from this local Linux host when available. The app does not inspect other machines.
- The local server registry and Java version checks are real, local-only features. Existing folder imports do not modify files and remain unmanaged. Server runtime state, players, mods, logs, backups, worlds and performance are still `DEMO` or `Preview`.
- Server creation is still a preview wizard. Installation and lifecycle controls are not connected yet; EULA files are never written by import or preview actions.
- User creation, roles, profile, password, avatar and workspace/personal settings are backed by the local SQLite workspace. They do not control Minecraft permissions or server access.
- No Minecraft process control, RCON, SSH, remote host, LAN API or arbitrary shell endpoint is included. The API and Vite remain loopback-only.
