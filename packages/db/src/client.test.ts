import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type DbHandle, POOL_MAX } from './client.ts'

// postgres.js opens no socket until the first query, so a fake URL is enough here.
const URL = 'postgres://postgres.x:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'

let handle: DbHandle | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
})

describe('createDb', () => {
  it('disables prepared statements for the transaction pooler', () => {
    handle = createDb(URL)
    expect(handle.sql.options.prepare).toBe(false)
  })

  it('keeps the pool small — api and worker share the free-tier connections', () => {
    handle = createDb(URL)
    expect(handle.sql.options.max).toBe(POOL_MAX)
  })

  it('rejects an empty url instead of falling back to libpq defaults', () => {
    expect(() => createDb('')).toThrow()
  })
})
