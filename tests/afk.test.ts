import { describe, expect, mock, test } from 'claude-code/testing'

import { checkHandle, normalizeSettings, parseVoices } from '../hooks/settings'
import { SAY_VOICES_OUTPUT } from './fixtures/voices'

const PLUGIN = 'afk'
const MINUTE = 60_000
const HANDLE = 'someone@example.com'
const SURFACES_WITH_FIELDS = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: 'AFK setup',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, height: 40, total: 40 },
  view: {},
} as never

const configured = {
  settings: {
    voice: { isEnabled: true, name: 'Samantha' },
    messages: { isEnabled: true, primary: HANDLE, fallback: '' },
    pings: { finished: true, question: true, plan: true, approval: true, error: true },
    autoAwayMinutes: 5,
  },
}

type Engine = Parameters<Extract<Parameters<typeof test>[1], Function>>[0]
type TestOn = Parameters<Extract<Parameters<typeof test>[1], Function>>[1]

// Stands in for the engine beneath the plugin: records every host command
// instead of running it, keeps the plugin's store in a Map the test reads,
// runs a clock the test moves, and answers the events a session would.
function harness(on: TestOn, options: { store?: Record<string, unknown>; exitCode?: number; now?: number } = {}) {
  const { exitCode = 0 } = options
  const runs: string[][] = []
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const clock = mock.clock(on, { now: options.now ?? 0 })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'say' && e.argv[2] === '?' ? SAY_VOICES_OUTPUT : ''
    return { value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: '/Users/someone/project' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { runs, store, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/Users/someone/project', surface: null } as never)
}

async function submitFrom($: Engine, kind: 'composer' | 'bridge') {
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind } } as never)
}

describe('settings helpers', () => {
  test('checkHandle accepts emails and phone numbers and rejects junk', async () => {
    expect(checkHandle(' someone@example.com ')).toEqual({ handle: 'someone@example.com' })
    expect(checkHandle('+1 (555) 555-0123')).toEqual({ handle: '+15555550123' })
    expect(checkHandle('')).toEqual({ handle: '' })
    expect('error' in checkHandle('not a handle')).toBe(true)
    expect('error' in checkHandle('12345')).toBe(true)
  })

  test('parseVoices keeps names with spaces and parentheses', async () => {
    const voices = parseVoices(
      'Samantha            en_US    # Hello\nEddy (English (US)) en_US    # Hi\nThomas              fr_FR    # Bonjour\n',
    )
    expect(voices.map(v => v.name)).toEqual(['Eddy (English (US))', 'Samantha', 'Thomas'])
  })

  test('normalizeSettings fills in fields an older store lacks', async () => {
    const settings = normalizeSettings({ voice: { name: 'Samantha' } })
    expect(settings.voice).toEqual({ isEnabled: true, name: 'Samantha' })
    expect(settings.messages.isEnabled).toBe(false)
    expect(settings.pings.finished).toBe(true)
    expect(settings.autoAwayMinutes).toBe(5)
  })
})

describe('/afk command', () => {
  test('toggles, and warns when no channel can reach you', async ($, on) => {
    const h = harness(on, { store: { settings: { voice: { isEnabled: false } } } })
    const first = await $.command.run({ command: 'afk', args: '' } as never)
    expect(first.text).toContain('nothing will reach you')
    expect(h.store.get('isAway')).toBe(true)
    const second = await $.command.run({ command: 'afk', args: 'off' } as never)
    expect(second.text).toBe('AFK off.')
    expect(h.store.get('isAway')).toBe(false)
  })
})

describe('automatic AFK', () => {
  test('a phone message after the quiet period turns AFK on; a Mac message turns it off', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    const { clock } = h

    await submitFrom($, 'composer')
    await clock.advance(6 * MINUTE)
    await submitFrom($, 'bridge')
    expect(h.store.get('isAway')).toBe(true)
    expect(h.store.get('isAutoAway')).toBe(true)

    await submitFrom($, 'composer')
    expect(h.store.get('isAway')).toBe(false)
  })

  test('a phone message inside the quiet period leaves AFK off', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    const { clock } = h

    await submitFrom($, 'composer')
    await clock.advance(4 * MINUTE)
    await submitFrom($, 'bridge')
    expect(h.store.get('isAway') === true).toBe(false)
  })

  test('a Mac message never turns off AFK that was turned on by hand', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: { ...configured, isAway: true, isAutoAway: false } })

    await submitFrom($, 'composer')
    expect(h.store.get('isAway')).toBe(true)
  })

  test('set to Never, a phone message changes nothing', async ($, on) => {
    const h = harness(on, { now: 100 * MINUTE, store: { settings: { ...configured.settings, autoAwayMinutes: 0 } } })

    await submitFrom($, 'bridge')
    expect(h.store.get('isAway') === true).toBe(false)
  })
})

