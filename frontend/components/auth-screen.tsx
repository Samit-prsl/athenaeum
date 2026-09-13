'use client'

import { useState, type FormEvent } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import * as api from '@/lib/api'
import type { ApiError, User } from '@/lib/types'

type Mode = 'login' | 'register'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const apiError = error as ApiError
  if (typeof apiError?.detail === 'string') return apiError.detail
  if (Array.isArray(apiError?.detail)) {
    return apiError.detail.map((item) => item.msg ?? 'Invalid input').join(', ')
  }
  return 'Something went wrong. Please try again.'
}

const inputClass =
  'h-11 w-full rounded-[9px] border border-[#e2e2ea] bg-white px-3 text-[13px] text-[#171822] outline-none transition-colors focus:border-[#8179ed] focus:ring-2 focus:ring-[#eeedff] placeholder:text-[#a8a9b4] dark:border-white/10 dark:bg-white/5 dark:text-[#e8e8ee] dark:placeholder:text-[#6b6c78] dark:focus:border-[#6f67e8] dark:focus:ring-[#3a3650]'

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const user =
        mode === 'login'
          ? await api.login(email.trim(), password)
          : await api.register({
              email: email.trim(),
              password,
              name: name.trim(),
            })
      onAuthenticated(user)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
  }

  const title = mode === 'login' ? 'Welcome back' : 'Create your account'
  const subtitle =
    mode === 'login'
      ? 'Sign in to continue to your study space.'
      : 'Start building your personal study library.'

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f7f8fb] px-5 py-10 text-[#171822] dark:bg-[#12131a] dark:text-[#e8e8ee]">
      <div className="sm:w-full lg:w-1/2 ">
        <div className="mb-6 flex justify-center">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#5b52eb] text-white shadow-[0_8px_20px_rgba(91,82,235,.3)]">
              <Sparkles size={20} strokeWidth={2.4} />
            </div>
            <span className="text-[20px] font-semibold tracking-[-.03em] text-[#171822] dark:text-white">
              athenaeum
            </span>
          </div>
        </div>

        <div className="rounded-[18px] border border-[#e7e8ef] bg-white p-6 shadow-[0_16px_40px_rgba(30,31,55,.08)] dark:border-white/10 dark:bg-[#1a1b23] dark:shadow-none sm:p-8">
          <div className="mb-6 flex rounded-[10px] bg-[#f2f2f7] p-1 dark:bg-white/5">
            {(['login', 'register'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`flex-1 rounded-[8px] py-2 text-[12px] font-semibold transition-colors ${
                  mode === m
                    ? 'bg-white text-[#171822] shadow-sm dark:bg-white/10 dark:text-white'
                    : 'text-[#8a8c99] hover:text-[#5a52df] dark:text-[#989aa8] dark:hover:text-[#aaa3fa]'
                }`}
              >
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <h1 className="text-[20px] font-semibold tracking-[-.04em] text-[#171822] dark:text-white">
            {title}
          </h1>
          <p className="mt-1 text-[12px] text-[#8d8f9d] dark:text-[#b1b3c0]">{subtitle}</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-3.5">
            {mode === 'register' && (
              <div>
                <label className="text-[12px] font-semibold text-[#33343f] dark:text-[#cfd0d8]">
                  Name
                </label>
                <input
                  className={`mt-1.5 ${inputClass}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            )}
            <div>
              <label className="text-[12px] font-semibold text-[#33343f] dark:text-[#cfd0d8]">
                Email
              </label>
              <input
                className={`mt-1.5 ${inputClass}`}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="text-[12px] font-semibold text-[#33343f] dark:text-[#cfd0d8]">
                Password
              </label>
              <input
                className={`mt-1.5 ${inputClass}`}
                type="password"
                required
                minLength={mode === 'register' ? 6 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              {mode === 'register' && (
                <p className="mt-1 text-[10px] text-[#8f92a0] dark:text-[#9da0ac]">
                  At least 6 characters
                </p>
              )}
            </div>

            {error && (
              <div className="rounded-[8px] bg-[#fdecec] px-3 py-2.5 text-[12px] font-medium text-[#b3382e] dark:bg-[#3a2222] dark:text-[#f2a4a0]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-[9px] bg-[#5b52eb] text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(91,82,235,.25)] transition-colors hover:bg-[#4e46d8] disabled:opacity-60"
            >
              {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
              {!submitting && <ArrowRight size={15} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}