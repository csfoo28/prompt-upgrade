// Pure helpers: no `$`, no state. Everything here is unit-tested directly.

import type { Answer, Question, Upgrade } from '../types'

export const PLUGIN = 'prompt-upgrade'
export const PANE = 'prompt-upgrade'
export const HISTORY_LIMIT = 20
export const QUESTION_MODEL = 'haiku'
export const REWRITE_MODEL = 'sonnet'

// ---------------------------------------------------------------- intercept

/** Short replies that go straight through in automatic mode. */
const SHORT_REPLIES = new Set([
  'y', 'yes', 'yep', 'yeah', 'ya', 'sure', 'ok', 'okay', 'k', 'no', 'nope', 'n',
  'go', 'go on', 'go ahead', 'continue', 'keep going', 'carry on', 'proceed',
  'do it', 'done', 'next', 'more', 'again', 'retry', 'try again', 'stop',
  'thanks', 'thank you', 'thx', 'ty', 'cool', 'nice', 'great', 'perfect',
  'looks good', 'lgtm', 'sounds good', 'ship it', 'agreed', 'correct', 'right',
])

export type SubmitFacts = {
  text: string
  originKind: string
  originName?: string
  hasCommand: boolean
  isMeta: boolean
  hasAttachments: boolean
  isMidTurn: boolean
}

/**
 * What automatic mode does with one submitted prompt:
 * `pass` sends it untouched, `strip` sends it without its leading ">",
 * `intercept` takes it to the pane.
 */
export type Route = { kind: 'pass' } | { kind: 'strip'; text: string } | { kind: 'intercept' }

export function route(facts: SubmitFacts, isAuto: boolean): Route {
  // The mod's own sends never loop back into the pane.
  if (facts.originKind === 'plugin' && facts.originName === PLUGIN) return { kind: 'pass' }
  if (!isAuto) return { kind: 'pass' }
  if (facts.hasCommand || facts.isMeta) return { kind: 'pass' }
  // Only what the person typed: never a notification, a peer, a schedule.
  if (facts.originKind !== 'composer' && facts.originKind !== 'bridge') return { kind: 'pass' }
  const trimmed = facts.text.trim()
  if (trimmed.startsWith('/')) return { kind: 'pass' }
  if (trimmed.startsWith('>')) {
    const rest = trimmed.slice(1).trimStart()
    return rest === '' ? { kind: 'pass' } : { kind: 'strip', text: rest }
  }
  if (facts.hasAttachments || facts.isMidTurn) return { kind: 'pass' }
  if (trimmed === '' || isShortReply(trimmed)) return { kind: 'pass' }
  return { kind: 'intercept' }
}

export function isShortReply(text: string): boolean {
  const norm = text.toLowerCase().replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ').trim()
  if (SHORT_REPLIES.has(norm)) return true
  return wordCount(norm) <= 2
}

export function wordCount(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

// ---------------------------------------------------------------- model text

export const QUESTION_SYSTEM = [
  'You help a person turn a rough request to an AI coding and writing assistant into a clear one.',
  'Given their rough prompt, choose at most three multiple-choice questions whose answers would most improve the result.',
  'Ask only about things the prompt leaves open that would really change the outcome: goal, audience, format, scope, constraints, what "done" means.',
  'Never ask about something the prompt already states. If no question would help, return an empty list.',
  'Each question is short and plain. Each has two to four options of at most six words each. Do not add an "Other" option.',
  'Reply with JSON only, no prose, exactly: {"questions":[{"question":"...","options":["...","..."]}]}',
].join('\n')

export function questionPrompt(original: string): string {
  return `Rough prompt:\n<<<\n${original}\n>>>`
}

export const REWRITE_SYSTEM = [
  'You rewrite a rough prompt into a great one, before it is sent to an AI assistant.',
  'Rules:',
  '- Keep exactly what the person meant. Do not change the task.',
  '- Add a clear goal, who it is for, the format of the result, and what "done" looks like.',
  '- Use the answers given. Leave out anything they skipped.',
  '- Never invent facts, names, numbers, prices, dates or file paths. Where something needed is unknown, leave a placeholder in square brackets, like [project name].',
  '- Write it as one request the person could have typed themselves, in plain language, first person, no headings, no markdown, no preamble.',
  'Also list what you added, as short phrases of at most eight words each.',
  'Reply with JSON only, no prose, exactly: {"prompt":"...","added":["...","..."]}',
].join('\n')

export function rewritePrompt(original: string, questions: readonly Question[], answers: readonly Answer[]): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const a = answers[i]
    if (a && a.kind === 'pick') lines.push(`- ${q.text} ${a.value}`)
  })
  const answered = lines.length > 0 ? lines.join('\n') : '(none)'
  return `Rough prompt:\n<<<\n${original}\n>>>\n\nThe person's answers:\n${answered}`
}

