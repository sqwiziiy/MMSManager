import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { link, lstat, mkdir, readdir, realpath, unlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { NativeLoader } from './native-loader.js'

const INSTALLER_TIMEOUT_MS = 15 * 60 * 1000
const MAX_INSTALL_OUTPUT_CHARS = 64 * 1024
const MAX_INSTALL_FILES = 50_000
const MAX_INSTALL_BYTES = 8 * 1024 * 1024 * 1024

export class LoaderInstallerError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export type LoaderInstallRunner = (input: {
  javaPath: string
  installerPath: string
  workDirectory: string
  signal: AbortSignal
  onOutput: (text: string) => void
}) => Promise<void>

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }

async function findResourceLimiter(): Promise<string> {
  if (process.platform !== 'linux') throw new LoaderInstallerError('INSTALL_RESOURCE_LIMITER_UNAVAILABLE', 'Forge and NeoForge installation requires Linux process limits on this host.')
  if (process.getuid?.() === 0) throw new LoaderInstallerError('INSTALL_REQUIRES_UNPRIVILEGED_ACCOUNT', 'Run MMSManager as a regular, unprivileged account before installing a loader.')
  for (const candidate of ['/usr/bin/prlimit', '/bin/prlimit']) {
    try {
      const stat = await lstat(candidate)
      if ((stat.isFile() || stat.isSymbolicLink()) && stat.isSymbolicLink() === false) {
        await realpath(candidate)
        await import('node:fs/promises').then(({ access }) => access(candidate, constants.X_OK))
        return candidate
      }
    } catch { /* try the next standard system path */ }
  }
  throw new LoaderInstallerError('INSTALL_RESOURCE_LIMITER_UNAVAILABLE', 'The Linux prlimit utility is required to safely run the official loader installer.')
}

export async function runOfficialLoaderInstaller(input: Parameters<LoaderInstallRunner>[0]): Promise<void> {
  const limiter = await findResourceLimiter()
  if (input.signal.aborted) throw new LoaderInstallerError('INSTALL_CANCELLED', 'The installation was cancelled.')
  await new Promise<void>((resolve, reject) => {
    let output = ''
    let settled = false
    let timedOut = false
    let cancelled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const args = [
      '--as=4294967296', '--cpu=900', '--fsize=8589934592', '--nofile=512', '--nproc=8192', '--',
      input.javaPath, '-XX:ActiveProcessorCount=2', '-Xms32m', '-Xmx1024m', '-XX:MaxDirectMemorySize=256m', '-jar', input.installerPath, '--installServer',
    ]
    const child = spawn(limiter, args, {
      cwd: input.workDirectory,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: input.workDirectory, TMPDIR: input.workDirectory },
    })
    const append = (chunk: Buffer | string) => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-MAX_INSTALL_OUTPUT_CHARS)
      input.onOutput(text)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const cleanup = () => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      input.signal.removeEventListener('abort', abort)
    }
    const failAfterClose = () => {
      if (settled) return
      settled = true
      cleanup()
      if (cancelled) reject(new LoaderInstallerError('INSTALL_CANCELLED', 'The installation was cancelled; its partial files remain available for review.'))
      else if (timedOut) reject(new LoaderInstallerError('INSTALLER_TIMEOUT', 'The official loader installer exceeded the 15 minute time limit.'))
      else reject(new LoaderInstallerError('INSTALLER_FAILED', `The official loader installer exited with code ${child.exitCode ?? 'unknown'}.${output ? `\n${output.trim().slice(-4000)}` : ''}`))
    }
    const abort = () => {
      cancelled = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      killTimer.unref()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      killTimer.unref()
    }, INSTALLER_TIMEOUT_MS)
    timeout.unref()
    input.signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new LoaderInstallerError('INSTALLER_SPAWN_FAILED', `The official loader installer could not be started: ${error.message}`))
    })
    child.once('close', (code) => {
      if (code === 0 && !cancelled && !timedOut && !input.signal.aborted) {
        settled = true
        cleanup()
        resolve()
      } else failAfterClose()
    })
  })
}

async function publishDirectory(source: string, target: string, state: { files: number; bytes: number }): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')) {
      throw new LoaderInstallerError('INSTALL_OUTPUT_UNSAFE', 'The loader installer produced an invalid file name.')
    }
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    const stat = await lstat(from)
    if (stat.isSymbolicLink()) throw new LoaderInstallerError('INSTALL_OUTPUT_UNSAFE', 'The loader installer produced a symbolic link; its output was not published.')
    if (stat.isDirectory()) {
      await mkdir(to, { mode: 0o700 }).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      })
      const destinationStat = await lstat(to)
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) throw new LoaderInstallerError('INSTALL_OUTPUT_CONFLICT', 'The loader installer output conflicts with an existing server file.')
      await publishDirectory(from, to, state)
      const { rmdir } = await import('node:fs/promises')
      await rmdir(from)
      continue
    }
    if (!stat.isFile() || ++state.files > MAX_INSTALL_FILES || (state.bytes += stat.size) > MAX_INSTALL_BYTES) {
      throw new LoaderInstallerError('INSTALL_OUTPUT_LIMIT', 'The official loader installer exceeded the file-count or 8 GiB output limit.')
    }
    try { await link(from, to) } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') throw new LoaderInstallerError('INSTALL_OUTPUT_CONFLICT', 'The loader installer output conflicts with an existing server file.')
      throw error
    }
    await unlink(from)
  }
}

export async function publishLoaderInstallerOutput(workDirectory: string, serverDirectory: string): Promise<{ files: number; bytes: number }> {
  const canonicalRoot = await realpath(serverDirectory)
  const canonicalWork = await realpath(workDirectory)
  const relativeWork = relative(canonicalRoot, canonicalWork)
  if (!relativeWork.startsWith('.mmsmanager-install-') || relativeWork.includes(sep) || canonicalWork === canonicalRoot) {
    throw new LoaderInstallerError('INSTALL_OUTPUT_UNSAFE', 'The loader installer must run in its own private child directory.')
  }
  const state = { files: 0, bytes: 0 }
  await publishDirectory(workDirectory, serverDirectory, state)
  const { rmdir } = await import('node:fs/promises')
  await rmdir(workDirectory)
  return state
}

export function loaderInstallerWorkName(operationId: string): string {
  return `.mmsmanager-install-${operationId}`
}

export function isLoaderInstallerOutput(software: string): software is NativeLoader {
  return software === 'forge' || software === 'neoforge'
}
