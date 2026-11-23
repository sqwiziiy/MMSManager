import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

export const MAX_AVATAR_BYTES = 1_048_576
export const MAX_AVATAR_SIDE = 1024

export class InvalidAvatarError extends Error {
  constructor(readonly reason: 'size' | 'format' | 'dimensions' | 'decode') {
    super(reason)
  }
}

export class AvatarStore {
  readonly directory: string

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, 'avatars')
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  async save(input: Buffer): Promise<string> {
    if (input.byteLength === 0 || input.byteLength > MAX_AVATAR_BYTES) throw new InvalidAvatarError('size')
    let encoded: Buffer
    try {
      const image = sharp(input, { failOn: 'error', limitInputPixels: MAX_AVATAR_SIDE * MAX_AVATAR_SIDE, animated: false })
      const metadata = await image.metadata()
      if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format)) throw new InvalidAvatarError('format')
      if (!metadata.width || !metadata.height || metadata.width > MAX_AVATAR_SIDE || metadata.height > MAX_AVATAR_SIDE || (metadata.pages ?? 1) !== 1) {
        throw new InvalidAvatarError('dimensions')
      }
      encoded = await image.rotate().resize({ width: 256, height: 256, fit: 'cover', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer()
    } catch (error) {
      if (error instanceof InvalidAvatarError) throw error
      throw new InvalidAvatarError('decode')
    }
    const key = randomBytes(16).toString('hex')
    const path = this.pathFor(key)
    await writeFile(path, encoded, { flag: 'wx', mode: 0o600 })
    await chmod(path, 0o600)
    return key
  }

  async read(key: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{32}$/.test(key)) return null
    try { return await readFile(this.pathFor(key)) } catch { return null }
  }

  async remove(key: string | null): Promise<void> {
    if (!key || !/^[a-f0-9]{32}$/.test(key)) return
    try { await unlink(this.pathFor(key)) } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }

  private pathFor(key: string): string {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid avatar key')
    return join(this.directory, `${key}.webp`)
  }
}
