export type ServerStatus = 'Online' | 'Offline' | 'Starting'

export type ServerRecord = {
  id: string
  name: string
  software: string
  version: string
  status: ServerStatus
  players: number
  capacity: number
  memoryUsed: number
  memoryTotal: number
  uptime: string
  address: string
  world: string
  accent: string
}

export const servers: ServerRecord[] = [
  {
    id: 'alder-smp',
    name: 'Alder SMP',
    software: 'Fabric',
    version: '1.21.4',
    status: 'Online',
    players: 18,
    capacity: 40,
    memoryUsed: 5.2,
    memoryTotal: 8,
    uptime: '12d 08h',
    address: 'play.alder.example',
    world: 'Overworld',
    accent: 'moss',
  },
  {
    id: 'copper-grove',
    name: 'Copper Grove',
    software: 'Paper',
    version: '1.21.4',
    status: 'Online',
    players: 6,
    capacity: 20,
    memoryUsed: 2.4,
    memoryTotal: 6,
    uptime: '4d 19h',
    address: 'grove.example',
    world: 'The Grove',
    accent: 'stone',
  },
  {
    id: 'test-dimension',
    name: 'Test Dimension',
    software: 'NeoForge',
    version: '1.20.1',
    status: 'Offline',
    players: 0,
    capacity: 12,
    memoryUsed: 0,
    memoryTotal: 6,
    uptime: 'Stopped',
    address: 'not published',
    world: 'Test world',
    accent: 'clay',
  },
]

export type ActivityRecord = {
  id: string
  server: string
  event: string
  detail: string
  time: string
  tone: 'neutral' | 'good' | 'warn'
}

export const activities: ActivityRecord[] = [
  { id: 'a1', server: 'Alder SMP', event: 'Player joined', detail: 'MiraWoods joined the world', time: '2 min ago', tone: 'good' },
  { id: 'a2', server: 'Copper Grove', event: 'Backup completed', detail: 'Scheduled snapshot · 842 MB', time: '18 min ago', tone: 'neutral' },
  { id: 'a3', server: 'Alder SMP', event: 'Server started', detail: 'Fabric 1.21.4 · demo event', time: 'Today, 09:12', tone: 'good' },
  { id: 'a4', server: 'Test Dimension', event: 'Server stopped', detail: 'Manual stop · sample history', time: 'Yesterday, 21:40', tone: 'warn' },
]

export const mockLogs = [
  { time: '14:42:18', level: 'INFO', message: 'MiraWoods joined the game', source: 'Server thread' },
  { time: '14:41:03', level: 'INFO', message: 'Saving chunks for level "Overworld"', source: 'Server thread' },
  { time: '14:39:51', level: 'WARN', message: "Can't keep up! Is the server overloaded?", source: 'Server thread' },
  { time: '14:36:24', level: 'INFO', message: 'RiverOtter has made the advancement [Into the Nether]', source: 'Server thread' },
  { time: '14:32:09', level: 'INFO', message: 'Loaded 246 advancements', source: 'Server thread' },
  { time: '14:30:42', level: 'INFO', message: 'Preparing spawn area: 100%', source: 'Server thread' },
  { time: '14:30:08', level: 'INFO', message: 'Starting Minecraft server on *:25565', source: 'Server thread' },
]

export const mockMods = [
  { name: 'Lithium', version: '0.14.5', author: 'CaffeineMC', category: 'Performance', enabled: true },
  { name: 'Sodium', version: '0.6.9', author: 'CaffeineMC', category: 'Performance', enabled: true },
  { name: 'FerriteCore', version: '7.1.0', author: 'malte0811', category: 'Memory', enabled: true },
  { name: 'Simple Voice Chat', version: '2.5.26', author: 'henkelmax', category: 'Utility', enabled: true },
  { name: 'Waystones', version: '21.4.1', author: 'BlayTheNinth', category: 'Gameplay', enabled: false },
]

export type MockUser = { name: string; email: string; role: 'Administrator' | 'Member'; lastSeen: string; initials: string }

export const mockUsers: MockUser[] = [
  { name: 'Alex Mercer', email: 'alex@example.test', role: 'Administrator', lastSeen: 'Active now', initials: 'AM' },
  { name: 'Mira Woods', email: 'mira@example.test', role: 'Member', lastSeen: '12 min ago', initials: 'MW' },
  { name: 'Jonah Reed', email: 'jonah@example.test', role: 'Member', lastSeen: 'Yesterday', initials: 'JR' },
]

export const cpuSeries = [21, 18, 24, 30, 27, 35, 32, 28, 42, 38, 35, 31, 44, 39, 36, 49, 42, 38, 32, 36, 30, 27, 35, 34]

export function getServerSummary(items: ServerRecord[] = servers) {
  return {
    total: items.length,
    online: items.filter((server) => server.status === 'Online').length,
    players: items.reduce((count, server) => count + server.players, 0),
    allocatedMemory: items.reduce((total, server) => total + server.memoryTotal, 0),
  }
}

export function formatMemory(value: number) {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} GB`
}
