import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'

const dataDirectory = mkdtempSync(join(tmpdir(), 'mmsmanager-stage3-e2e-'))
const env = {
  ...process.env,
  MMSMANAGER_DATA_DIR: dataDirectory,
  MMSMANAGER_E2E_ADMIN_PASSWORD: `${randomBytes(24).toString('base64url')}Aa1!`,
  MMSMANAGER_E2E_MEMBER_PASSWORD: `${randomBytes(24).toString('base64url')}Bb2!`,
}

try {
  const code = await new Promise((resolve, reject) => {
    const args = process.argv.slice(2).filter((argument) => argument !== '--')
    const child = spawn('pnpm', ['exec', 'playwright', 'test', ...args], { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (status, signal) => resolve(signal ? 1 : status ?? 1))
  })
  process.exitCode = code
} finally {
  rmSync(dataDirectory, { recursive: true, force: true })
}
