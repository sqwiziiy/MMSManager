import packageMetadata from '../../../package.json'

export const appMetadata = {
  name: 'MMSManager',
  fullName: 'Mentality Minecraft Server Manager',
  version: packageMetadata.version,
  status: 'Alpha',
  developer: 'Mentality',
  authorUrl: 'https://github.com/sqwiziiy',
  repositoryUrl: 'https://github.com/sqwiziiy/MMSManager',
  licenseName: 'GNU General Public License v3.0 only',
  licenseSpdx: 'GPL-3.0-only',
  copyright: 'Copyright © 2026 Mentality',
} as const
