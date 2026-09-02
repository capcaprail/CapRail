import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { encodeBase58, type WalletAddress } from '@caprail/shared'

// A wallet for tests: a real ed25519 keypair, so the signature path under test is
// the one Phantom and Solflare produce, not a stub that always agrees.
export type TestWallet = {
  address: WalletAddress
  signMessage: (message: string) => string
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('ed25519 jwk without x')
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'))
}

export function testWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    address: encodeBase58(rawPublicKey(publicKey)) as WalletAddress,
    signMessage: (message) =>
      encodeBase58(new Uint8Array(sign(null, Buffer.from(message, 'utf8'), privateKey))),
  }
}
