import { describe, expect, it } from 'vitest'

import { buildIssueNotification } from '#sources/github/handlers/issue'

describe('buildIssueNotification', () => {
  it('formats a notification for a third-party issue', () => {
    expect(
      buildIssueNotification({
        repo: 'fohte/example',
        title: 'fix: support <T> generics',
        url: 'https://github.com/fohte/example/issues/3',
        author: 'octocat',
      }),
    ).toEqual({
      text: [
        ':speech_balloon: *New issue opened on `fohte/example` by `octocat`*',
        '*fix: support &lt;T&gt; generics*',
        '<https://github.com/fohte/example/issues/3|View issue>',
      ].join('\n'),
      repo: 'fohte/example',
      url: 'https://github.com/fohte/example/issues/3',
    })
  })
})
