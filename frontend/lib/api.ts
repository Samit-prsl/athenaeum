import type {
  ApiError,
  ChatResult,
  Document,
  Quiz,
  SummaryResult,
  TokenPair,
  UploadItem,
  User,
  VivaSession,
  VivaSessionDetail,
  VivaStart,
  VivaTurnResult,
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

export async function chat(
  question: string,
  document_ids: string[] | null,
): Promise<ChatResult> {
  return request<ChatResult>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, document_ids }),
  })
}

export async function quiz(
  topic: string,
  num_questions: number,
  document_ids: string[] | null,
): Promise<Quiz> {
  return request<Quiz>('/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, num_questions, document_ids }),
  })
}

export async function summary(
  topic: string,
  document_ids: string[] | null,
): Promise<SummaryResult> {
  return request<SummaryResult>('/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, document_ids }),
  })
}

export async function startViva(
  topic: string,
  num_questions: number,
  difficulty: string,
  document_ids: string[] | null,
): Promise<VivaStart> {
  return request<VivaStart>('/viva/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, num_questions, difficulty, document_ids }),
  })
}

export async function submitVivaAnswer(
  sessionId: string,
  audio: Blob,
): Promise<VivaTurnResult> {
  const form = new FormData()
  form.append('session_id', sessionId)
  form.append('audio', audio, 'answer.webm')
  return request<VivaTurnResult>('/viva/turn', {
    method: 'POST',
    body: form,
  })
}

export async function listVivaSessions(): Promise<VivaSession[]> {
  return request<VivaSession[]>('/viva/sessions')
}

export async function getVivaSession(sessionId: string): Promise<VivaSessionDetail> {
  return request<VivaSessionDetail>(`/viva/sessions/${sessionId}`)
}

export async function deleteVivaSession(sessionId: string): Promise<void> {
  return request<void>(`/viva/sessions/${sessionId}`, { method: 'DELETE' })
}

export type { Quiz }