'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '@/lib/theme'

const order: Theme[] = ['light', 'dark', 'system']

const icons: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

const labels: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  function cycle() {
    const index = order.indexOf(theme)
    setTheme(order[(index + 1) % order.length])
  }

  const Icon = icons[theme]

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Color theme: ${labels[theme]} (click to change)`}
      title={`Theme: ${labels[theme]}`}
      className="flex h-8 w-8 items-center justify-center rounded-[9px] border border-[#e4e5ec] bg-white text-[#878996] transition-colors hover:bg-[#f4f4f8] hover:text-[#5a52df] dark:border-white/10 dark:bg-white/5 dark:text-[#a9abb8] dark:hover:bg-white/10 dark:hover:text-[#aaa3fa]"
    >
      <Icon size={16} />
    </button>
  )
}