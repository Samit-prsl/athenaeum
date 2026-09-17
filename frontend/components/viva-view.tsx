'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  CircleHelp,
  ClipboardList,
  FileText,
  History,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Target,
  Trash2,
} from 'lucide-react'
import * as api from '@/lib/api'
import type {
  Document,
  VivaQuestion,
  VivaReport,
  VivaSession,
  VivaSessionDetail,
} from '@/lib/types'

type VivaMode = 'setup' | 'live' | 'history' | 'review'

type LiveSession = { sessionId: string; question: VivaQuestion }

const surface = 'bg-white dark:bg-[#1a1b23]'
const border = 'border-[#e7e8ef] dark:border-white/10'
const borderSoft = 'border-[#f0f0f4] dark:border-white/5'
const muted = 'text-[#80828e] dark:text-[#b1b3c0]'
const faint = 'text-[#8f92a0] dark:text-[#9da0ac]'

const inputClass =
  'h-11 w-full rounded-[9px] border border-[#e2e2ea] bg-white px-3 text-[13px] text-[#171822] outline-none transition-colors focus:border-[#8179ed] focus:ring-2 focus:ring-[#eeedff] placeholder:text-[#a8a9b4] dark:border-white/10 dark:bg-white/5 dark:text-[#e8e8ee] dark:placeholder:text-[#6b6c78] dark:focus:border-[#6f67e8] dark:focus:ring-[#3a3650]'

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-[10px] bg-[#fdecec] px-4 py-3 text-[12px] font-medium text-[#b3382e] dark:bg-[#3a2222] dark:text-[#f2a4a0]">
      {message}
    </div>
  )
}

