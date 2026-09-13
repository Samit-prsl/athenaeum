'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  CircleHelp,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Plus,
  Send,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { AuthScreen } from '@/components/auth-screen'
import { ThemeToggle } from '@/components/theme-toggle'
import * as api from '@/lib/api'
import type { ChatEntry, Document, Quiz, User } from '@/lib/types'

type View = 'Overview' | 'Documents' | 'Chat' | 'Quiz' | 'Summary'

type JobLoading = { kind: View; label: string }

const navItems: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Documents', icon: FolderOpen },
  { label: 'Chat', icon: Bot },
  { label: 'Quiz', icon: CircleHelp },
  { label: 'Summary', icon: FileText },
]

const docTints = [
  { bg: 'bg-violet-50 text-violet-500 dark:bg-violet-500/15 dark:text-violet-300' },
  { bg: 'bg-blue-50 text-blue-500 dark:bg-blue-500/15 dark:text-blue-300' },
  { bg: 'bg-orange-50 text-orange-500 dark:bg-orange-500/15 dark:text-orange-300' },
  { bg: 'bg-pink-50 text-pink-500 dark:bg-pink-500/15 dark:text-pink-300' },
]

const surface = 'bg-white dark:bg-[#1a1b23]'
const border = 'border-[#e7e8ef] dark:border-white/10'
const borderSoft = 'border-[#f0f0f4] dark:border-white/5'
const muted = 'text-[#80828e] dark:text-[#b1b3c0]'
const faint = 'text-[#8f92a0] dark:text-[#9da0ac]'

function formatAdded(createdAt: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(date, today)) return 'today'
  if (sameDay(date, yesterday)) return 'yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function initials(user: User): string {
  const source = user.name.trim() || user.email
  const parts = source.split(/[\s@.]+/).filter(Boolean)
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || 'U'
}

export default function Page() {
  const [user, setUser] = useState<User | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [activeView, setActiveView] = useState<View>('Overview')
  const [documents, setDocuments] = useState<Document[]>([])
  const [documentsError, setDocumentsError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showUpload, setShowUpload] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function restore() {
      try {
        if (!api.hasSession()) return
        const current = await api.me()
        if (!cancelled) setUser(current)
      } catch {
        api.logout()
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshDocuments = useCallback(async () => {
    try {
      const docs = await api.listDocuments()
      setDocuments(docs)
      setDocumentsError(null)
      setSelectedIds((current) => current.filter((id) => docs.some((d) => d.id === id)))
    } catch (err) {
      if (err instanceof Error) setDocumentsError(err.message)
    }
  }, [])

  useEffect(() => {
    if (user) void refreshDocuments()
  }, [user, refreshDocuments])

  useEffect(() => {
    if (!user || !documents.some((d) => d.status === 'processing')) return
    const id = window.setInterval(() => void refreshDocuments(), 2500)
    return () => window.clearInterval(id)
  }, [documents, user, refreshDocuments])

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7f8fb] dark:bg-[#12131a]">
        <Loader2 size={22} className="animate-spin text-[#5b52eb]" />
      </div>
    )
  }

  if (!user) {
    return <AuthScreen onAuthenticated={setUser} />
  }

  function handleLogout() {
    api.logout()
    setUser(null)
    setDocuments([])
    setSelectedIds([])
  }

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-[#171822] dark:bg-[#12131a] dark:text-[#e8e8ee]">
      <Sidebar
        user={user}
        docCount={documents.length}
        activeView={activeView}
        mobileOpen={mobileOpen}
        onSelect={(view) => {
          setActiveView(view)
          setMobileOpen(false)
        }}
        onClose={() => setMobileOpen(false)}
        onLogout={handleLogout}
      />

      <main className="lg:pl-[248px]">
        <Header
          user={user}
          onOpenMenu={() => setMobileOpen(true)}
          onUpload={() => setShowUpload(true)}
        />

        <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
          {activeView === 'Overview' && (
            <Overview
              user={user}
              documents={documents}
              selectedIds={selectedIds}
              onToggleDoc={toggleDoc}
              onUpload={() => setShowUpload(true)}
              onViewAll={() => setActiveView('Documents')}
              onNavigate={setActiveView}
            />
          )}

          {activeView === 'Documents' && (
            <PageHeader
              title="Document library"
              description="Upload and manage the materials Athena uses to help you learn."
              action={
                <button
                  onClick={() => setShowUpload(true)}
                  className="flex h-10 items-center gap-2 rounded-[9px] bg-[#5b52eb] px-4 text-[12px] font-semibold text-white shadow-[0_6px_18px_rgba(91,82,235,.2)] hover:bg-[#4e46d8]"
                >
                  <Plus size={16} /> Add documents
                </button>
              }
            >
              {documentsError && <ErrorBanner message={documentsError} />}
              <DocumentList
                documents={documents}
                selectedIds={selectedIds}
                onToggle={toggleDoc}
                onDelete={handleDeleteDocument}
              />
            </PageHeader>
          )}

          {activeView === 'Chat' && (
            <ChatView
              documents={documents}
              selectedIds={selectedIds}
              onToggleDoc={toggleDoc}
            />
          )}

          {activeView === 'Quiz' && (
            <PageHeader
              title="Quiz generator"
              description="Turn your study materials into an interactive practice session."
            >
              <QuizView documents={documents} selectedIds={selectedIds} />
            </PageHeader>
          )}

          {activeView === 'Summary' && (
            <PageHeader
              title="Write a summary"
              description="Get a clear, focused overview of any topic in your library."
            >
              <SummaryView documents={documents} selectedIds={selectedIds} />
            </PageHeader>
          )}
        </div>
      </main>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => void refreshDocuments()}
        />
      )}
    </div>
  )

  function toggleDoc(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  async function handleDeleteDocument(id: string) {
    const doc = documents.find((d) => d.id === id)
    if (!doc) return
    if (!window.confirm(`Delete "${doc.filename}"? This can't be undone.`)) return
    try {
      await api.deleteDocument(id)
      await refreshDocuments()
    } catch (err) {
      if (err instanceof Error) window.alert(err.message)
    }
  }
}

