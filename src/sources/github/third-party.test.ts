import { describe, expect, it } from 'vitest'

import { isThirdParty } from '#sources/github/third-party'

describe('isThirdParty', () => {
  it.each([
    {
      name: 'a bot sender',
      sender: { login: 'renovate[bot]', type: 'Bot' },
      expected: false,
    },
    {
      name: 'the repository owner',
      sender: { login: 'fohte', type: 'User' },
      expected: false,
    },
    {
      name: 'a third-party user',
      sender: { login: 'octocat', type: 'User' },
      expected: true,
    },
  ])('returns $expected for $name', ({ sender, expected }) => {
    expect(
      isThirdParty({ sender, repository: { owner: { login: 'fohte' } } }),
    ).toBe(expected)
  })
})
