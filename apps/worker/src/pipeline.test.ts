import type { ProgramTransaction } from '@caprail/indexer'
import { describe, expect, it } from 'vitest'
import type { Cursor, CursorStore } from './cursor.ts'
import { createPipeline } from './pipeline.ts'

const tx = (signature: string, slot: number): ProgramTransaction => ({
  signature,
  slot,
  blockTime: null,
  logs: [],
  failed: false,
})

function memoryStore() {
  const saved: Cursor[] = []
  const store: CursorStore = {
    load: () => Promise.resolve(saved.at(-1) ?? null),
    save: (cursor) => {
      saved.push(cursor)
      return Promise.resolve()
    },
  }
  return { store, saved }
}

describe('createPipeline', () => {
  it('applies in order, once per signature, and saves the cursor after each', async () => {
    const { store, saved } = memoryStore()
    const applied: string[] = []
    const pipeline = createPipeline({
      apply: (t) => {
        applied.push(t.signature)
        return Promise.resolve()
      },
      store,
      initial: null,
      onError: () => {},
    })
    pipeline.push(tx('a', 10))
    pipeline.push(tx('b', 11))
    await pipeline.handle(tx('a', 10))
    await pipeline.drain()
    expect(applied).toEqual(['a', 'b'])
    expect(saved).toEqual([
      { signature: 'a', slot: 10 },
      { signature: 'b', slot: 11 },
    ])
    expect(pipeline.cursor()).toEqual({ signature: 'b', slot: 11 })
  })

  it('never moves the cursor backwards when an older transaction arrives late', async () => {
    const { store, saved } = memoryStore()
    const pipeline = createPipeline({
      apply: () => Promise.resolve(),
      store,
      initial: { signature: 'z', slot: 50 },
      onError: () => {},
    })
    await pipeline.handle(tx('old', 40))
    await pipeline.handle(tx('new', 60))
    expect(saved).toEqual([{ signature: 'new', slot: 60 }])
  })

  it('reports a failed apply, keeps the cursor, and lets the signature be retried', async () => {
    const { store, saved } = memoryStore()
    const errors: string[] = []
    let failOnce = true
    const pipeline = createPipeline({
      apply: () => {
        if (failOnce) {
          failOnce = false
          return Promise.reject(new Error('db down'))
        }
        return Promise.resolve()
      },
      store,
      initial: null,
      onError: (_, t) => errors.push(t.signature),
    })
    await expect(pipeline.handle(tx('a', 1))).rejects.toThrow('db down')
    expect(errors).toEqual(['a'])
    expect(saved).toEqual([])
    await pipeline.handle(tx('a', 1))
    expect(saved).toEqual([{ signature: 'a', slot: 1 }])
  })

  it('keeps going after a push that failed', async () => {
    const { store } = memoryStore()
    const applied: string[] = []
    const pipeline = createPipeline({
      apply: (t) => {
        applied.push(t.signature)
        return t.signature === 'bad' ? Promise.reject(new Error('x')) : Promise.resolve()
      },
      store,
      initial: null,
      onError: () => {},
    })
    pipeline.push(tx('bad', 1))
    pipeline.push(tx('good', 2))
    await pipeline.drain()
    expect(applied).toEqual(['bad', 'good'])
  })
})