// --------------------------------------------------------------------------- //
// Layout pieces
// --------------------------------------------------------------------------- //

function Sidebar({
  user,
  docCount,
  activeView,
  mobileOpen,
  onSelect,
  onClose,
  onLogout,
}: {
  user: User
  docCount: number
  activeView: View
  mobileOpen: boolean
  onSelect: (view: View) => void
  onClose: () => void
  onLogout: () => void
}) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 flex w-[248px] flex-col border-r px-4 py-5 transition-transform lg:translate-x-0 ${border} bg-white dark:bg-[#1a1b23] ${
        mobileOpen ? 'translate-x-0' : '-translate-x-[110%]'
      }`}
    >
      <div className="flex items-center justify-between px-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#5b52eb] text-white shadow-[0_5px_12px_rgba(91,82,235,.24)]">
            <Sparkles size={17} strokeWidth={2.4} />
          </div>
          <span className="text-[17px] font-semibold tracking-[-.03em] dark:text-white">
            athenaeum
          </span>
        </div>
        <button aria-label="Close menu" className="lg:hidden" onClick={onClose}>
          <X size={19} className="dark:text-[#b6b8c4]" />
        </button>
      </div>

      <div className="mt-10 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-[#989aa8] dark:text-[#6b6d78]">
        Workspace
      </div>
      <nav className="mt-3 space-y-1">
        {navItems.map(({ label, icon: Icon }) => (
          <button
            key={label}
            onClick={() => onSelect(label)}
            className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] font-medium transition-colors ${
              activeView === label
                ? 'bg-[#eeedff] text-[#5149d9] dark:bg-[#2b2750] dark:text-[#aaa3fa]'
                : 'text-[#707281] hover:bg-[#f4f4f8] dark:text-[#a9abb8] dark:hover:bg-white/5'
            }`}
          >
            <Icon size={17} strokeWidth={activeView === label ? 2.3 : 1.8} />
            {label}
            {label === 'Documents' && (
              <span className="ml-auto rounded-full bg-[#f0f0f5] px-2 py-0.5 text-[10px] text-[#8a8c99] dark:bg-white/10 dark:text-[#a9abb8]">
                {docCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-auto space-y-4">
        <div className="flex items-center gap-2.5 border-t px-2 pt-4 dark:border-white/5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f0d9ca] text-[11px] font-semibold text-[#7d5544] dark:bg-[#3a2a23] dark:text-[#e0b39d]">
            {initials(user)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold dark:text-[#e0e1e7]">
              {user.name || 'Athenaeum user'}
            </p>
            <p className="truncate text-[10px] text-[#8f92a0] dark:text-[#9da0ac]">{user.email}</p>
          </div>
          <button
            onClick={onLogout}
            aria-label="Log out"
            title="Log out"
            className="text-[#a5a6b0] transition-colors hover:text-[#c7463a] dark:text-[#6f717c] dark:hover:text-[#f0887d]"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function Header({
  user,
  onOpenMenu,
  onUpload,
}: {
  user: User
  onOpenMenu: () => void
  onUpload: () => void
}) {
  const now = new Date()
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const hour = now.getHours()
  const greeting =
    hour < 5
      ? 'Good evening'
      : hour < 12
        ? 'Good morning'
        : hour < 18
          ? 'Good afternoon'
          : 'Good evening'
  const firstName = user.name.trim().split(/\s+/)[0] || 'there'

  return (
    <header className={`sticky top-0 z-20 flex h-[68px] items-center justify-between border-b px-5 backdrop-blur-md sm:px-8 lg:px-10 ${border} bg-[#f7f8fb]/90 dark:bg-[#12131a]/90`}>
      <div className="flex items-center gap-3">
        <button className="lg:hidden" onClick={onOpenMenu} aria-label="Open menu">
          <Menu size={21} className="dark:text-[#c8cad4]" />
        </button>
        <div>
          <p className="text-[11px] font-medium text-[#9a9ba8] dark:text-[#9da0ac]">{dateLabel}</p>
          <h1 className="mt-0.5 text-[16px] font-semibold tracking-[-.02em] dark:text-white">
            {greeting}, {firstName}
          </h1>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <button
          onClick={onUpload}
          className="flex h-9 items-center gap-2 rounded-[9px] bg-[#5b52eb] px-3.5 text-[12px] font-semibold text-white shadow-[0_6px_18px_rgba(91,82,235,.2)] hover:bg-[#4e46d8]"
        >
          <UploadCloud size={15} /> Upload
        </button>
      </div>
    </header>
  )
}

function PageHeader({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-[30px] font-semibold tracking-[-.055em]">{title}</h2>
          <p className={`mt-2 text-[13px] ${muted}`}>{description}</p>
        </div>
        {action}
      </div>
      {children}
    </>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-5 rounded-[10px] bg-[#fdecec] px-4 py-3 text-[12px] font-medium text-[#b3382e] dark:bg-[#3a2222] dark:text-[#f2a4a0]">
      {message}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Overview
// --------------------------------------------------------------------------- //

function Overview({
  user,
  documents,
  selectedIds,
  onToggleDoc,
  onUpload,
  onViewAll,
  onNavigate,
}: {
  user: User
  documents: Document[]
  selectedIds: string[]
  onToggleDoc: (id: string) => void
  onUpload: () => void
  onViewAll: () => void
  onNavigate: (view: View) => void
}) {
  const readyCount = useMemo(() => documents.filter((d) => d.status === 'ready').length, [documents])

  return (
    <>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[#dedcff] bg-[#f1f0ff] px-2.5 py-1 text-[10px] font-semibold text-[#5a51dc] dark:border-[#3a3650] dark:bg-[#221f3d] dark:text-[#aaa3fa]">
            <Sparkles size={11} /> YOUR STUDY SPACE
          </div>
          <h2 className="text-[30px] font-semibold tracking-[-.055em] sm:text-[36px]">
            What would you like to learn?
          </h2>
          <p className={`mt-2 max-w-[510px] text-[13px] leading-6 ${muted}`}>
            Your documents are ready. Ask a question, build a quiz, or get a focused summary.
          </p>
        </div>
        <button
          onClick={onUpload}
          className="flex h-10 items-center justify-center gap-2 rounded-[9px] bg-[#5b52eb] px-4 text-[12px] font-semibold text-white shadow-[0_6px_18px_rgba(91,82,235,.2)] hover:bg-[#4e46d8]"
        >
          <UploadCloud size={16} /> Upload documents
        </button>
      </div>

      <section className="mt-8 grid gap-3 md:grid-cols-3">
        {[
          { icon: Bot, title: 'Ask Athena', text: 'Get grounded answers from your notes', view: 'Chat' as View, bg: 'bg-[#eeedff] dark:bg-[#2b2750]', fg: 'text-[#5c54e5] dark:text-[#aaa3fa]' },
          { icon: CircleHelp, title: 'Generate a quiz', text: 'Test your understanding by topic', view: 'Quiz' as View, bg: 'bg-[#e9f6ef] dark:bg-[#1d3527]', fg: 'text-[#2c9560] dark:text-[#6fd9a0]' },
          { icon: FileText, title: 'Write a summary', text: 'Turn dense material into key points', view: 'Summary' as View, bg: 'bg-[#fff1e6] dark:bg-[#3a2a1a]', fg: 'text-[#d47a34] dark:text-[#f0a862]' },
        ].map(({ icon: Icon, title, text, view, bg, fg }) => (
          <button
            key={title}
            onClick={() => onNavigate(view)}
            className={`group flex items-center gap-4 rounded-[14px] border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(30,31,55,.06)] ${border} ${surface} dark:hover:shadow-none`}
          >
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] ${bg} ${fg}`}>
              <Icon size={19} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold">{title}</p>
              <p className={`mt-1 text-[11px] ${faint}`}>{text}</p>
            </div>
            <ArrowUpRight
              size={16}
              className={`ml-auto transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 ${muted}`}
            />
          </button>
        ))}
      </section>

      <div className="mt-10 flex items-center justify-between">
        <div>
          <h3 className="text-[17px] font-semibold tracking-[-.025em]">Your library</h3>
          <p className={`mt-1 text-[12px] ${faint}`}>
            {readyCount} {readyCount === 1 ? 'document' : 'documents'} indexed and ready to use
          </p>
        </div>
        <button onClick={onViewAll} className="text-[12px] font-semibold text-[#5a52df] hover:underline dark:text-[#aaa3fa]">
          View all <span className="ml-1">→</span>
        </button>
      </div>

      <DocumentList
        documents={documents.slice(0, 3)}
        selectedIds={selectedIds}
        onToggle={onToggleDoc}
        onDelete={() => {}}
        compact
      />

      <div className="mt-8 grid gap-4 md:grid-cols-[1.5fr_1fr]">
        <div className="rounded-[15px] bg-[#242337] p-5 text-white sm:p-6 dark:bg-[#1f1e33]">
          <div className="flex items-start justify-between">
            <div>
              <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-[9px] bg-[#5f57eb]">
                <Bot size={16} />
              </div>
              <h3 className="text-[17px] font-semibold">Ask anything about your materials</h3>
              <p className="mt-2 max-w-[360px] text-[12px] leading-5 text-[#b4b3c7]">
                Athena reads between the lines so you can focus on understanding.
              </p>
            </div>
            <Sparkles size={20} className="text-[#8d87fa]" />
          </div>
          <button
            onClick={() => onNavigate('Chat')}
            className="mt-5 flex items-center gap-2 text-[12px] font-semibold text-[#a9a4ff]"
          >
            Start a conversation <ArrowUpRight size={14} />
          </button>
        </div>

        <div className={`rounded-[15px] border p-5 ${border} ${surface}`}>
          <div className="flex items-center gap-2 text-[12px] font-semibold">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#fff1e6] text-[#d47a34] dark:bg-[#3a2a1a] dark:text-[#f0a862]">
              <BookOpen size={15} />
            </div>
            Extras
          </div>
          <div className={`mt-5 flex items-end justify-between`}>
            <div>
              <span className="text-[28px] font-semibold tracking-[-.05em]">{readyCount}</span>
              <p className={`mt-1 text-[11px] ${faint}`}>documents indexed</p>
            </div>
            <button
              onClick={() => onNavigate('Documents')}
              className="rounded-full bg-[#eaf7ef] px-2 py-1 text-[10px] font-semibold text-[#389666] dark:bg-white/10 dark:text-[#6fd9a0]"
            >
              Manage →
            </button>
          </div>
          <p className={`mt-4 text-[11px] leading-5 ${muted}`}>
            {readyCount === 0
              ? 'Upload a PDF to start indexing your library.'
              : documents.some((d) => d.status !== 'ready')
                ? `${documents.length - readyCount} ${documents.length - readyCount === 1 ? 'document is' : 'documents are'} still being processed or failed.`
                : 'Everything is indexed and ready to use.'}
          </p>
        </div>
      </div>
    </>
  )
}

// --------------------------------------------------------------------------- //
// Documents
// --------------------------------------------------------------------------- //

function DocumentList({
  documents,
  selectedIds,
  onToggle,
  onDelete,
  compact = false,
}: {
  documents: Document[]
  selectedIds: string[]
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  compact?: boolean
}) {
  if (documents.length === 0) {
    return (
      <div className={`mt-5 overflow-hidden rounded-[14px] border ${border} ${surface}`}>
        <div className={`p-10 text-center text-[13px] ${faint}`}>
          No documents yet. Upload a PDF to get started.
        </div>
      </div>
    )
  }

  return (
    <div className={`mt-5 overflow-hidden rounded-[14px] border ${border} ${surface}`}>
      {documents.map((doc, i) => (
        <div
          key={doc.id}
          className={`flex items-center gap-3 px-4 py-3.5 sm:px-5 ${i !== documents.length - 1 ? `border-b ${borderSoft}` : ''}`}
        >
          <button
            onClick={() => onToggle(doc.id)}
            aria-label={`Select ${doc.filename}`}
            disabled={doc.status !== 'ready'}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
              selectedIds.includes(doc.id)
                ? 'border-[#5b52eb] bg-[#5b52eb] text-white'
                : doc.status === 'ready'
                  ? 'border-[#d7d8e1] hover:border-[#8a83ee] dark:border-[#3d3f4a]'
                  : 'cursor-not-allowed border-[#efeff1] bg-[#f5f5f7] dark:border-white/5 dark:bg-white/5'
            }`}
          >
            {selectedIds.includes(doc.id) && <Check size={13} />}
          </button>

          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] ${docTints[i % docTints.length].bg}`}
          >
            <FileText size={17} />
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold">{doc.filename}</p>
            <p className={`mt-1 text-[10px] ${faint}`}>
              {doc.status === 'ready'
                ? `${doc.total_pages} ${doc.total_pages === 1 ? 'page' : 'pages'} · Added ${formatAdded(doc.created_at) || ''}`.trim()
                : doc.status === 'processing'
                  ? 'Processing…'
                  : doc.error || 'Failed to index'}
            </p>
          </div>

          <StatusBadge status={doc.status} />
          {!compact && (
            <button
              onClick={() => onDelete(doc.id)}
              aria-label={`Delete ${doc.filename}`}
              title="Delete document"
              className="text-[#a7a8b2] transition-colors hover:text-[#c7463a] dark:text-[#6f717c] dark:hover:text-[#f0887d]"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: Document['status'] }) {
  if (status === 'ready') {
    return (
      <span className="hidden items-center gap-1.5 rounded-full bg-[#eaf7ef] px-2.5 py-1 text-[10px] font-semibold text-[#399466] dark:bg-white/10 dark:text-[#6fd9a0] sm:flex">
        <Check size={11} /> Ready
      </span>
    )
  }
  if (status === 'processing') {
    return (
      <span className="hidden items-center gap-1.5 rounded-full bg-[#fff4e7] px-2.5 py-1 text-[10px] font-semibold text-[#cb7a2d] dark:bg-white/10 dark:text-[#f0a862] sm:flex">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[#df8b3d]" /> Processing
      </span>
    )
  }
  return (
    <span className="hidden items-center gap-1.5 rounded-full bg-[#fdecec] px-2.5 py-1 text-[10px] font-semibold text-[#b3382e] dark:bg-white/10 dark:text-[#f2a4a0] sm:flex">
      Failed
    </span>
  )
}

// --------------------------------------------------------------------------- //
// Chat
// --------------------------------------------------------------------------- //

function ChatView({
  documents,
  selectedIds,
  onToggleDoc,
}: {
  documents: Document[]
  selectedIds: string[]
  onToggleDoc: (id: string) => void
}) {
  const [question, setQuestion] = useState('')
  const [transcript, setTranscript] = useState<ChatEntry[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAsk() {
    const text = question.trim()
    if (!text || pending) return
    setQuestion('')
    setError(null)
    setPending(text)
    try {
      const { job_id } = await api.startChat(text, selectedIds.length ? selectedIds : null)
      const job = await api.waitForJob(job_id)
      const jobFailed = api.jobError(job)
      const answer = jobFailed ?? String(job.result ?? '')
      setTranscript((current) => [...current, { question: text, answer }])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reach Athena.'
      setError(message)
      setPending(null)
    } finally {
      setPending(null)
    }
  }

  const readyCount = documents.filter((d) => d.status === 'ready').length

  return (
    <>
      <div className={`mt-7 rounded-[16px] border p-4 sm:p-6 ${border} ${surface}`}>
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#eeedff] text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
              <Bot size={18} />
            </div>
            <div>
              <p className="text-[13px] font-semibold">New conversation</p>
              <p className={`text-[11px] ${faint}`}>
                {selectedIds.length
                  ? `${selectedIds.length} ${selectedIds.length === 1 ? 'document' : 'documents'} selected`
                  : `Using all ${readyCount} ready documents`}
              </p>
            </div>
          </div>
        </div>

        {documents.length > 0 && (
          <DocSelector documents={documents} selectedIds={selectedIds} onToggleDoc={onToggleDoc} />
        )}

        {error && <ErrorBanner message={error} />}

        {transcript.map((entry, i) => (
          <div key={`${i}-${entry.question}`} className="border-b border-[#f0f0f4] py-4 dark:border-white/5">
            <div className="rounded-[12px] bg-[#f5f4ff] p-4 text-[13px] leading-6 text-[#3c3b54] dark:bg-[#241f41] dark:text-[#cfd0f4]">
              <p className="font-semibold">You asked</p>
              <p className="mt-1">{entry.question}</p>
            </div>
            <div className="mt-4 flex gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#242337] text-white">
                <Sparkles size={13} />
              </div>
              <div className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-6 text-[#444553] dark:text-[#c3c5d2]">
                {entry.answer}
              </div>
            </div>
          </div>
        ))}

        {pending && (
          <div className="mt-4 flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#242337] text-white">
              <Sparkles size={13} />
            </div>
            <div className="flex-1 text-[13px] leading-6 text-[#888a98] dark:text-[#a9abb8]">
              <span className="font-semibold text-[#3c3b54] dark:text-[#cfd0f4]">Athena</span> is
              thinking…
              <Loader2 size={13} className="ml-2 inline animate-spin text-[#5b52eb]" />
            </div>
          </div>
        )}

        <div className="mt-5 rounded-[12px] border border-[#e2e2ea] p-3 focus-within:border-[#8a83ee] focus-within:ring-2 focus-within:ring-[#eeedff] dark:border-white/10 dark:focus-within:border-[#6f67e8] dark:focus-within:ring-[#3a3650]">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAsk()
              }
            }}
            placeholder="Ask a question about your documents..."
            className="min-h-[88px] w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-[#a8a9b4] dark:placeholder:text-[#6b6c78]"
          />
          <div className="flex items-center justify-between border-t border-[#efeff3] pt-3 dark:border-white/5">
            <span className={`text-[11px] ${faint}`}>Enter to send · Shift+Enter for a new line</span>
            <button
              onClick={() => void handleAsk()}
              disabled={!question.trim() || !!pending}
              className="flex h-8 items-center gap-2 rounded-[8px] bg-[#5b52eb] px-3 text-[11px] font-semibold text-white transition-colors hover:bg-[#4e46d8] disabled:opacity-50"
            >
              {pending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              Ask Athena
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function DocSelector({
  documents,
  selectedIds,
  onToggleDoc,
}: {
  documents: Document[]
  selectedIds: string[]
  onToggleDoc: (id: string) => void
}) {
  const ready = documents.filter((d) => d.status === 'ready')
  if (ready.length === 0) return null
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      <button
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
// Quiz
// --------------------------------------------------------------------------- //

function QuizView({
  documents,
  selectedIds,
}: {
  documents: Document[]
  selectedIds: string[]
}) {
  const [topic, setTopic] = useState('')
  const [numQuestions, setNumQuestions] = useState(5)
  const [quiz, setQuiz] = useState<Quiz | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate(event?: FormEvent) {
    event?.preventDefault()
    const subject = topic.trim()
    if (!subject || loading) return
    setLoading(true)
    setError(null)
    setQuiz(null)
    try {
      const { job_id } = await api.startQuiz(subject, numQuestions, selectedIds.length ? selectedIds : null)
      const job = await api.waitForJob(job_id)
      const jobErrorMessage = api.jobError(job)
      if (jobErrorMessage) {
        setError(jobErrorMessage)
      } else if (job.result && typeof job.result === 'object') {
        setQuiz(job.result as Quiz)
      } else {
        setError('Athena returned an unexpected quiz format.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate the quiz.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <ToolCard title="Create a quiz" icon={<CircleHelp size={18} />}>
        <form onSubmit={handleGenerate}>
          <label className="text-[12px] font-semibold">What would you like to practice?</label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Neural network architectures"
            className="mt-2 h-11 w-full rounded-[9px] border border-[#e2e2ea] bg-white px-3 text-[13px] text-[#171822] outline-none transition-colors focus:border-[#8179ed] focus:ring-2 focus:ring-[#eeedff] placeholder:text-[#a8a9b4] dark:border-white/10 dark:bg-white/5 dark:text-[#e8e8ee] dark:placeholder:text-[#6b6c78] dark:focus:border-[#6f67e8] dark:focus:ring-[#3a3650]"
          />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-[12px] font-semibold">Number of questions</label>
              <select
                value={numQuestions}
                onChange={(e) => setNumQuestions(Number(e.target.value))}
                className="mt-2 h-11 w-full rounded-[9px] border border-[#e2e2ea] bg-white px-3 text-[13px] text-[#171822] outline-none transition-colors focus:border-[#8179ed] dark:border-white/10 dark:bg-[#1a1b23] dark:text-[#e8e8ee]"
              >
                <option value={5}>5 questions</option>
                <option value={10}>10 questions</option>
                <option value={15}>15 questions</option>
              </select>
            </div>
            <div className="flex items-end pb-2">
              <p className={`text-[11px] leading-5 ${faint}`}>
                {selectedIds.length
                  ? `Using ${selectedIds.length} selected ${selectedIds.length === 1 ? 'document' : 'documents'}.`
                  : `Using all ${documents.filter((d) => d.status === 'ready').length} ready documents.`}
              </p>
            </div>
          </div>

          {error && <ErrorBanner message={error} />}

          <button
            type="submit"
            disabled={!topic.trim() || loading}
            className="mt-6 flex h-10 items-center gap-2 rounded-[9px] bg-[#5b52eb] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#4e46d8] disabled:opacity-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {loading ? 'Generating…' : 'Generate quiz'}
          </button>
        </form>
      </ToolCard>

      {quiz && <QuizResult quiz={quiz} />}
    </>
  )
}

function QuizResult({ quiz }: { quiz: Quiz }) {
  return (
    <div className="mt-8">
      <h3 className="text-[17px] font-semibold tracking-[-.025em]">{quiz.title}</h3>
      {quiz.message && <p className={`mt-1 text-[12px] ${faint}`}>{quiz.message}</p>}
      <div className="mt-4 space-y-4">
        {quiz.questions.map((q, index) => (
          <QuizQuestionCard key={index} quiz={quiz} index={index} />
        ))}
      </div>
    </div>
  )
}

function QuizQuestionCard({ quiz, index }: { quiz: Quiz; index: number }) {
  const [chosen, setChosen] = useState<number | null>(null)
  const question = quiz.questions[index]
  if (!question) return null
  const revealed = chosen !== null

  return (
    <div className={`rounded-[14px] border p-4 sm:p-5 ${border} ${surface}`}>
      <div className="flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#eeedff] text-[11px] font-bold text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
          {index + 1}
        </span>
        <p className="pt-0.5 text-[13px] font-semibold leading-6">{question.question}</p>
      </div>
      <div className="mt-3 grid gap-2 pl-9 sm:grid-cols-2">
        {question.options.map((option, oi) => {
          const isCorrect = oi === question.answer_index
          const isChosen = chosen === oi
          let style =
            'border-[#e2e2ea] text-[#5f616d] hover:border-[#8a83ee] dark:border-white/10 dark:text-[#a9abb8]'
          if (revealed) {
            if (isCorrect) {
              style =
                'border-[#36a06a] bg-[#eaf7ef] text-[#256f48] dark:border-[#36a06a] dark:bg-[#1d3527] dark:text-[#6fd9a0]'
            } else if (isChosen) {
              style =
                'border-[#c7463a] bg-[#fdecec] text-[#a3352b] dark:border-[#c7463a] dark:bg-[#3a2222] dark:text-[#f2a4a0]'
            } else {
              style = 'border-[#efeff1] text-[#b0b1bb] dark:border-white/5 dark:text-[#565763]'
            }
          }
          return (
            <button
              key={oi}
              disabled={revealed}
              onClick={() => setChosen(oi)}
              className={`flex items-start gap-2 rounded-[9px] border bg-white px-3 py-2.5 text-left text-[12px] leading-5 transition-colors dark:bg-white/5 ${style} ${
                revealed ? 'cursor-default' : 'cursor-pointer'
              }`}
            >
              {revealed && isCorrect && <Check size={13} className="mt-0.5 shrink-0" />}
              <span>{option}</span>
            </button>
          )
        })}
      </div>
      {revealed && (
        <p className="mt-3 pl-9 text-[12px] leading-5 text-[#7c7e8a] dark:text-[#989aa8]">
          <span className="font-semibold text-[#33343f] dark:text-[#d8d9e0]">Explanation:</span>{' '}
          {question.explanation}
          {question.page ? ` (Page ${question.page})` : ''}
        </p>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Summary
// --------------------------------------------------------------------------- //

function SummaryView({
  documents,
  selectedIds,
}: {
  documents: Document[]
  selectedIds: string[]
}) {
  const [topic, setTopic] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate(event?: FormEvent) {
    event?.preventDefault()
    const subject = topic.trim()
    if (!subject || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const { job_id } = await api.startSummary(subject, selectedIds.length ? selectedIds : null)
      const job = await api.waitForJob(job_id)
      const jobErrorMessage = api.jobError(job)
      if (jobErrorMessage) {
        setError(jobErrorMessage)
      } else {
        setResult(typeof job.result === 'string' ? job.result : String(job.result ?? ''))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate the summary.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <ToolCard title="Choose a topic" icon={<FileText size={18} />}>
        <form onSubmit={handleGenerate}>
          <label className="text-[12px] font-semibold">Topic or chapter</label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. The basics of cognition"
            className="mt-2 h-11 w-full rounded-[9px] border border-[#e2e2ea] bg-white px-3 text-[13px] text-[#171822] outline-none transition-colors focus:border-[#8179ed] focus:ring-2 focus:ring-[#eeedff] placeholder:text-[#a8a9b4] dark:border-white/10 dark:bg-white/5 dark:text-[#e8e8ee] dark:placeholder:text-[#6b6c78] dark:focus:border-[#6f67e8] dark:focus:ring-[#3a3650]"
          />
          <p className={`mt-3 text-[11px] ${faint}`}>
            {selectedIds.length
              ? `Using ${selectedIds.length} selected ${selectedIds.length === 1 ? 'document' : 'documents'}.`
              : `Using all ${documents.filter((d) => d.status === 'ready').length} ready documents.`}
          </p>

          {error && <ErrorBanner message={error} />}

          <button
            type="submit"
            disabled={!topic.trim() || loading}
            className="mt-6 flex h-10 items-center gap-2 rounded-[9px] bg-[#5b52eb] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#4e46d8] disabled:opacity-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {loading ? 'Summarizing…' : 'Generate summary'}
          </button>
        </form>
      </ToolCard>

      {result && (
        <div className={`mt-8 max-w-[820px] rounded-[14px] border p-5 whitespace-pre-wrap ${border} ${surface}`}>
          <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold">
            <FileText size={15} className="text-[#5b52eb]" /> Summary
          </div>
          <div className="text-[13px] leading-6 text-[#33343f] dark:text-[#c3c5d2]">{result}</div>
        </div>
      )}
    </>
  )
}

function ToolCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`mt-7 max-w-[650px] rounded-[16px] border p-5 sm:p-7 ${border} ${surface}`}>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#eeedff] text-[#5b52eb] dark:bg-[#2b2750] dark:text-[#aaa3fa]">
          {icon}
        </div>
        <h3 className="text-[15px] font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Upload modal
// --------------------------------------------------------------------------- //

function UploadModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void
  onUploaded: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function addFiles(list: FileList | null) {
    if (!list) return
    const accepted = Array.from(list).filter(
      (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    )
    setFiles((current) => [...current, ...accepted])
    if (accepted.length !== Array.from(list).length) {
      setError('Only PDF files are accepted. Non-PDF files were ignored.')
    }
  }

  async function handleUpload() {
    if (files.length === 0 || uploading) return
    setUploading(true)
    setError(null)
    try {
      await api.uploadDocuments(files)
      setDone(true)
      onUploaded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
      setUploading(false)
    }
  }

  if (done) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#171822]/30 p-5 backdrop-blur-sm dark:bg-black/50">
        <div className={`w-full max-w-[430px] rounded-[18px] p-6 shadow-2xl ${surface}`}>
          <div className="flex items-start justify-between">
            <h2 className="text-[18px] font-semibold dark:text-white">Documents uploaded</h2>
            <button aria-label="Close" onClick={onClose}>
              <X size={18} className="text-[#9899a5] dark:text-[#7c7e8a]" />
            </button>
          </div>
          <p className={`mt-2 text-[13px] leading-6 ${muted}`}>
            Athena is indexing {files.length} {files.length === 1 ? 'document' : 'documents'}. You'll
            see them move to Ready automatically.
          </p>
          <button
            onClick={onClose}
            className="mt-6 flex h-10 w-full items-center justify-center rounded-[9px] bg-[#5b52eb] text-[13px] font-semibold text-white hover:bg-[#4e46d8]"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#171822]/30 p-5 backdrop-blur-sm dark:bg-black/50">
      <div className={`w-full max-w-[430px] rounded-[18px] p-6 shadow-2xl ${surface}`}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[18px] font-semibold dark:text-white">Upload documents</h2>
            <p className={`mt-1 text-[12px] ${faint}`}>PDFs up to 50 MB each</p>
          </div>
          <button aria-label="Close upload dialog" onClick={onClose}>
            <X size={18} className="text-[#9899a5] dark:text-[#7c7e8a]" />
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {files.length === 0 ? (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="mt-6 flex w-full flex-col items-center justify-center rounded-[13px] border border-dashed border-[#bbb9ee] bg-[#fafaff] py-9 text-center transition-colors hover:bg-[#f5f4ff] disabled:opacity-60 dark:border-[#3a3650] dark:bg-white/5 dark:hover:bg-white/10"
          >
            <UploadCloud size={24} className="text-[#635be6]" />
            <span className="mt-3 text-[13px] font-semibold dark:text-[#e0e1e7]">
              Drop PDFs here or browse
            </span>
            <span className={`mt-1 text-[11px] ${faint}`}>Select one or more files to add to your library</span>
          </button>
        ) : (
          <div className="mt-6 max-h-48 space-y-2 overflow-y-auto">
            {files.map((file, i) => (
              <div
                key={`${file.name}-${i}`}
                className="flex items-center gap-2.5 rounded-[9px] border border-[#f0f0f4] bg-[#fafaff] px-3 py-2.5 dark:border-white/5 dark:bg-white/5"
              >
                <FileText size={15} className="shrink-0 text-[#5b52eb]" />
                <p className="min-w-0 flex-1 truncate text-[12px] font-medium">{file.name}</p>
                <p className={`shrink-0 text-[10px] ${faint}`}>
                  {(file.size / 1024 / 1024).toFixed(file.size > 1048576 ? 1 : 0)} MB
                </p>
                <button
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
                  className="shrink-0 text-[#a7a8b2] hover:text-[#c7463a]"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-[8px] bg-[#fdecec] px-3 py-2.5 text-[12px] font-medium text-[#b3382e] dark:bg-[#3a2222] dark:text-[#f2a4a0]">
            {error}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-[9px] border px-4 text-[12px] font-semibold ${border} text-[#555764] transition-colors hover:bg-[#f4f4f8] disabled:opacity-50 dark:text-[#a9abb8] dark:hover:bg-white/5`}
          >
            {files.length === 0 ? <UploadCloud size={15} /> : <Plus size={15} />}
            {files.length === 0 ? 'Browse files' : 'Add more'}
          </button>
          <button
            onClick={() => void handleUpload()}
            disabled={files.length === 0 || uploading}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[9px] bg-[#5b52eb] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#4e46d8] disabled:opacity-50"
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
            {uploading ? 'Uploading…' : `Upload ${files.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}