import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, apiRequestHeaders, ApiRequestError } from './client'

const passthrough = { parse: (value: unknown) => value }

function reply(status: number, payload: unknown): Response {
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: payload === null ? undefined : { 'content-type': 'application/json' },
  })
}

describe('central API request handling', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  let sessionExpired: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('document', { cookie: 'mmsmanager_csrf=csrf%2Bvalue' })
    const browserEvents = new EventTarget()
    sessionExpired = vi.fn()
    browserEvents.addEventListener('mmsmanager:session-expired', sessionExpired)
    vi.stubGlobal('window', browserEvents)
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('applies same-origin credentials and the CSRF cookie to unsafe JSON requests', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }))
    await apiRequest('/api/v1/admin/servers', passthrough, { method: 'POST', body: '{}' })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(init.credentials).toBe('same-origin')
    expect(headers.get('x-mms-csrf')).toBe('csrf+value')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('leaves multipart boundaries to the browser and skips CSRF only for setup/login', () => {
    const form = new FormData()
    form.append('file', new Blob(['fixture']), 'fixture.txt')
    const multipartHeaders = apiRequestHeaders('/api/v1/admin/servers/abc/files', { method: 'POST', body: form })
    expect(multipartHeaders.has('content-type')).toBe(false)
    expect(multipartHeaders.get('x-mms-csrf')).toBe('csrf+value')

    expect(apiRequestHeaders('/api/v1/auth/login', { method: 'POST', body: '{}' }).has('x-mms-csrf')).toBe(false)
    expect(apiRequestHeaders('/api/v1/auth/setup', { method: 'POST', body: '{}' }).has('x-mms-csrf')).toBe(false)
  })

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [422, 'validation'],
  ] as const)('preserves backend details and classifies HTTP %s responses', async (status, kind) => {
    fetchMock.mockResolvedValue(reply(status, { error: { code: 'FIXTURE_CODE', message: 'Backend explanation' } }))
    await expect(apiRequest('/api/v1/admin/action', passthrough, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status,
      kind,
      code: 'FIXTURE_CODE',
      message: 'Backend explanation',
    })
    expect(sessionExpired).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
  })

  it('uses a shared fallback for conflicts and validation when the API has no message', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, null)).mockResolvedValueOnce(reply(422, null))
    await expect(apiRequest('/api/v1/action', passthrough, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      message: 'The item changed or conflicts with another request. Refresh and try again.',
    })
    await expect(apiRequest('/api/v1/action', passthrough, { method: 'POST', body: '{}' })).rejects.toMatchObject({
      message: 'Some values were rejected. Review them and try again.',
    })
  })

  it('does not expire the session during login or the initial auth-me probe', async () => {
    fetchMock.mockResolvedValue(reply(401, { error: { message: 'Not signed in.' } }))
    await expect(apiRequest('/api/v1/auth/login', passthrough, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ApiRequestError)
    await expect(apiRequest('/api/v1/auth/me', passthrough)).rejects.toBeInstanceOf(ApiRequestError)
    expect(sessionExpired).not.toHaveBeenCalled()
  })

  it('normalizes unreachable API failures but preserves cancellation', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expect(apiRequest('/api/v1/servers', passthrough)).rejects.toMatchObject({ status: 0, kind: 'network', code: 'API_UNAVAILABLE' })

    const cancelled = new DOMException('cancelled', 'AbortError')
    fetchMock.mockRejectedValueOnce(cancelled)
    await expect(apiRequest('/api/v1/servers', passthrough)).rejects.toBe(cancelled)
  })
})
