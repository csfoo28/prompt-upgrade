import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

// ---------------------------------------------------------------- the world beneath the mod

const QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Who is the page for?', options: ['Local customers', 'Wholesale buyers'] },
    { question: 'What should it include?', options: ['Menu and hours', 'Online ordering', 'Story'] },
  ],
})

const REWRITE = JSON.stringify({
  prompt:
    'Build a one-page landing site for [bakery name] aimed at local customers, showing the menu and opening hours. Done means a single responsive HTML page I can open in a browser.',
  added: ['A clear goal', 'Audience: local customers', 'Contents: menu and hours', 'What done looks like'],
})

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type WorldOptions = {
  isPlaced?: boolean
  questions?: string
  failRewrite?: boolean
}

function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = {
    sent: [] as { text: string; origin: PromptOrigin }[],
    filled: [] as string[],
    logs: [] as string[],
    models: [] as string[],
    opened: 0,
    closed: 0,
  }
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    seen.opened++
    return { value: options.isPlaced === false ? { isPlaced: false as const, reason: 'narrow' } : { isPlaced: true as const } }
  })
  on('ui.close', () => {
    seen.closed++
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    seen.sent.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('model.complete', (_$, e) => {
    seen.models.push(e.model)
    const isRewrite = e.model !== 'haiku'
    if (isRewrite && options.failRewrite) {
      return { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } }
    }
    const text = isRewrite ? REWRITE : (options.questions ?? QUESTIONS)
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  return { clock, seen }
}

const TYPED: PromptOrigin = { kind: 'composer' }

function paneProps(bodyColumns: number) {
  return {
    title: 'Prompt Upgrade',
    isFocused: true,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  }
}

function mountPane($: Engine, surface: 'terminal' | 'desktop', columns = 100) {
  return $.ui.mount({
    plugin: 'prompt-upgrade',
    surface,
    component: 'Pane',
    requestId: 'prompt-upgrade',
    props: paneProps(columns),
    viewport: { columns: columns + 4, rows: 60, isFullscreen: true },
  })
}

function better($: Engine, args: string) {
  return $.command.run({ command: 'better', args, origin: TYPED, presentation: { isFullscreen: true, columns: 120 } })
}

function typePrompt($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: TYPED })
}

// ---------------------------------------------------------------- the full flow

describe('the full flow', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`/better to Run on ${surface}`, async ($, on) => {
      const { clock, seen } = world(on)

      const answer = await better($, 'make a landing page for my bakery')
      expect(answer.text).toContain('Upgrading')
      await clock.settle()
      expect(seen.opened).toBeGreaterThan(0)
      expect(seen.models).toEqual(['haiku'])

      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: 'Who is the page for?' })).toBeDefined()
      expect(await ui.find({ key: 'skip-rest' })).toBeDefined()

      await ui.press({ key: 'q0-o0' })
      expect(await ui.find({ type: 'Text', text: /1 of 2 answered/i })).toBeDefined()
      await ui.press({ key: 'q1-o0' })
      await clock.settle()
      expect(seen.models).toEqual(['haiku', 'sonnet'])

      // Review: numbers, buttons above the cards, what was added, both cards.
      expect(await ui.find({ key: 'run' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'DETAILS ADDED' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Audience: local customers' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '[bakery name]' })).toBeDefined()

      await ui.press({ key: 'run' })
      expect(seen.sent).toHaveLength(1)
      expect(seen.sent[0]!.text).toContain('one-page landing site')
      expect(seen.sent[0]!.origin).toMatchObject({ kind: 'plugin', name: 'prompt-upgrade', asUser: true })
      expect(seen.closed).toBeGreaterThan(0)
      await ui.unmount()
    })
  }

  test('Skip the rest goes straight to the rewrite without the skipped answers', async ($, on) => {
    const { clock, seen } = world(on)
    await better($, 'write a blog post about sourdough')
    await clock.settle()
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'q0-o1' })
    await ui.press({ key: 'skip-rest' })
    await clock.settle()
    expect(seen.models).toEqual(['haiku', 'sonnet'])
    expect(await ui.find({ key: 'run' })).toBeDefined()
  })

  test('when no question would help it goes straight to the rewrite', async ($, on) => {
    const { clock, seen } = world(on, { questions: '{"questions": []}' })
    await better($, 'rename the variable foo to bar in utils.ts and run the tests')
    await clock.settle()
    await clock.settle()
    expect(seen.models).toEqual(['haiku', 'sonnet'])
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ key: 'run' })).toBeDefined()
  })

  test('Edit lets the person change the upgrade and Enter runs it', async ($, on) => {
    const { clock, seen } = world(on, { questions: '{"questions": []}' })
    await better($, 'plan my week')
    await clock.settle()
    await clock.settle()
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'edit' })
    await ui.input({ key: 'edit', text: 'My edited prompt' })
    expect(seen.sent.map(s => s.text)).toEqual(['My edited prompt'])
  })
})

