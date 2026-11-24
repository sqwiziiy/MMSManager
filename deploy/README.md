# Single-host reverse-proxy deployment preview

This mode runs the web build and API on one Linux host. The browser and reverse proxy use one HTTPS origin; the MMSManager API still binds to `127.0.0.1`. This preview has fixture coverage, but it is not a production security audit and has not been deployed to a VPS.

## Build and run

Build from a reviewed checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Set these deployment values in the service manager, then start the built API process:

```text
MMSMANAGER_SERVE_WEB=true
MMSMANAGER_WEB_ORIGIN=https://panel.example.com
MMSMANAGER_COOKIE_SECURE=true
MMSMANAGER_DATA_DIR=/var/lib/mmsmanager
MMSMANAGER_API_PORT=4174
```

`MMSMANAGER_WEB_ORIGIN` is one exact origin with no path. Non-loopback origins must use HTTPS. The API binds to loopback and serves `apps/web/dist` from the same origin. Browser API calls stay relative to the current page. Do not run Vite as the public web server.

The reverse proxy must preserve the original `Host` and `Origin` values and proxy the entire origin to `127.0.0.1:4174`. The API checks both against the configured origin, uses exact-origin CORS, and does not trust forwarded headers. `MMSMANAGER_COOKIE_SECURE=true` marks session and CSRF cookies Secure and enables HSTS on responses. Terminate TLS at a maintained reverse proxy and configure its certificate and host firewall separately. Do not expose port 4174 directly or open a firewall as part of this preview.

An example service unit is in [`mmsmanager.service.example`](./mmsmanager.service.example). Create a dedicated unprivileged OS account and state directory yourself, review the paths and systemd protections, then install the unit using your normal change process. The example does not create accounts, directories, DNS, certificates, firewall rules or game-port access.

## Operational configuration

The first start creates `app-config.json` in the private MMSManager data directory with mode `0600`; the directory uses mode `0700`. Its versioned `monitoring` section can also be changed by an administrator from **Settings → Monitoring**. The UI limits quick CPU/memory/network sampling to 1–60 seconds, history persistence to 5–60 seconds, and disk refresh to 10–60 seconds. Defaults are 1, 10 and 30 seconds. One shared backend collector serves all browsers. Fast samples remain in memory; raw SQLite snapshots are written on the slower configured cadence, and minute/day summaries aggregate actual readings since the previous write. A clean API shutdown flushes the pending window.

The existing deployment environment variables remain authoritative for their established settings such as data directory, API port, timezone, server roots, import allowlists and cookie security. The JSON file owns only the allowlisted monitoring values; defaults apply when it is absent. Account display, language and navigation preferences remain per-user SQLite settings. Do not copy the config file into Git or a public backup.

## Boundaries

The managed Minecraft game bind remains loopback by default. WebUI HTTPS and game-port reachability are separate settings. This preview does not configure public game access, install a systemd unit, change a firewall, deploy to a VPS, or add SSH, RCON or multiple-host support. Test import, first-run setup, login, CSRF, Member authorization, backups, and server lifecycle on an isolated deployment copy before any real host is considered.
