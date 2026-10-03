import { describe, expect, it } from 'vitest'
import { legacyPath } from './legacy-path.ts'

const BASE = '/CapRail/app/'

describe('legacyPath', () => {
  it('moves a link of the panel at the site root under the app', () => {
    expect(legacyPath('/CapRail/company/16497703148306843135', BASE)).toBe(
      '/CapRail/app/company/16497703148306843135',
    )
    expect(legacyPath('/CapRail/market', BASE)).toBe('/CapRail/app/market')
  })

  it('leaves a path already under the app alone', () => {
    expect(legacyPath('/CapRail/app/cabinet', BASE)).toBeNull()
    expect(legacyPath('/CapRail/app/', BASE)).toBeNull()
    expect(legacyPath('/CapRail/app', BASE)).toBeNull()
  })

  it('does nothing when the app is not served from an /app/ folder', () => {
    expect(legacyPath('/company/1', '/')).toBeNull()
    expect(legacyPath('/CapRail/company/1', '/CapRail/')).toBeNull()
  })

  it('works on a custom domain where the app lives at /app/', () => {
    expect(legacyPath('/cabinet', '/app/')).toBe('/app/cabinet')
  })

  it('ignores a path outside the site', () => {
    expect(legacyPath('/elsewhere/company/1', BASE)).toBeNull()
  })

  it('treats a look-alike prefix as a path of the old panel', () => {
    expect(legacyPath('/CapRail/application', BASE)).toBe('/CapRail/app/application')
  })
})
