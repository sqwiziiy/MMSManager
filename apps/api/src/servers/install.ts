import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, lstat, realpath, statfs } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { eq, desc } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServers, serverInstallOperations } from '../db/schema.js'
import type { JavaRuntimeRegistry } from './java.js'
import type { ServerRegistry } from './registry.js'
import type { InstallCatalog, InstallOperation, InstallSoftware, ServerInstallRequest } from '@mmsmanager/shared'

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const FABRIC_META = 'https://meta.fabricmc.net/v2'
const PAPER_API = 'https://fill.papermc.io/v3'
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const MIN_FREE_BYTES = 64 * 1024 * 1024
const REDIRECT_LIMIT = 3

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>
type Artifact = {
  provider: string
  url: string
  expectedSize: number | null
  checksumType: 'sha1' | 'sha256' | null
  checksum: string | null
  javaMajor: number
}

export class ServerInstallError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null }
function positiveInteger(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null }
function checkDomain(url: string, allowed: string[]): URL {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new ServerInstallError('PROVIDER_URL_INVALID', 'The provider returned an invalid download URL.') }
  if (parsed.protocol !== 'https:' || !allowed.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
    throw new ServerInstallError('PROVIDER_URL_REJECTED', 'The provider returned a URL outside its official HTTPS download hosts.')
  }
  return parsed
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolvePort(true)))
  })
}

export class ServerInstallService {
  private readonly active = new Set<string>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly env: NodeJS.ProcessEnv

  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly javaRuntimes: JavaRuntimeRegistry,
    options: { fetch?: FetchLike; now?: () => number; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.env = options.env ?? process.env
  }

  async prepare(): Promise<void> {
    const at = new Date(this.now()).toISOString()
    this.db.update(serverInstallOperations).set({
      status: 'failed', phase: 'interrupted', errorCode: 'API_RESTARTED',
      errorMessage: 'The API restarted before this installation completed. Its partial directory was preserved for review.', updatedAt: at,
    }).where(eq(serverInstallOperations.status, 'pending')).run()
    this.db.update(serverInstallOperations).set({
      status: 'failed', phase: 'interrupted', errorCode: 'API_RESTARTED',
      errorMessage: 'The API restarted before this installation completed. Its partial directory was preserved for review.', updatedAt: at,
    }).where(eq(serverInstallOperations.status, 'downloading')).run()
    this.db.update(serverInstallOperations).set({
      status: 'failed', phase: 'interrupted', errorCode: 'API_RESTARTED',
      errorMessage: 'The API restarted before this installation completed. Its partial directory was preserved for review.', updatedAt: at,
    }).where(eq(serverInstallOperations.status, 'validating')).run()
  }

  get(operationId: string): InstallOperation | null {
    const row = this.db.select().from(serverInstallOperations).where(eq(serverInstallOperations.id, operationId)).get()
    return row ? this.toPublic(row) : null
  }

  cancel(operationId: string): InstallOperation {
    const operation = this.get(operationId)
    if (!operation) throw new ServerInstallError('INSTALL_NOT_FOUND', 'The installation operation was not found.')
    if (!['pending', 'downloading', 'validating'].includes(operation.status)) {
      throw new ServerInstallError('INSTALL_NOT_RUNNING', 'This installation is no longer running.')
    }
    const controller = this.abortControllers.get(operationId)
    if (!controller) throw new ServerInstallError('INSTALL_NOT_RUNNING', 'The running installation cannot be cancelled from this API process.')
    controller.abort()
    return this.get(operationId)!
  }

  list(): InstallOperation[] {
    return this.db.select().from(serverInstallOperations).orderBy(desc(serverInstallOperations.createdAt)).limit(50).all().map((row) => this.toPublic(row))
  }

