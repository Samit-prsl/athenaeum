import type {
  ApiError,
  Document,
  JobResult,
  Quiz,
  TokenPair,
  UploadItem,
  User,
} from './types'

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:8000'

const ACCESS_KEY = 'athenaeum.access_token'
const REFRESH_KEY = 'athenaeum.refresh_token'

type StoredTokens = { access: string; refresh: string }

function readTokens(): StoredTokens | null {
  if (typeof window === 'undefined') return null
  const access = window.localStorage.getItem(ACCESS_KEY)
  const refresh = window.localStorage.getItem(REFRESH_KEY)
  return access && refresh ? { access, refresh } : null
}

function writeTokens(tokens: TokenPair) {
  window.localStorage.setItem(ACCESS_KEY, tokens.access_token)
  window.localStorage.setItem(REFRESH_KEY, tokens.refresh_token)
}

function clearTokens() {
  window.localStorage.removeItem(ACCESS_KEY)
  window.localStorage.removeItem(REFRESH_KEY)
}

function toError(status: number, payload: unknown): ApiError {
  const detail =
    typeof payload === 'object' && payload !== null && 'detail' in payload
      ? (payload as { detail: unknown }).detail
      : payload
  return { status, detail }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  withAuth = true,
  retry = true,
): Promise<T> {
  const tokens = readTokens()
  const headers = new Headers(init.headers)

  if (withAuth && tokens) {
    headers.set('Authorization', `Bearer ${tokens.access}`)
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers })
  } catch {
    throw new Error('Unable to reach the Athenaeum server.')
  }

  if (response.status === 401 && withAuth && tokens && retry) {
    const refreshed = await refreshAccessToken()
    if (refreshed) return request<T>(path, init, withAuth, false)
  }

  const payload: unknown = await response
    .json()
    .catch(() => (null as unknown) as unknown)

  if (!response.ok) {
    if (response.status === 401) clearTokens()
    throw toError(response.status, payload)
  }

  return payload as T
}

async function refreshAccessToken(): Promise<boolean> {
  const tokens = readTokens()
  if (!tokens) return false
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh }),
    })
    if (!response.ok) {
      clearTokens()
      return false
    }
    const body = (await response.json()) as { access_token: string }
    const refreshed = { ...tokens, access: body.access_token } satisfies StoredTokens
    window.localStorage.setItem(ACCESS_KEY, refreshed.access)
    return true
  } catch {
    return false
  }
}

export type AuthPayload = { email: string; password: string; name?: string }

export async function register(payload: AuthPayload): Promise<User> {
  const tokens = await request<TokenPair>('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, false)
  writeTokens(tokens)
  return me()
}

export async function login(email: string, password: string): Promise<User> {
  const body = new URLSearchParams()
  body.set('username', email)
  body.set('password', password)
  const tokens = await request<TokenPair>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, false)
  writeTokens(tokens)
  return me()
}

export async function me(): Promise<User> {
  return request<User>('/auth/me')
}

export function hasSession(): boolean {
  return readTokens() !== null
}

export function logout() {
  clearTokens()
}

export async function listDocuments(): Promise<Document[]> {
  return request<Document[]>('/documents')
}

export async function uploadDocuments(files: File[]): Promise<UploadItem[]> {
  const form = new FormData()
  for (const file of files) form.append('files', file)
  const result = await request<{ uploads: UploadItem[] }>('/documents', {
    method: 'POST',
    body: form,
  })
  return result.uploads
}

export async function deleteDocument(documentId: string): Promise<void> {
  return request<void>(`/documents/${documentId}`, { method: 'DELETE' })
}

export async function startChat(
  question: string,
  document_ids: string[] | null,
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, document_ids }),
  })
}

export async function startQuiz(
  topic: string,
  num_questions: number,
  document_ids: string[] | null,
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>('/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, num_questions, document_ids }),
  })
}

export async function startSummary(
  topic: string,
  document_ids: string[] | null,
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>('/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, document_ids }),
  })
}

export async function getJob(jobId: string): Promise<JobResult> {
  return request<JobResult>(`/jobs/${jobId}`)
}

export const jobIsDone = (status: JobResult['status']) =>
  status === 'finished' || status === 'failed' || status === 'stopped' || status === 'canceled'

export function jobError(job: JobResult): string | null {
  if (job.status === 'failed') {
    const detail = job.error
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
    return 'The job failed. Please try again.'
  }
  return null
}

export async function waitForJob(jobId: string, intervalMs = 1500): Promise<JobResult> {
  for (;;) {
    const job = await getJob(jobId)
    if (jobIsDone(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export type { Quiz }