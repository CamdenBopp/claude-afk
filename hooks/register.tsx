import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AfkPingKind, AfkSettings, AfkTestResult, AfkVoice } from '../types'
import {
  AUTO_AWAY_CHOICES,
  DEFAULT_SETTINGS,
  PING_KINDS,
  MAX_SELECT_OPTIONS,
  PING_LABELS,
  basename,
  checkHandle,
  clip,
  formatAgo,
  groupVoices,
  languageLabel,
  languageOf,
  normalizeSettings,
  voiceLabel,
  parseVoices,
} from './settings'

type Api = EngineInterface

// $.store keys. The store outlives sessions: being away is about the person,
// not one conversation, so every session with the plugin shares these.
const SETTINGS_KEY = 'settings'
const AWAY_KEY = 'isAway'
// True when a phone message turned AFK on, so a message typed on this Mac
// turns it back off. AFK turned on by hand stays on.
const AUTO_AWAY_KEY = 'isAutoAway'
const LAST_MAC_KEY = 'lastMacMessageAt'
const ORIGIN_LOG_KEY = 'recentOrigins'

// $.state: what the setup pane draws from.
const settingsAtom = atom({ plugin: 'afk', key: 'settings' } as const, DEFAULT_SETTINGS)
const awayAtom = atom({ plugin: 'afk', key: 'isAway' } as const, false)
const autoAwayAtom = atom({ plugin: 'afk', key: 'isAutoAway' } as const, false)
const voicesAtom = atom({ plugin: 'afk', key: 'voices' } as const, [] as AfkVoice[])
const voiceLanguageAtom = atom({ plugin: 'afk', key: 'voiceLanguage' } as const, null as string | null)
const fieldErrorsAtom = atom({ plugin: 'afk', key: 'fieldErrors' } as const, {} as Record<string, string>)
const lastTestAtom = atom({ plugin: 'afk', key: 'lastTest' } as const, null as AfkTestResult | null)

const PANE = 'afk-setup'
const SYSTEM_VOICE = 'system'

// Where a prompt came from, as the engine stamps it (PromptOrigin.kind).
// `composer` is Enter in the session's own window; `bridge` is Remote Control
// from a phone or the web.
const MAC_ORIGINS: readonly string[] = ['composer']
const PHONE_ORIGINS: readonly string[] = ['bridge']

// An `ask` verdict alone doesn't mean a dialog is up: in auto mode the
// classifier may settle it within seconds. Ping only if the call is still
// unsettled after this long.
const APPROVAL_GRACE_MS = 15_000

const MINUTE_MS = 60_000
const ORIGIN_LOG_LENGTH = 20
const SPOKEN_SNIPPET_CHARS = 80
const TEXT_SNIPPET_CHARS = 300
const COMMAND_TIMEOUT_MS = 20_000

// The message and handle go in as argv, so nothing needs AppleScript quoting.
const SEND_SCRIPT = [
  'on run argv',
  'tell application "Messages" to send (item 1 of argv) to participant (item 2 of argv) of (1st account whose service type = iMessage)',
  'end run',
]

type Ping = { spoken: string; text: string }
type OriginEntry = { kind: string; at: number }
type SendOutcome = { sentTo: string } | { error: string }

// Calls that got an `ask` verdict and haven't settled, by tool_use_id.
const pendingApprovals = new Map<string, { cancel: () => void }>()
// What's typed in a setup field but not yet saved with Enter, by Input key.
const drafts = new Map<string, string>()

async function loadSettings($: Api) {
  return normalizeSettings(await $.store.get(SETTINGS_KEY))
}

async function saveSettings($: Api, change: (settings: AfkSettings) => AfkSettings) {
  const next = change(await loadSettings($))
  await $.store.set(SETTINGS_KEY, next)
  await update($, settingsAtom, () => next)
  return next
}

async function isAway($: Api) {
  return (await $.store.get(AWAY_KEY)) === true
}

