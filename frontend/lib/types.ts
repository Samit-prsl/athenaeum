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
}

export type ChatResult = {
  answer: string
}

export type SummaryResult = {
  summary: string
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

export type VivaQuestion = {
  question: string
  question_audio: string
  turn_index: number
  total_questions: number
  page?: string | null
}

export type VivaStart = {
  session_id: string
  question: VivaQuestion
}

export type VivaEvaluation = {
  score: number
  missed_points: string[]
  feedback: string
}

export type VivaReport = {
  overall_score: number
  strengths: string[]
  weaknesses: string[]
  recommended_revisions: string[]
  summary: string
}

export type VivaTurnResult = {
  done: boolean
  transcript?: string | null
  feedback?: string | null
  question?: VivaQuestion | null
  report?: VivaReport | null
}

export type VivaSession = {
  id: string
  topic: string
  num_questions: number
  difficulty: string
  status: 'active' | 'completed' | 'failed'
  score?: number | null
  created_at: string
  completed_at?: string | null
}

export type VivaTurn = {
  question: string
  page: string
  answer_text: string
  evaluation: VivaEvaluation | null
  created_at: string
}

export type VivaSessionDetail = {
  id: string
  topic: string
  num_questions: number
  difficulty: string
  status: 'active' | 'completed' | 'failed'
  score?: number | null
  report?: VivaReport | null
  created_at: string
  completed_at?: string | null
  turns: VivaTurn[]
}