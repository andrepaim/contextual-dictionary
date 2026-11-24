import { expect, it } from 'vitest'
import { exerciseCore, expected } from '../fixtures/core'

it('uses the shared dictionary pack and model order in Node', async () => {
  expect(await exerciseCore()).toEqual(expected)
})
