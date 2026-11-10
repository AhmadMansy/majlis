/**
 * The panel key arrives in the URL fragment of the link `majlis host` prints.
 * It is moved into session storage and removed from the address bar at once.
 */
function takeKey(): string {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('key')
  if (fromHash) {
    sessionStorage.setItem('majlis-panel-key', fromHash)
    history.replaceState(null, '', window.location.pathname)
  }
  return sessionStorage.getItem('majlis-panel-key') ?? ''
}

const key = takeKey()

export const hasKey = key !== ''

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Calls the panel API. A body makes it a POST. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-Panel-Key': key,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok)
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`)
  return data as T
}
