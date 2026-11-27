import { afterEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/client.js'
import { users } from '../db/schema.js'
import { JavaRuntimeRegistry } from './java.js'
import { ServerRegistry } from './registry.js'
import { ServerZipImportService } from './zip-import.js'
import { randomUUID } from 'node:crypto'

const roots: string[] = []
async function fixtureArchive(files: Record<string, string>): Promise<Buffer> {
  const checksumTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1
    return crc >>> 0
  })
  const checksum = (bytes: Buffer) => {
    let crc = 0xffffffff
    for (const byte of bytes) crc = (crc >>> 8) ^ checksumTable[(crc ^ byte) & 0xff]!
    return (crc ^ 0xffffffff) >>> 0
  }
  const local: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name)
    const content = Buffer.from(value)
    const crc = checksum(content)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(crc, 14); localHeader.writeUInt32LE(content.length, 18); localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(filename.length, 26)
    local.push(localHeader, filename, content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(20, 4); centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(crc, 16); centralHeader.writeUInt32LE(content.length, 20); centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(filename.length, 28); centralHeader.writeUInt32LE(localOffset, 42)
    central.push(centralHeader, filename)
    localOffset += localHeader.length + filename.length + content.length
  }
  const centralDirectory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...local, centralDirectory, end])
}

describe('native loader ZIP import previews', () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it.each([
    ['Forge', 'forge', 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt', '1.20.1'],
    ['NeoForge', 'neoforge', 'libraries/net/neoforged/neoforge/21.1.184/unix_args.txt', '1.21.1'],
  ] as const)('recognizes an installed %s archive without requiring server.jar', async (_label, software, argsFile, version) => {
    const root = await mkdtemp(join(tmpdir(), 'mms-zip-loader-'))
    roots.push(root)
    const opened = await openDatabase({ path: join(root, 'state.sqlite') })
    const servers = new ServerRegistry(opened.db, root, { MMSMANAGER_SERVER_ROOT: join(root, 'servers') })
    await servers.prepare()
    const imports = new ServerZipImportService(opened.db, servers, new JavaRuntimeRegistry(async () => []))
    await imports.prepare()
    const actorUserId = randomUUID()
    const at = new Date().toISOString()
    await opened.db.insert(users).values({ id: actorUserId, username: `zip-loader-${actorUserId.slice(0, 8)}`, usernameKey: `zip-loader-${actorUserId.slice(0, 8)}`, displayName: 'ZIP Loader Fixture', role: 'administrator', passwordHash: 'test-only-hash', createdAt: at, updatedAt: at, passwordChangedAt: at }).run()
    const archive = await fixtureArchive({
      'server.properties': 'server-port=25569\n',
      [argsFile]: '-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap --launchTarget forgeserver\n',
      'world/level.dat': 'synthetic world metadata',
    })
    const preview = await imports.stage('loader-server.zip', Readable.from([archive]), () => false, actorUserId)
    expect(preview).toMatchObject({ software, version, jarName: null, port: 25569, worldFolders: ['world'], supported: true })
    opened.native.close()
  })
})
