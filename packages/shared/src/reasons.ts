import { z } from 'zod'

// Order = order of checks in the hook; names = variants of `CaprailError` in the program.
export const REJECTION_REASONS = [
  'NotAccredited',
  'AccreditationExpired',
  'Unvested',
  'RofrWindowOpen',
] as const

export const rejectionReasonSchema = z.enum(REJECTION_REASONS)

export type RejectionReason = z.infer<typeof rejectionReasonSchema>

export function isRejectionReason(value: unknown): value is RejectionReason {
  return rejectionReasonSchema.safeParse(value).success
}
