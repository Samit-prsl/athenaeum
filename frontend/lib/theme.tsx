'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark' | 'system'

const THEME_KEY = 'athenaeum.theme'
const LIGHT = 'light'
const DARK = 'dark'

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolve(theme: Theme): Theme {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT
  }
  return theme
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.remove(LIGHT, DARK)
  root.classList.add(resolve(theme))
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system')

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY)
      if (stored === LIGHT || stored === DARK || stored === 'system') {
        setThemeState(stored)
      }
    } catch {
      /* ignore storage errors */
    }
  }, [])

  useEffect(() => {
    applyTheme(theme)
    try {
      window.localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore storage errors */
    }

    if (theme !== 'system') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(theme)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => setThemeState(next), [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used within ThemeProvider')
  return value
}