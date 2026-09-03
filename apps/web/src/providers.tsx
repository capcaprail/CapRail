import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useMemo, useRef } from 'react'
import { createApiClient } from './api/client.ts'
import { createQueryClient } from './api/query.ts'
import { SessionProvider } from './auth/SessionProvider.tsx'
import { sessionStore } from './auth/session.ts'
import { webConfig } from './config.ts'
import '@solana/wallet-adapter-react-ui/styles.css'

// `wallets={[]}` on purpose: Phantom, Solflare and Backpack register themselves
// through Wallet Standard, and `@solana/wallet-adapter-wallets` would add
// react-native, Trezor and WalletConnect to a browser SPA (PLAN → Стек).
export function Providers({ children }: { children: ReactNode }) {
  const config = webConfig()
  const queryClient = useRef(createQueryClient()).current
  // The API client reads the token at request time from the store, so a query
  // created before sign-in picks the token up without being recreated.
  const store = useMemo(() => sessionStore(window.sessionStorage), [])
  const api = useMemo(
    () => createApiClient({ baseUrl: config.apiUrl, token: () => store.token() }),
    [config.apiUrl, store],
  )

  return (
    <ConnectionProvider endpoint={config.rpcUrl} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <QueryClientProvider client={queryClient}>
            <SessionProvider api={api} store={store}>
              {children}
            </SessionProvider>
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
