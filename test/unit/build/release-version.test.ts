import { describe, expect, test } from 'vitest'
// @ts-expect-error plain JavaScript build script without types
import { releaseProblems } from '../../../scripts/release-version.mjs'

const versions = { packageVersion: '0.1.0', lockVersion: '0.1.0', manifestVersion: '0.1.0' }

describe('releaseProblems', () => {
  test('a tag equal to v<version> everywhere is fine', () => {
    expect(releaseProblems('v0.1.0', versions)).toEqual([])
    expect(releaseProblems('refs/tags/v0.1.0', versions)).toEqual([])
  })

  test('a tag that differs from the package version is refused', () => {
    expect(releaseProblems('v0.2.0', versions)).toEqual([expect.stringMatching(/v0\.2\.0.*0\.1\.0/)])
    expect(releaseProblems('0.1.0', versions)).toEqual([expect.stringMatching(/v<version>/)])
    expect(releaseProblems('', versions)).toEqual([expect.stringMatching(/v<version>/)])
  })

  test('the lock file and the built manifest must carry the same version', () => {
    expect(releaseProblems('v0.1.0', { ...versions, lockVersion: '0.0.9' })).toEqual([expect.stringMatching(/package-lock/)])
    expect(releaseProblems('v0.1.0', { ...versions, manifestVersion: '0.0.0' })).toEqual([expect.stringMatching(/manifest/)])
  })

  test('a version Chrome cannot use is refused', () => {
    const beta = { packageVersion: '0.1.0-beta.1', lockVersion: '0.1.0-beta.1', manifestVersion: '0.1.0-beta.1' }
    expect(releaseProblems('v0.1.0-beta.1', beta)).toEqual([expect.stringMatching(/Chrome/)])
  })
})