/** The first top-level JSON object in a reply, fences and chatter tolerated. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('The reply held no JSON.')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  throw new Error('The reply held unfinished JSON.')
}

function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one
}

/** Reads the questions reply: at most three, each with two to four options. */
export function parseQuestions(text: string): Question[] {
  const data = extractJson(text) as { questions?: unknown }
  if (!data || !Array.isArray(data.questions)) throw new Error('The reply had no question list.')
  const out: Question[] = []
  for (const raw of data.questions as unknown[]) {
    if (out.length === 3) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { question?: unknown; text?: unknown; options?: unknown }
    const q = cleanLine(r.question ?? r.text, 140)
    if (q === '' || !Array.isArray(r.options)) continue
    const seen = new Set<string>()
    const options: string[] = []
    for (const o of r.options as unknown[]) {
      const opt = cleanLine(o, 48)
      if (opt === '' || /^other\b/i.test(opt) || seen.has(opt.toLowerCase())) continue
      seen.add(opt.toLowerCase())
      options.push(opt)
      if (options.length === 4) break
    }
    if (options.length >= 2) out.push({ text: q, options })
  }
  return out
}

/** Reads the rewrite reply: the upgraded prompt and what was added. */
export function parseRewrite(text: string): Upgrade {
  const data = extractJson(text) as { prompt?: unknown; added?: unknown }
  if (!data || typeof data.prompt !== 'string' || data.prompt.trim() === '') {
    throw new Error('The reply had no rewritten prompt.')
  }
  const added = Array.isArray(data.added)
    ? (data.added as unknown[]).map(a => cleanLine(a, 90)).filter(a => a !== '').slice(0, 8)
    : []
  return { text: data.prompt.trim(), added }
}

/** A plain sentence for a model call that did not answer. */
export function failureReason(r: { reason?: string; status?: number }): string {
  switch (r.reason) {
    case 'aborted':
      return 'The model took too long to answer.'
    case 'empty-reply':
      return 'The model sent back an empty reply.'
    case 'api-error':
      return r.status === 429
        ? 'The model is busy right now (rate limited).'
        : `The model could not be reached${r.status ? ` (error ${r.status})` : ''}.`
    default:
      return 'The model did not answer.'
  }
}

// ---------------------------------------------------------------- drawing aids

/** Cuts a single line to `n` cells, with an ellipsis when cut. */
export function fit(text: string, n: number): string {
  if (n <= 0) return ''
  const one = text.replace(/\s+/g, ' ')
  return one.length <= n ? one : n === 1 ? '…' : one.slice(0, n - 1) + '…'
}

/** Heavy box-drawing digits, three rows tall, three cells wide. */
const DIGITS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

export function bigNumber(n: number): [string, string, string] {
  const digits = String(Math.max(0, Math.floor(n))).split('')
  const rows: [string, string, string] = ['', '', '']
  digits.forEach((d, i) => {
    const glyph = DIGITS[d] ?? DIGITS['0']!
    for (let r = 0; r < 3; r++) rows[r] += (i > 0 ? ' ' : '') + glyph[r]
  })
  return rows
}

export function bigWidth(n: number): number {
  return bigNumber(n)[0].length
}

export const STEPS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const

/** The tracker's current index for a flow step. */
export function stepIndex(step: string, errorDuring?: string): number {
  switch (step) {
    case 'compose':
    case 'asking':
      return 0
    case 'questions':
      return 1
    case 'writing':
      return 2
    case 'review':
      return 3
    case 'error':
      return errorDuring === 'writing' ? 2 : 0
    default:
      return 0
  }
}

/**
 * The tracker's labels for a width: full names, then short ones, then numbers.
 * Each step is drawn as mark + space + label, joined by a separator.
 */
export function trackerLabels(width: number): { labels: string[]; sep: string } {
  const tries: { labels: string[]; sep: string }[] = [
    { labels: [...STEPS], sep: '  ──  ' },
    { labels: [...STEPS], sep: ' ─ ' },
    { labels: ['Prompt', 'Ask', 'Write', 'Review'], sep: ' ─ ' },
    { labels: ['1', '2', '3', '4'], sep: ' ' },
  ]
  for (const t of tries) {
    const size = t.labels.reduce((sum, l) => sum + 2 + l.length, 0) + t.sep.length * (t.labels.length - 1)
    if (size <= width) return t
  }
  return tries[tries.length - 1]!
}

export function newId(now: number): string {
  return `${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

export function timeLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const hr = Math.round(m / 60)
  if (hr < 48) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}