  async catalog(software: InstallSoftware, version?: string): Promise<InstallCatalog> {
    if (software === 'vanilla') {
      const manifest = await this.getJson(MANIFEST_URL, ['piston-meta.mojang.com'])
      const versions = this.releaseVersions(manifest)
      const requiredJavaMajor = version ? await this.requiredJavaMajor(version) : null
      return { software, versions, loaders: [], builds: [], installerVersion: null, requiredJavaMajor }
    }
    if (software === 'fabric') {
      const [games, installers] = await Promise.all([
        this.getJson(`${FABRIC_META}/versions/game`, ['meta.fabricmc.net']),
        this.getJson(`${FABRIC_META}/versions/installer`, ['meta.fabricmc.net']),
      ])
      const versions = Array.isArray(games) ? games.filter((entry) => isRecord(entry) && entry['stable'] === true).map((entry) => stringValue(entry['version'])).filter((entry): entry is string => Boolean(entry)).slice(0, 100) : []
      const installer = Array.isArray(installers) ? installers.find((entry) => isRecord(entry) && entry['stable'] === true) : undefined
      const installerVersion = isRecord(installer) ? stringValue(installer['version']) : null
      let loaders: string[] = []
      if (version) {
        const loaderData = await this.getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(version)}`, ['meta.fabricmc.net'])
        loaders = Array.isArray(loaderData) ? loaderData.filter((entry) => isRecord(entry) && isRecord(entry['loader']) && entry['loader']['stable'] === true).map((entry) => isRecord(entry) && isRecord(entry['loader']) ? stringValue(entry['loader']['version']) : null).filter((entry): entry is string => Boolean(entry)).slice(0, 100) : []
      }
      const requiredJavaMajor = version ? await this.requiredJavaMajor(version) : null
      return { software, versions, loaders, builds: [], installerVersion, requiredJavaMajor }
    }
    const paperAgent = this.paperUserAgent()
    const project = await this.getJson(`${PAPER_API}/projects/paper`, ['fill.papermc.io'], paperAgent)
    const versionMap = isRecord(project) && isRecord(project['versions']) ? project['versions'] : null
    const versions = versionMap ? [...new Set(Object.values(versionMap).flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))].slice(0, 150) : []
    let builds: number[] = []
    if (version) {
      const buildData = await this.getJson(`${PAPER_API}/projects/paper/versions/${encodeURIComponent(version)}/builds`, ['fill.papermc.io'], paperAgent)
      builds = Array.isArray(buildData) ? buildData.filter((entry) => isRecord(entry) && entry['channel'] === 'STABLE').map((entry) => isRecord(entry) ? positiveInteger(entry['id']) : null).filter((entry): entry is number => entry !== null).slice(0, 100) : []
    }
    const requiredJavaMajor = version ? await this.requiredJavaMajor(version) : null
    return { software, versions, loaders: [], builds, installerVersion: null, requiredJavaMajor }
  }

  async create(input: ServerInstallRequest, actorUserId: string): Promise<InstallOperation> {
    if (this.active.size >= 2) throw new ServerInstallError('INSTALL_LIMIT', 'Two installations are already running. Wait for one to finish before retrying.')
    const id = randomUUID()
    const at = new Date(this.now()).toISOString()
    this.db.insert(serverInstallOperations).values({
      id, actorUserId, serverId: null, name: input.name, directoryName: input.directoryName,
      software: input.software, version: input.version, requestJson: JSON.stringify(input),
      status: 'pending', progress: 1, phase: 'queued', artifactUrl: null, artifactSize: null,
      artifactSha1: null, artifactSha256: null, errorCode: null, errorMessage: null,
      partialDirectory: null, createdAt: at, updatedAt: at,
    }).run()
    this.active.add(id)
    const controller = new AbortController()
    this.abortControllers.set(id, controller)
    void this.run(id, input, actorUserId, controller.signal).finally(() => {
      this.active.delete(id)
      this.abortControllers.delete(id)
    })
    return this.get(id)!
  }

  private async run(id: string, input: ServerInstallRequest, actorUserId: string, signal: AbortSignal): Promise<void> {
    let partialDirectory: string | null = null
    try {
      await this.update(id, { status: 'pending', progress: 4, phase: 'validating-selection' })
      const runtime = this.javaRuntimes.list().find((candidate) => candidate.path === input.javaPath)
      if (!runtime) throw new ServerInstallError('JAVA_NOT_VERIFIED', 'Scan or probe this Java runtime before selecting it.')
      const artifact = await this.resolveArtifact(input, signal)
      if (runtime.major !== artifact.javaMajor && runtime.major < artifact.javaMajor) {
        throw new ServerInstallError('JAVA_VERSION_UNSUPPORTED', `Minecraft ${input.version} requires Java ${artifact.javaMajor} or newer; the selected runtime is Java ${runtime.major}.`)
      }
      const javaStat = await lstat(runtime.path)
      if (!javaStat.isFile() && !javaStat.isSymbolicLink()) throw new ServerInstallError('JAVA_NOT_EXECUTABLE', 'The selected Java runtime is no longer a regular executable.')
      await access(runtime.path, constants.X_OK)
      const portConflict = await this.servers.findPortConflict('', input.port)
      if (portConflict) throw new ServerInstallError('PORT_CONFLICT', `Game port ${input.port} is also configured for “${portConflict.name}”.`)
      if (!await isLoopbackPortAvailable(input.port)) throw new ServerInstallError('PORT_IN_USE', `Local port ${input.port} is already in use.`)

      const root = await realpath(this.servers.managedRoot)
      const finalDirectory = resolve(root, input.directoryName)
      if (dirname(finalDirectory) !== root) throw new ServerInstallError('DIRECTORY_REJECTED', 'Choose a single directory name inside the configured managed root.')
      try {
        await lstat(finalDirectory)
        throw new ServerInstallError('DIRECTORY_EXISTS', 'That directory already exists. Choose a new dedicated server folder; existing files are never overwritten.')
      } catch (error) {
        if (error instanceof ServerInstallError) throw error
        if (!isNodeFsError(error) || error.code !== 'ENOENT') throw error
      }
      const available = await statfs(root)
      const availableBytes = Number(available.bavail) * Number(available.bsize)
      if (availableBytes < (artifact.expectedSize ?? MAX_ARTIFACT_BYTES) + MIN_FREE_BYTES) {
        throw new ServerInstallError('DISK_SPACE_LOW', 'There is not enough available space under the managed server root for this installation.')
      }
      await mkdir(finalDirectory, { mode: 0o700 })
      partialDirectory = finalDirectory
      const directoryStat = await lstat(finalDirectory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(finalDirectory) !== finalDirectory) {
        throw new ServerInstallError('DIRECTORY_REJECTED', 'The new server directory did not remain a safe direct child of the managed root.')
      }
      await this.update(id, {
        status: 'downloading', progress: 10, phase: 'downloading', artifactUrl: artifact.url,
        artifactSize: artifact.expectedSize,
      })
      const download = await this.downloadArtifact(id, artifact, join(finalDirectory, 'server.jar.part'), signal)
      if (signal.aborted) throw new ServerInstallError('INSTALL_CANCELLED', 'The installation was cancelled. Created files were preserved for review.')
      await this.update(id, { status: 'validating', progress: 86, phase: 'validating-artifact', artifactSha1: download.sha1, artifactSha256: download.sha256 })
      const jarPartial = join(finalDirectory, 'server.jar.part')
      const jarFinal = join(finalDirectory, 'server.jar')
      await (await import('node:fs/promises')).rename(jarPartial, jarFinal)
      const properties = [
        '# Generated by MMSManager. Edit through the local server properties screen.',
        `server-port=${input.port}`,
        'server-ip=127.0.0.1',
        'motd=A local Minecraft server',
        'max-players=20',
        'online-mode=true',
        'pvp=true',
        'difficulty=normal',
        'gamemode=survival',
        'white-list=false',
        'spawn-protection=16',
        'view-distance=10',
        'simulation-distance=10',
        '',
      ].join('\n')
      await this.writeExclusive(join(finalDirectory, 'server.properties'), properties, 0o600)
      await this.writeExclusive(join(finalDirectory, 'eula.txt'), `# Human acceptance recorded by MMSManager\neula=${input.eulaAccepted ? 'true' : 'false'}\n`, 0o600)
      const startScript = `#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ${shellQuote(runtime.path)} -Xms${input.minMemoryMb}M -Xmx${input.maxMemoryMb}M -jar server.jar nogui\n`
      await this.writeExclusive(join(finalDirectory, 'start.sh'), startScript, 0o700)

      const serverId = randomUUID()
      const at = new Date(this.now()).toISOString()
      this.db.transaction((tx) => {
        tx.insert(localServers).values({
          id: serverId, name: input.name, directory: finalDirectory, source: 'created',
          software: input.software, version: input.version, jarName: 'server.jar', javaPath: runtime.path,
          javaMajor: runtime.major, javaSelectionMode: 'auto', requiredJavaMajor: artifact.javaMajor,
          minMemoryMb: input.minMemoryMb, maxMemoryMb: input.maxMemoryMb,
          jvmOptionsJson: '{"collector":"default","maxGCPauseMs":null,"parallelGcThreads":null,"alwaysPreTouch":false,"disableExplicitGc":false}',
          startScriptSha256: createHash('sha256').update(startScript).digest('hex'),
          port: input.port, eula: input.eulaAccepted ? 'accepted' : 'not-accepted', managed: true,
          worldFolders: '[]', createdBy: actorUserId, createdAt: at, updatedAt: at,
        }).run()
        tx.insert(localServerEvents).values({
          serverId, actorUserId, action: 'server-installed', outcome: 'success', occurredAt: at,
          detail: JSON.stringify({ operationId: id, provider: artifact.provider, version: input.version, artifactUrl: artifact.url, size: download.size, checksumType: artifact.checksumType, providerChecksum: artifact.checksum, sha1: download.sha1, sha256: download.sha256, eulaAccepted: input.eulaAccepted }),
        }).run()
        tx.update(serverInstallOperations).set({
          serverId, status: 'completed', progress: 100, phase: 'complete', artifactSize: download.size,
          artifactSha1: download.sha1, artifactSha256: download.sha256, partialDirectory: null, updatedAt: at,
        }).where(eq(serverInstallOperations.id, id)).run()
      })
    } catch (error) {
      const failure = signal.aborted
        ? new ServerInstallError('INSTALL_CANCELLED', 'The installation was cancelled. Any files already created were preserved for review.')
        : error instanceof ServerInstallError
        ? error
        : new ServerInstallError('INSTALL_FAILED', 'The installation failed. Any panel-created partial directory was preserved for inspection.')
      const at = new Date(this.now()).toISOString()
      this.db.update(serverInstallOperations).set({
        status: 'failed', phase: 'failed', errorCode: failure.code, errorMessage: failure.message,
        partialDirectory, updatedAt: at,
      }).where(eq(serverInstallOperations.id, id)).run()
      this.db.insert(localServerEvents).values({
        serverId: null, actorUserId, action: failure.code === 'INSTALL_CANCELLED' ? 'server-install-cancelled' : 'server-install-failed',
        outcome: failure.code === 'INSTALL_CANCELLED' ? 'success' : 'failure', occurredAt: at,
        detail: JSON.stringify({ operationId: id, software: input.software, version: input.version, code: failure.code, partialDirectory }),
      }).run()
    }
  }

