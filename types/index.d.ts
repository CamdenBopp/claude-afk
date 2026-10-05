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
}

export type AfkVoice = { name: string; locale: string }

export type AfkTestResult = { channel: 'voice' | 'messages'; isOk: boolean; detail: string }

declare module 'claude-code' {
  interface PluginState {
    afk: {
      settings: AfkSettings
      isAway: boolean
      isAutoAway: boolean
      voices: AfkVoice[]
      /** The language the voice picker shows; null follows the saved voice. */
      voiceLanguage: string | null
      /** Per-field problems with what was typed, by Input key. */
      fieldErrors: Record<string, string>
      lastTest: AfkTestResult | null
    }
  }
}
