import type { AfkPingKind, AfkSettings, AfkVoice } from '../types'

export const DEFAULT_SETTINGS: AfkSettings = {
  voice: { isEnabled: true, name: '' },
  // Off until there's somewhere to send to.
  messages: { isEnabled: false, primary: '', fallback: '' },
  pings: { finished: true, question: true, plan: true, approval: true, error: true },
  autoAwayMinutes: 5,
}

export const PING_LABELS: Record<AfkPingKind, string> = {
  finished: 'A turn finishes',
  question: 'Claude asks a question',
  plan: 'A plan is ready for review',
  approval: 'A tool call may need approval',
  error: 'A turn stops on an error',
}

export const PING_KINDS = Object.keys(PING_LABELS) as AfkPingKind[]

export const AUTO_AWAY_CHOICES = [0, 2, 5, 10, 15, 30] as const

// Merges whatever the store held over the defaults, so a settings object
// saved by an older version (or hand-edited) still yields every field.
export function normalizeSettings(stored: unknown): AfkSettings {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Partial<AfkSettings>
  const pings = { ...DEFAULT_SETTINGS.pings }
  for (const kind of PING_KINDS) {
    if (typeof raw.pings?.[kind] === 'boolean') pings[kind] = raw.pings[kind]
  }
  const minutes = raw.autoAwayMinutes
  return {
    voice: {
      isEnabled: typeof raw.voice?.isEnabled === 'boolean' ? raw.voice.isEnabled : DEFAULT_SETTINGS.voice.isEnabled,
      name: typeof raw.voice?.name === 'string' ? raw.voice.name : DEFAULT_SETTINGS.voice.name,
    },
    messages: {
      isEnabled: raw.messages?.isEnabled === true,
      primary: typeof raw.messages?.primary === 'string' ? raw.messages.primary : '',
      fallback: typeof raw.messages?.fallback === 'string' ? raw.messages.fallback : '',
    },
    pings,
    autoAwayMinutes: typeof minutes === 'number' && minutes >= 0 ? minutes : DEFAULT_SETTINGS.autoAwayMinutes,
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_CHARS = /^\+?[0-9\s().-]+$/
const MIN_PHONE_DIGITS = 7

export type HandleCheck = { handle: string } | { error: string }

// Accepts an email address or a phone number and returns the form Messages
// takes: a trimmed email, or a phone number with its punctuation removed.
export function checkHandle(input: string): HandleCheck {
  const text = input.trim()
  if (text === '') return { handle: '' }
  if (EMAIL.test(text)) return { handle: text }
  if (PHONE_CHARS.test(text)) {
    const digits = text.replace(/\D/g, '')
    if (digits.length >= MIN_PHONE_DIGITS) return { handle: `${text.startsWith('+') ? '+' : ''}${digits}` }
  }
  return { error: 'Enter an email address or a phone number, like +15555550123.' }
}

// One line of `say -v ?` reads `Name   en_US    # Sample sentence`. A name
// may hold spaces and parentheses, and a long one leaves a single space
// before the locale: `Eddy (German (Germany)) de_DE    # Hallo!`.
const VOICE_LINE = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/

export function parseVoices(output: string): AfkVoice[] {
  const voices: AfkVoice[] = []
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    const match = VOICE_LINE.exec(line)
    if (!match) continue
    const [, rawName = "", locale = ""] = match
    const name = rawName.trim()
    if (seen.has(name)) continue
    seen.add(name)
    voices.push({ name, locale })
  }
  return voices.sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))
}

export const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

export function formatAgo(ms: number) {
  const minutes = Math.round(ms / 60_000)
  return minutes < 1 ? 'under a minute ago' : `${minutes} min ago`
}
