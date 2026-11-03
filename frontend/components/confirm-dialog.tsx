'use client'

import { useEffect, useId, useRef } from 'react'
import { Loader2, Trash2, X } from 'lucide-react'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const onCancelRef = useRef(onCancel)

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancelRef.current()
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, busy])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#171822]/30 p-5 backdrop-blur-sm dark:bg-black/50"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-[420px] rounded-[18px] bg-white p-6 shadow-2xl dark:bg-[#1a1b23]"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[#fdecec] text-[#c7463a] dark:bg-[#3a2222] dark:text-[#f0887d]">
              <Trash2 size={18} />
            </div>
            <h2 id={titleId} className="text-[17px] font-semibold dark:text-white">
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close confirmation dialog"
            onClick={onCancel}
            disabled={busy}
            className="text-[#9899a5] transition-colors hover:text-[#555764] disabled:opacity-50 dark:text-[#7c7e8a] dark:hover:text-[#c9cad4]"
          >
            <X size={18} />
          </button>
        </div>

        <p id={descriptionId} className="mt-4 text-[13px] leading-6 text-[#80828e] dark:text-[#b1b3c0]">
          {description}
        </p>

        {error && (
          <div className="mt-4 rounded-[8px] bg-[#fdecec] px-3 py-2.5 text-[12px] font-medium text-[#b3382e] dark:bg-[#3a2222] dark:text-[#f2a4a0]">
            {error}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex h-10 flex-1 items-center justify-center rounded-[9px] border border-[#e7e8ef] px-4 text-[12px] font-semibold text-[#555764] transition-colors hover:bg-[#f4f4f8] disabled:opacity-50 dark:border-white/10 dark:text-[#a9abb8] dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[9px] bg-[#c7463a] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#b13b30] disabled:opacity-60"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
