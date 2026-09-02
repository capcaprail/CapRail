import { z } from 'zod'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function decodeBase58(text: string): Uint8Array | null {
  if (text.length === 0) return null
  let value = 0n
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit < 0) return null
    value = value * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  while (value > 0n) {
    bytes.push(Number(value & 0xffn))
    value >>= 8n
  }
  let leadingZeros = 0
  while (text[leadingZeros] === '1') leadingZeros += 1
  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()])
}

export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let text = ''
  while (value > 0n) {
    text = BASE58_ALPHABET[Number(value % 58n)] + text
    value /= 58n
  }
  let leadingZeros = 0
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1
  return '1'.repeat(leadingZeros) + text
}

const P = 2n ** 255n - 19n

function mod(a: bigint): bigint {
  const r = a % P
  return r < 0n ? r + P : r
}

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }
  return result
}

const D = mod(-121665n * pow(121666n, P - 2n))
const SQRT_M1 = pow(2n, (P - 1n) / 4n)

// RFC 8032 §5.1.3 point decompression, without building the point. A wallet is a
// keypair, so its public key is on the curve; PDAs are chosen to be off it — this is the
// distinction between "an address" and "a wallet".
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false
  let y = 0n
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i] ?? 0)
  const signBit = y >> 255n
  y &= (1n << 255n) - 1n
  if (y >= P) return false

  const y2 = mod(y * y)
  const u = mod(y2 - 1n)
  const v = mod(D * y2 + 1n)
  const v3 = mod(v * v * v)
  const v7 = mod(v3 * v3 * v)
  let x = mod(u * v3 * pow(mod(u * v7), (P - 5n) / 8n))
  const vx2 = mod(v * x * x)
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1)
  else if (vx2 !== u) return false
  return !(x === 0n && signBit === 1n)
}

declare const walletAddressBrand: unique symbol
export type WalletAddress = string & { readonly [walletAddressBrand]: true }

export function isWalletAddress(value: unknown): value is WalletAddress {
  if (typeof value !== 'string') return false
  const bytes = decodeBase58(value)
  return bytes !== null && bytes.length === 32 && isOnCurve(bytes)
}

export const walletAddressSchema = z.custom<WalletAddress>(isWalletAddress, {
  message: 'expected a base58 ed25519 public key on the curve',
})
