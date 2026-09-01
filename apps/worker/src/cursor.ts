import { type Db, schema } from '@caprail/db'
import { eq } from 'drizzle-orm'

export type Cursor = { signature: string; slot: number }

export type CursorStore = {
  load: () => Promise<Cursor | null>
  save: (cursor: Cursor) => Promise<void>
}

export function cursorStore(db: Db, program: string): CursorStore {
  return {
    load: async () => {
      const rows = await db
        .select({ signature: schema.indexerCursor.signature, slot: schema.indexerCursor.slot })
        .from(schema.indexerCursor)
        .where(eq(schema.indexerCursor.program, program))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : { signature: row.signature, slot: Number(row.slot) }
    },
    save: async ({ signature, slot }) => {
      const updatedAt = new Date()
      await db
        .insert(schema.indexerCursor)
        .values({ program, signature, slot: BigInt(slot), updatedAt })
        .onConflictDoUpdate({
          target: schema.indexerCursor.program,
          set: { signature, slot: BigInt(slot), updatedAt },
        })
    },
  }
}
