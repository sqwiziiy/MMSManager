# MMSManager

**Mentality Minecraft Server Manager** is a local-first control panel for one Linux machine. It brings host monitoring, authenticated accounts, and tools for managing Minecraft servers created or imported into its local registry together in one responsive web app.

[![CI](https://github.com/sqwiziiy/MMSManager/actions/workflows/ci.yml/badge.svg)](https://github.com/sqwiziiy/MMSManager/actions/workflows/ci.yml)

## What it includes

- Live CPU, memory, storage and network readings from the Linux host, with persisted history and a local-time calendar.
- Local accounts with Administrator and Member roles, server-scoped permissions, profiles and personal preferences.
- A server registry, ZIP import, and new Vanilla, Fabric or Paper installations from their official metadata services.
- Controls for panel-owned server processes, a bounded console and logs, managed `server.properties`, files, Fabric mods, Paper plugins, player commands and world inventory.
- Stopped-server snapshots, verified restore, scheduled backups and a downloadable ZIP of a stopped, panel-managed server.

Imported server folders stay unmanaged and read only.

## Requirements

- Linux for real host metrics and local server-folder/process management.
- Node.js 22.13 or newer and pnpm 10.23 or newer.
- A supported Java runtime for installing or running a server. MMSManager does not scan for Java during an ordinary page read; an administrator explicitly checks available runtimes.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173>. The API listens on <http://127.0.0.1:4174> and the web development server proxies local API requests. Keep both on loopback; this development mode is not for LAN or public access.

On first start, the API creates a one-time setup key and prints the private file path in the local terminal. Read the key there and enter it at `/setup` to create the first administrator. The key expires after 30 minutes and is consumed once. MMSManager creates no default account or password.

For another loopback port pair:

```sh
MMSMANAGER_WEB_PORT=5183 MMSMANAGER_API_PORT=4183 pnpm dev
```

An administrator can then create accounts and assign roles. Passwords are stored as Argon2id hashes. Sessions use HttpOnly cookies and CSRF checks; authorization is enforced by the API.

## Local data

Application state is outside the source tree, by default at `${XDG_STATE_HOME:-$HOME/.local/state}/mmsmanager`. Set `MMSMANAGER_DATA_DIR` to choose a different private state directory. The SQLite database, session data, app configuration and server backups stay in that directory. The default managed server root is `servers/` inside it; `MMSMANAGER_SERVER_ROOT` can select another local path.

The API and development web server bind to IPv4 loopback. Do not put the database, bootstrap key, app configuration, session files or backup archives in Git or in the public web root.

## Import, export and backups

Administrators can preview a server ZIP before import. The compressed upload is limited to 128 MiB and extracted content to 2 GiB. The preview checks paths and file types; importing does not execute the archive. Publishing an imported server requires an explicit Java selection, trust confirmation and EULA acceptance. Imported folders remain unmanaged.

**Download server** creates a regular ZIP from a stopped, panel-managed server. It includes server-owned worlds, player data, JARs, libraries, mods, plugins, configuration and ordinary files, including files protected from generic file editing. The ZIP preserves relative paths and binary contents and supports ZIP64. The export is limited to 100,000 entries and 256 GiB of source files. Administrators see a warning first because server properties and player data may contain passwords or personal information. MMSManager excludes its private `.mmsmanager` files, temporary upload files, nested mounts, links and special files. The SQLite database, sessions, app secrets and separately stored backup archives are outside the managed server folder and are not exported.

Administrators can create private snapshots only for stopped, panel-created servers. Each archive is capped at 20 GiB and retained snapshots share a 100 GiB budget. Restore verifies the archive and creates a safety snapshot before replacing a world. Existing archives are not automatically deleted. Review the exclusions shown in the restore preview before restoring.

## Build and run the production preview

Build the web app and API from a reviewed checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

For a same-origin HTTPS reverse-proxy preview on one Linux host, configure the service with values such as:

```text
MMSMANAGER_SERVE_WEB=true
MMSMANAGER_WEB_ORIGIN=https://panel.example.com
MMSMANAGER_COOKIE_SECURE=true
MMSMANAGER_DATA_DIR=/var/lib/mmsmanager
MMSMANAGER_API_PORT=4174
```

Then start the built API with `pnpm --filter @minepanel/api start`. It serves `apps/web/dist` and binds to `127.0.0.1:4174`. Configure a maintained TLS reverse proxy to that loopback address, preserving the original `Host` and `Origin`. Do not expose the API port or run Vite as a public web server. See [`deploy/README.md`](deploy/README.md) and [`deploy/mmsmanager.service.example`](deploy/mmsmanager.service.example) for deployment details and a reviewed service-unit example. The preview has not been deployed to a VPS or independently security-audited.

## Development checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

```sh
```

## Current limitations

MMSManager currently targets one local Linux host. It does not support remote hosts, SSH, RCON, Forge or NeoForge. The API is not intended for direct LAN or public exposure. An HTTPS proxy preview is documented, but has not been deployed or security-audited on a VPS.
