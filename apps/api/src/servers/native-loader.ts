import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { InstallSoftware, ServerSoftware } from '@mmsmanager/shared'

const MAX_ARGUMENT_FILE_BYTES = 2 * 1024 * 1024
const MAX_INSTALL_DIRECTORIES = 200

export type NativeLoader = 'forge' | 'neoforge'
export type ServerLaunchConfiguration = { kind: 'jar'; jarName: string } | { kind: 'argfile'; argsFile: string }
export type NativeLoaderDetection = { software: NativeLoader; loaderVersion: string; launch: ServerLaunchConfiguration }

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function versionDirectory(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(value) }
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function detectNativeLoaderFromArchivePaths(paths: string[]): { software: NativeLoader; loaderVersion: string } | null {
  const found = new Map<string, NativeLoaderDetection['software']>()
  for (const path of paths) {
    const match = /^libraries\/(net\/minecraftforge\/forge|net\/neoforged\/(?:neoforge|forge))\/([^/]+)\/unix_args\.txt$/i.exec(path)
    if (!match || !versionDirectory(match[2]!)) continue
    const software: NativeLoader = match[1]!.toLowerCase().includes('minecraftforge') ? 'forge' : 'neoforge'
    found.set(`${software}:${match[2]}`, software)
  }
  if (found.size !== 1) return null
  const [key, software] = [...found.entries()][0]!
  return { software, loaderVersion: key.slice(key.indexOf(':') + 1) }
}

export function nativeLoaderMinecraftVersion(software: NativeLoader, loaderVersion: string): string | null {
  if (software === 'forge') return /^(\d{1,3}(?:\.\d{1,3}){1,3})-/.exec(loaderVersion)?.[1] ?? null
  const legacy = /^(1\.20\.1)-/.exec(loaderVersion)
  if (legacy) return legacy[1] ?? null
  const parts = loaderVersion.split(/[-+]/, 1)[0]!.split('.').map(Number)
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part))) return null
  if (parts[0]! >= 20 && parts[0]! <= 21) return parts[1] === 0 ? `1.${parts[0]}` : `1.${parts[0]}.${parts[1]}`
  if (parts[0]! >= 26) return parts.length >= 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : `${parts[0]}.${parts[1]}`
  return null
}

async function validateArgfile(root: string, argsFile: string): Promise<void> {
  const safeRelative = argsFile.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..') && !isAbsolute(argsFile)
  if (!safeRelative || !argsFile.endsWith('/unix_args.txt')) throw new Error('The loader argument file path is invalid.')
  const path = join(root, argsFile)
  const fileStat = await lstat(path)
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || fileStat.size < 1 || fileStat.size > MAX_ARGUMENT_FILE_BYTES) {
    throw new Error('The loader argument file is missing, oversized or unsafe.')
  }
  const canonical = await realpath(path)
  if (!inside(root, canonical)) throw new Error('The loader argument file resolves outside its server directory.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const content = await handle.readFile('utf8')
    const containsUnsupportedControl = [...content].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)
    })
    if (Buffer.byteLength(content, 'utf8') > MAX_ARGUMENT_FILE_BYTES || containsUnsupportedControl) {
      throw new Error('The loader argument file contains unsupported content.')
    }
    const tokens = content.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) ?? []
    for (const token of tokens) {
      const value = token.replace(/^['"]|['"]$/g, '')
      if (value.startsWith('@') || /^-(?:javaagent|agentlib|agentpath|Xbootclasspath|Djava\.system\.class\.loader|Djava\.security\.manager)(?::|=|$)/i.test(value)
        || /^-XX:(?:OnError|OnOutOfMemoryError|ErrorFile|HeapDumpPath|HeapDumpOnOutOfMemoryError|InitialHeapSize|MaxHeapSize|MaxRAM(?:Percentage)?|MaxDirectMemorySize)(?:=|$)/i.test(value)
        || /^-X(?:ms|mx|ss|oss|mn)\d/i.test(value)
        || /^--(?:patch-module|upgrade-module-path)(?:=|$)/i.test(value)
        || /^-(?:jar|cp|classpath)$|^--class-path(?:=|$)/i.test(value)) {
        throw new Error('The loader argument file requests a nested file, executable JVM hook, launch override, or unrestricted memory setting.')
      }
      if (/(?:^|[=:])[A-Za-z]:[\\/]|(?:^|[=:])\/(?:[^\s])/u.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
        throw new Error('The loader argument file references a path outside the managed server folder.')
      }
    }
    if (!tokens.some((token) => /^(?:cpw\.mods\.bootstraplauncher\.BootstrapLauncher|cpw\.mods\.bootstraplauncher\/cpw\.mods\.bootstraplauncher\.Bootstrap(?:Launcher)?)$/i.test(token.replace(/^['"]|['"]$/g, '')))) {
      throw new Error('The loader argument file does not identify a supported Minecraft loader entry point.')
    }
  } finally { await handle.close() }
}

async function directoryVersions(root: string, relativeDirectory: string): Promise<string[]> {
  const parent = join(root, relativeDirectory)
  try {
    const parentStat = await lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return []
    const entries = await readdir(parent, { withFileTypes: true })
    if (entries.length > MAX_INSTALL_DIRECTORIES) throw new Error('The installed loader has too many candidate versions.')
    return entries.filter((entry) => entry.isDirectory() && versionDirectory(entry.name)).map((entry) => entry.name)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

export async function detectNativeLoader(directory: string, requested?: InstallSoftware): Promise<NativeLoaderDetection | null> {
  const root = await realpath(directory)
  const definitions: Array<{ software: NativeLoader; folder: string }> = [
    { software: 'forge', folder: 'libraries/net/minecraftforge/forge' },
    { software: 'neoforge', folder: 'libraries/net/neoforged/neoforge' },
    { software: 'neoforge', folder: 'libraries/net/neoforged/forge' },
  ]
  const candidates: NativeLoaderDetection[] = []
  for (const definition of definitions) {
    if (requested && definition.software !== requested) continue
    for (const loaderVersion of await directoryVersions(root, definition.folder)) {
      const argsFile = `${definition.folder}/${loaderVersion}/unix_args.txt`
      try {
        await validateArgfile(root, argsFile)
        candidates.push({ software: definition.software, loaderVersion, launch: { kind: 'argfile', argsFile } })
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue
        throw error
      }
    }
  }
  if (candidates.length !== 1) return null
  return candidates[0]!
}

export async function resolveNativeLaunch(directory: string, software: NativeLoader, jarName: string | null): Promise<ServerLaunchConfiguration> {
  const detected = await detectNativeLoader(directory, software)
  if (detected) return detected.launch
  if (jarName && /^[A-Za-z0-9][A-Za-z0-9._ -]*\.jar$/.test(jarName)) {
    const path = join(directory, jarName)
    const stat = await lstat(path).catch(() => null)
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0) return { kind: 'jar', jarName }
  }
  throw new Error('No safe Forge or NeoForge server argument file or executable server JAR was found.')
}

export function isNativeLoader(software: ServerSoftware | string | null | undefined): software is NativeLoader {
  return software === 'forge' || software === 'neoforge'
}
