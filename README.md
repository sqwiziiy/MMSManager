# MMSManager

MMSManager is a local-first workspace for Minecraft server operators. It includes real, read-only metrics from the Linux host, persistent machine history, an authenticated local server-folder inventory, an official-provider installer, and lifecycle controls for processes created by MMSManager. Imported folders remain read only and unmanaged.

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

Monitoring operations use a versioned `app-config.json` in that private state directory. It is created with mode `0600` and stores only allowlisted global monitoring settings. Administrators can change the live sample, history save, disk refresh and server-status intervals under **Settings → Monitoring**; the single backend collector and bounded status service apply changes without restarting. Defaults are 1 second, 10 seconds, 30 seconds and 15 seconds. Fast readings feed current metrics and recent charts, while SQLite raw snapshots are saved at the slower history cadence and rollups summarize the actual readings in each window. User appearance and navigation preferences remain in the account database.

Passwords are stored as salted Argon2id hashes. Sessions use HttpOnly, SameSite cookies with CSRF and same-origin checks, idle and absolute expiry, server-side authorization, and rate limits. The supported development server is loopback HTTP; do not expose it to LAN or the public internet.

For a same-origin reverse-proxy deployment preview on one Linux host, see [`deploy/README.md`](./deploy/README.md). It requires an exact HTTPS origin, Secure cookies and a reverse proxy to the loopback API. It has not been deployed or security-audited on a VPS.

`MMSMANAGER_TIME_ZONE` sets the collector's IANA timezone and defaults to the host timezone. Keep it stable while collecting history. Raw telemetry samples are retained for 7 days, minute rollups for 90 days, and daily rollups remain until a cleanup policy is configured.

The local server registry is stored in the same SQLite database. The app-managed root defaults to `${MMSMANAGER_DATA_DIR}/servers` (mode `0700`); set `MMSMANAGER_SERVER_ROOT` to choose another local root. `MMSMANAGER_IMPORT_ROOTS` is an optional colon-separated allowlist of existing folders. Without it, only subdirectories of the managed root may be imported. Import inspection reads immediate directory entries and bounded `server.properties`/`eula.txt` files only; it does not write to the selected server folder. Imported servers stay unmanaged.

An administrator can explicitly scan known local Java locations or check a custom executable from Machine settings. Each check calls only `java -version` with no shell, a short timeout and an output limit. A normal page read does not run Java. No Minecraft process is launched by the inventory scan.

## Importing an existing server

On the Servers page an administrator can upload a ZIP archive from the browser. MMSManager stores it in the private application data directory, previews its files and server settings, then creates a new managed folder without overwriting an existing server. ZIP64 is supported; the compressed upload is capped at 128 MiB, expanded content at 2 GiB, and entry paths, links, special files and compression ratios are checked before extraction. Archives are never executed during preview or import. The administrator must choose a discovered Java runtime, explicitly trust the server JAR and mods, and separately accept the Minecraft EULA before choosing to start the imported server.

Registering a server folder already on the machine remains a read-only inspection. Imported folders stay unmanaged and can only be unregistered from the panel; their folder contents remain untouched.

## Creating a local server

Administrators can open **Create server** from the dashboard or Servers page. The creation flow installs stable Vanilla, Fabric or Paper builds into a new, dedicated directory below the configured managed root. Version lists and artifacts come from Mojang's official distribution metadata, Fabric Meta, and PaperMC's v3 Downloads Service. Paper requests include a specific MMSManager User-Agent; configure `MMSMANAGER_CONTACT_URL` to an HTTPS contact page or `mailto:` address if you want to use your own contact. Forge and NeoForge remain unavailable.

The wizard checks Minecraft's declared Java major against a runtime that an administrator has explicitly scanned or probed. It checks the loopback game port, caps downloads at 256 MiB, validates the archive header/size and verifies Mojang SHA-1 or Paper SHA-256 when the provider publishes one. Fabric Meta's generated jar endpoint does not publish an artifact checksum; MMSManager records a local SHA-256 for provenance but cannot compare it with an upstream digest. Failed downloads are preserved in their new panel-created directory and are never registered as healthy. Existing directories are never overwritten or cleaned.

The EULA checkbox starts unchecked. The installer writes `eula=true` only after explicit administrator acceptance; otherwise it writes `eula=false`. New `server.properties` bind to `127.0.0.1`. A readable `start.sh` is generated but is not executed; the Start control invokes the chosen Java executable directly with an argument array and `shell: false`.

## Starting and managing a local server

Only an administrator can control a new, panel-managed server with an accepted EULA, a configured Java runtime and its managed JAR. Imported folders remain read only. Start waits for Minecraft's readiness line. Stop writes Minecraft's graceful `stop` command to the owned process; MMSManager does not signal or kill a process. If the API restarts while a child is still alive, its state becomes **Unmanaged** and the panel will not adopt it. An administrator can confirm it stopped only after the stored PID/start identity check shows that exact process is gone.

An administrator can unregister a server to hide its registry entry while retaining its files and associated history. Permanent deletion is limited to stopped, panel-created servers: the administrator reviews backups, types the exact server name and confirms the consequence. The folder is moved to a private same-volume quarantine and removed with a recovery journal; existing backup archives, audit events and server history remain separately retained. Imported folders cannot be permanently deleted through MMSManager.

The local Console shows output from the owned process and sends bounded Minecraft commands to its stdin; browser input is never passed to a shell. Console history retains the most recent 5,000 entries. Raw stdout/stderr logs rotate into 16 MiB files with a 256 MiB total cap, stored privately under the MMSManager data directory. New raw capture pauses at the cap; existing logs are not deleted.

