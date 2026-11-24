export type ApiErrorKind = 'unauthenticated' | 'forbidden' | 'conflict' | 'validation' | 'rate-limited' | 'http' | 'network' | 'invalid-response'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly kind: ApiErrorKind = 'http',
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

type ApiSchema<T> = { parse: (input: unknown) => T }
type ApiRequestOptions = { suppressSessionExpiry?: boolean }

function errorKind(status: number): ApiErrorKind {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  if (status === 409) return 'conflict'
  if (status === 422) return 'validation'
  if (status === 429) return 'rate-limited'
  return 'http'
}

function statusFallback(status: number, fallback?: string): string {
  if (fallback) return fallback
  switch (status) {
    case 401: return 'Your session has expired. Sign in again.'
    case 403: return 'Your account does not have permission to do that.'
    case 404: return 'This item is no longer available. Refresh and try again.'
    case 409: return 'The item changed or conflicts with another request. Refresh and try again.'
    case 422: return 'Some values were rejected. Review them and try again.'
    case 429: return 'Too many requests. Wait a moment and retry.'
    default: return status >= 500 ? 'The local API could not complete this request. Retry in a moment.' : `The local API returned HTTP ${status}.`
  }
}

export function apiCsrfToken(): string | null {
  if (typeof document === 'undefined') return null
  const part = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('mmsmanager_csrf='))
  if (!part) return null
  const value = part.slice('mmsmanager_csrf='.length)
  try { return decodeURIComponent(value) } catch { return value }
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

function shouldSuppressSessionExpiry(url: string, options?: ApiRequestOptions): boolean {
  if (options?.suppressSessionExpiry) return true
  const path = pathOf(url)
  return path.endsWith('/auth/me') || path.endsWith('/auth/login') || path.endsWith('/auth/setup')
}

export function reportSessionExpiry(status: number, url: string, options?: ApiRequestOptions): void {
  if (status === 401 && !shouldSuppressSessionExpiry(url, options) && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('mmsmanager:session-expired'))
  }
}

export function apiRequestHeaders(url: string, init: RequestInit = {}): Headers {
  const headers = new Headers(init.headers)
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  const method = (init.method ?? 'GET').toUpperCase()
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const formData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (init.body && !formData && !headers.has('content-type') && typeof init.body === 'string') {
    headers.set('content-type', 'application/json')
  }
  const path = pathOf(url)
  const csrfExempt = path.endsWith('/auth/setup') || path.endsWith('/auth/login')
  if (unsafe && !csrfExempt && !headers.has('x-mms-csrf')) {
    const token = apiCsrfToken()
    if (token) headers.set('x-mms-csrf', token)
  }
  return headers
}

function payloadMessage(payload: unknown): { message: string | null; code: string | null } {
  if (!payload || typeof payload !== 'object') return { message: null, code: null }
  const root = payload as { error?: unknown; message?: unknown; code?: unknown }
  const error = root.error && typeof root.error === 'object' ? root.error as { message?: unknown; code?: unknown } : null
  const message = typeof error?.message === 'string' ? error.message : typeof root.message === 'string' ? root.message : null
  const code = typeof error?.code === 'string' ? error.code : typeof root.code === 'string' ? root.code : null
  return { message, code }
}

export function apiErrorFromPayload(status: number, payload: unknown, fallback?: string): ApiRequestError {
  const detail = payloadMessage(payload)
  return new ApiRequestError(status, detail.message ?? statusFallback(status, fallback), detail.code, errorKind(status))
}

export function apiNetworkError(fallback: string): ApiRequestError {
  return new ApiRequestError(0, fallback, 'API_UNAVAILABLE', 'network')
}

export function apiInvalidResponseError(): ApiRequestError {
  return new ApiRequestError(502, 'The local API returned an unexpected response. Retry, and contact an administrator if it continues.', 'INVALID_RESPONSE', 'invalid-response')
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export async function apiRequestResponse(url: string, init: RequestInit = {}, options?: ApiRequestOptions): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = apiRequestHeaders(url, { ...init, method })
  let response: Response
  try {
    response = await fetch(url, { ...init, method, headers, credentials: 'same-origin' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const fallback = error instanceof Error && error.message ? `The local API could not be reached: ${error.message}` : 'The local API could not be reached. Check that MMSManager is running, then retry.'
    throw apiNetworkError(fallback)
  }
  reportSessionExpiry(response.status, url, options)
  if (!response.ok) {
    const payload: unknown = await response.clone().json().catch(() => null)
    throw apiErrorFromPayload(response.status, payload)
  }
  return response
}

export async function apiRequest<T>(url: string, schema: ApiSchema<T>, init: RequestInit = {}, options?: ApiRequestOptions): Promise<T> {
  const response = await apiRequestResponse(url, init, options)
  let payload: unknown
  try { payload = await response.json() } catch { throw apiInvalidResponseError() }
  try { return schema.parse(payload) } catch { throw apiInvalidResponseError() }
}