// Copies what the store holds into the pane's state; another session may
// have changed it since this one last looked.
async function syncState($: Api) {
  const settings = await loadSettings($)
  const away = await isAway($)
  const isAuto = away && (await $.store.get(AUTO_AWAY_KEY)) === true
  await update($, settingsAtom, () => settings)
  await update($, awayAtom, () => away)
  await update($, autoAwayAtom, () => isAuto)
  showStatus($, away, isAuto)
}

function showStatus($: Api, away: boolean, isAuto: boolean) {
  return $.ui.status(away ? (isAuto ? 'AFK: auto, pings on' : 'AFK: pings on') : undefined)
}

async function setAway($: Api, away: boolean, isAuto: boolean) {
  await $.store.set(AWAY_KEY, away)
  await $.store.set(AUTO_AWAY_KEY, away && isAuto)
  await update($, awayAtom, () => away)
  await update($, autoAwayAtom, () => away && isAuto)
  showStatus($, away, away && isAuto)
}

function hasChannel(settings: AfkSettings) {
  return settings.voice.isEnabled || (settings.messages.isEnabled && settings.messages.primary !== '')
}

async function projectName($: Api) {
  return basename(await $.session.cwd())
}

async function sendOne($: Api, handle: string, text: string) {
  const run = await $.process.run(
    ['osascript', ...SEND_SCRIPT.flatMap(line => ['-e', line]), text, handle],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  )
  return run.exitCode === 0 ? undefined : run.stderr.trim() || `exit ${run.exitCode}`
}

// Tries the primary handle, then the fallback. A 0 exit means Messages took
// the message, not that it was delivered.
async function sendMessage($: Api, settings: AfkSettings, text: string): Promise<SendOutcome> {
  const { primary, fallback } = settings.messages
  if (primary === '') return { error: 'no address or number is set' }
  try {
    const primaryError = await sendOne($, primary, text)
    if (primaryError === undefined) return { sentTo: primary }
    if (fallback === '') return { error: primaryError }
    const fallbackError = await sendOne($, fallback, text)
    return fallbackError === undefined ? { sentTo: fallback } : { error: `${primaryError}; fallback: ${fallbackError}` }
  } catch (error) {
    return { error: String(error) }
  }
}

async function speak($: Api, settings: AfkSettings, text: string) {
  const voiceArgs = settings.voice.name === '' ? [] : ['-v', settings.voice.name]
  try {
    const run = await $.process.run(['say', ...voiceArgs, text], { timeoutMs: COMMAND_TIMEOUT_MS })
    return run.exitCode === 0 ? undefined : run.stderr.trim() || `exit ${run.exitCode}`
  } catch (error) {
    return String(error)
  }
}

// Speaks and texts at once, through whichever channels are on. Never throws,
// since a failed ping must not break the turn, but a failure shows as a toast.
async function ping($: Api, { spoken, text }: Ping) {
  const settings = await loadSettings($)
  const voiceError = settings.voice.isEnabled ? speak($, settings, spoken) : Promise.resolve(undefined)
  const messageOutcome: Promise<SendOutcome | undefined> =
    settings.messages.isEnabled && settings.messages.primary !== ''
      ? sendMessage($, settings, text)
      : Promise.resolve(undefined)
  const [spokenError, sent] = await Promise.all([voiceError, messageOutcome])
  const failures = [
    spokenError === undefined ? undefined : `voice failed: ${spokenError}`,
    sent !== undefined && 'error' in sent ? `iMessage failed: ${sent.error}` : undefined,
  ].filter((failure): failure is string => failure !== undefined)
  if (failures.length > 0) $.ui.toast(`AFK: ${failures.join('; ')}`)
}

// Fire and forget from inside a hook: the turn never waits on Messages.
async function notify($: Api, kind: AfkPingKind, build: (project: string) => Ping) {
  if (!(await isAway($))) return
  const settings = await loadSettings($)
  if (!settings.pings[kind]) return
  void ping($, build(await projectName($)))
}

function settle(id: string | undefined) {
  if (id === undefined) return
  pendingApprovals.get(id)?.cancel()
  pendingApprovals.delete(id)
}

