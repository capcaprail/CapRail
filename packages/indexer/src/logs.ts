// Solana log lines carry no program of their own; which program wrote a line is
// known only from the `invoke` / `success` / `failed` lines around it. The parser
// needs that for two things: which program threw the Anchor error (a refusal is a
// refusal only when the hook did), and where each `Program data:` came from.

export type LogFrame = {
  program: string
  depth: number
  line: string
}

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/
const LEAVE = /^Program (\w+) (?:success|failed: .*)$/

// Attributes every line that is not a frame boundary to the program on top of the
// stack at that moment. Lines outside any frame (none in practice) get program ''.
export function attributeLogs(logs: readonly string[]): LogFrame[] {
  const stack: string[] = []
  const out: LogFrame[] = []
  for (const line of logs) {
    const invoke = INVOKE.exec(line)
    if (invoke?.[1] !== undefined) {
      stack.push(invoke[1])
      continue
    }
    const leave = LEAVE.exec(line)
    if (leave?.[1] !== undefined && stack.at(-1) === leave[1]) {
      stack.pop()
      continue
    }
    out.push({ program: stack.at(-1) ?? '', depth: stack.length, line })
  }
  return out
}

const DATA_PREFIX = 'Program data: '

export function eventData(frame: LogFrame): string | null {
  return frame.line.startsWith(DATA_PREFIX) ? frame.line.slice(DATA_PREFIX.length) : null
}

// Anchor writes one line per error: `AnchorError thrown in <file>:<line>. Error Code:
// NotAccredited. Error Number: 6000. Error Message: …`. The name is what the journal
// shows (FR-006); the number is the same fact as the `Custom` code in `meta.err`.
const ERROR_LINE = /Error Code: (\w+)\. Error Number: (\d+)\./

export function anchorError(frame: LogFrame): { code: string; number: number } | null {
  const match = ERROR_LINE.exec(frame.line)
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { code: match[1], number: Number(match[2]) }
}

// `meta.err` for a failed instruction is `{ InstructionError: [index, …] }`; the
// index is the top-level instruction. Anything else (a fee failure, an account
// error before execution) has no instruction to blame.
export function failedInstructionIndex(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) return null
  const detail = (err as { InstructionError: unknown }).InstructionError
  if (!Array.isArray(detail) || typeof detail[0] !== 'number') return null
  return detail[0]
}