function base64ToAudioUrl(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function VivaView({
  documents,
  selectedIds,
  onToggleDoc,
}: {
  documents: Document[]
  selectedIds: string[]
  onToggleDoc: (id: string) => void
}) {
  const [mode, setMode] = useState<VivaMode>('setup')
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveSession | null>(null)

  return (
    <div className="mt-7">
      <div className="mb-6 flex w-fit rounded-[10px] bg-[#f2f2f7] p-1 dark:bg-white/5">
        {(
          [
            { key: 'setup', label: 'Practice a viva' },
            { key: 'history', label: 'Past vivas' },
          ] as { key: VivaMode; label: string }[]
        ).map((tab) => {
          const active =
            tab.key === 'setup' ? mode === 'setup' || mode === 'live' : mode === 'history' || mode === 'review'
          return (
            <button
              key={tab.key}
              onClick={() => {
                if (tab.key === 'history') {
                  setReviewId(null)
                  setMode('history')
                } else {
                  setMode('setup')
                }
              }}
              className={`flex items-center gap-2 rounded-[8px] px-3 py-2 text-[12px] font-semibold transition-colors ${
                active
                  ? 'bg-white text-[#171822] shadow-sm dark:bg-white/10 dark:text-white'
                  : 'text-[#8a8c99] hover:text-[#5a52df] dark:text-[#989aa8] dark:hover:text-[#aaa3fa]'
              }`}
            >
              {tab.key === 'history' ? <History size={14} /> : <Mic size={14} />}
              {tab.label}
            </button>
          )
        })}
      </div>

      {mode === 'setup' && (
        <VivaSetup
          documents={documents}
          selectedIds={selectedIds}
          onToggleDoc={onToggleDoc}
          onStarted={(sessionId, question) => {
            setLive({ sessionId, question })
            setMode('live')
          }}
        />
      )}

      {mode === 'live' && live && (
        <VivaLive
          sessionId={live.sessionId}
          initialQuestion={live.question}
          documents={documents}
          onFinished={() => setMode('history')}
        />
      )}

      {mode === 'history' && (
        <VivaHistory
          onOpen={(id) => {
            setReviewId(id)
            setMode('review')
          }}
          onStartNew={() => setMode('setup')}
        />
      )}

      {mode === 'review' && (
        <VivaReview
          sessionId={reviewId}
          onBack={() => {
            setReviewId(null)
            setMode('history')
          }}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Setup
// --------------------------------------------------------------------------- //

function VivaSetup({
  documents,
  selectedIds,
  onToggleDoc,
  onStarted,
}: {
  documents: Document[]
  selectedIds: string[]
  onToggleDoc: (id: string) => void
  onStarted: (sessionId: string, question: VivaQuestion) => void
}) {
  const [topic, setTopic] = useState('')
  const [difficulty, setDifficulty] = useState('medium')
  const [numQuestions, setNumQuestions] = useState(5)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleStart(event?: FormEvent) {
    event?.preventDefault()
    const subject = topic.trim()
    if (!subject || starting) return
    setStarting(true)
    setError(null)
    try {
      const started = await api.startViva(
        subject,
        numQuestions,
        difficulty,
        selectedIds.length ? selectedIds : null,
      )
      onStarted(started.session_id, started.question)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the viva.')
    } finally {
      setStarting(false)
    }
  }

  const readyCount = documents.filter((d) => d.status === 'ready').length

  return (
    <div className={`max-w-[650px] rounded-[16px] border p-5 sm:p-7 ${border} ${surface}`}>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#eeedff] text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
          <Mic size={18} />
        </div>
        <div>
          <h3 className="text-[15px] font-semibold">Voice viva setup</h3>
          <p className={`mt-0.5 text-[11px] ${faint}`}>
            Athena asks questions out loud and evaluates your spoken answers.
          </p>
        </div>
      </div>

      <form onSubmit={handleStart} className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="text-[12px] font-semibold">Topic to be examined on</label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Neural network architectures"
            className={`mt-2 ${inputClass}`}
          />
        </div>

        <div>
          <label className="text-[12px] font-semibold">Number of questions</label>
          <select
            value={numQuestions}
            onChange={(e) => setNumQuestions(Number(e.target.value))}
            className={`mt-2 ${inputClass}`}
          >
            <option value={3}>3 questions</option>
            <option value={5}>5 questions</option>
            <option value={10}>10 questions</option>
          </select>
        </div>

        <div>
          <label className="text-[12px] font-semibold">Difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className={`mt-2 ${inputClass}`}
          >
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <p className="text-[12px] font-semibold">Documents</p>
          <p className={`mt-0.5 text-[11px] ${faint}`}>
            {selectedIds.length
              ? `${selectedIds.length} ${selectedIds.length === 1 ? 'document' : 'documents'} selected`
              : `Using all ${readyCount} ready documents`}
          </p>
          <div className="mt-2">
            <VivaDocSelector documents={documents} selectedIds={selectedIds} onToggleDoc={onToggleDoc} />
          </div>
        </div>

        {error && (
          <div className="sm:col-span-2">
            <ErrorBanner message={error} />
          </div>
        )}

        <button
          type="submit"
          disabled={!topic.trim() || starting}
          className="mt-1 flex h-10 items-center justify-center gap-2 rounded-[9px] bg-[#5b52eb] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#4e46d8] disabled:opacity-50 sm:col-span-2"
        >
          {starting ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}
          {starting ? 'Setting up…' : 'Start the viva'}
        </button>
      </form>
    </div>
  )
}

function VivaDocSelector({
  documents,
  selectedIds,
  onToggleDoc,
}: {
  documents: Document[]
  selectedIds: string[]
  onToggleDoc: (id: string) => void
}) {
  const ready = documents.filter((d) => d.status === 'ready')
  if (ready.length === 0) {
    return (
      <p className={`mt-2 text-[11px] ${faint}`}>No ready documents yet. Upload and index a PDF first.</p>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => ready.forEach((d) => selectedIds.includes(d.id) && onToggleDoc(d.id))}
        className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
          selectedIds.length === 0
            ? 'border-[#5b52eb] bg-[#eeedff] text-[#5149d9] dark:border-[#6f67e8] dark:bg-[#2b2750] dark:text-[#aaa3fa]'
            : 'border-[#e2e2ea] text-[#8a8c99] hover:border-[#8a83ee] dark:border-white/10 dark:text-[#989aa8]'
        }`}
      >
        All ready docs
      </button>
      {ready.map((doc) => (
        <button
          key={doc.id}
          type="button"
          onClick={() => onToggleDoc(doc.id)}
          className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
            selectedIds.includes(doc.id)
              ? 'border-[#5b52eb] bg-[#eeedff] text-[#5149d9] dark:border-[#6f67e8] dark:bg-[#2b2750] dark:text-[#aaa3fa]'
              : 'border-[#e2e2ea] text-[#8a8c99] hover:border-[#8a83ee] dark:border-white/10 dark:text-[#989aa8]'
          }`}
        >
          {doc.filename}
        </button>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Live viva session
// --------------------------------------------------------------------------- //

type TurnLogEntry = { question: string; answer: string; feedback: string; page?: string | null }

function VivaLive({
  sessionId,
  initialQuestion,
  documents,
  onFinished,
}: {
  sessionId: string
  initialQuestion: VivaQuestion
  documents: Document[]
  onFinished: () => void
}) {
  const [question, setQuestion] = useState<VivaQuestion>(initialQuestion)
  const [turns, setTurns] = useState<TurnLogEntry[]>([])
  const [recording, setRecording] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const questionRef = useRef<VivaQuestion>(initialQuestion)
  questionRef.current = question

  // Speak the first question on mount.
  useEffect(() => {
    setAudioUrl(base64ToAudioUrl(initialQuestion.question_audio))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!audioUrl) return
    const audio = new Audio(audioUrl)
    void audio.play().catch(() => {})
    return () => {
      audio.pause()
      URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function playBase64(b64: string) {
    try {
      setAudioUrl(base64ToAudioUrl(b64))
    } catch {
      // audio playback is best-effort; the question text stays on screen
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        await submitAnswer(blob)
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
      setError(null)
    } catch {
      setError('Microphone access was denied. Allow mic access and try again.')
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    setRecording(false)
    setThinking(true)
  }

  async function submitAnswer(blob: Blob) {
    const asked = questionRef.current
    try {
      const result = await api.submitVivaAnswer(sessionId, blob)
      setTurns((log) => [
        ...log,
        {
          question: asked.question,
          page: asked.page,
          answer: result.transcript ?? '',
          feedback: result.feedback ?? '',
        },
      ])
      if (result.done) {
        setError(null)
        onFinished()
        return
      }
      if (result.question) {
        setQuestion(result.question)
        playBase64(result.question.question_audio)
        setError(null)
      } else {
        setError('Athena returned an unexpected viva response.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process your answer.')
    } finally {
      setThinking(false)
    }
  }

  const readyDocs = documents.filter((d) => d.status === 'ready').length

  return (
    <div className={`max-w-[820px] rounded-[16px] border p-5 sm:p-7 ${border} ${surface}`}>
      {error && <ErrorBanner message={error} />}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#eeedff] text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
            <Mic size={18} />
          </div>
          <div>
            <p className="text-[13px] font-semibold">Live viva</p>
            <p className={`text-[11px] ${faint}`}>
              {readyDocs} ready {readyDocs === 1 ? 'document' : 'documents'} in scope
            </p>
          </div>
        </div>
        <span className="rounded-full bg-[#f0f0f5] px-2.5 py-1 text-[10px] font-semibold text-[#8a8c99] dark:bg-white/10 dark:text-[#a9abb8]">
          Question {question.turn_index} of {question.total_questions}
        </span>
      </div>

      <div className="rounded-[12px] bg-[#f5f4ff] p-4 text-[13px] leading-6 text-[#3c3b54] dark:bg-[#241f41] dark:text-[#cfd0f4]">
        <p className="font-semibold">
          Question {question.turn_index}
          {question.page ? ` · Page ${question.page}` : ''}
        </p>
        <p className="mt-1">{question.question}</p>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => playBase64(question.question_audio)}
          className="flex h-9 items-center gap-2 rounded-[9px] border px-3 text-[12px] font-semibold text-[#555764] transition-colors hover:bg-[#f4f4f8] dark:text-[#a9abb8] dark:hover:bg-white/5"
        >
          <Play size={14} /> Replay
        </button>
        <button
          onClick={recording ? stopRecording : () => void startRecording()}
          disabled={thinking}
          className={`flex h-10 items-center gap-2 rounded-[9px] px-4 text-[12px] font-semibold text-white transition-colors disabled:opacity-60 ${
            recording
              ? 'bg-[#c7463a] shadow-[0_6px_18px_rgba(199,70,58,.25)] hover:bg-[#b03c31]'
              : 'bg-[#5b52eb] shadow-[0_6px_18px_rgba(91,82,235,.2)] hover:bg-[#4e46d8]'
          }`}
        >
          {recording ? (
            <>
              <Square size={13} /> Stop and submit
            </>
          ) : thinking ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Evaluating…
            </>
          ) : (
            <>
              <Mic size={14} /> Record answer
            </>
          )}
        </button>
        {recording && (
          <span className="animate-pulse text-[11px] font-semibold text-[#c7463a]">● Recording</span>
        )}
      </div>

      {turns.length > 0 && (
        <div className="mt-6 space-y-3 border-t pt-5 dark:border-white/5">
          {turns.map((turn, i) => (
            <div key={i} className={`rounded-[11px] border p-3.5 ${borderSoft}`}>
              <p className="text-[12px] font-semibold">Q{i + 1}: {turn.question}</p>
              <p className={`mt-1 text-[12px] leading-5 ${muted}`}>
                <span className="font-semibold text-[#33343f] dark:text-[#d8d9e0]">You said:</span>{' '}
                {turn.answer || '(no audible answer)'}
              </p>
              {turn.feedback && (
                <p className="mt-1 text-[12px] leading-5 text-[#5a52df] dark:text-[#aaa3fa]">{turn.feedback}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// History
// --------------------------------------------------------------------------- //

function VivaHistory({ onOpen, onStartNew }: { onOpen: (id: string) => void; onStartNew: () => void }) {
  const [history, setHistory] = useState<VivaSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setHistory(await api.listVivaSessions())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load viva history.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleDelete(id: string, topic: string) {
    if (!window.confirm(`Delete the viva on "${topic}"? This can't be undone.`)) return
    try {
      await api.deleteVivaSession(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the viva.')
    }
  }

  return (
    <div className={`max-w-[820px] rounded-[16px] border p-5 sm:p-7 ${border} ${surface}`}>
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#eeedff] text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
          <ClipboardList size={18} />
        </div>
        <div>
          <h3 className="text-[15px] font-semibold">Past vivas</h3>
          <p className={`mt-0.5 text-[11px] ${faint}`}>Reopen any finished viva and its report.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {history === null ? (
        <div className="flex items-center gap-2 py-8 text-[13px]">
          <Loader2 size={16} className="animate-spin text-[#5b52eb]" /> Loading…
        </div>
      ) : history.length === 0 ? (
        <div className="py-8 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#e9f6ef] text-[#2c9560] dark:bg-[#1d3527] dark:text-[#6fd9a0]">
            <Check size={20} />
          </div>
          <p className={`mt-3 text-[13px] ${faint}`}>No vivas yet. Start your first voice practice session.</p>
          <button
            onClick={onStartNew}
            className="mt-5 flex h-9 items-center gap-2 rounded-[9px] bg-[#5b52eb] px-3.5 text-[12px] font-semibold text-white hover:bg-[#4e46d8]"
          >
            <Mic size={14} /> Start a viva
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[12px] border">
          {history.map((session, i) => (
            <div
              key={session.id}
              className={`flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap sm:px-5 ${
                i !== history.length - 1 ? `border-b ${borderSoft}` : ''
              }`}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-[#eeedff] text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
                <Mic size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold">{session.topic}</p>
                <p className={`mt-0.5 text-[10px] ${faint}`}>
                  {session.num_questions} questions · {session.difficulty} · {formatDate(session.created_at)}
                </p>
              </div>
              {session.status === 'completed' && session.score !== null && (
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                    (session.score ?? 0) >= 60
                      ? 'bg-[#eaf7ef] text-[#2c9560] dark:bg-white/10 dark:text-[#6fd9a0]'
                      : 'bg-[#fdecec] text-[#b3382e] dark:bg-white/10 dark:text-[#f2a4a0]'
                  }`}
                >
                  {Math.round(session.score ?? 0)}%
                </span>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onOpen(session.id)}
                  className="flex h-8 items-center gap-1.5 rounded-[8px] border px-2.5 text-[11px] font-semibold text-[#555764] transition-colors hover:bg-[#f4f4f8] dark:text-[#a9abb8] dark:hover:bg-white/5"
                >
                  <FileText size={13} /> Report
                </button>
                <button
                  onClick={() => void handleDelete(session.id, session.topic)}
                  aria-label={`Delete viva on ${session.topic}`}
                  className="text-[#a7a8b2] transition-colors hover:text-[#c7463a] dark:text-[#6f717c] dark:hover:text-[#f0887d]"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Report review
// --------------------------------------------------------------------------- //

function VivaReview({ sessionId, onBack }: { sessionId: string | null; onBack: () => void }) {
  const [detail, setDetail] = useState<VivaSessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api
      .getVivaSession(sessionId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the report.')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  return (
    <div className={`max-w-[860px] rounded-[16px] border p-5 sm:p-7 ${border} ${surface}`}>
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[12px] font-semibold text-[#5a52df] hover:underline dark:text-[#aaa3fa]"
      >
        <ArrowLeft size={14} /> Back to past vivas
      </button>

      {error && <ErrorBanner message={error} />}

      {detail === null && !error && (
        <div className="flex items-center gap-2 py-8 text-[13px]">
          <Loader2 size={16} className="animate-spin text-[#5b52eb]" /> Loading report…
        </div>
      )}

      {detail && detail.report && <VivaReportCard detail={detail} />}
    </div>
  )
}

function VivaReportCard({ detail }: { detail: VivaSessionDetail }) {
  const report: VivaReport = detail.report ?? {
    overall_score: 0,
    strengths: [],
    weaknesses: [],
    recommended_revisions: [],
    summary: '',
  }
  const score = Math.round(report.overall_score)
  const scoreTone = score >= 60 ? 'text-[#2c9560] dark:text-[#6fd9a0]' : 'text-[#c7463a] dark:text-[#f2a4a0]'

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-5">
        <div
          className={`flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-full border-4 ${scoreTone}`}
        >
          <span className="text-[24px] font-bold leading-none">{score}</span>
          <span className={`text-[10px] font-semibold ${faint}`}>/ 100</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold tracking-[-.03em]">{detail.topic}</p>
          <p className={`mt-1 text-[12px] leading-5 ${muted}`}>{report.summary || 'No summary available.'}</p>
        </div>
      </div>

      {report.strengths.length > 0 && (
        <Section title="Strengths" icon={<BadgeCheck size={15} />} tone="text-[#2c9560]">
          <ul className="space-y-1.5">
            {report.strengths.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-5 text-[#33343f] dark:text-[#c3c5d2]">
                <Check size={13} className="mt-0.5 shrink-0 text-[#2c9560]" /> {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.weaknesses.length > 0 && (
        <Section title="What to improve" icon={<Target size={15} />} tone="text-[#c7463a]">
          <ul className="space-y-1.5">
            {report.weaknesses.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-5 text-[#33343f] dark:text-[#c3c5d2]">
                <CircleHelp size={13} className="mt-0.5 shrink-0 text-[#c7463a]" /> {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.recommended_revisions.length > 0 && (
        <Section title="What to revise" icon={<RotateCcw size={15} />} tone="text-[#5b52eb]">
          <ul className="space-y-1.5">
            {report.recommended_revisions.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-5 text-[#33343f] dark:text-[#c3c5d2]">
                <Sparkles size={13} className="mt-0.5 shrink-0 text-[#5b52eb]" /> {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="mt-6 border-t pt-5 dark:border-white/5">
        <p className="text-[12px] font-semibold">Q&A transcript</p>
        <div className="mt-3 space-y-3">
          {detail.turns.map((turn, i) => (
            <div key={i} className={`rounded-[11px] border p-3.5 ${borderSoft}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-[12px] font-semibold">Q{i + 1}: {turn.question}</p>
                {turn.evaluation && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      turn.evaluation.score >= 6
                        ? 'bg-[#eaf7ef] text-[#2c9560] dark:bg-white/10 dark:text-[#6fd9a0]'
                        : 'bg-[#fdecec] text-[#b3382e] dark:bg-white/10 dark:text-[#f2a4a0]'
                    }`}
                  >
                    {turn.evaluation.score}/10
                  </span>
                )}
              </div>
              <p className={`mt-1 text-[12px] leading-5 ${muted}`}>
                <span className="font-semibold text-[#33343f] dark:text-[#d8d9e0]">You said:</span>{' '}
                {turn.answer_text || '(no audible answer)'}
              </p>
              {turn.evaluation?.feedback && (
                <p className="mt-1 text-[12px] leading-5 text-[#5a52df] dark:text-[#aaa3fa]">
                  {turn.evaluation.feedback}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  icon,
  tone,
  children,
}: {
  title: string
  icon: React.ReactNode
  tone: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-6 rounded-[12px] border p-4 dark:border-white/5">
      <div className={`flex items-center gap-2 text-[12px] font-semibold ${tone}`}>
        {icon} {title}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  )
}