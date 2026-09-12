import { describe, expect, it } from 'vitest'
import { anchorError, attributeLogs, eventData, failedInstructionIndex } from './logs.ts'

describe('attributeLogs', () => {
  it('gives each line the program on top of the invoke stack', () => {
    const frames = attributeLogs([
      'Program A invoke [1]',
      'Program log: a1',
      'Program B invoke [2]',
      'Program log: b',
      'Program data: ZGF0YQ==',
      'Program B consumed 10 of 20 compute units',
      'Program B success',
      'Program log: a2',
      'Program A consumed 30 of 40 compute units',
      'Program A failed: custom program error: 0x1',
    ])
    expect(frames).toEqual([
      { program: 'A', depth: 1, line: 'Program log: a1' },
      { program: 'B', depth: 2, line: 'Program log: b' },
      { program: 'B', depth: 2, line: 'Program data: ZGF0YQ==' },
      { program: 'B', depth: 2, line: 'Program B consumed 10 of 20 compute units' },
      { program: 'A', depth: 1, line: 'Program log: a2' },
      { program: 'A', depth: 1, line: 'Program A consumed 30 of 40 compute units' },
    ])
    expect(eventData(frames[2] as (typeof frames)[number])).toBe('ZGF0YQ==')
    expect(eventData(frames[1] as (typeof frames)[number])).toBeNull()
  })

  it('does not pop on a success line of a program that is not on top', () => {
    // A program logging "Program X success" itself would otherwise corrupt the stack.
    const frames = attributeLogs([
      'Program A invoke [1]',
      'Program B success',
      'Program log: still a',
      'Program A success',
    ])
    expect(frames.map((f) => f.program)).toEqual(['A', 'A'])
  })
})

describe('anchorError', () => {
  it('reads the code name and number from the Anchor line', () => {
    expect(
      anchorError({
        program: 'x',
        depth: 1,
        line: "Program log: AnchorError thrown in programs/caprail-hook/src/execute.rs:142. Error Code: AccreditationExpired. Error Number: 6001. Error Message: recipient's accreditation has expired.",
      }),
    ).toEqual({ code: 'AccreditationExpired', number: 6001 })
    expect(
      anchorError({ program: 'x', depth: 1, line: 'Program log: Instruction: Execute' }),
    ).toBeNull()
  })
})

describe('failedInstructionIndex', () => {
  it('reads the top-level index from InstructionError and nothing else', () => {
    expect(failedInstructionIndex({ InstructionError: [2, { Custom: 6000 }] })).toBe(2)
    expect(failedInstructionIndex({ InstructionError: [0, 'InsufficientFunds'] })).toBe(0)
    expect(failedInstructionIndex('InsufficientFundsForFee')).toBeNull()
    expect(failedInstructionIndex(null)).toBeNull()
    expect(failedInstructionIndex(undefined)).toBeNull()
  })
})
