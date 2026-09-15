import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { QueryClientProvider } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react'
import { type ApiClient, createApiClient } from './api/client.ts'
import { createQueryClient } from './api/query.ts'
import { SessionProvider } from './auth/SessionProvider.tsx'
import { sessionStore } from './auth/session.ts'
import { webConfig } from './config.ts'
import '@solana/wallet-adapter-react-ui/styles.css'

const ApiContext = createContext<ApiClient | null>(null)

// The same client the session signs in with, for the screens' own reads.
export function useApi(): ApiClient {
  const api = useContext(ApiContext)
  if (api === null) throw new Error('useApi outside Providers')
  return api
}

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
            <ApiContext.Provider value={api}>
              <SessionProvider api={api} store={store}>
                {children}
              </SessionProvider>
            </ApiContext.Provider>
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
