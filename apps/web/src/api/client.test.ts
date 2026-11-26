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
    vi.stubGlobal('document', { cookie: 'mmsmanager_csrf=csrf%2Bvalue', documentElement: { lang: 'en' } })
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

  it('translates structured API failures in Russian and hides unknown server wording', async () => {
    const documentFixture = document as unknown as { documentElement: { lang: string } }
    documentFixture.documentElement.lang = 'ru'
    fetchMock.mockResolvedValueOnce(reply(500, { error: { code: 'INTERNAL_ERROR', message: 'The local data request failed.' } }))
      .mockResolvedValueOnce(reply(500, { error: { code: 'UNRECOGNIZED_INTERNAL', message: 'private stack detail' } }))
    await expect(apiRequest('/api/v1/servers', passthrough)).rejects.toMatchObject({ message: 'Не удалось получить локальные данные.' })
    await expect(apiRequest('/api/v1/servers', passthrough)).rejects.toMatchObject({ message: 'Не удалось выполнить запрос. Попробуйте ещё раз.' })
  })

  it('shows specific Russian reasons for structured backup-limit failures', async () => {
    const documentFixture = document as unknown as { documentElement: { lang: string } }
    documentFixture.documentElement.lang = 'ru'
    fetchMock.mockResolvedValueOnce(reply(413, { error: { code: 'BACKUP_ARCHIVE_LIMIT', message: 'This server snapshot exceeds the configured maximum archive size.' } }))
      .mockResolvedValueOnce(reply(409, { error: { code: 'BACKUP_QUOTA_EXCEEDED', message: 'The configured private backup storage quota would be exceeded.' } }))
      .mockResolvedValueOnce(reply(413, { error: { code: 'BACKUP_ENTRY_LIMIT', message: 'The server folder exceeds the configured file and folder limit.' } }))
      .mockResolvedValueOnce(reply(413, { error: { code: 'BACKUP_MANIFEST_LIMIT', message: 'The backup manifest exceeds the supported safe metadata size.' } }))
      .mockResolvedValueOnce(reply(503, { error: { code: 'BACKUP_DISK_SPACE', message: 'There is not enough free space for this snapshot plus a safety margin.' } }))
      .mockResolvedValueOnce(reply(503, { error: { code: 'BACKUP_SPACE_UNAVAILABLE', message: 'Free space could not be verified, so the backup was not started.' } }))
      .mockResolvedValueOnce(reply(504, { error: { code: 'BACKUP_TIMEOUT', message: 'The backup exceeded the configured operation time limit.' } }))
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Превышен максимальный размер одной резервной копии.' })
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Будет превышена настроенная квота резервных копий. Существующие копии не удалялись.' })
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Превышено максимальное количество файлов и папок для резервной копии.' })
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Манифест резервной копии превышает безопасный поддерживаемый размер.' })
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Недостаточно свободного места для копии и безопасного запаса.' })
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Не удалось проверить свободное место. Создание копии отменено.' })
    await expect(apiRequest('/api/v1/admin/servers/example/backups', passthrough)).rejects.toMatchObject({ message: 'Превышена настроенная максимальная продолжительность операции.' })
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
