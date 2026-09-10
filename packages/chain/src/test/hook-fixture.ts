import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'

// `fixtures/hook-extra-account-metas.json` — the hook's on-chain list and the addresses
// the program derives for fixed inputs. Written by hand from the Rust test's expected
// output and pinned by that test; read here with `fs` because the file lives outside
// this package's `rootDir`.

export type HookFixture = {
  readonly list: Uint8Array
  readonly companyId: bigint
  readonly tokenIndex: number
  readonly company: PublicKey
  readonly mint: PublicKey
  readonly tokenConfig: PublicKey
  readonly treasury: PublicKey
  readonly extraAccountMetaList: PublicKey
  readonly sender: PublicKey
  readonly recipient: PublicKey
  readonly source: PublicKey
  readonly destination: PublicKey
  readonly investorRecord: PublicKey
  readonly grant: PublicKey
  readonly transferPermit: PublicKey
}

const FIXTURE_URL = new URL('../../../../fixtures/hook-extra-account-metas.json', import.meta.url)

function field(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== 'string') throw new Error(`fixture: ${name} must be a string`)
  return value
}

export function loadHookFixture(): HookFixture {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error('fixture: not an object')
  const doc = raw as { list?: unknown; sample?: unknown }
  if (typeof doc.list !== 'string') throw new Error('fixture: list must be base64')
  if (typeof doc.sample !== 'object' || doc.sample === null) {
    throw new Error('fixture: sample must be an object')
  }
  const sample = doc.sample as Record<string, unknown>
  const tokenIndex = sample.tokenIndex
  if (typeof tokenIndex !== 'number') throw new Error('fixture: tokenIndex must be a number')
  const key = (name: string) => new PublicKey(field(sample, name))

  return {
    list: Uint8Array.from(Buffer.from(doc.list, 'base64')),
    companyId: BigInt(field(sample, 'companyId')),
    tokenIndex,
    company: key('company'),
    mint: key('mint'),
    tokenConfig: key('tokenConfig'),
    treasury: key('treasury'),
    extraAccountMetaList: key('extraAccountMetaList'),
    sender: key('sender'),
    recipient: key('recipient'),
    source: key('source'),
    destination: key('destination'),
    investorRecord: key('investorRecord'),
    grant: key('grant'),
    transferPermit: key('transferPermit'),
  }
}
