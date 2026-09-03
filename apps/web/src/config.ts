import { z } from 'zod'

// Everything here is baked into the bundle at build time, so it is public by
// construction; the schema only guards against an unfilled `.env`.
export const webConfigSchema = z.object({
  apiUrl: z.url(),
  rpcUrl: z.url(),
})

export type WebConfig = z.infer<typeof webConfigSchema>

export function readWebConfig(env: Record<string, unknown>): WebConfig {
  return webConfigSchema.parse({
    apiUrl: env.VITE_API_URL,
    rpcUrl: env.VITE_DEVNET_RPC_URL,
  })
}

let cached: WebConfig | undefined

export function webConfig(): WebConfig {
  cached ??= readWebConfig(import.meta.env)
  return cached
}
