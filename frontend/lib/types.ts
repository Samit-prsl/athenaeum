export type TokenPair = {
  access_token: string
  refresh_token: string
  token_type: string
}

export type User = {
  id: string
  email: string
  name: string
  created_at: string
}

export type DocStatus = 'processing' | 'ready' | 'failed'

export type Document = {
  id: string
  filename: string
  total_pages: number
  status: DocStatus
  error: string | null
  created_at: string
}

export type UploadItem = {
  filename: string
  document_id: string
  job_id: string
}

export type JobStatus =
  | 'queued'
  | 'started'
  | 'finished'
  | 'failed'
  | 'deferred'
  | 'scheduled'
  | 'canceled'
  | 'stopped'

export type JobResult = {
  job_id: string
  status: JobStatus
  result: unknown
  error: string | null
}

export type QuizQuestion = {
  question: string
  options: string[]
  answer_index: number
  explanation: string
  page: string
}

export type Quiz = {
  title: string
  questions: QuizQuestion[]
  message?: string
}

export type ChatEntry = {
  question: string
  answer: string
}

export type ApiError = {
  status: number
  detail: string | unknown
}