describe('pings', () => {
  test('a finished turn speaks with the chosen voice and texts the configured handle', async ($, on) => {
    const h = harness(on, { store: { ...configured, isAway: true } })
    const { runs } = h

    await $.turn.complete({ reason: 'answer', answer: 'All tests pass.', durationMs: 1, isAborted: false, turnId: 't1' } as never)
    await h.clock.settle()

    const say = runs.find(argv => argv[0] === 'say')
    const osa = runs.find(argv => argv[0] === 'osascript')
    expect(say?.slice(0, 3)).toEqual(['say', '-v', 'Samantha'])
    expect(say?.[3]).toContain('All tests pass.')
    expect(osa?.at(-1)).toBe(HANDLE)
    expect(osa?.at(-2)).toContain('All tests pass.')
  })

  test('nothing runs while AFK is off', async ($, on) => {
    const h = harness(on, { store: configured })
    const { runs } = h

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as never)
    await h.clock.settle()
    expect(runs).toEqual([])
  })

  test('an interrupted turn does not ping', async ($, on) => {
    const h = harness(on, { store: { ...configured, isAway: true } })
    const { runs } = h

    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' } as never)
    await h.clock.settle()
    expect(runs).toEqual([])
  })

  test('a ping kind switched off stays quiet', async ($, on) => {
    const h = harness(on, { store: { settings: { ...configured.settings, pings: { ...configured.settings.pings, finished: false } }, isAway: true } })
    const { runs } = h

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as never)
    await h.clock.settle()
    expect(runs).toEqual([])
  })

  test('the fallback handle is tried when the first send fails', async ($, on) => {
    const h = harness(on, {
      exitCode: 1,
      store: {
        settings: { ...configured.settings, voice: { isEnabled: false, name: '' }, messages: { isEnabled: true, primary: HANDLE, fallback: '+15555550123' } },
      isAway: true,
      },
    })
    const { runs } = h

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as never)
    await h.clock.settle()
    expect(runs.map(argv => argv.at(-1))).toEqual([HANDLE, '+15555550123'])
  })
})

describe('setup pane', () => {
  for (const surface of SURFACES_WITH_FIELDS) {
    test(`${surface}: an invalid address shows an error and saves nothing`, async ($, on) => {
      const h = harness(on, { store: {} })
      await start($)
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      await ui.input({ key: 'primary', text: 'not a handle' })
      expect(await ui.find({ type: 'Text', text: /Enter an email address or a phone number/ })).toBeDefined()
      expect(normalizeSettings(h.store.get('settings')).messages.primary).toBe('')
    })

    test(`${surface}: a valid address saves and turns texts on`, async ($, on) => {
      const h = harness(on, { store: {} })
      await start($)
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      await ui.input({ key: 'primary', text: HANDLE })
      const saved = normalizeSettings(h.store.get('settings'))
      expect(saved.messages).toEqual({ isEnabled: true, primary: HANDLE, fallback: '' })
      expect(await ui.find({ key: 'messages-enabled', text: 'Text pings: on' })).toBeDefined()
    })

    test(`${surface}: picking a voice and toggling a ping kind persist`, async ($, on) => {
      const h = harness(on, { store: {} })
      await start($)
      // /afk setup loads the voice list; a voice not in it can't be picked.
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      await ui.select({ key: 'voice-name', value: 'Samantha (English (US))' })
      await ui.press({ key: 'ping-approval' })
      await ui.select({ key: 'auto-away', value: '10' })
      const saved = normalizeSettings(h.store.get('settings'))
      expect(saved.voice.name).toBe('Samantha (English (US))')
      expect(saved.pings.approval).toBe(false)
      expect(saved.autoAwayMinutes).toBe(10)
    })

    test(`${surface}: a voice in another language is picked through the language picker`, async ($, on) => {
      const h = harness(on, { store: {} })
      await start($)
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      const englishOnly = (await ui.find({ key: 'voice-name' }))?.props.options as Array<{ value: string }>
      expect(englishOnly.some(option => option.value === 'Thomas')).toBe(false)
      await ui.select({ key: 'voice-language', value: 'fr' })
      await ui.select({ key: 'voice-name', value: 'Thomas' })
      expect(normalizeSettings(h.store.get('settings')).voice.name).toBe('Thomas')
    })

        test(`${surface}: the voice test reports what happened`, async ($, on) => {
      const h = harness(on, { store: {} })
      const { runs } = h
      await start($)
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      await ui.press({ key: 'voice-test' })
      expect(runs.some(argv => argv[0] === 'say' && argv[1] !== '-v')).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'Spoke with the system voice.' })).toBeDefined()
    })
  }

  test('the voice test refuses a voice that is not installed instead of trusting say', async ($, on) => {
    const h = harness(on, { store: { settings: { voice: { isEnabled: true, name: 'Nonexistent Voice' } } } })
    const { runs } = h
    await start($)
    await $.command.run({ command: 'afk', args: 'setup' } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

    expect(await ui.find({ type: 'Text', text: /isn't installed on this Mac/ })).toBeDefined()
    await ui.press({ key: 'voice-test' })
    expect(await ui.find({ type: 'Text', text: /isn't installed, so pings would use the system voice/ })).toBeDefined()
    expect(runs.some(argv => argv[0] === 'say' && argv[2] !== '?')).toBe(false)
  })

  test('mobile: draws without fields and still toggles AFK', async ($, on) => {
    const h = harness(on, { store: configured })
    await start($)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

    expect(await ui.find({ type: 'Text', text: `Send to: ${HANDLE}` })).toBeDefined()
    await ui.press({ key: 'away' })
    expect(h.store.get('isAway')).toBe(true)
  })
})
