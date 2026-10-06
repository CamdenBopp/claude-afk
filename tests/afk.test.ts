import { describe, expect, mock, test } from 'claude-code/testing'

import { checkHandle, effectiveAway, normalizeSettings, parseVoices } from '../hooks/settings'
import { SAY_VOICES_OUTPUT } from './fixtures/voices'

const PLUGIN = 'afk'
const MINUTE = 60_000
const HANDLE = 'someone@example.com'
const SURFACES_WITH_FIELDS = ['terminal', 'desktop'] as const
// A worktree checkout of the repo: the project key is the main repo's root.
const REPO_ROOT = '/Users/someone/project'
const WORKTREE = '/Users/someone/project/.claude/worktrees/feature'

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
    startAway: false,
  },
}

type Engine = Parameters<Extract<Parameters<typeof test>[1], Function>>[0]
type TestOn = Parameters<Extract<Parameters<typeof test>[1], Function>>[1]

type HarnessOptions = {
  store?: Record<string, unknown>
  exitCode?: number
  now?: number
  /** The repo root `$.session.repo()` answers; null for a folder outside git. */
  repoRoot?: string | null
}

// Stands in for the engine beneath the plugin: records every host command
// instead of running it, keeps the plugin's store in a Map the test reads,
// runs a clock the test moves, and answers the events a session would.
function harness(on: TestOn, options: HarnessOptions = {}) {
  const { exitCode = 0 } = options
  const repoRoot = options.repoRoot === undefined ? REPO_ROOT : options.repoRoot
  const runs: string[][] = []
  const tools: string[] = []
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const clock = mock.clock(on, { now: options.now ?? 0 })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'say' && e.argv[2] === '?' ? SAY_VOICES_OUTPUT : ''
    return { value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: WORKTREE }))
  on('session.root', () => ({ value: WORKTREE }))
  on('session.repo', () => ({ value: repoRoot === null ? null : { root: repoRoot, remote: null, internal: false, name: null } }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('command.run', () => ({ text: '' }) as never)
  on('tool.register', (_$, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__afk__${e.name}` } } as never
  })
  // Beneath the plugin's own allow: what the engine would decide unasked.
  on('tool.check', () => ({ decision: 'ask' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { runs, store, clock, tools }
}

async function start($: Engine) {
  await $.session.start({ cwd: WORKTREE, surface: null } as never)
}

async function afk($: Engine, args: string) {
  // A neutral origin: neither the Mac nor the phone.
  return (await $.command.run({ command: 'afk', args, origin: { kind: 'plugin', name: 'test' } } as never)).text ?? ''
}

async function isAwayHere($: Engine) {
  return (await afk($, 'status')).startsWith('AFK is on')
}

async function submitFrom($: Engine, kind: 'composer' | 'bridge') {
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind } } as never)
}

async function finishTurn($: Engine, answer = 'done') {
  await $.turn.complete({ reason: 'answer', answer, durationMs: 1, isAborted: false, turnId: 't1' } as never)
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
    expect(settings.startAway).toBe(false)
  })
})

describe('effectiveAway', () => {
  const mark = (isAway: boolean, at: number, isAuto = false) => ({ isAway, isAuto, at })

  test('the newer of the session mark and the all-sessions mark wins', async () => {
    expect(effectiveAway(mark(false, 1), mark(true, 2), undefined).isAway).toBe(true)
    expect(effectiveAway(mark(true, 3), mark(false, 2), undefined).isAway).toBe(true)
    expect(effectiveAway(mark(false, 3), mark(true, 2), undefined).isAway).toBe(false)
    expect(effectiveAway(null, null, undefined).isAway).toBe(false)
  })

  test('a later Mac message ends automatic AFK but not AFK set by hand', async () => {
    expect(effectiveAway(mark(true, 5, true), null, 6)).toEqual({ isAway: false, isAuto: false })
    expect(effectiveAway(mark(true, 5, true), null, 4)).toEqual({ isAway: true, isAuto: true })
    expect(effectiveAway(mark(true, 5), null, 6)).toEqual({ isAway: true, isAuto: false })
  })
})

describe('/afk command', () => {
  test('toggles this session, and warns when no channel can reach you', async ($, on) => {
    harness(on, { store: { settings: { voice: { isEnabled: false } } } })
    await start($)
    expect(await afk($, '')).toContain("pings can't reach you")
    expect(await isAwayHere($)).toBe(true)
    expect(await afk($, 'off')).toBe('AFK off in this session.')
    expect(await isAwayHere($)).toBe(false)
  })

  test('says no ping will go out when every ping kind is off', async ($, on) => {
    const off = { finished: false, question: false, plan: false, approval: false, error: false }
    harness(on, { store: { settings: { ...configured.settings, pings: off } } })
    await start($)
    const text = await afk($, 'on')
    expect(text).toContain('no ping will go out')
    expect(text).not.toContain('You will get a ping')
  })

  test('on all writes a mark every session reads', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await h.clock.advance(MINUTE)
    expect(await afk($, 'on all')).toContain('for every open session')
    expect(h.store.get('awayAll')).toEqual({ isAway: true, isAuto: false, at: 11 * MINUTE })
    expect(await isAwayHere($)).toBe(true)
  })

  test('removes the global switch version 0.1 stored', async ($, on) => {
    const h = harness(on, { store: { ...configured, isAway: true, isAutoAway: true } })
    await start($)
    expect(h.store.has('isAway')).toBe(false)
    expect(h.store.has('isAutoAway')).toBe(false)
    expect(await isAwayHere($)).toBe(false)
  })
})

describe('set_afk tool', () => {
  const TOOL = 'mcp__afk__set_afk'
  const call = ($: Engine, args: Record<string, unknown>) =>
    $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', ...args } as never) as Promise<{ result?: unknown; deny?: string; isError?: true; text?: string }>

  test('is registered when the session starts', async ($, on) => {
    const h = harness(on, { store: configured })
    await start($)
    expect(h.tools).toEqual(['set_afk'])
  })

  test('turns AFK on and off in this session, like the command', async ($, on) => {
    harness(on, { store: configured })
    await start($)
    const turnedOn = await call($, { action: 'on' })
    expect(String(turnedOn.result)).toContain('AFK on in this session')
    expect(await isAwayHere($)).toBe(true)
    await call($, { action: 'off' })
    expect(await isAwayHere($)).toBe(false)
  })

  test('scope all writes the mark every session reads', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await h.clock.advance(MINUTE)
    await call($, { action: 'on', scope: 'all' })
    expect(h.store.get('awayAll')).toEqual({ isAway: true, isAuto: false, at: 11 * MINUTE })
  })

  test('status reports without changing anything', async ($, on) => {
    harness(on, { store: configured })
    await start($)
    const status = await call($, { action: 'status' })
    expect(String(status.result)).toContain('AFK is off in this session.')
    expect(await isAwayHere($)).toBe(false)
  })

  test('refuses an action it does not know instead of guessing', async ($, on) => {
    harness(on, { store: configured })
    await start($)
    const refused = await call($, { action: 'toggle' })
    expect(refused.deny ?? refused.text).toBe('action must be "on", "off" or "status".')
    expect(await isAwayHere($)).toBe(false)
  })

  test('needs no permission dialog', async ($, on) => {
    harness(on, { store: configured })
    await start($)
    const verdict = await $.tool.check({ tool: TOOL, input: { action: 'on' } } as never)
    expect(verdict.decision).toBe('allow')
  })
})

describe('sessions and projects', () => {
  test('a new session starts with the global default', async ($, on) => {
    harness(on, { store: { settings: { ...configured.settings, startAway: true } } })
    await start($)
    expect(await isAwayHere($)).toBe(true)
  })

  test("a project's own default beats the global one", async ($, on) => {
    harness(on, {
      store: {
        settings: { ...configured.settings, startAway: true },
        projects: { [REPO_ROOT]: { startAway: 'off', autoAwayMinutes: null } },
      },
    })
    await start($)
    expect(await isAwayHere($)).toBe(false)
  })

  test('a project set to on starts its sessions away', async ($, on) => {
    harness(on, { store: { ...configured, projects: { [REPO_ROOT]: { startAway: 'on', autoAwayMinutes: null } } } })
    await start($)
    expect(await isAwayHere($)).toBe(true)
  })

  test('outside git, the project is the session folder', async ($, on) => {
    harness(on, { repoRoot: null, store: { ...configured, projects: { [WORKTREE]: { startAway: 'on', autoAwayMinutes: null } } } })
    await start($)
    expect(await isAwayHere($)).toBe(true)
  })

  test('a hot reload keeps the session state instead of resetting to the default', async ($, on) => {
    harness(on, { store: configured })
    await start($)
    await afk($, 'on')
    // A reload raises session.start again.
    await start($)
    expect(await isAwayHere($)).toBe(true)
  })

  test('an all-sessions mark from before the session opened does not override its default', async ($, on) => {
    harness(on, { now: 10 * MINUTE, store: { ...configured, awayAll: { isAway: true, isAuto: false, at: 5 * MINUTE } } })
    await start($)
    expect(await isAwayHere($)).toBe(false)
  })

  test('another session turning everything on reaches this one', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await h.clock.advance(MINUTE)
    h.store.set('awayAll', { isAway: true, isAuto: false, at: 11 * MINUTE })
    expect(await isAwayHere($)).toBe(true)
  })
})

describe('automatic AFK', () => {
  test('a phone message after the quiet period turns AFK on; a Mac message turns it off', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)

    await submitFrom($, 'composer')
    await h.clock.advance(6 * MINUTE)
    await submitFrom($, 'bridge')
    expect(await afk($, 'status')).toContain('turned on from your phone')

    await h.clock.advance(MINUTE)
    await submitFrom($, 'composer')
    expect(await isAwayHere($)).toBe(false)
  })

  test('a Mac message in another session ends automatic AFK here too', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await submitFrom($, 'composer')
    await h.clock.advance(6 * MINUTE)
    await submitFrom($, 'bridge')
    await h.clock.advance(MINUTE)
    h.store.set('lastMacMessageAt', 17 * MINUTE)
    expect(await isAwayHere($)).toBe(false)
  })

  test('a slash command typed on the Mac counts as Mac activity', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await submitFrom($, 'composer')
    await h.clock.advance(6 * MINUTE)
    await submitFrom($, 'bridge')
    expect(await isAwayHere($)).toBe(true)

    await h.clock.advance(MINUTE)
    await $.command.run({ command: 'compact', args: '', origin: { kind: 'composer' } } as never)
    expect(h.store.get('lastMacMessageAt')).toBe(17 * MINUTE)
    expect(await isAwayHere($)).toBe(false)
  })

  test('a slash command from the phone is not Mac activity', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await $.command.run({ command: 'compact', args: '', origin: { kind: 'bridge' } } as never)
    expect(h.store.has('lastMacMessageAt')).toBe(false)
  })

  test('a phone message inside the quiet period leaves AFK off', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)

    await submitFrom($, 'composer')
    await h.clock.advance(4 * MINUTE)
    await submitFrom($, 'bridge')
    expect(await isAwayHere($)).toBe(false)
  })

  test("a project's own quiet time replaces the global one", async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: { ...configured, projects: { [REPO_ROOT]: { startAway: 'default', autoAwayMinutes: 10 } } } })
    await start($)

    await submitFrom($, 'composer')
    await h.clock.advance(6 * MINUTE)
    await submitFrom($, 'bridge')
    expect(await isAwayHere($)).toBe(false)

    await h.clock.advance(5 * MINUTE)
    await submitFrom($, 'bridge')
    expect(await isAwayHere($)).toBe(true)
  })

  test('a Mac message never turns off AFK that was turned on by hand', async ($, on) => {
    const h = harness(on, { now: 10 * MINUTE, store: configured })
    await start($)
    await afk($, 'on')
    await h.clock.advance(MINUTE)

    await submitFrom($, 'composer')
    expect(await isAwayHere($)).toBe(true)
  })

  test('set to Never, a phone message changes nothing', async ($, on) => {
    harness(on, { now: 100 * MINUTE, store: { settings: { ...configured.settings, autoAwayMinutes: 0 } } })
    await start($)

    await submitFrom($, 'bridge')
    expect(await isAwayHere($)).toBe(false)
  })
})

describe('pings', () => {
  test('a finished turn speaks with the chosen voice and texts the configured handle', async ($, on) => {
    const h = harness(on, { store: configured })
    await start($)
    await afk($, 'on')

    await finishTurn($, 'All tests pass.')
    await h.clock.settle()

    const say = h.runs.find(argv => argv[0] === 'say')
    const osa = h.runs.find(argv => argv[0] === 'osascript')
    expect(say?.slice(0, 3)).toEqual(['say', '-v', 'Samantha'])
    expect(say?.[3]).toContain('Claude finished in project.')
    expect(say?.[3]).toContain('All tests pass.')
    expect(osa?.at(-1)).toBe(HANDLE)
    expect(osa?.at(-2)).toContain('All tests pass.')
  })

  test('nothing runs while AFK is off', async ($, on) => {
    const h = harness(on, { store: configured })
    await start($)

    await finishTurn($)
    await h.clock.settle()
    expect(h.runs).toEqual([])
  })

  test('an interrupted turn does not ping', async ($, on) => {
    const h = harness(on, { store: configured })
    await start($)
    await afk($, 'on')

    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't1' } as never)
    await h.clock.settle()
    expect(h.runs).toEqual([])
  })

  test('a ping kind switched off stays quiet', async ($, on) => {
    const h = harness(on, { store: { settings: { ...configured.settings, pings: { ...configured.settings.pings, finished: false } } } })
    await start($)
    await afk($, 'on')

    await finishTurn($)
    await h.clock.settle()
    expect(h.runs).toEqual([])
  })

  test('the fallback handle is tried when the first send fails', async ($, on) => {
    const h = harness(on, {
      exitCode: 1,
      store: {
        settings: { ...configured.settings, voice: { isEnabled: false, name: '' }, messages: { isEnabled: true, primary: HANDLE, fallback: '+15555550123' } },
      },
    })
    await start($)
    await afk($, 'on')

    await finishTurn($)
    await h.clock.settle()
    expect(h.runs.map(argv => argv.at(-1))).toEqual([HANDLE, '+15555550123'])
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
      expect((await ui.find({ key: 'messages-enabled' }))?.props.value).toBe('on')
    })

    test(`${surface}: picking a voice and toggling a ping kind persist`, async ($, on) => {
      const h = harness(on, { store: {} })
      await start($)
      // /afk setup loads the voice list; a voice not in it can't be picked.
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      await ui.select({ key: 'voice-name', value: 'Samantha (English (US))' })
      await ui.select({ key: 'ping-approval', value: 'off' })
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

        test(`${surface}: project pickers save under the repo root, not the worktree`, async ($, on) => {
      const h = harness(on, { store: configured })
      await start($)
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      expect(await ui.find({ type: 'Text', text: 'This project: project' })).toBeDefined()
      await ui.select({ key: 'project-start-away', value: 'on' })
      await ui.select({ key: 'project-auto-away', value: '15' })
      expect(h.store.get('projects')).toEqual({ [REPO_ROOT]: { startAway: 'on', autoAwayMinutes: 15 } })

      await ui.select({ key: 'project-auto-away', value: 'default' })
      expect(h.store.get('projects')).toEqual({ [REPO_ROOT]: { startAway: 'on', autoAwayMinutes: null } })
    })

    test(`${surface}: the all-sessions buttons write the shared mark`, async ($, on) => {
      const h = harness(on, { now: 10 * MINUTE, store: configured })
      await start($)
      await $.command.run({ command: 'afk', args: 'setup' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'afk-setup', props: PANE_PROPS })

      await h.clock.advance(MINUTE)
      await ui.press({ key: 'away-all-on' })
      expect(h.store.get('awayAll')).toEqual({ isAway: true, isAuto: false, at: 11 * MINUTE })
      expect(await ui.find({ type: 'Text', text: 'AFK is on in this session.' })).toBeDefined()
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
    // No pickers on the phone: the button names its action, not a state.
    expect(await ui.find({ key: 'ping-finished', text: 'Turn off: ping when a turn finishes' })).toBeDefined()
    await ui.press({ key: 'ping-finished' })
    expect(normalizeSettings(h.store.get('settings')).pings.finished).toBe(false)
    expect(await ui.find({ key: 'ping-finished', text: 'Turn on: ping when a turn finishes' })).toBeDefined()
    await ui.press({ key: 'away' })
    expect(await isAwayHere($)).toBe(true)
    // Project settings are read-only text on the phone.
    expect(await ui.find({ type: 'Text', text: 'AFK in new sessions here: Off (default)' })).toBeDefined()
  })
})
