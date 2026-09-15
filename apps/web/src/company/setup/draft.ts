import { type WalletAddress, walletAddressSchema } from '@caprail/shared'
import { z } from 'zod'

// The wizard is two transactions. Between them the page may be reloaded or the
// wallet may decline the second one: the company then exists on chain with no
// token, and the id is nowhere but here. The draft survives in sessionStorage and
// resumes step two; it is bound to the admin key like the session is.

export const SETUP_DRAFT_KEY = 'caprail.setup'

export const setupDraftSchema = z.object({
  admin: walletAddressSchema,
  companyId: z.string().regex(/^\d{1,20}$/),
  name: z.string().min(1),
  complianceOfficer: walletAddressSchema,
  createCompanySignature: z.string().min(1),
})
export type SetupDraft = z.infer<typeof setupDraftSchema>

export type DraftStore = {
  load: (admin: WalletAddress) => SetupDraft | null
  save: (draft: SetupDraft) => void
  clear: () => void
}

export function draftStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): DraftStore {
  return {
    load(admin) {
      try {
        const raw = storage.getItem(SETUP_DRAFT_KEY)
        if (raw === null) return null
        const parsed = setupDraftSchema.safeParse(JSON.parse(raw))
        return parsed.success && parsed.data.admin === admin ? parsed.data : null
      } catch {
        return null
      }
    },
    save(draft) {
      try {
        storage.setItem(SETUP_DRAFT_KEY, JSON.stringify(draft))
      } catch {
        // Private mode or a full quota: the wizard still holds the draft in memory.
      }
    },
    clear() {
      try {
        storage.removeItem(SETUP_DRAFT_KEY)
      } catch {
        // Nothing to clear.
      }
    },
  }
}