async function loadVoices($: Api) {
  if ((await read($, voicesAtom)).length > 0) return
  try {
    const run = await $.process.run(['say', '-v', '?'], { timeoutMs: COMMAND_TIMEOUT_MS })
    if (run.exitCode === 0) await update($, voicesAtom, () => parseVoices(run.stdout))
  } catch {
    // Not macOS, or `say` is missing: the pane says the voice list is unavailable.
  }
}

async function openSetup($: Api) {
  await syncState($)
  void loadVoices($)
  await $.ui.open({ id: PANE, title: 'AFK setup', focus: true, closeOnEscape: true })
}

async function recordOrigin($: Api, entry: OriginEntry) {
  const previous = await $.store.get(ORIGIN_LOG_KEY)
  const list = Array.isArray(previous) ? (previous as OriginEntry[]) : []
  await $.store.set(ORIGIN_LOG_KEY, [...list, entry].slice(-ORIGIN_LOG_LENGTH))
}

async function saveHandle($: Api, field: 'primary' | 'fallback', value: string) {
  const checked = checkHandle(value)
  await update($, fieldErrorsAtom, errors => {
    const { [field]: _, ...rest } = errors
    return 'error' in checked ? { ...rest, [field]: checked.error } : rest
  })
  if ('error' in checked) return false
  drafts.delete(field)
  await saveSettings($, settings => ({
    ...settings,
    messages: {
      ...settings.messages,
      [field]: checked.handle,
      // Typing a first address is a clear sign texts are wanted.
      isEnabled: field === 'primary' && settings.messages.primary === '' && checked.handle !== '' ? true : settings.messages.isEnabled,
    },
  }))
  return true
}

async function runVoiceTest($: Api) {
  const settings = await loadSettings($)
  // `say` exits 0 for a voice that isn't installed and quietly uses the
  // system voice, so its exit code can't confirm the voice.
  await loadVoices($)
  const voices = await read($, voicesAtom)
  if (settings.voice.name !== '' && voices.length > 0 && !voices.some(voice => voice.name === settings.voice.name)) {
    await update($, lastTestAtom, () => ({
      channel: 'voice',
      isOk: false,
      detail: `${settings.voice.name} isn't installed, so pings would use the system voice. Pick another voice.`,
    }))
    return
  }
  const error = await speak($, settings, 'This is how AFK pings will sound.')
  const voiceName = settings.voice.name === '' ? 'the system voice' : settings.voice.name
  await update($, lastTestAtom, () =>
    error === undefined
      ? { channel: 'voice', isOk: true, detail: `Spoke with ${voiceName}.` }
      : { channel: 'voice', isOk: false, detail: `Couldn't speak: ${error}` },
  )
}

