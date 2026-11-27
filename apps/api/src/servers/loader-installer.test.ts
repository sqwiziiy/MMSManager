import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoaderInstallerError, publishLoaderInstallerOutput } from './loader-installer.js'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mms-loader-installer-'))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('isolated official loader installer output', () => {
  it('publishes verified regular files from its private child folder without overwriting existing files', async () => {
    const root = await fixture()
    const work = join(root, '.mmsmanager-install-test')
    await mkdir(join(work, 'libraries', 'org', 'example'), { recursive: true })
    await writeFile(join(work, 'libraries', 'org', 'example', 'loader.jar'), 'loader data')
    await writeFile(join(work, 'run.sh'), '# generated')
    await expect(publishLoaderInstallerOutput(work, root)).resolves.toEqual({ files: 2, bytes: 22 })
    expect(await readFile(join(root, 'libraries', 'org', 'example', 'loader.jar'), 'utf8')).toBe('loader data')
    expect(await readFile(join(root, 'run.sh'), 'utf8')).toBe('# generated')
    await expect(readFile(work)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects output symlinks and collisions without replacing existing server files', async () => {
    const root = await fixture()
    const work = join(root, '.mmsmanager-install-test')
    await mkdir(work)
    await writeFile(join(root, 'server.properties'), 'owner content')
    await writeFile(join(work, 'server.properties'), 'attacker content')
    await expect(publishLoaderInstallerOutput(work, root)).rejects.toMatchObject({ code: 'INSTALL_OUTPUT_CONFLICT' })
    expect(await readFile(join(root, 'server.properties'), 'utf8')).toBe('owner content')

    const second = join(root, '.mmsmanager-install-next')
    await mkdir(second)
    await symlink('/etc/passwd', join(second, 'unsafe.txt'))
    await expect(publishLoaderInstallerOutput(second, root)).rejects.toBeInstanceOf(LoaderInstallerError)
    expect(await readFile(join(root, 'unsafe.txt')).catch(() => null)).toBeNull()
  })

  it('rejects a work folder that is not a direct private child', async () => {
    const root = await fixture()
    const outside = await fixture()
    await expect(publishLoaderInstallerOutput(outside, root)).rejects.toMatchObject({ code: 'INSTALL_OUTPUT_UNSAFE' })
  })
})
