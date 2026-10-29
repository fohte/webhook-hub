import { z } from 'zod'

export const CreateTaskRequest = z
  .object({
    title: z.string().min(1),
    description: z.string().max(100000).optional(),
    template: z.string().optional(),
    startDate: z.string().optional(),
    dueDate: z.string().optional(),
    parentId: z.union([z.string(), z.string(), z.number()]).optional(),
    projectId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .optional(),
    context: z.enum(['work', 'personal']).optional(),
    commitment: z.enum(['inbox', 'active', 'someday']).optional(),
    labels: z.array(z.string().min(1)).optional(),
    recurrenceRule: z
      .object({
        type: z.enum(['daily', 'weekly', 'monthly', 'custom']),
        interval: z.number().int().gte(1).lte(9007199254740991),
        daysOfWeek: z.array(z.number().int().gte(0).lte(6)).optional(),
        dayOfMonth: z.number().int().gte(1).lte(31).optional(),
      })
      .passthrough()
      .optional(),
    blockedBy: z
      .array(
        z.union([z.union([z.string(), z.string(), z.number()]), z.string()]),
      )
      .optional(),
  })
  .passthrough()
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>
export const CreateTaskResponse = z
  .object({
    id: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid(),
    number: z.number().int().gte(-9007199254740991).lte(9007199254740991),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(['todo', 'completed']),
    statusReason: z.enum(['completed', 'not_planned', 'duplicate']).nullable(),
    context: z.enum(['work', 'personal']),
    commitment: z.enum(['inbox', 'active', 'someday']),
    labels: z.array(z.string()),
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    remindAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true })
      .nullable(),
    parentId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    projectId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    recurrenceRuleId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    recurrenceRule: z
      .object({
        id: z
          .string()
          .regex(
            /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
          )
          .uuid(),
        type: z.enum(['daily', 'weekly', 'monthly', 'custom']),
        interval: z.number().int().gte(1).lte(9007199254740991),
        daysOfWeek: z.array(z.number().int().gte(0).lte(6)).nullable(),
        dayOfMonth: z.number().int().gte(1).lte(31).nullable(),
      })
      .passthrough()
      .nullable(),
    templateId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    occurrenceDate: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$/,
      )
      .nullable(),
    githubLinks: z.array(
      z
        .object({
          id: z
            .string()
            .regex(
              /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
            )
            .uuid(),
          owner: z.string(),
          repo: z.string(),
          number: z.number().int().gte(-9007199254740991).lte(9007199254740991),
          kind: z.enum(['issue', 'pull_request']),
          role: z.enum(['subject', 'blocker']),
          notifyEvents: z.array(
            z.enum(['closed', 'reopened', 'comments', 'other']),
          ),
          url: z.string().url(),
          state: z.enum(['open', 'closed', 'merged']),
          title: z.string(),
          lastSyncedAt: z
            .string()
            .regex(
              /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
            )
            .datetime({ offset: true }),
        })
        .passthrough(),
    ),
    createdAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true }),
    updatedAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true }),
    linkSync: z
      .object({
        added: z.array(
          z
            .object({
              id: z
                .string()
                .regex(
                  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
                )
                .uuid(),
              number: z
                .number()
                .int()
                .gte(-9007199254740991)
                .lte(9007199254740991),
              title: z.string(),
              status: z.enum(['todo', 'completed']),
            })
            .passthrough(),
        ),
        unresolvedRefs: z.array(
          z.union([
            z
              .object({
                kind: z.literal('number'),
                value: z
                  .number()
                  .int()
                  .gte(-9007199254740991)
                  .lte(9007199254740991),
                sources: z.array(
                  z.union([
                    z.object({ kind: z.literal('description') }).passthrough(),
                    z
                      .object({
                        kind: z.literal('page'),
                        id: z
                          .string()
                          .regex(
                            /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
                          )
                          .uuid(),
                        title: z.string(),
                      })
                      .passthrough(),
                    z
                      .object({
                        kind: z.literal('comment'),
                        id: z
                          .string()
                          .regex(
                            /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
                          )
                          .uuid(),
                      })
                      .passthrough(),
                  ]),
                ),
              })
              .passthrough(),
            z
              .object({
                kind: z.literal('id'),
                value: z.string(),
                sources: z.array(
                  z.union([
                    z.object({ kind: z.literal('description') }).passthrough(),
                    z
                      .object({
                        kind: z.literal('page'),
                        id: z
                          .string()
                          .regex(
                            /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
                          )
                          .uuid(),
                        title: z.string(),
                      })
                      .passthrough(),
                    z
                      .object({
                        kind: z.literal('comment'),
                        id: z
                          .string()
                          .regex(
                            /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
                          )
                          .uuid(),
                      })
                      .passthrough(),
                  ]),
                ),
              })
              .passthrough(),
          ]),
        ),
      })
      .passthrough(),
  })
  .passthrough()
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>
export const GithubLinkLookupTaskResponse = z
  .object({
    id: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid(),
    number: z.number().int().gte(-9007199254740991).lte(9007199254740991),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(['todo', 'completed']),
    statusReason: z.enum(['completed', 'not_planned', 'duplicate']).nullable(),
    context: z.enum(['work', 'personal']),
    commitment: z.enum(['inbox', 'active', 'someday']),
    labels: z.array(z.string()),
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    remindAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true })
      .nullable(),
    parentId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    projectId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    recurrenceRuleId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    recurrenceRule: z
      .object({
        id: z
          .string()
          .regex(
            /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
          )
          .uuid(),
        type: z.enum(['daily', 'weekly', 'monthly', 'custom']),
        interval: z.number().int().gte(1).lte(9007199254740991),
        daysOfWeek: z.array(z.number().int().gte(0).lte(6)).nullable(),
        dayOfMonth: z.number().int().gte(1).lte(31).nullable(),
      })
      .passthrough()
      .nullable(),
    templateId: z
      .string()
      .regex(
        /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
      )
      .uuid()
      .nullable(),
    occurrenceDate: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$/,
      )
      .nullable(),
    githubLinks: z.array(
      z
        .object({
          id: z
            .string()
            .regex(
              /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
            )
            .uuid(),
          owner: z.string(),
          repo: z.string(),
          number: z.number().int().gte(-9007199254740991).lte(9007199254740991),
          kind: z.enum(['issue', 'pull_request']),
          role: z.enum(['subject', 'blocker']),
          notifyEvents: z.array(
            z.enum(['closed', 'reopened', 'comments', 'other']),
          ),
          url: z.string().url(),
          state: z.enum(['open', 'closed', 'merged']),
          title: z.string(),
          lastSyncedAt: z
            .string()
            .regex(
              /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
            )
            .datetime({ offset: true }),
        })
        .passthrough(),
    ),
    createdAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true }),
    updatedAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true }),
  })
  .passthrough()
export type GithubLinkLookupTaskResponse = z.infer<
  typeof GithubLinkLookupTaskResponse
>
export const GithubLinkLookupResponse = z
  .object({ task: GithubLinkLookupTaskResponse.nullable() })
  .passthrough()
export type GithubLinkLookupResponse = z.infer<typeof GithubLinkLookupResponse>
export const TaskStatusChangedWebhookEvent = z
  .object({
    event: z.literal('task.status_changed'),
    occurredAt: z
      .string()
      .regex(
        /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/,
      )
      .datetime({ offset: true }),
    task: z
      .object({
        id: z.string(),
        number: z.number().int().gte(-9007199254740991).lte(9007199254740991),
        status: z.enum(['todo', 'completed']),
        statusReason: z
          .enum(['completed', 'not_planned', 'duplicate'])
          .nullable(),
        duplicateOfTask: z
          .object({
            id: z.string(),
            number: z
              .number()
              .int()
              .gte(-9007199254740991)
              .lte(9007199254740991),
            title: z.string(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
export type TaskStatusChangedWebhookEvent = z.infer<
  typeof TaskStatusChangedWebhookEvent
>