async function runMessageTest($: Api) {
  // Save anything typed but not yet entered, so the test uses what's on screen.
  for (const field of ['primary', 'fallback'] as const) {
    const draft = drafts.get(field)
    if (draft !== undefined && !(await saveHandle($, field, draft))) {
      await update($, lastTestAtom, () => ({ channel: 'messages', isOk: false, detail: 'Fix the address above first.' }))
      return
    }
  }
  const settings = await loadSettings($)
  const outcome = await sendMessage($, settings, `AFK test from Claude Code in ${await projectName($)}.`)
  await update($, lastTestAtom, () =>
    'sentTo' in outcome
      ? { channel: 'messages', isOk: true, detail: `Messages accepted a test to ${outcome.sentTo}. Check that it arrived.` }
      : { channel: 'messages', isOk: false, detail: `Couldn't send: ${outcome.error}` },
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'afk',
      description: 'Get a spoken and iMessage ping when Claude finishes or needs you',
      argumentHint: '[on|off|setup|status|test]',
      immediate: true,
    })
    await syncState($)
    return next(e)
  })

  on('command.run', { command: 'afk' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wasAway = await isAway($)
    const settings = await loadSettings($)

    if (arg === 'setup') {
      await openSetup($)
      return { text: 'AFK setup opened.' }
    }

    if (arg === 'status') {
      const isAuto = (await $.store.get(AUTO_AWAY_KEY)) === true
      const lastMac = await $.store.get(LAST_MAC_KEY)
      const now = await $.clock.now()
      const state = wasAway ? (isAuto ? 'AFK is on (turned on from your phone).' : 'AFK is on.') : 'AFK is off.'
      const macLine = typeof lastMac === 'number'
        ? `Last message from this Mac: ${formatAgo(now - lastMac)}.`
        : 'No message from this Mac recorded yet.'
      return { text: `${state} ${macLine}` }
    }

    if (arg === 'test') {
      await ping($, { spoken: 'AFK test from Claude.', text: `AFK test from Claude Code in ${await projectName($)}.` })
      return { text: hasChannel(settings) ? 'Test ping sent.' : 'Nothing to test: voice and iMessage are both off. Run /afk setup.' }
    }

    if (arg === 'origins') {
      const log = await $.store.get(ORIGIN_LOG_KEY)
      const list = Array.isArray(log) ? (log as OriginEntry[]) : []
      const now = await $.clock.now()
      return {
        text: list.length === 0
          ? 'No messages recorded yet.'
          : list.map(o => `${formatAgo(now - o.at)}: ${o.kind}`).join('\n'),
      }
    }

    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Usage: /afk [on|off|setup|status|test]. With no argument, /afk toggles.' }
    }

    const away = arg === '' ? !wasAway : arg === 'on'
    await setAway($, away, false)
    if (!away) return { text: 'AFK off.' }
    return {
      text: hasChannel(settings)
        ? 'AFK on. You will get a ping when a turn ends or Claude needs you.'
        : 'AFK on, but voice and iMessage are both off, so nothing will reach you. Run /afk setup.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const kind = e.origin.kind
    const now = await $.clock.now()
    await recordOrigin($, { kind, at: now })

    if (MAC_ORIGINS.includes(kind)) {
      await $.store.set(LAST_MAC_KEY, now)
      if ((await isAway($)) && (await $.store.get(AUTO_AWAY_KEY)) === true) {
        await setAway($, false, false)
        $.ui.toast('AFK off: you sent a message from this Mac.')
      }
    } else if (PHONE_ORIGINS.includes(kind) && !(await isAway($))) {
      const { autoAwayMinutes } = await loadSettings($)
      const lastMac = await $.store.get(LAST_MAC_KEY)
      const sinceMac = typeof lastMac === 'number' ? now - lastMac : Infinity
      if (autoAwayMinutes > 0 && sinceMac > autoAwayMinutes * MINUTE_MS) {
        await setAway($, true, true)
        $.ui.toast(`AFK on: a message came from your phone and nothing from this Mac in ${autoAwayMinutes} minutes.`)
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    for (const id of [...pendingApprovals.keys()]) settle(id)
    // A subagent's turn isn't one to come back for; an interrupt means you're here.
    if (e.agentId !== undefined || e.reason === 'aborted') return result

    if (e.reason === 'answer') {
      const answer = e.answer.trim()
      await notify($, 'finished', project => ({
        spoken: `Claude finished in ${project}. ${clip(answer, SPOKEN_SNIPPET_CHARS)}`,
        text: answer === ''
          ? `Claude finished in ${project}.`
          : `Claude finished in ${project}: ${clip(answer, TEXT_SNIPPET_CHARS)}`,
      }))
    } else {
      const why = e.reason === 'refusal' ? 'declined to continue' : 'stopped on an error'
      await notify($, 'error', project => ({
        spoken: `Claude ${why} in ${project}.`,
        text: `Claude ${why} in ${project} and needs you.`,
      }))
    }
    return result
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const first = (e.questions as Array<{ question?: string }>)[0]?.question ?? ''
    await notify($, 'question', project => ({
      spoken: `Claude has a question in ${project}.`,
      text: `Claude has a question in ${project}: ${clip(first, TEXT_SNIPPET_CHARS)}`,
    }))
    return next(e)
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    await notify($, 'plan', project => ({
      spoken: `Claude has a plan ready in ${project}.`,
      text: `Claude has a plan ready for your review in ${project}.`,
    }))
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    // A plugin's query has no id and no dialog behind it.
    if (verdict.decision !== 'ask' || id === undefined || !(await isAway($))) return verdict
    if (pendingApprovals.has(id)) return verdict

    const timer = $.clock.after(APPROVAL_GRACE_MS, () => {
      if (!pendingApprovals.has(id)) return
      pendingApprovals.delete(id)
      void notify($, 'approval', project => ({
        spoken: `Claude may need your approval in ${project}.`,
        text: `Claude may need your approval for ${e.tool} in ${project}.`,
      }))
    })
    pendingApprovals.set(id, timer)
    return verdict
  })

  // Settled one way or another: approved and ran, refused, or interrupted.
  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      settle(e.tool_use_id)
    }
  })

  // The run-in-background hint shows only once a call is running, so it's
  // past any dialog.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    settle(e.props.tool_use_id)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The phone app draws no text fields or pickers yet: its table still
    // hands back constructors for them, but what they build is dropped.
    const hasFields = e.surface !== 'mobile'
    const Input = hasFields && 'Input' in table ? table.Input : undefined
    const Select = hasFields && 'Select' in table ? table.Select : undefined
    const settings = await read($, settingsAtom)
    const away = await read($, awayAtom)
    const isAuto = await read($, autoAwayAtom)
    const voices = await read($, voicesAtom)
    const pickedLanguage = await read($, voiceLanguageAtom)
    const errors = await read($, fieldErrorsAtom)
    const lastTest = await read($, lastTestAtom)
    const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')

    const toggle = (change: (s: AfkSettings) => AfkSettings) => () => void saveSettings($, change)

    const heading = (text: string) => <Text bold>{text}</Text>

    const statusLine = away
      ? isAuto ? 'AFK is on. Your phone turned it on.' : 'AFK is on.'
      : 'AFK is off.'

    const testLine = (channel: AfkTestResult['channel']) =>
      lastTest !== null && lastTest.channel === channel
        ? <Text color={lastTest.isOk ? 'green' : 'red'}>{lastTest.detail}</Text>
        : null

    const groups = groupVoices(voices)
    const savedVoice = voices.find(voice => voice.name === settings.voice.name)
    const language =
      (pickedLanguage !== null && groups.has(pickedLanguage) ? pickedLanguage : undefined) ??
      (savedVoice !== undefined ? languageOf(savedVoice.locale) : undefined) ??
      (groups.has('en') ? 'en' : groups.keys().next().value) ??
      ''
    const languageOptions = [...groups.keys()]
      .slice(0, MAX_SELECT_OPTIONS)
      .map(code => ({ value: code, label: languageLabel(code) }))
    // "System voice" takes one of the slots.
    const voiceOptions = [
      { value: SYSTEM_VOICE, label: 'System voice' },
      ...(groups.get(language) ?? [])
        .slice(0, MAX_SELECT_OPTIONS - 1)
        .map(voice => ({ value: voice.name, label: voiceLabel(voice) })),
    ]
    // Keep a saved voice pickable when it isn't in the language shown.
    if (settings.voice.name !== '' && !voiceOptions.some(option => option.value === settings.voice.name)) {
      voiceOptions.splice(1, 0, { value: settings.voice.name, label: settings.voice.name })
      voiceOptions.length = Math.min(voiceOptions.length, MAX_SELECT_OPTIONS)
    }

    const awayOptions = AUTO_AWAY_CHOICES.map(minutes => ({
      value: String(minutes),
      label: minutes === 0 ? 'Never' : `After ${minutes} minutes`,
    }))

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          {heading('Status')}
          <Text>{statusLine}</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="away"
              variant="primary"
              label={away ? 'Turn AFK off' : 'Turn AFK on'}
              onPress={() => void setAway($, !away, false)}
            />
          </Box>
          {!hasChannel(settings) && (
            <Text color="yellow">Voice and iMessage are both off, so pings can't reach you.</Text>
          )}
        </Box>

        <Box flexDirection="column">
          {heading('Voice')}
          <Button
            key="voice-enabled"
            label={`Speak pings: ${onOff(settings.voice.isEnabled)}`}
            onPress={toggle(s => ({ ...s, voice: { ...s.voice, isEnabled: !s.voice.isEnabled } }))}
          />
          {Select !== undefined && languageOptions.length > 0 && (
            <Select
              key="voice-language"
              label="Language"
              options={languageOptions}
              value={language}
              onSelect={value => void update($, voiceLanguageAtom, () => value)}
            />
          )}
          {Select !== undefined ? (
            <Select
              key="voice-name"
              label="Voice"
              options={voiceOptions}
              value={settings.voice.name === '' ? SYSTEM_VOICE : settings.voice.name}
              onSelect={value =>
                void saveSettings($, s => ({ ...s, voice: { ...s.voice, name: value === SYSTEM_VOICE ? '' : value } }))
              }
            />
          ) : (
            <Text>{`Voice: ${settings.voice.name === '' ? 'System voice' : settings.voice.name}`}</Text>
          )}
          {settings.voice.name !== '' && voices.length > 0 && savedVoice === undefined && (
            <Text color="yellow">{`${settings.voice.name} isn't installed on this Mac, so pings use the system voice.`}</Text>
          )}
          {voices.length === 0 && <Text dimColor>The voice list loads from macOS. If it stays empty, `say` isn't available.</Text>}
          <Text dimColor>If you use a screen reader, pick a voice other than its voice so pings stand out.</Text>
          <Button key="voice-test" label="Test voice" onPress={() => void runVoiceTest($)} />
          {testLine('voice')}
        </Box>

        <Box flexDirection="column">
          {heading('iMessage')}
          <Button
            key="messages-enabled"
            label={`Text pings: ${onOff(settings.messages.isEnabled)}`}
            onPress={toggle(s => ({ ...s, messages: { ...s.messages, isEnabled: !s.messages.isEnabled } }))}
          />
          {Input !== undefined ? (
            <Box flexDirection="column">
              <Input
                key="primary"
                label="Send to"
                placeholder="Email or phone number"
                value={settings.messages.primary}
                submitLabel="save"
                onInput={value => void drafts.set('primary', value)}
                onSubmit={value => void saveHandle($, 'primary', value)}
              />
              {errors.primary !== undefined && <Text color="red">{errors.primary}</Text>}
              <Input
                key="fallback"
                label="Fallback"
                placeholder="Optional: tried if the first one fails"
                value={settings.messages.fallback}
                submitLabel="save"
                onInput={value => void drafts.set('fallback', value)}
                onSubmit={value => void saveHandle($, 'fallback', value)}
              />
              {errors.fallback !== undefined && <Text color="red">{errors.fallback}</Text>}
              <Text dimColor>Press Enter in a field to save it.</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text>{`Send to: ${settings.messages.primary === '' ? 'not set' : settings.messages.primary}`}</Text>
              <Text>{`Fallback: ${settings.messages.fallback === '' ? 'not set' : settings.messages.fallback}`}</Text>
              <Text dimColor>Change these from the Mac.</Text>
            </Box>
          )}
          <Button key="messages-test" label="Send test message" onPress={() => void runMessageTest($)} />
          {testLine('messages')}
        </Box>

        <Box flexDirection="column">
          {heading('Ping me when')}
          {PING_KINDS.map(kind => (
            <Button
              key={`ping-${kind}`}
              label={`${PING_LABELS[kind]}: ${onOff(settings.pings[kind])}`}
              onPress={toggle(s => ({ ...s, pings: { ...s.pings, [kind]: !s.pings[kind] } }))}
            />
          ))}
        </Box>

        <Box flexDirection="column">
          {heading('Turn AFK on automatically')}
          <Text dimColor>When a message comes from your phone through Remote Control and nothing has come from this Mac for a while. A message from this Mac turns it back off.</Text>
          {Select !== undefined ? (
            <Select
              key="auto-away"
              label="Turn on"
              options={awayOptions}
              value={String(settings.autoAwayMinutes)}
              onSelect={value => void saveSettings($, s => ({ ...s, autoAwayMinutes: Number(value) }))}
            />
          ) : (
            <Text>
              {settings.autoAwayMinutes === 0 ? 'Never' : `After ${settings.autoAwayMinutes} minutes`}
            </Text>
          )}
        </Box>

        <Box flexDirection="row">
          <Button key="done" role="dismiss" label="Done" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
