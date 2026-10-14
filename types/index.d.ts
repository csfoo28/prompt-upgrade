export type Question = { text: string; options: string[] }

/** One question's answer: an option or typed text, 'skip', or null while open. */
export type Answer = { kind: 'pick'; value: string } | { kind: 'skip' } | null

export type Upgrade = { text: string; added: string[] }

export type Step = 'compose' | 'asking' | 'questions' | 'writing' | 'review' | 'error'

export type Flow = {
  id: string
  step: Step
  original: string
  questions: Question[]
  answers: Answer[]
  /** Which question has its "Other" field open, or -1. */
  otherOpen: number
  upgrade: Upgrade | null
  /** The step a failed model call was on, and why it failed. */
  error: { during: 'asking' | 'writing'; reason: string } | null
  isEditing: boolean
  isCopied: boolean
}

export type HistoryEntry = {
  id: string
  at: number
  original: string
  upgrade: Upgrade
}

export type View = 'flow' | 'history'

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: Flow | null
      view: View
      isAuto: boolean
      history: HistoryEntry[]
    }
  }
}
