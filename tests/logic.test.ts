import { describe, expect, test } from 'claude-code/testing'

import {
  bigNumber,
  fit,
  parseQuestions,
  parseRewrite,
  route,
  trackerLabels,
  type SubmitFacts,
} from '../hooks/logic'

const typed = (text: string, extra: Partial<SubmitFacts> = {}): SubmitFacts => ({
  text,
  originKind: 'composer',
  hasCommand: false,
  isMeta: false,
  hasAttachments: false,
  isMidTurn: false,
  ...extra,
})

describe('which prompts are intercepted', () => {
  test('a normal typed prompt goes to the pane when automatic mode is on', () => {
    expect(route(typed('write a landing page for my bakery'), true)).toEqual({ kind: 'intercept' })
  })

  test('nothing is intercepted when automatic mode is off', () => {
    expect(route(typed('write a landing page for my bakery'), false)).toEqual({ kind: 'pass' })
    expect(route(typed('> keep this'), false)).toEqual({ kind: 'pass' })
  })

  test('slash commands pass through', () => {
    expect(route(typed('/compact', { hasCommand: true }), true)).toEqual({ kind: 'pass' })
    expect(route(typed('/unknown thing'), true)).toEqual({ kind: 'pass' })
  })

  test('prompts with files or images pass through', () => {
    expect(route(typed('what is in this screenshot please', { hasAttachments: true }), true)).toEqual({ kind: 'pass' })
  })

  test('messages typed while Claude is working pass through', () => {
    expect(route(typed('also add tests for the parser', { isMidTurn: true }), true)).toEqual({ kind: 'pass' })
  })

  test('short replies pass through', () => {
    for (const reply of ['yes', 'Yes!', 'keep going', 'ok.', 'looks good', 'go ahead', 'no thanks']) {
      expect(route(typed(reply), true), reply).toEqual({ kind: 'pass' })
    }
  })

  test('a leading ">" sends the rest untouched', () => {
    expect(route(typed('> just send this as it is'), true)).toEqual({ kind: 'strip', text: 'just send this as it is' })
    expect(route(typed('>tight'), true)).toEqual({ kind: 'strip', text: 'tight' })
  })

  test('the mod\'s own sends never loop back into the pane', () => {
    const own = typed('a long upgraded prompt with many words in it', { originKind: 'plugin', originName: 'prompt-upgrade' })
    expect(route(own, true)).toEqual({ kind: 'pass' })
  })

  test('notifications, peers and hidden prompts pass through', () => {
    expect(route(typed('a background task finished its work', { originKind: 'task-notification' }), true)).toEqual({ kind: 'pass' })
    expect(route(typed('another plugin sent this long prompt', { originKind: 'plugin', originName: 'other' }), true)).toEqual({ kind: 'pass' })
    expect(route(typed('something hidden from the person', { isMeta: true }), true)).toEqual({ kind: 'pass' })
  })
})

describe('reading the questions', () => {
  test('reads up to three questions with two to four options', () => {
    const reply = '```json\n' + JSON.stringify({
      questions: [
        { question: 'Who is it for?', options: ['Customers', 'Investors', 'Other'] },
        { question: 'What format?', options: ['One page', 'Slides', 'Email', 'Doc', 'Video'] },
        { question: 'Bad, one option', options: ['Only'] },
        { question: 'Tone?', options: ['Warm', 'Formal'] },
        { question: 'Fourth valid?', options: ['A', 'B'] },
      ],
    }) + '\n```'
    const qs = parseQuestions(reply)
    expect(qs).toHaveLength(3)
    expect(qs[0]).toEqual({ text: 'Who is it for?', options: ['Customers', 'Investors'] })
    expect(qs[1]!.options).toHaveLength(4)
    expect(qs[2]!.text).toBe('Tone?')
  })

  test('an empty list means no question would help', () => {
    expect(parseQuestions('{"questions": []}')).toEqual([])
  })

  test('a reply with no JSON is an error, not a crash', () => {
    expect(() => parseQuestions('Sure! Here are some questions.')).toThrow()
  })
})

describe('reading the rewrite', () => {
  test('reads the prompt and the list of additions', () => {
    const up = parseRewrite('Here you go {"prompt": "Write a one-page site for [bakery name].", "added": ["Clear goal", "Format: one page"]} done')
    expect(up.text).toBe('Write a one-page site for [bakery name].')
    expect(up.added).toEqual(['Clear goal', 'Format: one page'])
  })

  test('braces inside the prompt text do not confuse the reader', () => {
    const up = parseRewrite('{"prompt": "Use the {name} field and \\"quotes\\"", "added": []}')
    expect(up.text).toBe('Use the {name} field and "quotes"')
  })

  test('a reply with no prompt is an error', () => {
    expect(() => parseRewrite('{"added": ["x"]}')).toThrow()
  })
})

describe('sizing', () => {
  test('big numbers are three rows of equal width', () => {
    const rows = bigNumber(128)
    expect(rows).toHaveLength(3)
    expect(rows[0].length).toBe(rows[1].length)
    expect(rows[1].length).toBe(rows[2].length)
    expect(rows[0].length).toBe(11)
  })

  test('fit never exceeds its width', () => {
    expect(fit('a very long line of text', 10).length).toBe(10)
    expect(fit('short', 10)).toBe('short')
  })

  test('the tracker fits narrow and wide panes', () => {
    for (const width of [24, 40, 60, 120]) {
      const { labels, sep } = trackerLabels(width)
      const size = labels.reduce((s, l) => s + 2 + l.length, 0) + sep.length * (labels.length - 1)
      expect(size, `width ${width}`).toBeLessThanOrEqual(width)
    }
  })
})
