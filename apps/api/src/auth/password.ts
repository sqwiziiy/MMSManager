import { randomBytes } from 'node:crypto'
import { hash, parseOptions, verify } from '@node-rs/argon2'

export const ARGON2_POLICY = Object.freeze({
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
})

export function validatePasswordBytes(password: string): boolean {
  return Buffer.byteLength(password, 'utf8') <= 512
}

export async function hashPassword(password: string): Promise<string> {
  if (!validatePasswordBytes(password)) throw new Error('Password exceeds the supported UTF-8 length')
  return hash(password, { ...ARGON2_POLICY, salt: randomBytes(16) })
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (!validatePasswordBytes(password)) return false
  try {
    const parameters = parseOptions(passwordHash)
    if (parameters.algorithm !== 2) return false
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

export async function makeDummyPasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64url'))
}
