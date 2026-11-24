import { describe, expect, it } from 'vitest'
import { getWebOrigin } from './config.js'

describe('configured browser origin', () => {
  it('keeps the loopback default and accepts one exact HTTPS origin for a reverse proxy', () => {
    expect(getWebOrigin({ MMSMANAGER_WEB_PORT: '5183' } as NodeJS.ProcessEnv)).toBe('http://127.0.0.1:5183')
    expect(getWebOrigin({ MMSMANAGER_WEB_ORIGIN: 'https://panel.example.test' } as NodeJS.ProcessEnv)).toBe('https://panel.example.test')
    expect(getWebOrigin({ MMSMANAGER_WEB_ORIGIN: 'https://panel.example.test:8443' } as NodeJS.ProcessEnv)).toBe('https://panel.example.test:8443')
  })

  it('rejects non-loopback HTTP, paths and wildcard origins', () => {
    expect(() => getWebOrigin({ MMSMANAGER_WEB_ORIGIN: 'http://panel.example.test' } as NodeJS.ProcessEnv)).toThrow('must use HTTPS')
    expect(() => getWebOrigin({ MMSMANAGER_WEB_ORIGIN: 'https://panel.example.test/app' } as NodeJS.ProcessEnv)).toThrow('exact HTTP or HTTPS origin')
    expect(() => getWebOrigin({ MMSMANAGER_WEB_ORIGIN: 'https://*' } as NodeJS.ProcessEnv)).toThrow()
  })
})
