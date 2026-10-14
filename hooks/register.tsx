import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Answer, Flow, HistoryEntry, Upgrade, View } from '../types'
import {
  HISTORY_LIMIT,
  PANE,
  PLUGIN,
  QUESTION_MODEL,
  QUESTION_SYSTEM,
  REWRITE_MODEL,
  REWRITE_SYSTEM,
  STEPS,
  bigNumber,
  bigWidth,
  failureReason,
  fit,
  newId,
  parseQuestions,
  parseRewrite,
  questionPrompt,
  rewritePrompt,
  route,
  stepIndex,
  timeLabel,
  trackerLabels,
  wordCount,
} from './logic'

type Engine = EngineInterface

// ---------------------------------------------------------------- palette

const GOLD = '#F2C46D'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#0D1117'

// ---------------------------------------------------------------- state

const flowAtom = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, null)
const viewAtom = atom({ plugin: 'prompt-upgrade', key: 'view' } as const, 'flow')
const autoAtom = atom({ plugin: 'prompt-upgrade', key: 'isAuto' } as const, false)
const historyAtom = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [])

const STORE_AUTO = 'isAuto'
const STORE_HISTORY = 'history'

const TITLE = 'Prompt Upgrade'

// ---------------------------------------------------------------- flow actions
// Every change of state happens here, from a command, a press or an event.
// The render hook only reads.

function freshFlow(original: string, step: Flow['step'], now: number): Flow {
  return {
    id: newId(now),
    step,
    original,
    questions: [],
    answers: [],
    otherOpen: -1,
    upgrade: null,
    error: null,
    isEditing: false,
    isCopied: false,
  }
}

async function patchFlow($: Engine, id: string, fn: (f: Flow) => Flow): Promise<void> {
  await update($, flowAtom, f => (f && f.id === id ? fn(f) : f))
}

/** Opens the pane on the person's behalf; true when a surface draws it. */
async function openPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
  return opened.isPlaced
}

async function closePane($: Engine): Promise<void> {
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Already closed, or another plugin kept it: nothing to do.
  }
}

/**
 * Starts an upgrade of `original`. Returns false when no pane could be drawn,
 * after putting the words back in the prompt box.
 */
async function startUpgrade($: Engine, original: string, options: { sayWhy: boolean }): Promise<boolean> {
  const flow = freshFlow(original, 'asking', await $.clock.now())
  await update($, viewAtom, () => 'flow' as View)
  await update($, flowAtom, () => flow)
  const isPlaced = await openPane($)
  if (!isPlaced) {
    await update($, flowAtom, () => null)
    await closePane($)
    await $.prompt.fill({ text: original })
    if (options.sayWhy) {
      $.ui.log('Prompt Upgrade: the window is too narrow for its pane, so your words are back in the prompt box.')
    }
    return false
  }
  later($, () => askQuestions($, flow.id))
  return true
}

/** Runs work after the current dispatch, so commands and hooks answer at once. */
function later($: Engine, fn: () => Promise<void>): void {
  $.clock.after(0, () => {
    fn().catch(err => failFlow($, String((err as Error)?.message ?? err)))
  })
}

async function failFlow($: Engine, reason: string): Promise<void> {
  try {
    await update($, flowAtom, (f): Flow | null => {
      if (!f || (f.step !== 'asking' && f.step !== 'writing')) return f
      return { ...f, step: 'error', error: { during: f.step, reason } }
    })
  } catch {
    // Nothing more can be done from here.
  }
}

