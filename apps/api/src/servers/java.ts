import { constants } from 'node:fs'
import { access, lstat, realpath, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export class JavaRuntimeError extends Error {
  constructor(readonly code: 'invalid-path' | 'not-executable' | 'probe-failed', message: string) {
    super(message)
  }
}

export type JavaRuntime = {
  path: string
  version: string
  major: number
  vendor: string | null
  source: 'discovered' | 'custom'
}

export class JavaRuntimeRegistry {
  private readonly runtimes = new Map<string, JavaRuntime>()

  constructor(private readonly discover: () => Promise<JavaRuntime[]> = () => discoverJavaRuntimes()) {}

  list(): JavaRuntime[] {
    return [...this.runtimes.values()].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path))
  }

  async scan(): Promise<JavaRuntime[]> {
    const found = await this.discover()
    this.runtimes.clear()
    for (const runtime of found) this.runtimes.set(runtime.path, runtime)
    return this.list()
  }

  async probe(path: string): Promise<JavaRuntime> {
    const runtime = await inspectJavaRuntime(path)
    this.runtimes.set(runtime.path, runtime)
    return runtime
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function parseRuntime(output: string): { version: string; major: number; vendor: string | null } | null {
  const match = output.match(/(?:openjdk|java|graalvm|temurin|dragonwell|corretto|zulu)\s+(?:version\s+)?["']?((?:1\.)?\d+(?:[._+-][\w.-]+)?)/i)
  if (!match?.[1]) return null
  const version = match[1]
  const majorMatch = version.match(/^1\.(\d+)/) ?? version.match(/^(\d+)/)
  const major = majorMatch?.[1] ? Number(majorMatch[1]) : Number.NaN
  if (!Number.isInteger(major) || major < 1) return null
  const firstLine = output.split(/\r?\n/, 1)[0] ?? ''
  const vendorMatch = firstLine.match(/\b(OpenJDK|Oracle|Temurin|Eclipse|Amazon|Corretto|Azul|Zulu|GraalVM|Microsoft|IBM|Red Hat)\b/i)
  const vendorNames: Record<string, string> = {
    openjdk: 'OpenJDK', oracle: 'Oracle', temurin: 'Temurin', eclipse: 'Eclipse', amazon: 'Amazon',
    corretto: 'Corretto', azul: 'Azul', zulu: 'Zulu', graalvm: 'GraalVM', microsoft: 'Microsoft',
    ibm: 'IBM', 'red hat': 'Red Hat',
  }
  const vendor = vendorMatch?.[1] ? vendorNames[vendorMatch[1].toLowerCase()] ?? vendorMatch[1] : null
  return { version, major, vendor }
}

async function runJavaVersion(binary: string): Promise<JavaRuntime> {
  let stat
  try {
    stat = await lstat(binary)
    await access(binary, constants.X_OK)
  } catch {
    throw new JavaRuntimeError('not-executable', 'The Java runtime path is not executable.')
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new JavaRuntimeError('not-executable', 'The Java runtime path is not a regular file.')
  let canonical: string
  try {
    canonical = await realpath(binary)
  } catch {
    throw new JavaRuntimeError('not-executable', 'The Java runtime path could not be resolved.')
  }

  const output = await new Promise<string>((resolveOutput, reject) => {
    let child
    try {
      child = spawn(canonical, ['-version'], {
        cwd: dirname(canonical),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      })
    } catch {
      reject(new JavaRuntimeError('probe-failed', 'The Java runtime did not start successfully.'))
      return
    }
    let captured = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolveOutput(captured)
    }
    const collect = (chunk: Buffer) => {
      captured += chunk.toString('utf8')
      if (captured.length > 16_384) {
        child.kill('SIGKILL')
        finish(new JavaRuntimeError('probe-failed', 'The Java runtime produced too much version output.'))
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', () => finish(new JavaRuntimeError('probe-failed', 'The Java runtime did not start successfully.')))
    child.once('close', (code) => {
      if (settled) return
      if (code !== 0) finish(new JavaRuntimeError('probe-failed', 'The Java runtime version check failed.'))
      else finish()
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new JavaRuntimeError('probe-failed', 'The Java runtime did not respond to its version check.'))
    }, 2500)
    timeout.unref()
  })
  const parsed = parseRuntime(output)
  if (!parsed) throw new JavaRuntimeError('probe-failed', 'The executable did not report a recognizable Java version.')
  return { path: canonical, ...parsed, source: 'custom' }
}

export async function inspectJavaRuntime(path: string, source: 'discovered' | 'custom' = 'custom'): Promise<JavaRuntime> {
  if (!isAbsolute(path) || path.length > 1024) throw new JavaRuntimeError('invalid-path', 'Enter an absolute Java executable path.')
  const runtime = await runJavaVersion(resolve(path))
  return { ...runtime, source }
}

export async function discoverJavaRuntimes(env: NodeJS.ProcessEnv = process.env): Promise<JavaRuntime[]> {
  const candidates = new Set<string>()
  const home = env['JAVA_HOME']
  if (home && isAbsolute(home)) candidates.add(join(home, 'bin', 'java'))
  for (const path of ['/usr/bin/java', '/usr/local/bin/java', '/bin/java']) candidates.add(path)
  const roots = new Set(['/usr/lib/jvm', '/opt/java', '/usr/java', join(homedir(), '.sdkman', 'candidates', 'java')])
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) candidates.add(join(root, entry.name, 'bin', 'java'))
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT' && error.code !== 'EACCES') throw error
    }
  }
  const runtimes = new Map<string, JavaRuntime>()
  for (const candidate of [...candidates].slice(0, 128)) {
    try {
      const runtime = await inspectJavaRuntime(candidate, 'discovered')
      runtimes.set(runtime.path, runtime)
    } catch (error) {
      if (!(error instanceof JavaRuntimeError)) throw error
    }
  }
  return [...runtimes.values()].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path))
}
