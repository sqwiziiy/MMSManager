import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectNativeLoader, detectNativeLoaderFromArchivePaths, nativeLoaderMinecraftVersion, resolveNativeLaunch } from './native-loader.js'

const temps: string[] = []
async function serverFixture() {
  const root = await mkdtemp(join(tmpdir(), 'mms-native-loader-'))
  temps.push(root)
  return root
}
afterEach(async () => { await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('native Forge and NeoForge launch detection', () => {
  it('detects Forge and NeoForge argument-file layouts and preserves the launch strategy', async () => {
    const forgeRoot = await serverFixture()
    const forgeArgs = ' -p libraries/org/ow2/asm/asm/9.6/asm-9.6.jar\n-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap --launchTarget forgeserver\n'
    const forgePath = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt'
    await mkdir(join(forgeRoot, forgePath, '..'), { recursive: true })
    await writeFile(join(forgeRoot, forgePath), forgeArgs)
    await expect(detectNativeLoader(forgeRoot)).resolves.toEqual({ software: 'forge', loaderVersion: '1.20.1-47.2.0', launch: { kind: 'argfile', argsFile: forgePath } })
    await expect(resolveNativeLaunch(forgeRoot, 'forge', null)).resolves.toEqual({ kind: 'argfile', argsFile: forgePath })

    const neoRoot = await serverFixture()
    const neoPath = 'libraries/net/neoforged/neoforge/21.1.184/unix_args.txt'
    await mkdir(join(neoRoot, neoPath, '..'), { recursive: true })
    await writeFile(join(neoRoot, neoPath), '-p libraries/net/neoforged/fancymod/1.0/fancymod.jar\n-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap --launchTarget neoforgeserver\n')
    await expect(detectNativeLoader(neoRoot)).resolves.toMatchObject({ software: 'neoforge', loaderVersion: '21.1.184', launch: { kind: 'argfile', argsFile: neoPath } })
    expect(nativeLoaderMinecraftVersion('neoforge', '21.1.184')).toBe('1.21.1')
  })

  it('recognizes Forge 1.20.1 archive paths and rejects ambiguous or untrusted layouts', async () => {
    expect(detectNativeLoaderFromArchivePaths(['server.properties', 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt']))
      .toEqual({ software: 'forge', loaderVersion: '1.20.1-47.2.0' })
    expect(detectNativeLoaderFromArchivePaths([
      'libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt',
      'libraries/net/neoforged/neoforge/21.1.184/unix_args.txt',
    ])).toBeNull()
    expect(detectNativeLoaderFromArchivePaths(['libraries/net/neoforged/neoforge/../../x/unix_args.txt'])).toBeNull()
  })

  it('rejects argument-file traversal, executable JVM hooks, nested argfiles, symlinks and oversized files', async () => {
    const root = await serverFixture()
    const argsPath = 'libraries/net/neoforged/neoforge/21.1.184/unix_args.txt'
    await mkdir(join(root, argsPath, '..'), { recursive: true })
    const fullPath = join(root, argsPath)
    for (const unsafe of [
      '@nested_args.txt -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-javaagent:agent.jar -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-XX:OnError=sh -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-Xmx256G -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-jar rogue.jar -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-Djava.security.manager=allow -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-Dconfig.file=/etc/passwd -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
      '-cp ../outside.jar -m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap',
    ]) {
      await writeFile(fullPath, unsafe)
      await expect(detectNativeLoader(root, 'neoforge')).rejects.toThrow(/argument file|executable JVM hook|outside/)
    }
    const outside = join(root, 'outside.txt')
    await writeFile(outside, '-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap')
    await rm(fullPath)
    await symlink(outside, fullPath)
    await expect(detectNativeLoader(root, 'neoforge')).rejects.toThrow(/argument file|unsafe/)
    await rm(fullPath)
    await writeFile(fullPath, `-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap ${'x'.repeat(2 * 1024 * 1024)}`)
    await expect(detectNativeLoader(root, 'neoforge')).rejects.toThrow(/oversized|unsafe/)
  })

  it('keeps executable JAR fallback for legacy layouts', async () => {
    const root = await serverFixture()
    await writeFile(join(root, 'forge-server.jar'), 'jar')
    await expect(resolveNativeLaunch(root, 'forge', 'forge-server.jar')).resolves.toEqual({ kind: 'jar', jarName: 'forge-server.jar' })
  })
})
