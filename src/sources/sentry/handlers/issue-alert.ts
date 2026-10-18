import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import type { SlackBlock, SlackMessageContent } from '#slack'
import { escapeSlackMrkdwn } from '#slack-mrkdwn'

interface SentryEventTagObject {
  key?: string | null
  value?: string | null
}

type SentryEventTag = SentryEventTagObject | [string, string]

interface SentryStacktraceFrame {
  in_app?: boolean | null
  filename?: string | null
  lineno?: number | null
  context_line?: string | null
}

interface SentryExceptionValue {
  type?: string | null
  value?: string | null
  stacktrace?: {
    frames?: SentryStacktraceFrame[] | null
  } | null
}

export interface SentryIssueAlertEvent {
  action: string
  data?: {
    event?: {
      title?: string | null
      level?: string | null
      web_url?: string | null
      url?: string | null
      culprit?: string | null
      request?: {
        method?: string | null
        url?: string | null
      } | null
      tags?: SentryEventTag[] | null
      exception?: {
        values?: SentryExceptionValue[] | null
      } | null
    } | null
    triggered_rule?: string | null
  }
}

export interface IssueAlertInput {
  action: string
  app: string
  culprit: string
  title: string
  level: string
  webUrl: string
  triggeredRule: string
  environment: string
  handled: string
  requestMethod: string
  requestUrl: string
  causes: string[]
  stacktraceFrames: SentryStacktraceFrame[]
}

export interface IssueAlertNotification {
  content: SlackMessageContent
  task: CreateTaskRequest
  title: string
  level: string
  webUrl: string
  triggeredRule: string
}

const SENTRY_ALERT_COLOR = '#d73a49'
const SENTRY_USERNAME = 'Sentry'
const SENTRY_ICON_URL = 'https://avatars.githubusercontent.com/u/1396951?v=4'
const DEFAULT_ISSUE_TITLE = 'Sentry issue alert'
// Slack header blocks use plain_text and are limited to 150 characters.
const HEADER_TEXT_MAX_LENGTH = 150
const SECTION_TEXT_MAX_LENGTH = 3000
// Four context values, separators, and code delimiters stay below the section limit.
const CONTEXT_VALUE_MAX_LENGTH = 700
// Three capped frame lines and the surrounding code fences stay below the section limit.
const STACKTRACE_FRAME_LIMIT = 3
const STACKTRACE_LINE_MAX_LENGTH = 996
const TASK_CAUSE_LIMIT = 3

const extractProjectSlug = (eventUrl: string | null | undefined): string =>
  eventUrl?.split('/projects/')[1]?.split('/')[1] ?? ''

const truncateHeaderText = (text: string): string =>
  text.length > HEADER_TEXT_MAX_LENGTH
    ? `${text.slice(0, HEADER_TEXT_MAX_LENGTH - 1)}…`
    : text

const escapeAndTruncateSlackMrkdwn = (
  text: string,
  maxLength = SECTION_TEXT_MAX_LENGTH,
): string => {
  const escapedText = escapeSlackMrkdwn(text)
  if (escapedText.length <= maxLength) return escapedText

  let result = ''
  for (const character of text) {
    const escapedCharacter = escapeSlackMrkdwn(character)
    if (result.length + escapedCharacter.length > maxLength - 1) {
      break
    }
    result += escapedCharacter
  }
  return `${result}…`
}

const getTagValue = (
  tags: SentryEventTag[] | null | undefined,
  key: string,
): string => {
  const tag = tags?.find((entry) =>
    Array.isArray(entry) ? entry[0] === key : entry.key === key,
  )
  if (tag === undefined) return ''
  return Array.isArray(tag) ? tag[1] : (tag.value ?? '')
}

const normalizeHandled = (value: string): string => {
  if (value === 'yes') return 'handled'
  if (value === 'no') return 'unhandled'
  return value
}

