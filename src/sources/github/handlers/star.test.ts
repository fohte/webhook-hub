import { describe, expect, it } from 'vitest'

import type { StarInput } from '#sources/github/handlers/star'
import { buildStarNotification } from '#sources/github/handlers/star'

const baseInput = (overrides: Partial<StarInput> = {}): StarInput => ({
  repo: 'fohte/example',
  repoUrl: 'https://github.com/fohte/example',
  sender: 'octocat',
  ...overrides,
})

describe('buildStarNotification', () => {
  it('returns a notification for the starred repository', () => {
    expect(buildStarNotification(baseInput())).toEqual({
      text: [
        ':star: *`fohte/example` was starred by `octocat`*',
        '<https://github.com/fohte/example|View repository>',
      ].join('\n'),
      repo: 'fohte/example',
      sender: 'octocat',
    })
  })

  it('escapes Slack mrkdwn metacharacters in repo and sender', () => {
    const input = baseInput({
      repo: 'fohte/<example>',
      sender: '<octocat>',
    })
    expect(buildStarNotification(input)).toEqual({
      text: [
        ':star: *`fohte/&lt;example&gt;` was starred by `&lt;octocat&gt;`*',
        '<https://github.com/fohte/example|View repository>',
      ].join('\n'),
      repo: 'fohte/<example>',
      sender: '<octocat>',
    })
  })
})
