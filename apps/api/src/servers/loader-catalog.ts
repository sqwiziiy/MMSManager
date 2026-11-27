const MAX_MAVEN_METADATA_BYTES = 2 * 1024 * 1024

export type LoaderCatalogSelection = { stable: string[]; experimental: string[] }

function validVersion(value: string): boolean {
  // Maven coordinates include loader-specific suffixes, for example Forge's
  // 1.20.1-47.1.106 as well as NeoForge's 21.1.200.
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(value)
}

export function parseMavenMetadata(xml: string): string[] {
  if (Buffer.byteLength(xml, 'utf8') > MAX_MAVEN_METADATA_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('Official Maven metadata is oversized or contains unsupported declarations.')
  }
  if (!/<metadata(?:\s[^>]*)?>[\s\S]*<versioning>[\s\S]*<versions>[\s\S]*<\/versions>[\s\S]*<\/versioning>[\s\S]*<\/metadata>/.test(xml)) {
    throw new Error('Official Maven metadata did not contain a valid version list.')
  }
  const section = xml.match(/<versions>([\s\S]*?)<\/versions>/)?.[1]
  if (section === undefined) throw new Error('Official Maven metadata did not contain a valid version list.')
  const versions = [...section.matchAll(/<version>([^<>]{1,100})<\/version>/g)].map((match) => match[1]!.trim())
  if (versions.length > 50_000 || versions.some((version) => !validVersion(version))) {
    throw new Error('Official Maven metadata returned invalid version identifiers.')
  }
  return [...new Set(versions)]
}

export function compareLoaderVersions(left: string, right: string): number {
  const tokens = (value: string) => value.toLowerCase().match(/[0-9]+|[a-z]+/g) ?? []
  const a = tokens(left)
  const b = tokens(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index]
    const rightPart = b[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return rightPart && /^[a-z]+$/.test(rightPart) ? 1 : -1
    if (rightPart === undefined) return /^[a-z]+$/.test(leftPart) ? -1 : 1
    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) return Number(leftPart) - Number(rightPart)
    if (leftNumber !== rightNumber) return leftNumber ? 1 : -1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

export function parseForgePromotions(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Forge promotions metadata is invalid.')
  const promos = (value as Record<string, unknown>)['promos']
  if (typeof promos !== 'object' || promos === null || Array.isArray(promos)) throw new Error('Forge promotions metadata is invalid.')
  const result: Record<string, string> = {}
  for (const [key, version] of Object.entries(promos as Record<string, unknown>)) {
    if (!/^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}-(?:latest|recommended)$/.test(key) || typeof version !== 'string' || !validVersion(version)) continue
    result[key] = version
  }
  return result
}

export function forgeGameVersions(releaseVersions: string[], promotions: Record<string, string>): string[] {
  return releaseVersions.filter((version) => Boolean(promotions[`${version}-latest`] || promotions[`${version}-recommended`]))
}

export function forgeLoaderVersions(
  minecraftVersion: string,
  promotions: Record<string, string>,
  mavenVersions: string[],
): LoaderCatalogSelection {
  const recommended = promotions[`${minecraftVersion}-recommended`]
  const latest = promotions[`${minecraftVersion}-latest`]
  const exists = (version: string | undefined) => Boolean(version && mavenVersions.includes(`${minecraftVersion}-${version}`))
  const stable = exists(recommended) ? [recommended!] : []
  const experimental = exists(latest) && latest !== recommended ? [latest!] : []
  return { stable, experimental }
}

function numericPrefix(version: string): number[] {
  const numeric = version.split(/[-+]/, 1)[0]!
  return numeric.split('.').map((part) => Number(part))
}

function normalizedMinecraftVersion(version: string): number[] | null {
  if (!/^[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}$/.test(version)) return null
  const parts = version.split('.').map(Number)
  return parts[0] === 1 ? parts.slice(1) : parts
}

/** Match NeoForge's version prefix to the current official release list, including its omitted leading 1 and 1.21.0 convention. */
export function neoForgeMinecraftVersion(loaderVersion: string, gameVersions: string[]): string | null {
  const legacy = /^(1\.20\.1)-([0-9]+(?:\.[0-9]+){1,3})(?:[-+][A-Za-z0-9.-]+)?$/.exec(loaderVersion)
  if (legacy) return gameVersions.includes(legacy[1]!) ? legacy[1]! : null
  const loaderParts = numericPrefix(loaderVersion)
  if (loaderParts.length < 3) return null
  const matches = gameVersions.flatMap((gameVersion) => {
    const gameParts = normalizedMinecraftVersion(gameVersion)
    if (!gameParts) return []
    const compatible = gameParts.length >= 2
      ? gameParts[0] === loaderParts[0] && gameParts[1] === loaderParts[1]
      : gameParts[0] === loaderParts[0] && loaderParts[1] === 0
    if (!compatible) return []
    return [{ gameVersion, length: gameParts.length }]
  }).sort((a, b) => b.length - a.length)
  if (!matches.length) return null
  const mostSpecificLength = matches[0]!.length
  const best = matches.filter((match) => match.length === mostSpecificLength)
  return best.length === 1 ? best[0]!.gameVersion : null
}

export function isExperimentalLoaderVersion(version: string): boolean {
  return /(?:^|[-+.])(?:alpha|beta|snapshot|pre|rc|experimental)(?:$|[-+.\d])/i.test(version)
}

export function neoForgeLoaderVersions(
  minecraftVersion: string,
  modernMavenVersions: string[],
  legacyMavenVersions: string[],
  gameVersions: string[],
): LoaderCatalogSelection {
  const available = [
    ...modernMavenVersions.filter((version) => neoForgeMinecraftVersion(version, gameVersions) === minecraftVersion),
    ...legacyMavenVersions.filter((version) => neoForgeMinecraftVersion(version, gameVersions) === minecraftVersion),
  ].sort(compareLoaderVersions)
  return {
    stable: available.filter((version) => !isExperimentalLoaderVersion(version)).reverse().slice(0, 100),
    experimental: available.filter(isExperimentalLoaderVersion).reverse().slice(0, 100),
  }
}