const extractRequestPath = (url: string | null | undefined): string =>
  (url ?? '')
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/iu, '')
    .replace(/^\/\/[^/]+/u, '')
    .split(/[?#]/u, 1)[0] ?? ''

const formatExceptionValue = (exception: SentryExceptionValue): string => {
  const type = exception.type ?? ''
  const value = exception.value ?? ''
  if (type === '') return value
  if (value === '') return type
  return `${type}: ${value}`
}

const getFrameLocation = (frame: SentryStacktraceFrame): string =>
  [
    frame.filename ?? '',
    frame.lineno === undefined || frame.lineno === null
      ? ''
      : String(frame.lineno),
  ]
    .filter((value) => value !== '')
    .join(':')

const getTaskAppName = (app: string): string => (app === '' ? 'Sentry' : app)

const getTaskLabels = (app: string): string[] => [
  'alert/sentry',
  ...(app === '' ? [] : [`dev/${app}`]),
]

const findStacktraceFrames = (
  exceptions: SentryExceptionValue[],
): SentryStacktraceFrame[] =>
  [...exceptions]
    .reverse()
    .map((exception) => exception.stacktrace?.frames ?? [])
    .find((frames) => frames.some((frame) => frame.in_app === true))
    ?.filter((frame) => frame.in_app === true) ?? []

const neutralizeBackticks = (text: string): string => text.replace(/`/gu, 'ˋ')

const renderRequest = (method: string, url: string): string =>
  [method, url].filter((value) => value !== '').join(' ')

const renderContextText = (text: string): string =>
  escapeAndTruncateSlackMrkdwn(
    neutralizeBackticks(text),
    CONTEXT_VALUE_MAX_LENGTH,
  )

const renderInlineCode = (text: string): string =>
  `\`${renderContextText(text)}\``

const selectStacktraceLines = (frames: SentryStacktraceFrame[]): string[] =>
  [...frames]
    .reverse()
    .slice(0, STACKTRACE_FRAME_LIMIT)
    .map((frame) =>
      [getFrameLocation(frame), (frame.context_line ?? '').trimStart()]
        .filter((value) => value !== '')
        .join('  ')
        .replace(/\s*\n\s*/gu, ' '),
    )
    .filter((line) => line !== '')

const renderStacktrace = (frames: SentryStacktraceFrame[]): string => {
  const lines = selectStacktraceLines(frames).map((line) =>
    escapeAndTruncateSlackMrkdwn(
      neutralizeBackticks(line),
      STACKTRACE_LINE_MAX_LENGTH,
    ),
  )
  return lines.length === 0 ? '' : `\`\`\`\n${lines.join('\n')}\n\`\`\``
}

const getLongestBacktickSequence = (text: string): number =>
  [...text.matchAll(/`+/gu)].reduce(
    (longest, [sequence]) => Math.max(longest, sequence.length),
    0,
  )

const normalizeTaskText = (text: string): string =>
  text.replace(/\s*\n\s*/gu, ' ').trim()

const truncateTaskText = (
  text: string,
  maxLength = CONTEXT_VALUE_MAX_LENGTH,
): string => {
  const normalized = normalizeTaskText(text)
  let result = ''
  let characterCount = 0
  for (const character of normalized) {
    characterCount += 1
    if (characterCount === maxLength) continue
    if (characterCount > maxLength) return `${result}…`
    result += character
  }
  return normalized
}

const renderTaskCode = (text: string): string => {
  const normalized = truncateTaskText(text)
  const delimiter = '`'.repeat(getLongestBacktickSequence(normalized) + 1)
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`')
  const content = needsPadding ? ` ${normalized} ` : normalized
  return `${delimiter}${content}${delimiter}`
}

const renderTaskStacktrace = (
  frames: SentryStacktraceFrame[],
): string | undefined => {
  const lines = selectStacktraceLines(frames).map((line) =>
    truncateTaskText(line, STACKTRACE_LINE_MAX_LENGTH),
  )
  if (lines.length === 0) return undefined

  const fence = '`'.repeat(
    Math.max(3, ...lines.map((line) => getLongestBacktickSequence(line) + 1)),
  )
  return `- Stacktrace:\n\n  ${fence}\n${lines
    .map((line) => `  ${line}`)
    .join('\n')}\n  ${fence}`
}

const buildTaskDescription = (input: IssueAlertInput): string => {
  const app = getTaskAppName(input.app)
  const request = renderRequest(input.requestMethod, input.requestUrl)
  const reasonDetails = [
    input.level === '' ? undefined : `- Level: ${input.level}`,
    input.triggeredRule === '' ? undefined : `- Rule: ${input.triggeredRule}`,
  ].filter((line): line is string => line !== undefined)
  const workDetails = [
    input.culprit === ''
      ? undefined
      : `- 発生箇所: ${renderTaskCode(input.culprit)}`,
    input.environment === ''
      ? undefined
      : `- Environment: ${renderTaskCode(input.environment)}`,
    input.handled === ''
      ? undefined
      : `- Handled: ${renderTaskCode(input.handled)}`,
    request === '' ? undefined : `- Request: ${renderTaskCode(request)}`,
    input.causes.length === 0
      ? undefined
      : `- Causes:\n${input.causes
          .slice(0, TASK_CAUSE_LIMIT)
          .map((cause) => `  - ${renderTaskCode(cause)}`)
          .concat(
            input.causes.length > TASK_CAUSE_LIMIT
              ? ['  - (additional causes omitted)']
              : [],
          )
          .join('\n')}`,
    renderTaskStacktrace(input.stacktraceFrames),
    input.webUrl === '' ? undefined : `- Issue: ${input.webUrl}`,
  ].filter((line): line is string => line !== undefined)

  return [
    '## なぜやるか',
    '',
    `${app} で ${renderTaskCode(input.title)} が発生している。`,
    ...(reasonDetails.length === 0 ? [] : ['', ...reasonDetails]),
    '',
    '## やること',
    '',
    '発生箇所の原因を調べて直す。',
    ...(workDetails.length === 0 ? [] : ['', ...workDetails]),
    '',
    '## 完了条件',
    '',
    '- [ ] Sentry の issue が resolved になる',
  ].join('\n')
}

export const extractIssueAlertInput = (
  payload: SentryIssueAlertEvent,
): IssueAlertInput => {
  const event = payload.data?.event
  const exceptions = event?.exception?.values ?? []
  const handled = normalizeHandled(getTagValue(event?.tags, 'handled'))

  return {
    action: payload.action,
    app: extractProjectSlug(event?.url),
    culprit: event?.culprit ?? '',
    title: event?.title ?? DEFAULT_ISSUE_TITLE,
    level: event?.level ?? '',
    webUrl: event?.web_url ?? '',
    triggeredRule: payload.data?.triggered_rule ?? '',
    environment: getTagValue(event?.tags, 'environment'),
    handled,
    requestMethod: event?.request?.method ?? '',
    requestUrl: extractRequestPath(event?.request?.url),
    causes: exceptions
      .slice(0, -1)
      .reverse()
      .map(formatExceptionValue)
      .filter((value) => value !== ''),
    stacktraceFrames: findStacktraceFrames(exceptions),
  }
}

export const buildIssueAlertNotification = (
  input: IssueAlertInput,
): IssueAlertNotification | null => {
  if (input.action !== 'triggered') return null

  const request = renderRequest(input.requestMethod, input.requestUrl)
  const app = getTaskAppName(input.app)
  const contextLine = [
    input.app === '' ? '' : renderInlineCode(input.app),
    input.environment === '' ? '' : renderContextText(input.environment),
    input.handled === '' ? '' : renderContextText(input.handled),
    request === '' ? '' : renderInlineCode(request),
  ]
    .filter((value) => value !== '')
    .join(' · ')
  const stacktrace = renderStacktrace(input.stacktraceFrames)
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: truncateHeaderText(input.title) },
    },
    ...(contextLine === ''
      ? []
      : [
          {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: contextLine,
            },
          },
        ]),
    ...(input.causes.length === 0
      ? []
      : [
          {
            type: 'section' as const,
            text: {
              type: 'mrkdwn' as const,
              text: escapeAndTruncateSlackMrkdwn(
                `原因: ${input.causes.join(' › ')}`,
              ),
            },
          },
        ]),
    ...(stacktrace === ''
      ? []
      : [
          {
            type: 'section' as const,
            text: { type: 'mrkdwn' as const, text: stacktrace },
          },
        ]),
    ...(input.webUrl === ''
      ? []
      : [
          {
            type: 'context' as const,
            elements: [
              {
                type: 'mrkdwn' as const,
                text: `<${input.webUrl}|View issue>`,
              },
            ],
          },
        ]),
  ]
  const content: SlackMessageContent = {
    text: input.title,
    color: SENTRY_ALERT_COLOR,
    blocks,
    username: SENTRY_USERNAME,
    iconUrl: SENTRY_ICON_URL,
  }

  return {
    content,
    task: {
      title: `${app}: ${input.title}`,
      description: buildTaskDescription(input),
      context: 'personal',
      labels: getTaskLabels(input.app),
    },
    title: input.title,
    level: input.level,
    webUrl: input.webUrl,
    triggeredRule: input.triggeredRule,
  }
}
