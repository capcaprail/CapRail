import { decodeBase58, signInMessage } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { verifyEd25519 } from './signature.ts'
import { testWallet } from './test-wallet.ts'

const bytes = (text: string) => decodeBase58(text) ?? new Uint8Array()
const utf8 = (text: string) => new TextEncoder().encode(text)

describe('verifyEd25519', () => {
  it('accepts a signature made by the wallet over the same message', () => {
    const wallet = testWallet()
    const message = signInMessage(wallet.address, 'a'.repeat(32))
    const signature = wallet.signMessage(message)
    expect(verifyEd25519(utf8(message), bytes(signature), bytes(wallet.address))).toBe(true)
  })

  it('rejects another message, another wallet and a flipped bit', () => {
    const wallet = testWallet()
    const other = testWallet()
    const message = signInMessage(wallet.address, 'a'.repeat(32))
    const signature = bytes(wallet.signMessage(message))
    expect(verifyEd25519(utf8(`${message} `), signature, bytes(wallet.address))).toBe(false)
    expect(verifyEd25519(utf8(message), signature, bytes(other.address))).toBe(false)
    const flipped = Uint8Array.from(signature)
    flipped[10] = (flipped[10] ?? 0) ^ 1
    expect(verifyEd25519(utf8(message), flipped, bytes(wallet.address))).toBe(false)
  })

  it('rejects malformed key or signature lengths without throwing', () => {
    expect(verifyEd25519(utf8('m'), new Uint8Array(64), new Uint8Array(31))).toBe(false)
    expect(verifyEd25519(utf8('m'), new Uint8Array(63), new Uint8Array(32))).toBe(false)
    expect(verifyEd25519(utf8('m'), new Uint8Array(64), new Uint8Array(32))).toBe(false)
  })
})
