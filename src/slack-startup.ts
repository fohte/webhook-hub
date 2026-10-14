import { captureWithFingerprint } from '@fohte/service-kit/observability'

import { logger } from '#logger'
import { SlackMissingScopesError, type SlackScopeChecker } from '#slack'

const SLACK_SCOPE_ERROR_FINGERPRINT = 'webhook-hub.slack-scope-check-failed'

export const checkSlackScopesAtStartup = (
  checker: SlackScopeChecker,
): Promise<void> =>
  checker.checkScopes().match(
    () => {},
    (error) => {
      const missingScopes =
        error instanceof SlackMissingScopesError ? error.missingScopes : []
      captureWithFingerprint(
        error,
        [SLACK_SCOPE_ERROR_FINGERPRINT, '{{ default }}'],
        { extras: { missing_scopes: missingScopes } },
      )
      logger.error(
        { error: error.message, missing_scopes: missingScopes },
        'slack_scope_check_failed',
      )
    },
  )
