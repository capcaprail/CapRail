import type { WalletAddress } from '@caprail/shared'
import { useWallet } from '@solana/wallet-adapter-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ApiClient } from '../api/client.ts'
import { signIn as performSignIn, type Session, type SessionStore } from './session.ts'

// The wallet is connected or not; the API session is a second, separate step
// that needs a signature. Both are visible so a screen can say "connect" versus
// "sign in" instead of one vague "log in".
export type SessionState =
  // A stored session exists and the wallet is still auto-connecting: guards hold
  // instead of bouncing a reloaded page through the sign-in screen.
  | { kind: 'restoring' }
  | { kind: 'no-wallet' }
  | { kind: 'wallet'; wallet: WalletAddress; error?: string }
  | { kind: 'signing'; wallet: WalletAddress }
  | { kind: 'signed-in'; session: Session }

export type SessionContextValue = {
  state: SessionState
  session: Session | null
  restoring: boolean
  canSign: boolean
  signIn: () => Promise<void>
  signOut: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

// Long enough for a wallet extension to answer a silent connect on page load,
// short enough that a wallet that was really disconnected does not hold the screen.
export const RESTORE_GRACE_MS = 2_500

export type SessionProviderProps = {
  api: ApiClient
  store: SessionStore
  children: ReactNode
}

export function SessionProvider({ api, store, children }: SessionProviderProps) {
  const { publicKey, signMessage, disconnect } = useWallet()
  const wallet = useMemo(
    () => (publicKey === null ? null : (publicKey.toBase58() as WalletAddress)),
    [publicKey],
  )
  const [state, setState] = useState<SessionState>(() =>
    store.token() === null ? { kind: 'no-wallet' } : { kind: 'restoring' },
  )
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Wallet changed (connected, disconnected, or another account selected):
  // whatever session was in memory is for someone else now. Without a wallet the
  // stored session is given a moment to be claimed by auto-connect before the
  // page is treated as signed out.
  useEffect(() => {
    if (wallet !== null) {
      const stored = store.load(wallet)
      setState(
        stored === null ? { kind: 'wallet', wallet } : { kind: 'signed-in', session: stored },
      )
      return
    }
    if (store.token() === null) {
      setState({ kind: 'no-wallet' })
      return
    }
    const giveUp = setTimeout(() => {
      store.clear()
      setState({ kind: 'no-wallet' })
    }, RESTORE_GRACE_MS)
    return () => clearTimeout(giveUp)
  }, [wallet, store])

  // Drop the session the moment the token expires rather than on the next 401:
  // the screen then asks for a signature instead of showing a failed request.
  useEffect(() => {
    if (expiryTimer.current !== null) clearTimeout(expiryTimer.current)
    if (state.kind !== 'signed-in') return
    const { wallet: sessionWallet, expiresAt } = state.session
    expiryTimer.current = setTimeout(
      () => {
        store.clear()
        setState({ kind: 'wallet', wallet: sessionWallet, error: 'session expired' })
      },
      Math.max(0, expiresAt - Date.now()),
    )
    return () => {
      if (expiryTimer.current !== null) clearTimeout(expiryTimer.current)
    }
  }, [state, store])

  const signIn = useCallback(async () => {
    if (wallet === null || signMessage === undefined) return
    setState({ kind: 'signing', wallet })
    try {
      const session = await performSignIn(api, { publicKey: wallet, signMessage })
      store.save(session)
      setState({ kind: 'signed-in', session })
    } catch (error) {
      setState({
        kind: 'wallet',
        wallet,
        error: error instanceof Error ? error.message : 'sign-in failed',
      })
    }
  }, [api, store, wallet, signMessage])

  const signOut = useCallback(() => {
    store.clear()
    if (wallet !== null) setState({ kind: 'wallet', wallet })
    void disconnect().catch(() => undefined)
  }, [store, wallet, disconnect])

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      session: state.kind === 'signed-in' ? state.session : null,
      restoring: state.kind === 'restoring',
      // Ledger and some hardware paths connect without `signMessage`; the button
      // then says why rather than failing on click.
      canSign: wallet !== null && signMessage !== undefined,
      signIn,
      signOut,
    }),
    [state, wallet, signMessage, signIn, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (value === null) throw new Error('useSession outside SessionProvider')
  return value
}
