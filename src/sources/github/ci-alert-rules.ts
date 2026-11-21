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
    () => 'GITHUB_CI_ALERT_RULES must be valid JSON',
  )(value).andThen((candidate) => {
    const parsed = z.array(CiAlertRuleSchema).safeParse(candidate)
    return parsed.success
      ? ok(parsed.data)
      : err(
          'GITHUB_CI_ALERT_RULES must be an array of rules with string repo and branch and optional string actor',
        )
  })

const matchesGlob = (glob: string, value: string): boolean => {
  let globIndex = 0
  let valueIndex = 0
  let lastStarIndex = -1
  let valueIndexAfterStar = 0

  while (valueIndex < value.length) {
    const current = glob[globIndex]
    if (current === value[valueIndex]) {
      globIndex += 1
      valueIndex += 1
    } else if (current === '*') {
      lastStarIndex = globIndex
      globIndex += 1
      valueIndexAfterStar = valueIndex
    } else if (lastStarIndex >= 0) {
      globIndex = lastStarIndex + 1
      valueIndex = valueIndexAfterStar + 1
      valueIndexAfterStar = valueIndex
    } else {
      return false
    }
  }

  while (glob[globIndex] === '*') globIndex += 1
  return globIndex === glob.length
}

export const matchesCiAlertRule = (
  rule: CiAlertRule,
  input: { repo: string; branch: string; actor: string | null },
  ignoreActor: boolean,
): boolean =>
  matchesGlob(rule.repo, input.repo) &&
  matchesGlob(rule.branch, input.branch) &&
  (ignoreActor ||
    rule.actor === undefined ||
    (input.actor !== null && matchesGlob(rule.actor, input.actor)))
