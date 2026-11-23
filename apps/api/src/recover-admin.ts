import { openDatabase } from './db/client.js'
import { getDataDirectory } from './config.js'
import { AuthFailure, AuthService } from './auth/service.js'

function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode || !process.stdout.isTTY) {
    return Promise.reject(new Error('Run this recovery command in a local interactive terminal.'))
  }
  process.stdout.write(prompt)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Recovery canceled.'))
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('')
        else if (character >= ' ') value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  const [username, ...rest] = process.argv.slice(2)
  if (!username || rest.length > 0 || !/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Usage: pnpm --filter @minepanel/api auth:recover -- <username>')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this recovery command in a local interactive terminal.')

  const database = await openDatabase()
  try {
    const auth = new AuthService(database.native, getDataDirectory())
    const confirmation = await readHidden(`Type RECOVER ${username} to confirm direct local administrator recovery: `)
    if (confirmation !== `RECOVER ${username}`) throw new Error('Recovery confirmation did not match.')
    const password = await readHidden('New password (input is hidden): ')
    const confirmPassword = await readHidden('Confirm new password (input is hidden): ')
    if (password !== confirmPassword) throw new Error('The passwords do not match.')
    if (password.length < 14 || password.length > 128) throw new Error('Use a password between 14 and 128 characters.')
    await auth.recoverAdministrator(username, password)
    process.stdout.write('Administrator access was recovered. All previous sessions were revoked; sign in with the new password.\n')
  } catch (error) {
    if (error instanceof AuthFailure && error.code === 'not-found') throw new Error('No local account exists with that username.')
    throw error
  } finally {
    database.native.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Local administrator recovery failed.'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
