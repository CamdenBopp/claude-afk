import type { AfkMark, AfkPingKind, AfkProjectSettings, AfkSettings, AfkVoice } from '../types'

export const DEFAULT_SETTINGS: AfkSettings = {
  voice: { isEnabled: true, name: '' },
  // Off until there's somewhere to send to.
  messages: { isEnabled: false, primary: '', fallback: '' },
  pings: { finished: true, question: true, plan: true, approval: true, error: true },
  autoAwayMinutes: 5,
  startAway: false,
}

export const DEFAULT_PROJECT: AfkProjectSettings = { startAway: 'default', autoAwayMinutes: null }

// Each reads after "Ping when".
export const PING_LABELS: Record<AfkPingKind, string> = {
  finished: 'a turn finishes',
  question: 'Claude asks a question',
  plan: 'a plan is ready for review',
  approval: 'a tool call may need approval',
  error: 'a turn stops on an error',
}

export const PING_KINDS = Object.keys(PING_LABELS) as AfkPingKind[]

// Why AFK being on would still reach nobody, or undefined when a ping can
// get through.
export function reachProblem(settings: AfkSettings) {
  const hasVoice = settings.voice.isEnabled
  const hasMessages = settings.messages.isEnabled && settings.messages.primary !== ''
  if (!hasVoice && !hasMessages) return 'Voice and iMessage are both off, so pings can\'t reach you.'
  if (!PING_KINDS.some(kind => settings.pings[kind])) return 'Every event under "Ping me when" is off, so nothing will ping you.'
  return undefined
}

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
    startAway: raw.startAway === true,
  }
}

export function normalizeProject(stored: unknown): AfkProjectSettings {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Partial<AfkProjectSettings>
  const minutes = raw.autoAwayMinutes
  return {
    startAway: raw.startAway === 'on' || raw.startAway === 'off' ? raw.startAway : 'default',
    autoAwayMinutes: typeof minutes === 'number' && minutes >= 0 ? minutes : null,
  }
}

// Whether a new session in a project starts away.
export const startsAway = (settings: AfkSettings, project: AfkProjectSettings) =>
  project.startAway === 'default' ? settings.startAway : project.startAway === 'on'

export const autoAwayMinutesFor = (settings: AfkSettings, project: AfkProjectSettings) =>
  project.autoAwayMinutes ?? settings.autoAwayMinutes

export const describeAutoAway = (minutes: number) => (minutes === 0 ? 'Never' : `After ${minutes} minutes`)

// Whether a session is away right now. The newer of its own mark and the
// all-sessions mark wins; a tie goes to the session's own. AFK that a phone
// message turned on ends once the Mac sends a message after it.
export function effectiveAway(own: AfkMark | null, all: AfkMark | null, lastMacAt: number | undefined) {
  const latest = own === null ? all : all === null || own.at >= all.at ? own : all
  if (latest === null || !latest.isAway) return { isAway: false, isAuto: false }
  if (latest.isAuto && lastMacAt !== undefined && lastMacAt > latest.at) return { isAway: false, isAuto: false }
  return { isAway: true, isAuto: latest.isAuto }
}

export function readMark(stored: unknown): AfkMark | null {
  if (!stored || typeof stored !== 'object') return null
  const raw = stored as Partial<AfkMark>
  if (typeof raw.isAway !== 'boolean' || typeof raw.at !== 'number') return null
  return { isAway: raw.isAway, isAuto: raw.isAuto === true, at: raw.at }
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

// The engine refuses a Select with more than this many options, and macOS
// ships far more voices than that (216 on macOS 27), so voices are picked
// in two steps: a language, then a voice in it.
export const MAX_SELECT_OPTIONS = 64

export const languageOf = (locale: string) => locale.split('_')[0] ?? locale

export function languageLabel(code: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

// Voices by language code, languages in label order.
export function groupVoices(voices: readonly AfkVoice[]) {
  const groups = new Map<string, AfkVoice[]>()
  for (const voice of voices) {
    const code = languageOf(voice.locale)
    groups.set(code, [...(groups.get(code) ?? []), voice])
  }
  return new Map([...groups].sort(([a], [b]) => languageLabel(a).localeCompare(languageLabel(b))))
}

// macOS names many voices with their language already ("Samantha (English
// (US))"); the rest get their locale so en_US and en_GB voices tell apart.
export const voiceLabel = (voice: AfkVoice) => (voice.name.includes('(') ? voice.name : `${voice.name} (${voice.locale})`)

export const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

export function formatAgo(ms: number) {
  const minutes = Math.round(ms / 60_000)
  return minutes < 1 ? 'under a minute ago' : `${minutes} min ago`
}