  private async resolveArtifact(input: ServerInstallRequest, signal?: AbortSignal): Promise<Artifact> {
    let provider: string
    let url: string
    let expectedSize: number | null = null
    let checksumType: 'sha1' | 'sha256' | null = null
    let checksum: string | null = null
    if (input.software === 'vanilla') {
      provider = 'Mojang'
      const metadata = await this.mojangVersion(input.version, signal)
      const downloads = isRecord(metadata['downloads']) ? metadata['downloads'] : null
      const server = downloads && isRecord(downloads['server']) ? downloads['server'] : null
      url = stringValue(server?.['url']) ?? ''
      expectedSize = positiveInteger(server?.['size'])
      checksum = stringValue(server?.['sha1'])?.toLowerCase() ?? null
      checksumType = checksum ? 'sha1' : null
      if (!checksum || !/^[a-f0-9]{40}$/.test(checksum)) throw new ServerInstallError('PROVIDER_METADATA_INVALID', 'Mojang metadata did not include a valid server SHA-1 checksum.')
      checkDomain(url, ['piston-data.mojang.com', 'launcher.mojang.com'])
    } else if (input.software === 'fabric') {
      provider = 'Fabric Meta'
      const [loaders, installers] = await Promise.all([
        this.getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(input.version)}`, ['meta.fabricmc.net'], undefined, signal),
        this.getJson(`${FABRIC_META}/versions/installer`, ['meta.fabricmc.net'], undefined, signal),
      ])
      const loader = Array.isArray(loaders) ? loaders.find((entry) => isRecord(entry) && isRecord(entry['loader']) && entry['loader']['version'] === input.loaderVersion && entry['loader']['stable'] === true) : undefined
      const installer = Array.isArray(installers) ? installers.find((entry) => isRecord(entry) && entry['version'] === input.installerVersion && entry['stable'] === true) : undefined
      if (!loader || !installer) throw new ServerInstallError('BUILD_UNAVAILABLE', 'The selected stable Fabric loader or installer is no longer available.')
      url = `${FABRIC_META}/versions/loader/${encodeURIComponent(input.version)}/${encodeURIComponent(input.loaderVersion!)}/${encodeURIComponent(input.installerVersion!)}/server/jar`
      checkDomain(url, ['meta.fabricmc.net'])
    } else {
      provider = 'PaperMC Downloads Service v3'
      const builds = await this.getJson(`${PAPER_API}/projects/paper/versions/${encodeURIComponent(input.version)}/builds`, ['fill.papermc.io'], this.paperUserAgent(), signal)
      const stable = Array.isArray(builds) ? builds.filter((entry) => isRecord(entry) && entry['channel'] === 'STABLE') : []
      const build = stable.find((entry) => isRecord(entry) && entry['id'] === (input.paperBuild ?? stable[0]?.['id']))
      const downloads = isRecord(build) && isRecord(build['downloads']) ? build['downloads'] : null
      const server = downloads && isRecord(downloads['server:default']) ? downloads['server:default'] : null
      url = stringValue(server?.['url']) ?? ''
      expectedSize = positiveInteger(server?.['size'])
      checksum = stringValue(isRecord(server?.['checksums']) ? server['checksums']['sha256'] : null)?.toLowerCase() ?? null
      checksumType = checksum ? 'sha256' : null
      if (!url || !checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new ServerInstallError('BUILD_UNAVAILABLE', 'Paper has no stable build with a SHA-256 checksum for this version.')
      checkDomain(url, ['fill-data.papermc.io', 'fill.papermc.io'])
    }
    if (expectedSize !== null && expectedSize > MAX_ARTIFACT_BYTES) throw new ServerInstallError('ARTIFACT_TOO_LARGE', 'The official provider artifact exceeds the 256 MiB installation limit.')
    const javaMajor = await this.requiredJavaMajor(input.version, signal)
    return { provider, url, expectedSize, checksumType, checksum, javaMajor }
  }

  private async requiredJavaMajor(version: string, signal?: AbortSignal): Promise<number> {
    const metadata = await this.mojangVersion(version, signal)
    const javaVersion = isRecord(metadata['javaVersion']) ? metadata['javaVersion'] : null
    const major = javaVersion ? positiveInteger(javaVersion['majorVersion']) : null
    if (!major) throw new ServerInstallError('JAVA_REQUIREMENT_UNKNOWN', `Mojang metadata does not declare the Java requirement for Minecraft ${version}; installation is blocked until compatibility can be verified.`)
    return major
  }

  private async mojangVersion(version: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const manifest = await this.getJson(MANIFEST_URL, ['piston-meta.mojang.com'], undefined, signal)
    const versions = isRecord(manifest) && Array.isArray(manifest['versions']) ? manifest['versions'] : []
    const record = versions.find((item) => isRecord(item) && item['id'] === version && item['type'] === 'release')
    const metadataUrl = isRecord(record) ? stringValue(record['url']) : null
    if (!metadataUrl) throw new ServerInstallError('VERSION_UNAVAILABLE', `Minecraft release ${version} is not available in the official Mojang manifest.`)
    checkDomain(metadataUrl, ['piston-meta.mojang.com', 'launchermeta.mojang.com'])
    const metadata = await this.getJson(metadataUrl, ['piston-meta.mojang.com', 'launchermeta.mojang.com'], undefined, signal)
    if (!isRecord(metadata)) throw new ServerInstallError('PROVIDER_METADATA_INVALID', 'Mojang returned invalid version metadata.')
    return metadata
  }

  private releaseVersions(manifest: unknown): string[] {
    if (!isRecord(manifest) || !Array.isArray(manifest['versions'])) throw new ServerInstallError('PROVIDER_METADATA_INVALID', 'Mojang returned an invalid version manifest.')
    return manifest['versions'].filter((entry) => isRecord(entry) && entry['type'] === 'release' && typeof entry['id'] === 'string' && /^\d{1,3}(?:\.\d{1,3}){1,3}$/.test(entry['id'])).map((entry) => (entry as Record<string, unknown>)['id'] as string).slice(0, 100)
  }

  private async getJson(url: string, allowedHosts: string[], userAgent = 'MMSManager/0.2.0', signal?: AbortSignal): Promise<unknown> {
    let current = url
    for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
      checkDomain(current, allowedHosts)
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
      const response = await this.fetchImpl(current, { headers: { Accept: 'application/json', 'User-Agent': userAgent }, signal: requestSignal, redirect: 'manual' })
      if (signal?.aborted) throw new ServerInstallError('INSTALL_CANCELLED', 'The installation was cancelled.')
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location || redirects === REDIRECT_LIMIT) throw new ServerInstallError('PROVIDER_REDIRECT_REJECTED', 'The provider returned too many redirects.')
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) throw new ServerInstallError('PROVIDER_UNAVAILABLE', `Official provider metadata returned HTTP ${response.status}.`)
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('json')) throw new ServerInstallError('PROVIDER_METADATA_INVALID', 'Official provider metadata did not return JSON.')
      const body = await response.text()
      if (body.length > 2 * 1024 * 1024) throw new ServerInstallError('PROVIDER_METADATA_TOO_LARGE', 'Official provider metadata exceeded the 2 MiB limit.')
      try { return JSON.parse(body) as unknown } catch { throw new ServerInstallError('PROVIDER_METADATA_INVALID', 'Official provider metadata could not be parsed.') }
    }
    throw new ServerInstallError('PROVIDER_REDIRECT_REJECTED', 'The provider returned too many redirects.')
  }

  private paperUserAgent(): string {
    const contact = this.env['MMSMANAGER_CONTACT_URL'] || 'https://github.com/sqwiziiy/MMSManager'
    if (!/^https:\/\//.test(contact) && !/^mailto:[^\s@]+@[^\s@]+$/.test(contact)) {
      throw new ServerInstallError('PAPER_CONTACT_REQUIRED', 'Paper downloads require MMSMANAGER_CONTACT_URL (HTTPS) or an email contact in the service configuration.')
    }
    return `MMSManager/0.2.0 (${contact})`
  }

  private async downloadArtifact(id: string, artifact: Artifact, path: string, signal?: AbortSignal): Promise<{ size: number; sha1: string; sha256: string }> {
    const hosts = artifact.provider === 'Mojang' ? ['piston-data.mojang.com', 'launcher.mojang.com']
      : artifact.provider === 'Fabric Meta' ? ['meta.fabricmc.net'] : ['fill-data.papermc.io', 'fill.papermc.io']
    let current = artifact.url
    let response: Response | null = null
    for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
      checkDomain(current, hosts)
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      response = await this.fetchImpl(current, { headers: { Accept: 'application/java-archive, application/octet-stream' }, signal: requestSignal, redirect: 'manual' })
      if (signal?.aborted) throw new ServerInstallError('INSTALL_CANCELLED', 'The installation was cancelled.')
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location || redirects === REDIRECT_LIMIT) throw new ServerInstallError('DOWNLOAD_REDIRECT_REJECTED', 'The artifact download returned too many redirects.')
        current = new URL(location, current).toString()
        continue
      }
      break
    }
    if (!response?.ok) throw new ServerInstallError('DOWNLOAD_FAILED', `The official artifact download returned HTTP ${response?.status ?? 'no response'}.`)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!['application/java-archive', 'application/octet-stream', 'application/zip', 'application/x-java-archive'].includes(contentType)) {
      throw new ServerInstallError('ARTIFACT_TYPE_REJECTED', 'The provider response was not a Java archive download.')
    }
    const lengthHeader = response.headers.get('content-length')
    const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
    if (length !== null && (length > MAX_ARTIFACT_BYTES || artifact.expectedSize !== null && length !== artifact.expectedSize)) {
      throw new ServerInstallError('ARTIFACT_SIZE_MISMATCH', 'The artifact size did not match official metadata or exceeded the 256 MiB limit.')
    }
    if (!response.body) throw new ServerInstallError('DOWNLOAD_EMPTY', 'The provider returned an empty artifact.')
    const handle = await open(path, 'wx', 0o600)
    const sha1 = createHash('sha1')
    const sha256 = createHash('sha256')
    const firstBytes: number[] = []
    let size = 0
    try {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          size += value.byteLength
          if (size > MAX_ARTIFACT_BYTES || artifact.expectedSize !== null && size > artifact.expectedSize) {
            await reader.cancel()
            throw new ServerInstallError('ARTIFACT_SIZE_MISMATCH', 'The artifact exceeded its official size or the 256 MiB limit.')
          }
          if (firstBytes.length < 4) firstBytes.push(...value.subarray(0, 4 - firstBytes.length))
          sha1.update(value)
          sha256.update(value)
          let offset = 0
          while (offset < value.byteLength) {
            const written = await handle.write(value, offset, value.byteLength - offset, size - value.byteLength + offset)
            offset += written.bytesWritten
          }
          const progress = length ? Math.min(82, 10 + Math.floor(size / length * 72)) : Math.min(80, 10 + Math.floor(size / (64 * 1024 * 1024) * 16))
          await this.update(id, { status: 'downloading', progress, phase: 'downloading' })
        }
      } finally {
        if (signal?.aborted) await reader.cancel().catch(() => undefined)
      }
      if (size === 0 || firstBytes.join(',') !== '80,75,3,4') throw new ServerInstallError('ARTIFACT_TYPE_REJECTED', 'The downloaded file does not have a valid Java archive header.')
      if (length !== null && length !== size || artifact.expectedSize !== null && artifact.expectedSize !== size) throw new ServerInstallError('ARTIFACT_SIZE_MISMATCH', 'The completed artifact length did not match provider metadata.')
      await handle.sync()
      const digest1 = sha1.digest('hex')
      const digest256 = sha256.digest('hex')
      if (artifact.checksumType === 'sha1' && digest1 !== artifact.checksum || artifact.checksumType === 'sha256' && digest256 !== artifact.checksum) {
        throw new ServerInstallError('CHECKSUM_MISMATCH', 'The downloaded artifact checksum did not match the official provider metadata.')
      }
      return { size, sha1: digest1, sha256: digest256 }
    } finally {
      await handle.close()
    }
  }

  private async writeExclusive(path: string, contents: string, mode: number): Promise<void> {
    const handle = await open(path, 'wx', mode)
    try { await handle.writeFile(contents); await handle.sync() } finally { await handle.close() }
  }

  private async update(id: string, fields: Partial<typeof serverInstallOperations.$inferInsert>): Promise<void> {
    this.db.update(serverInstallOperations).set({ ...fields, updatedAt: new Date(this.now()).toISOString() }).where(eq(serverInstallOperations.id, id)).run()
  }

  private toPublic(row: typeof serverInstallOperations.$inferSelect): InstallOperation {
    return {
      id: row.id, name: row.name, directoryName: row.directoryName, software: row.software, version: row.version,
      status: row.status, progress: row.progress, phase: row.phase, serverId: row.serverId,
      artifactUrl: row.artifactUrl, artifactSize: row.artifactSize, artifactSha256: row.artifactSha256,
      error: row.errorCode && row.errorMessage ? { code: row.errorCode, message: row.errorMessage } : null,
      partialDirectory: row.partialDirectory, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }
  }
}

function isNodeFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