async function askQuestions($: Engine, id: string): Promise<void> {
  const flow = await read($, flowAtom)
  if (!flow || flow.id !== id || flow.step !== 'asking') return
  const reply = await $.model.complete({
    model: QUESTION_MODEL,
    system: QUESTION_SYSTEM,
    prompt: questionPrompt(flow.original),
    maxTokens: 700,
    effort: 'low',
    timeoutMs: 45_000,
  })
  const now = await read($, flowAtom)
  if (!now || now.id !== id || now.step !== 'asking') return
  if (!reply.isAnswered) {
    const r = reply as { reason?: string; status?: number }
    await patchFlow($, id, f => ({ ...f, step: 'error', error: { during: 'asking', reason: failureReason(r) } }))
    return
  }
  let questions
  try {
    questions = parseQuestions(reply.text)
  } catch {
    await patchFlow($, id, f => ({
      ...f,
      step: 'error',
      error: { during: 'asking', reason: 'The questions came back in a shape I could not read.' },
    }))
    return
  }
  if (questions.length === 0) {
    await patchFlow($, id, f => ({ ...f, step: 'writing', questions: [], answers: [] }))
    later($, () => writeUpgrade($, id))
    return
  }
  await patchFlow($, id, f => ({ ...f, step: 'questions', questions, answers: questions.map(() => null) }))
}

async function writeUpgrade($: Engine, id: string): Promise<void> {
  const flow = await read($, flowAtom)
  if (!flow || flow.id !== id || flow.step !== 'writing') return
  const reply = await $.model.complete({
    model: REWRITE_MODEL,
    system: REWRITE_SYSTEM,
    prompt: rewritePrompt(flow.original, flow.questions, flow.answers),
    maxTokens: 2500,
    timeoutMs: 90_000,
  })
  const now = await read($, flowAtom)
  if (!now || now.id !== id || now.step !== 'writing') return
  if (!reply.isAnswered) {
    const r = reply as { reason?: string; status?: number }
    await patchFlow($, id, f => ({ ...f, step: 'error', error: { during: 'writing', reason: failureReason(r) } }))
    return
  }
  let upgrade: Upgrade
  try {
    upgrade = parseRewrite(reply.text)
  } catch {
    await patchFlow($, id, f => ({
      ...f,
      step: 'error',
      error: { during: 'writing', reason: 'The rewrite came back in a shape I could not read.' },
    }))
    return
  }
  await patchFlow($, id, f => ({ ...f, step: 'review', upgrade, isEditing: false, isCopied: false }))
  await remember($, { id, at: await $.clock.now(), original: now.original, upgrade })
}

async function remember($: Engine, entry: HistoryEntry): Promise<void> {
  const saved = await update($, historyAtom, past =>
    [entry, ...past.filter(p => p.id !== entry.id)].slice(0, HISTORY_LIMIT),
  )
  await $.store.set(STORE_HISTORY, saved)
}

function allAnswered(answers: readonly Answer[]): boolean {
  return answers.every(a => a !== null)
}

async function answer($: Engine, id: string, index: number, value: Answer): Promise<void> {
  let isDone = false
  await patchFlow($, id, f => {
    if (f.step !== 'questions') return f
    const answers = f.answers.map((a, i) => (i === index ? value : a))
    isDone = allAnswered(answers)
    return { ...f, answers, otherOpen: -1, step: isDone ? 'writing' : 'questions' }
  })
  if (isDone) later($, () => writeUpgrade($, id))
}

async function skipRest($: Engine, id: string): Promise<void> {
  await patchFlow($, id, f =>
    f.step === 'questions'
      ? { ...f, answers: f.answers.map(a => a ?? { kind: 'skip' as const }), otherOpen: -1, step: 'writing' }
      : f,
  )
  later($, () => writeUpgrade($, id))
}

async function retry($: Engine, id: string): Promise<void> {
  const flow = await read($, flowAtom)
  if (!flow || flow.id !== id || flow.step !== 'error' || !flow.error) return
  const during = flow.error.during
  await patchFlow($, id, f => ({ ...f, step: during, error: null }))
  later($, () => (during === 'asking' ? askQuestions($, id) : writeUpgrade($, id)))
}

