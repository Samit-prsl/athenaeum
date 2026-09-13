import type { Metadata, Viewport } from 'next'
import { ThemeProvider } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'Athenaeum',
  description: 'Studying with AI-powered notes, quizzes, and summaries.',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

const themeScript = `(function(){try{var t=localStorage.getItem('athenaeum.theme')||'system';if(t==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var r=document.documentElement;r.classList.remove('light','dark');r.classList.add(t);}catch(e){}})();`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}