The visual Properties editor changes a supported set of `server.properties` options for managed folders only. It preserves comments and unknown keys, creates a private recovery copy before each atomic replacement, and flags changes made while running as restart required. Network binding stays fixed at `127.0.0.1`.

The dashboard and Servers list now read the local registry and show an honest empty state when no servers are registered. The server Overview shows persistent server metadata plus process RSS, uptime and CPU only when the process identity is verifiably owned by MMSManager. A bounded status ping targets only `127.0.0.1` at the registered game port and can report a count, version and description; it is never treated as proof of player identities. For Administrators, the Players tab can query names from the owned process `list` response. Fixed kick, ban, pardon, op/deop and whitelist commands require a browser confirmation, validated username and an owned running process. The result is marked confirmed only when a known server response appears; otherwise the UI says the action is unverified and points to Console. Imported folders remain read-only.

The Worlds page inventories configured and default world folders for managed servers with bounded size and timestamp inspection. It marks a world as backed up only when a retained snapshot includes that folder. Administrators can create private snapshots for stopped, panel-created servers, verify and download them, preview file coverage, then restore after typing the exact server name. A verified pre-restore safety snapshot and directory rollback journal protect replacement. Imported folders remain read only. The History calendar can switch between the local host, all managed servers or one managed server. Server metrics and conservative parsed lifecycle/player/moderation events come only from persisted local status pings and panel-owned process output. Local-time day boundaries honor daylight saving changes. World scans do not parse NBT or create maps.

Backup archives and manifests live under `server-backups/` in the private MMSManager data directory, outside each live server folder. Each backup is capped at 20 GiB and all retained archive-plus-manifest bytes share a 100 GiB budget. The scanner streams files in bounded chunks, skips symlinks, hard links, special files, nested mounts, panel databases, environment files and credential-like paths, and lists exclusions in the restore preview. Existing backups are never automatically deleted. Backups, previews and restore require Administrator access; imported folders and running servers cannot be backed up or restored.

## Runtime settings, restart and automation

The Runtime page saves a checked Java executable, minimum/maximum heap and a small typed set of JVM tuning fields. Compatibility is checked against the Java minimum recorded by the installer, and ZGC requires Java 17 or newer. Arbitrary JVM argument strings are not accepted. MMSManager updates a generated `start.sh` only when its saved content hash and file identity still match; edited or untracked scripts are left alone. These settings never start or restart a server automatically.

Restart is available only for a process still owned by MMSManager. It sends the graceful Minecraft `stop` command, waits up to 30 seconds for confirmed exit, then launches the configured runtime and waits up to 90 seconds for readiness. A timeout does not force-kill the child. API shutdown waits at most 15 seconds and marks a still-running child unmanaged rather than taking control of it.

Automation supports persisted daily or weekly backups in the configured `MMSMANAGER_TIME_ZONE`. Schedules handle daylight-saving changes, run only through the stopped-server backup checks, and retain actual job outcomes. A run more than 10 minutes late is recorded as missed; it is not backfilled. Failed or interrupted tasks are not retried automatically, and missed tasks need Administrator acknowledgement. There are no scheduled restarts, automatic retention deletions or RCON controls. RCON remains an optional later capability.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Current boundaries

- Machine metrics and history are real, read-only measurements from this local Linux host when available. The app does not inspect other machines.
- The local server registry, Java version checks, Vanilla/Fabric/Paper installation, panel-owned start/stop, basic process console/logs, typed managed `server.properties` editing and backup restore, Fabric mods/Paper plugins, constrained managed-server file operations, ZIP import, server unregister and guarded permanent deletion are local-only features. Imported folders remain read-only and unmanaged. File edits are bounded, recoverable and Administrator-only.
- Per-server CPU comes only from the verified owned process; status-ping player counts and process console identities show their own source and freshness. Fixed player actions are Admin-only and use response verification. Fabric mods and Paper plugins use the local file-backed manager; the managed-server Files page supports bounded, recoverable file operations. Worlds inventory and server history are read only; managed-server backup and restore are local, stopped-only Administrator actions. Typed Runtime settings, safe owned-process Restart and persisted stopped-server backup schedules are real local features. Optional RCON and scheduled restarts are not implemented.
- User creation, roles, profile, password, avatar, workspace/personal settings and Administrator account deletion are backed by the local SQLite workspace. Account deletion requires exact-name confirmation and protects the last enabled administrator. Per-server Access grants configurable capabilities to Members, enforces dependent permissions and applies changes immediately; workspace Administrators retain control.
- Activity now merges saved local-machine, security, server-action and parsed-player events with role-aware details; it never invents gaps. Templates persist safe server creation defaults and only prefill the reviewed create wizard. Settings provide per-user in-app operational alerts; read/unread state is private to that account and security alerts remain Administrator-only. Online mode can be changed only while a managed server is stopped, after explicit confirmation, with a recovery copy; changing it does not migrate player identities or data.
- Global Backups aggregates actual retained snapshots for managed servers. Unknown text-slug server URLs return not found instead of loading demo records. The UI API client applies consistent same-origin, CSRF and session-expiry handling. An in-progress provider installation can be cancelled; created partial files remain for review and a retry uses a separate directory. Retained backup deletion, automatic retention cleanup, Forge/NeoForge, SSH and RCON are not available.
- No RCON, SSH, remote host, LAN API or arbitrary OS shell endpoint is included. The API and Vite remain loopback-only.
