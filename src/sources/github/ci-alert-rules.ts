import { err, ok, Result } from 'neverthrow'
import { z } from 'zod'

const CiAlertRuleSchema = z
  .object({
    repo: z.string(),
    branch: z.string(),
    actor: z.string().optional(),
  })
  .strict()

export type CiAlertRule = z.infer<typeof CiAlertRuleSchema>

export const parseCiAlertRules = (
  value: string,
): Result<CiAlertRule[], string> =>
  Result.fromThrowable(
    (raw: string): unknown => JSON.parse(raw) as unknown,
    (cause) => `GITHUB_CI_ALERT_RULES must be valid JSON: ${String(cause)}`,
  )(value).andThen((candidate) => {
    const parsed = z.array(CiAlertRuleSchema).safeParse(candidate)
    return parsed.success
      ? ok(parsed.data)
      : err(
          `GITHUB_CI_ALERT_RULES has an invalid shape: ${parsed.error.message}`,
        )
  })

const escapeRegExp = (value: string): string =>
  value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const matchesGlob = (glob: string, value: string): boolean =>
  new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`).test(value)

export const matchesCiAlertRule = (
  rule: CiAlertRule,
  input: { repo: string; branch: string; actor: string },
  ignoreActor: boolean,
): boolean =>
  matchesGlob(rule.repo, input.repo) &&
  matchesGlob(rule.branch, input.branch) &&
  (ignoreActor ||
    rule.actor === undefined ||
    matchesGlob(rule.actor, input.actor))
