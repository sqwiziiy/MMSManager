import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'drizzle-kit'

const stateHome = process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state')
const dataDirectory = process.env['MMSMANAGER_DATA_DIR'] || join(stateHome, 'mmsmanager')

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: join(dataDirectory, 'mmsmanager.sqlite') },
})
