import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { Navigate, useLocation } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider.tsx'
import { landingFor } from '../auth/session.ts'
import { Action, Actions, Help, KV } from '../components/Ledger.tsx'
import { short } from '../format.ts'

// The only public screen. Two steps stay two steps on purpose: connecting a
// wallet is a browser-extension permission, signing in is a signature the API
// checks — a user should see which of the two they are being asked for.
export function Landing() {
  const { state, canSign, signIn } = useSession()
  const { setVisible } = useWalletModal()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from

  if (state.kind === 'restoring') return null
  if (state.kind === 'signed-in') {
    return <Navigate to={from ?? landingFor(state.session.memberships)} replace />
  }

  const walletValue =
    state.kind === 'no-wallet' ? (
      <span className="muted">no wallet connected</span>
    ) : (
      <span className="mono">{state.wallet}</span>
    )
  const statusValue =
    state.kind === 'signing' ? (
      <span className="muted">waiting for the wallet to sign…</span>
    ) : state.kind === 'wallet' && state.error !== undefined ? (
      <span className="text-stamp">{state.error}</span>
    ) : (
      <span className="muted">not signed in</span>
    )

  return (
    <>
      <h1>Sign in</h1>
      <div className="sub">
        A wallet is the only credential. The key that holds a role in a company opens that company's
        panel; a key on an investor register opens the cabinet.
      </div>

      <h2>Wallet</h2>
      <KV empty={false} rows={[['Connected', walletValue]]} />
      <Actions>
        <Action onClick={() => setVisible(true)}>
          {state.kind === 'no-wallet' ? 'Connect wallet' : 'Change wallet'}
        </Action>
      </Actions>

      <h2>Signature</h2>
      <KV empty={false} rows={[['Status', statusValue]]} />
      <Actions>
        <Action
          inert={state.kind !== 'wallet' || !canSign}
          onClick={() => {
            if (state.kind === 'wallet' && canSign) void signIn()
          }}
        >
          {state.kind === 'wallet' && !canSign
            ? `Sign in — ${short(state.wallet)} cannot sign messages`
            : 'Sign in with this wallet'}
        </Action>
      </Actions>
      <Help>
        The wallet signs a one-time text with your address and a nonce; nothing is sent to the
        network and no fee is paid. The session lasts one hour.
      </Help>
    </>
  )
}
