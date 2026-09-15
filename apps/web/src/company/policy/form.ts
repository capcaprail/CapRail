import type { TransferPolicyInput } from '@caprail/chain'
import type { TransferPolicy } from '@caprail/shared'

// The policy form has one live field until M4: admission required. ROFR and its
// window are shown, inert, so the shape of the rule is visible before it exists.

export type PolicyFormRaw = { requireAccreditation: boolean }

export function policyInput(raw: PolicyFormRaw): TransferPolicyInput {
  return { requireAccreditation: raw.requireAccreditation, requireRofr: false, rofrWindowSecs: 0 }
}

/** A change that would write the same policy again is a version with no difference. */
export function policyChanged(current: TransferPolicy, next: TransferPolicyInput): boolean {
  return (
    current.requireAccreditation !== next.requireAccreditation ||
    current.requireRofr !== next.requireRofr ||
    current.rofrWindowSecs !== next.rofrWindowSecs
  )
}