// ---------------------------------------------------------------- cancel and errors

describe('nothing is lost', () => {
  test('Cancel closes the pane and puts the original back in the prompt box', async ($, on) => {
    const { clock, seen } = world(on)
    await better($, 'on')
    const result = await typePrompt($, 'build me a sales dashboard for the team')
    expect(result.drop).toBeDefined()
    expect(seen.sent).toHaveLength(0)
    await clock.settle()
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'cancel' })
    expect(seen.filled).toContain('build me a sales dashboard for the team')
    expect(seen.closed).toBeGreaterThan(0)
    expect(seen.sent).toHaveLength(0)
  })

  test('a failed model call shows a calm card and can send the original', async ($, on) => {
    const { clock, seen } = world(on, { failRewrite: true, questions: '{"questions": []}' })
    await better($, 'summarise the quarterly numbers for the board')
    await clock.settle()
    await clock.settle()
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /prompt is safe/ })).toBeDefined()
    expect(await ui.find({ key: 'retry' })).toBeDefined()
    await ui.press({ key: 'send-original' })
    expect(seen.sent.map(s => s.text)).toEqual(['summarise the quarterly numbers for the board'])
  })

  test('a window too narrow for the pane puts the words back and says so once', async ($, on) => {
    const { seen } = world(on, { isPlaced: false })
    await better($, 'on')
    const result = await typePrompt($, 'draft a reply to the landlord about the leak')
    expect(result.drop).toMatch(/too narrow/)
    expect(seen.filled).toContain('draft a reply to the landlord about the leak')
    expect(seen.sent).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- the switch

describe('the on and off switch', () => {
  test('on intercepts typed prompts, off lets them through', async ($, on) => {
    const { seen } = world(on)

    // Off by default.
    await typePrompt($, 'refactor the payment module into smaller files')
    expect(seen.sent.map(s => s.text)).toEqual(['refactor the payment module into smaller files'])

    expect((await better($, 'on')).text).toMatch(/is on/)
    const held = await typePrompt($, 'refactor the payment module into smaller files')
    expect(held.drop).toBeDefined()
    expect(seen.sent).toHaveLength(1)

    // Pass-throughs while on.
    await typePrompt($, 'yes')
    await typePrompt($, '> send this exactly')
    expect(seen.sent.map(s => s.text)).toEqual([
      'refactor the payment module into smaller files',
      'yes',
      'send this exactly',
    ])

    expect((await better($, 'off')).text).toMatch(/is off/)
    await typePrompt($, 'write the release notes for version two')
    expect(seen.sent).toHaveLength(4)
  })
})

// ---------------------------------------------------------------- history and widths

describe('history and sizing', () => {
  test('history keeps the upgrade and reopens its review', async ($, on) => {
    const { clock } = world(on, { questions: '{"questions": []}' })
    await better($, 'make a packing list for a beach trip')
    await clock.settle()
    await clock.settle()
    const first = await mountPane($, 'terminal')
    await first.press({ key: 'cancel' })
    await first.unmount()

    expect((await better($, 'history')).text).toMatch(/last 1 upgrade/)
    const ui = await mountPane($, 'terminal')
    const rows = await ui.findAll({ type: 'Button' })
    const past = rows.find(r => (r.key ?? '').startsWith('past-'))
    expect(past).toBeDefined()
    await ui.press({ key: past!.key! })
    expect(await ui.find({ key: 'run' })).toBeDefined()
  })

  for (const columns of [34, 60, 140]) {
    test(`fixed rows fit a ${columns}-column pane`, async ($, on) => {
      const { clock } = world(on, { questions: '{"questions": []}' })
      await better($, 'write a short bio for my portfolio site')
      await clock.settle()
      await clock.settle()
      const ui = await mountPane($, 'terminal', columns)
      expect(await ui.find({ key: 'run' })).toBeDefined()
      const rule = await ui.find({ type: 'Text', text: /━/ })
      expect(rule).toBeDefined()
      expect(rule!.text.length).toBe(columns)
      const tracker = await ui.find({ type: 'Text', text: /Review|4/ })
      expect(tracker).toBeDefined()
      for (const t of await ui.findAll({ type: 'Text', text: /^\+ / })) {
        expect(t.text.length).toBeLessThanOrEqual(columns)
      }
    })
  }
})
