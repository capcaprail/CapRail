import { createPublicKey, verify } from 'node:crypto'

// SubjectPublicKeyInfo header for an Ed25519 key (RFC 8410): node:crypto takes no raw
// keys, and a 12-byte constant is cheaper than a second curve library next to the
// one web3.js already ships.
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

export function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + publicKey.length)
  der.set(ED25519_SPKI_PREFIX)
  der.set(publicKey, ED25519_SPKI_PREFIX.length)
  try {
    const key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' })
    return verify(null, message, key, signature)
  } catch {
    return false
  }
}