/** Sends `text` as the person's own prompt and closes the pane. */
async function runText($: Engine, text: string): Promise<void> {
  const body = text.trim()
  if (body === '') return
  await update($, flowAtom, () => null)
  await closePane($)
  // Submitted under this plugin's origin, which the prompt.submit hook passes through.
  await $.prompt.submit({ text: body, asUser: true })
}

/** Closes the pane and puts the original prompt back in the prompt box. */
async function cancel($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  await update($, flowAtom, () => null)
  await update($, viewAtom, () => 'flow' as View)
  await closePane($)
  if (flow && flow.original.trim() !== '') await $.prompt.fill({ text: flow.original })
}

async function openFromHistory($: Engine, entry: HistoryEntry): Promise<void> {
  const flow: Flow = {
    ...freshFlow(entry.original, 'review', await $.clock.now()),
    id: entry.id,
    upgrade: entry.upgrade,
  }
  await update($, flowAtom, () => flow)
  await update($, viewAtom, () => 'flow' as View)
}

async function setAuto($: Engine, isAuto: boolean): Promise<void> {
  await update($, autoAtom, () => isAuto)
  await $.store.set(STORE_AUTO, isAuto)
}

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'better',
      description: 'Upgrade a rough prompt before sending it (on, off, history)',
      argumentHint: '[prompt | on | off | history]',
    })
    // Settings that outlive the session.
    const storedAuto = await $.store.get(STORE_AUTO)
    await update($, autoAtom, () => storedAuto === true)
    const storedHistory = await $.store.get(STORE_HISTORY)
    if (Array.isArray(storedHistory)) {
      await update($, historyAtom, () => (storedHistory as HistoryEntry[]).slice(0, HISTORY_LIMIT))
    }
    // A reload mid-step picks the step back up instead of leaving the pane stuck.
    const flow = await read($, flowAtom)
    if (flow && (flow.step === 'asking' || flow.step === 'writing')) {
      const isUp = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isUp) void $.ui.open({ id: PANE, title: TITLE })
      const id = flow.id
      later($, () => (flow.step === 'asking' ? askQuestions($, id) : writeUpgrade($, id)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'better' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()

    if (word === 'on') {
      await setAuto($, true)
      return {
        text: 'Prompt Upgrade automatic mode is on. Prompts you type go to the pane first; start one with > to send it as-is.',
      }
    }
    if (word === 'off') {
      await setAuto($, false)
      return { text: 'Prompt Upgrade automatic mode is off. Use /better <prompt> to upgrade one prompt.' }
    }
    if (word === 'history') {
      const past = await read($, historyAtom)
      if (past.length === 0) return { text: 'No upgrades yet. Try /better followed by a rough prompt.' }
      await update($, viewAtom, () => 'history' as View)
      void openPane($).then(isPlaced => {
        if (!isPlaced) $.ui.log('Prompt Upgrade: the window is too narrow for its pane.')
      })
      return { text: `Showing your last ${past.length} upgrade${past.length === 1 ? '' : 's'} in the Prompt Upgrade pane.` }
    }
    if (args === '') {
      await update($, viewAtom, () => 'flow' as View)
      await update($, flowAtom, () => freshFlow('', 'compose', Date.now()))
      void openPane($).then(async isPlaced => {
        if (!isPlaced) {
          await update($, flowAtom, () => null)
          $.ui.log('Prompt Upgrade: the window is too narrow for its pane.')
        }
      })
      return { text: 'Type your prompt in the Prompt Upgrade pane.' }
    }
    void startUpgrade($, args, { sayWhy: true })
    return { text: 'Upgrading your prompt in the Prompt Upgrade pane.' }
  }).catch(() => ({ text: 'Prompt Upgrade could not run that command. Your prompt was not sent.' }))

  on('prompt.submit', async ($, e, next) => {
    const isAuto = await read($, autoAtom)
    const origin = e.origin as { kind: string; name?: string }
    const decision = route(
      {
        text: e.text,
        originKind: origin.kind,
        originName: origin.name,
        hasCommand: e.command !== undefined,
        isMeta: e.isMeta === true,
        hasAttachments: (e.attachments?.length ?? 0) > 0,
        isMidTurn: e.turnId !== undefined,
      },
      isAuto,
    )
    if (decision.kind === 'pass') return next(e)
    if (decision.kind === 'strip') return next({ ...e, text: decision.text })
    const isPlaced = await startUpgrade($, e.text, { sayWhy: false })
    return {
      drop: isPlaced
        ? 'Sent to Prompt Upgrade. Start a prompt with > to send it as-is.'
        : 'Prompt Upgrade: the window is too narrow for its pane, so your words are back in the prompt box.',
    }
  }).catch(($, e, next) => next(e))

  // The person's own close (the mark, Esc) is a Cancel: their prompt comes back.
  on('ui.close', { id: 'prompt-upgrade' }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      const flow = await read($, flowAtom)
      await update($, flowAtom, () => null)
      await update($, viewAtom, () => 'flow' as View)
      if (flow && flow.original.trim() !== '') await $.prompt.fill({ text: flow.original })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'prompt-upgrade' }, async ($, e) => {
    const flow = await read($, flowAtom)
    const view = await read($, viewAtom)
    const isAuto = await read($, autoAtom)
    const history = await read($, historyAtom)
    const now = await $.clock.now()

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const W = Math.max(20, e.props.bodyColumns)

    // ---------- pieces

    const rule = (len: number) => '─'.repeat(Math.max(0, len))

    const header = () => {
      const title = TITLE.toUpperCase()
      const mode = isAuto ? 'AUTO ON' : 'AUTO OFF'
      const gap = W - title.length - mode.length
      return (
        <Box flexDirection="column" width={W}>
          <Text wrap="truncate">
            <Text bold color={TEXT}>{title}</Text>
            {gap >= 2 ? <Text color={MUTED}>{' '.repeat(gap) + mode}</Text> : null}
          </Text>
          <Text wrap="truncate">
            <Text color={GOLD}>{'━'.repeat(Math.min(title.length, W))}</Text>
            <Text color={LINE}>{rule(W - title.length)}</Text>
          </Text>
        </Box>
      )
    }

    const heading = (label: string) => {
      const caps = fit(label.toUpperCase(), W)
      return (
        <Text wrap="truncate">
          <Text color={MUTED} size="caption">{caps}</Text>
          <Text color={LINE}>{caps.length + 1 < W ? ' ' + rule(W - caps.length - 1) : ''}</Text>
        </Text>
      )
    }

    const tracker = (current: number) => {
      const { labels, sep } = trackerLabels(W)
      return (
        <Text wrap="truncate">
          {labels.map((label, i) => {
            const isDone = i < current
            const isNow = i === current
            const color = isDone ? GREEN : isNow ? GOLD : MUTED
            return (
              <Text>
                {i > 0 ? <Text color={LINE}>{sep}</Text> : null}
                <Text color={color}>{isDone ? '✓' : isNow ? '●' : '○'}</Text>
                <Text color={isDone ? TEXT : color} bold={isNow}>{' ' + label}</Text>
              </Text>
            )
          })}
        </Text>
      )
    }

    const goldChip = (key: string, label: string, onPress: (p: UiPressArgument) => void) => (
      <Button key={key} plain={true} onPress={onPress}>
        <Text backgroundColor={GOLD} color={INK} bold>{` ${label} `}</Text>
      </Button>
    )
    const slateChip = (key: string, label: string, onPress: (p: UiPressArgument) => void) => (
      <Button key={key} plain={true} onPress={onPress}>
        <Text backgroundColor={LINE} color={TEXT}>{` ${label} `}</Text>
      </Button>
    )
    const quiet = (key: string, label: string, onPress: (p: UiPressArgument) => void) => (
      <Button key={key} plain={true} dimColor onPress={onPress}>
        <Text color={MUTED}>{label}</Text>
      </Button>
    )

    /** Upgraded text with its [placeholders] in amber. */
    const withPlaceholders = (text: string) =>
      text.split(/(\[[^\]\n]{1,60}\])/g).map(part =>
        /^\[[^\]\n]{1,60}\]$/.test(part) ? <Text color={AMBER}>{part}</Text> : <Text color={TEXT}>{part}</Text>,
      )

    const card = (label: string, labelColor: string, border: string, width: number, body: unknown) => (
      <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} width={width}>
        <Text color={labelColor} size="caption" wrap="truncate">{label}</Text>
        <Text wrap="wrap">{body as string}</Text>
      </Box>
    )

    const shell = (current: number | null, body: unknown[]) => (
      <Box flexDirection="column" width={W} gap={1}>
        {header()}
        {current === null ? null : tracker(current)}
        {...(body as never[])}
      </Box>
    )

    // ---------- history

    if (view === 'history') {
      return shell(null, [
        heading(`Last ${history.length} upgrade${history.length === 1 ? '' : 's'}`),
        history.length === 0 ? (
          <Text color={MUTED}>No upgrades yet. Try /better followed by a rough prompt.</Text>
        ) : (
          <Box flexDirection="column">
            {history.map(entry => {
              const when = timeLabel(entry.at, now)
              const room = Math.max(4, W - when.length - 3)
              return (
                <Button key={`past-${entry.id}`} plain={true} onPress={() => openFromHistory($, entry)}>
                  <Text color={TEXT}>{fit(entry.original, room)}</Text>
                  <Text color={MUTED}>{'  ' + when}</Text>
                </Button>
              )
            })}
          </Box>
        ),
        <Box flexDirection="row" gap={2}>
          {quiet('close', 'Close', () => cancel($))}
        </Box>,
      ])
    }

    // ---------- idle

    if (!flow) {
      return shell(null, [
        <Text color={MUTED}>Nothing to upgrade. Type /better followed by a rough prompt.</Text>,
        <Box flexDirection="row">{quiet('close', 'Close', () => closePane($))}</Box>,
      ])
    }

    const id = flow.id
    const current = stepIndex(flow.step, flow.error?.during)

    // ---------- compose: /better on its own

    if (flow.step === 'compose') {
      return shell(0, [
        heading('Your prompt'),
        Input ? (
          <Input
            key="compose"
            placeholder="Type the rough prompt to upgrade"
            submitLabel="upgrade"
            autoFocus={true}
            onSubmit={value => {
              const text = value.trim()
              if (text === '') return
              void patchFlow($, id, f => ({ ...f, original: text, step: 'asking' })).then(() =>
                later($, () => askQuestions($, id)),
              )
            }}
          />
        ) : (
          <Text color={MUTED}>This screen has no text field. Type /better followed by your prompt instead.</Text>
        ),
        <Box flexDirection="row">{quiet('cancel', 'Cancel', () => cancel($))}</Box>,
      ])
    }

    // ---------- 1. reading

    if (flow.step === 'asking') {
      return shell(current, [
        heading('Your prompt'),
        <Text color={MUTED} wrap="truncate">{fit('Reading your prompt and picking the questions that matter.', W)}</Text>,
        card('YOURS', MUTED, LINE, W, <Text color={TEXT}>{flow.original}</Text>),
        <Box flexDirection="row">{quiet('cancel', 'Cancel', () => cancel($))}</Box>,
      ])
    }

    // ---------- 2. questions

    if (flow.step === 'questions') {
      const answered = flow.answers.filter(a => a !== null).length
      const total = flow.questions.length
      return shell(current, [
        heading('Your prompt'),
        <Text color={MUTED} wrap="truncate">{fit(flow.original, W)}</Text>,
        heading(`Questions  ${answered} of ${total} answered`),
        ...flow.questions.map((q, i) => {
          const a = flow.answers[i] ?? null
          const isAnswered = a !== null
          const picked = a && a.kind === 'pick' ? a.value : null
          const isOther = picked !== null && !q.options.includes(picked)
          return (
            <Box flexDirection="column" width={W}>
              <Box flexDirection="row" width={W}>
                <Text
                  backgroundColor={isAnswered ? GREEN : GOLD}
                  color={INK}
                  bold
                >{isAnswered ? ' ✓ ' : ` ${i + 1} `}</Text>
                <Box width={W - 4} marginLeft={1}>
                  <Text color={TEXT} wrap="wrap">{q.text}</Text>
                </Box>
              </Box>
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginLeft={4} width={W - 4}>
                {q.options.map((opt, j) =>
                  picked === opt
                    ? goldChip(`q${i}-o${j}`, opt, () => answer($, id, i, { kind: 'pick', value: opt }))
                    : slateChip(`q${i}-o${j}`, opt, () => answer($, id, i, { kind: 'pick', value: opt })),
                )}
                {Input
                  ? isOther
                    ? goldChip(`q${i}-other`, fit(picked ?? '', 30), () =>
                        patchFlow($, id, f => ({ ...f, otherOpen: i })),
                      )
                    : slateChip(`q${i}-other`, 'Other (type it)', () => patchFlow($, id, f => ({ ...f, otherOpen: i })))
                  : null}
                {a && a.kind === 'skip'
                  ? <Text color={MUTED}>skipped</Text>
                  : quiet(`q${i}-skip`, 'Skip', () => answer($, id, i, { kind: 'skip' }))}
              </Box>
              {Input && flow.otherOpen === i ? (
                <Box marginLeft={4} width={W - 4}>
                  <Input
                    key={`q${i}-text`}
                    label="Your answer "
                    placeholder="type it and press Enter"
                    autoFocus={true}
                    onSubmit={value => {
                      const text = value.trim()
                      if (text !== '') void answer($, id, i, { kind: 'pick', value: text })
                    }}
                  />
                </Box>
              ) : null}
            </Box>
          )
        }),
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {goldChip('skip-rest', answered === 0 ? 'Skip the questions, upgrade now' : 'Skip the rest, upgrade now', () => skipRest($, id))}
          {quiet('cancel', 'Cancel', () => cancel($))}
        </Box>,
      ])
    }

    // ---------- 3. rewrite

    if (flow.step === 'writing') {
      const used = flow.answers.filter(a => a && a.kind === 'pick').length
      return shell(current, [
        heading('Rewrite'),
        <Text color={MUTED} wrap="truncate">
          {fit(
            used > 0
              ? `Writing the upgraded prompt with your ${used} answer${used === 1 ? '' : 's'}.`
              : 'Writing the upgraded prompt.',
            W,
          )}
        </Text>,
        card('YOURS', MUTED, LINE, W, <Text color={TEXT}>{flow.original}</Text>),
        <Box flexDirection="row">{quiet('cancel', 'Cancel', () => cancel($))}</Box>,
      ])
    }

    // ---------- error

    if (flow.step === 'error') {
      const during = flow.error?.during === 'writing' ? 'rewrite' : 'questions'
      return shell(current, [
        <Box flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1} width={W}>
          <Text color={AMBER} bold wrap="truncate">{fit(`THE ${during.toUpperCase()} DID NOT COME THROUGH`, W - 4)}</Text>
          <Text color={TEXT} wrap="wrap">Your prompt is safe. Nothing was sent.</Text>
          <Text color={MUTED} wrap="wrap">{flow.error?.reason ?? 'The model did not answer.'}</Text>
        </Box>,
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {goldChip('retry', 'Try again', () => retry($, id))}
          {slateChip('send-original', 'Send my original', () => runText($, flow.original))}
          {quiet('cancel', 'Cancel', () => cancel($))}
        </Box>,
      ])
    }

    // ---------- 4. review

    const upgrade = flow.upgrade ?? { text: flow.original, added: [] }
    const before = wordCount(flow.original)
    const after = wordCount(upgrade.text)
    const added = upgrade.added.length

    const tiles = [
      { n: before, label: 'WORDS BEFORE', color: TEXT },
      { n: after, label: 'WORDS AFTER', color: GOLD },
      { n: added, label: 'DETAILS ADDED', color: GREEN },
    ]
    const tileInner = tiles.map(t => Math.max(bigWidth(t.n), t.label.length))
    const tilesWidth = tileInner.reduce((s, w) => s + w + 4, 0) + (tiles.length - 1)
    const numbers =
      tilesWidth <= W ? (
        <Box flexDirection="row" columnGap={1}>
          {tiles.map((t, i) => {
            const rows = bigNumber(t.n)
            return (
              <Box flexDirection="column" borderStyle="round" borderColor={LINE} paddingX={1} width={tileInner[i]! + 4}>
                <Text color={t.color}>{rows[0]}</Text>
                <Text color={t.color}>{rows[1]}</Text>
                <Text color={t.color}>{rows[2]}</Text>
                <Text color={MUTED} size="caption">{t.label}</Text>
              </Box>
            )
          })}
        </Box>
      ) : (
        <Text wrap="truncate">
          <Text color={TEXT} bold>{String(before)}</Text>
          <Text color={MUTED}>{' words '}</Text>
          <Text color={LINE}>{'→ '}</Text>
          <Text color={GOLD} bold>{String(after)}</Text>
          <Text color={MUTED}>{' words · '}</Text>
          <Text color={GREEN} bold>{String(added)}</Text>
          <Text color={MUTED}>{' added'}</Text>
        </Text>
      )

    const buttons = flow.isEditing ? (
      <Box flexDirection="column" width={W} gap={1}>
        {Input ? (
          <Input
            key="edit"
            label="Edit "
            value={upgrade.text}
            submitLabel="run"
            autoFocus={true}
            onSubmit={value => runText($, value)}
          />
        ) : null}
        <Box flexDirection="row" columnGap={1}>
          {slateChip('back', 'Back', () => patchFlow($, id, f => ({ ...f, isEditing: false })))}
          {quiet('cancel', 'Cancel', () => cancel($))}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {goldChip('run', 'Run it', () => runText($, upgrade.text))}
        {Input ? slateChip('edit', 'Edit', () => patchFlow($, id, f => ({ ...f, isEditing: true, isCopied: false }))) : null}
        {slateChip('copy', flow.isCopied ? 'Copied' : 'Copy', press =>
          $.ui.copy({ text: upgrade.text, surface: press.surface }).then(r =>
            patchFlow($, id, f => ({ ...f, isCopied: r.isCopied })),
          ),
        )}
        {quiet('cancel', 'Cancel', () => cancel($))}
      </Box>
    )

    const addedList =
      upgrade.added.length === 0 ? (
        <Text color={MUTED}>Nothing to add: your prompt was already clear.</Text>
      ) : (
        <Box flexDirection="column">
          {upgrade.added.map(item => (
            <Text wrap="truncate">
              <Text color={GREEN}>{'+ '}</Text>
              <Text color={TEXT}>{fit(item, W - 2)}</Text>
            </Text>
          ))}
        </Box>
      )

    const isSide = W >= 64
    const half = isSide ? Math.floor((W - 1) / 2) : W
    const cards = (
      <Box flexDirection={isSide ? 'row' : 'column'} columnGap={1} rowGap={1} width={W}>
        {card('YOURS', MUTED, LINE, half, <Text color={TEXT}>{flow.original}</Text>)}
        {card('UPGRADED', GOLD, GOLD, isSide ? W - half - 1 : W, <Text>{withPlaceholders(upgrade.text)}</Text>)}
      </Box>
    )

    return shell(current, [numbers, buttons, heading('What I added'), addedList, heading('Side by side'), cards])
  }).catch(($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text color={MUTED}>Prompt Upgrade could not draw this screen. Press Esc to close it; your prompt is safe.</Text>
  })
}
