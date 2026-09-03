import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './client.ts'

// A 4xx is the answer, not a hiccup: retrying an UNAUTHORIZED or NOT_FOUND only
// delays the screen that explains it.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 2 && !(error instanceof ApiError && error.status < 500),
      },
    },
  })
}
