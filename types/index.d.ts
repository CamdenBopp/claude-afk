export type AfkPingKind = 'finished' | 'question' | 'plan' | 'approval' | 'error'

export type AfkSettings = {
  voice: {
    isEnabled: boolean
    /** A name from `say -v ?`; empty means the system voice. */
    name: string
  }
  messages: {
    isEnabled: boolean
    /** An iMessage email address or phone number. */
    primary: string
    /** Tried when sending to `primary` fails. Optional. */
    fallback: string
  }
  pings: Record<AfkPingKind, boolean>
  /** Minutes without a message from this Mac before a phone message turns AFK on. 0 is off. */
  autoAwayMinutes: number
  /** Whether a new session starts with AFK on, unless its project says otherwise. */
  startAway: boolean
}

/** One project's overrides of the global settings, keyed in the store by repo root. */
export type AfkProjectSettings = {
  /** `default` follows `AfkSettings.startAway`. */
  startAway: 'default' | 'on' | 'off'
  /** null follows `AfkSettings.autoAwayMinutes`. */
  autoAwayMinutes: number | null
}

/**
 * A decision about AFK and when it was made. A session keeps its own; `/afk on
 * all` writes one every session reads. The newer one wins.
 */
export type AfkMark = {
  isAway: boolean
  /** Turned on by a phone message: a later message from the Mac cancels it. */
  isAuto: boolean
  at: number
}

export type AfkVoice = { name: string; locale: string }

export type AfkTestResult = { channel: 'voice' | 'messages'; isOk: boolean; detail: string }

declare module 'claude-code' {
  interface PluginState {
    afk: {
      settings: AfkSettings
      isAway: boolean
      isAutoAway: boolean
      /** This session's own AFK decision; null until session.start sets the default. */
      sessionMark: AfkMark | null
      /** The repo root (or folder) this session belongs to, and its overrides. */
      project: { key: string; settings: AfkProjectSettings } | null
      voices: AfkVoice[]
      /** The language the voice picker shows; null follows the saved voice. */
      voiceLanguage: string | null
      /** Per-field problems with what was typed, by Input key. */
      fieldErrors: Record<string, string>
      lastTest: AfkTestResult | null
    }
  }
}
