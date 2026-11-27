export type ServerPropertySoftware = 'vanilla' | 'fabric' | 'paper' | 'forge' | 'neoforge'
export type ServerPropertyCategory = 'gameplay' | 'world' | 'limits' | 'status' | 'resources' | 'network'
export type ServerPropertyKind = 'boolean' | 'integer' | 'text' | 'json' | 'enum'

export type ServerPropertyCatalogEntry = {
  key: string
  label: string
  description: string
  category: ServerPropertyCategory
  kind: ServerPropertyKind
  defaultValue: string
  minimumMinecraftVersion: string
  software: readonly ServerPropertySoftware[]
  minimum?: number
  maximum?: number
  suffix?: string
  options?: readonly string[]
  softwareOptions?: Partial<Record<ServerPropertySoftware, readonly string[]>>
  risk?: 'world-generation' | 'level-name' | 'resource-pack' | 'game-port'
}

const allJavaSoftware = ['vanilla', 'fabric', 'paper', 'forge', 'neoforge'] as const
const baseline = '1.20.1'

// Conservative editable subset of Java server.properties documented by Mojang/Paper.
// Properties absent from the running server retain their native defaults until an override is saved.
export const serverPropertiesCatalog = [
  { key: 'allow-flight', label: 'Allow flight', description: 'Do not kick players for flying in Survival mode.', category: 'gameplay', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'enable-command-block', label: 'Command blocks', description: 'Allow command blocks to execute commands in this server.', category: 'gameplay', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'force-gamemode', label: 'Force default game mode', description: 'Set players to the configured default game mode when they join.', category: 'gameplay', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'hardcore', label: 'Hardcore', description: 'Put players into Spectator mode after death.', category: 'gameplay', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'enforce-secure-profile', label: 'Require secure player profiles', description: 'Require a Mojang-signed public key for player connections.', category: 'gameplay', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'op-permission-level', label: 'Operator command level', description: 'Default command permission level for Minecraft operators; this does not change MMSManager account roles.', category: 'gameplay', kind: 'integer', defaultValue: '4', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 0, maximum: 4 },
  { key: 'function-permission-level', label: 'Function command level', description: 'Default command permission level used by functions.', category: 'gameplay', kind: 'integer', defaultValue: '2', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 1, maximum: 4 },
  { key: 'spawn-animals', label: 'Spawn animals', description: 'Allow passive animal spawning.', category: 'gameplay', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'spawn-monsters', label: 'Spawn monsters', description: 'Allow hostile monster spawning.', category: 'gameplay', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'spawn-npcs', label: 'Spawn villagers', description: 'Allow villager and other NPC spawning.', category: 'gameplay', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'generate-structures', label: 'Generate structures', description: 'Generate structures in newly created chunks.', category: 'world', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware, risk: 'world-generation' },
  { key: 'level-name', label: 'World folder name', description: 'Select the world folder used by the server; changing it does not move or delete world data.', category: 'world', kind: 'text', defaultValue: 'world', minimumMinecraftVersion: baseline, software: allJavaSoftware, risk: 'level-name' },
  { key: 'level-seed', label: 'World seed', description: 'Seed used when a world is first generated; existing terrain is unchanged.', category: 'world', kind: 'text', defaultValue: '', minimumMinecraftVersion: baseline, software: allJavaSoftware, risk: 'world-generation' },
  { key: 'level-type', label: 'World type', description: 'Generator type for newly generated worlds and chunks.', category: 'world', kind: 'enum', defaultValue: 'minecraft:normal', minimumMinecraftVersion: baseline, software: allJavaSoftware, options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'], risk: 'world-generation' },
  { key: 'generator-settings', label: 'Generator settings', description: 'JSON used to configure world generation.', category: 'world', kind: 'json', defaultValue: '{}', minimumMinecraftVersion: baseline, software: allJavaSoftware, risk: 'world-generation' },
  { key: 'max-tick-time', label: 'Maximum tick time', description: 'Watchdog time limit for one server tick; −1 disables the watchdog.', category: 'limits', kind: 'integer', defaultValue: '60000', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: -1, maximum: 3600000, suffix: 'ms' },
  { key: 'max-world-size', label: 'Maximum world radius', description: 'Limit for world border expansion in blocks.', category: 'limits', kind: 'integer', defaultValue: '29999984', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 1, maximum: 29999984, suffix: 'blocks' },
  { key: 'max-chained-neighbor-updates', label: 'Chained block updates', description: 'Limit consecutive neighbor updates; a negative value disables the limit.', category: 'limits', kind: 'integer', defaultValue: '1000000', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: -1, maximum: 1000000000 },
  { key: 'entity-broadcast-range-percentage', label: 'Entity broadcast range', description: 'Scale the distance at which entities are sent to players.', category: 'limits', kind: 'integer', defaultValue: '100', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 10, maximum: 1000, suffix: '%' },
  { key: 'network-compression-threshold', label: 'Packet compression threshold', description: 'Compress packets at or above this size; −1 disables compression.', category: 'limits', kind: 'integer', defaultValue: '256', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: -1, maximum: 65535, suffix: 'bytes' },
  { key: 'player-idle-timeout', label: 'Idle player timeout', description: 'Kick idle players after this many minutes; 0 disables the timeout.', category: 'limits', kind: 'integer', defaultValue: '0', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 0, maximum: 10080, suffix: 'minutes' },
  { key: 'rate-limit', label: 'Packet rate limit', description: 'Maximum packet rate before a player is disconnected; 0 disables the limit.', category: 'limits', kind: 'integer', defaultValue: '0', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 0, maximum: 10000 },
  { key: 'enable-status', label: 'Server list status', description: 'Show server status in the multiplayer server list.', category: 'status', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'hide-online-players', label: 'Hide player list in status', description: 'Hide the player list returned by a server status request.', category: 'status', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'prevent-proxy-connections', label: 'Prevent proxy connections', description: 'Reject connections with a mismatched authentication network provider.', category: 'status', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'enforce-whitelist', label: 'Enforce the whitelist', description: 'Disconnect players who are not listed on the server whitelist.', category: 'status', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'sync-chunk-writes', label: 'Synchronous chunk writes', description: 'Write chunk data synchronously; changing this can affect performance and durability.', category: 'world', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'use-native-transport', label: 'Native network transport', description: 'Use the native Linux transport where available.', category: 'network', kind: 'boolean', defaultValue: 'true', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'server-port', label: 'Game connection port', description: 'TCP port used for player connections; other registered servers and local listeners are checked before saving.', category: 'network', kind: 'integer', defaultValue: '25565', minimumMinecraftVersion: baseline, software: allJavaSoftware, minimum: 1, maximum: 65535, risk: 'game-port' },
  { key: 'resource-pack', label: 'Resource pack URL', description: 'HTTPS or HTTP URL served to players as a resource pack.', category: 'resources', kind: 'text', defaultValue: '', minimumMinecraftVersion: baseline, software: allJavaSoftware, risk: 'resource-pack' },
  { key: 'resource-pack-sha1', label: 'Resource pack SHA-1', description: '40-character SHA-1 checksum for the resource pack download.', category: 'resources', kind: 'text', defaultValue: '', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'resource-pack-prompt', label: 'Resource pack prompt', description: 'Message displayed when players are asked to download the resource pack.', category: 'resources', kind: 'text', defaultValue: '', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'require-resource-pack', label: 'Require resource pack', description: 'Disconnect players who decline the resource pack.', category: 'resources', kind: 'boolean', defaultValue: 'false', minimumMinecraftVersion: baseline, software: allJavaSoftware },
  { key: 'region-file-compression', label: 'Region file compression', description: 'Choose compression for future region writes. Existing chunks are not rewritten; Paper also allows gzip.', category: 'world', kind: 'enum', defaultValue: 'deflate', minimumMinecraftVersion: '1.20.5', software: allJavaSoftware, options: ['deflate', 'lz4', 'none'], softwareOptions: { paper: ['gzip'] } },
] as const satisfies readonly ServerPropertyCatalogEntry[]

export type ServerPropertyCatalogKey = typeof serverPropertiesCatalog[number]['key']

export function compareMinecraftVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) if (a[index]! !== b[index]!) return a[index]! - b[index]!
  return 0
}

export function serverPropertyAvailable(entry: ServerPropertyCatalogEntry, software: string, version: string): boolean {
  return entry.software.includes(software as ServerPropertySoftware)
    && compareMinecraftVersions(version, entry.minimumMinecraftVersion) !== null
    && compareMinecraftVersions(version, entry.minimumMinecraftVersion)! >= 0
}
