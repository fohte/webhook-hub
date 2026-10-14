import { captureWithFingerprint } from '@fohte/service-kit/observability'
import { errAsync } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { SlackMissingScopesError, type SlackScopeChecker } from '#slack'
import { checkSlackScopesAtStartup } from '#slack-startup'

vi.mock('@fohte/service-kit/observability', () => ({
  captureWithFingerprint: vi.fn(),
}))

vi.mock('#logger', () => ({
  logger: { error: vi.fn() },
}))

const observeScopeReport = <TCheckCalls, TSentryCalls>(
  checkCalls: TCheckCalls,
  sentryCalls: TSentryCalls,
) => ({ checkCalls, sentryCalls })

describe('checkSlackScopesAtStartup', () => {
  it('reports missing scopes to Sentry without rejecting startup', async () => {
    const error = new SlackMissingScopesError(['files:write'], ['chat:write'])
    const checkScopes = vi
      .fn<SlackScopeChecker['checkScopes']>()
      .mockReturnValue(errAsync(error))
    const checker: SlackScopeChecker = { checkScopes }

    await checkSlackScopesAtStartup(checker)

    expect(
      observeScopeReport(
        checkScopes.mock.calls,
        vi.mocked(captureWithFingerprint).mock.calls,
      ),
    ).toEqual({
      checkCalls: [[]],
      sentryCalls: [
        [
          error,
          ['webhook-hub.slack-scope-check-failed', '{{ default }}'],
          { extras: { missing_scopes: ['files:write'] } },
        ],
      ],
    })
  })
})
