import { describe, expect, it, vi } from 'vitest'

import type { CreateTaskRequest } from '#plugins/tq/generated/tq-contract'
import { createTqClient } from '#plugins/tq/tq-client'

const taskRequest: CreateTaskRequest = {
  title: 'CI failure: build (sample/project)',
  description: 'Repository: sample/project\nRun: https://example.test/run/1',
  context: 'personal',
}

const taskResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 42,
  title: 'CI failure: build (sample/project)',
  description: 'Repository: sample/project\nRun: https://example.test/run/1',
  status: 'todo',
  statusReason: null,
  context: 'personal',
  commitment: 'inbox',
  labels: [],
  startDate: null,
  dueDate: null,
  remindAt: null,
  parentId: null,
  projectId: null,
  recurrenceRuleId: null,
  recurrenceRule: null,
  templateId: null,
  occurrenceDate: null,
  githubLinks: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  linkSync: { outgoing: [], unresolvedRefs: [] },
}

const observeRequests = (
  calls: [input: string | URL | Request, init?: RequestInit | undefined][],
) =>
  calls.map(([input, init]) => ({
    url:
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : null,
    method: init?.method ?? null,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body ?? null,
    signal: init?.signal === undefined ? null : 'timeout',
  }))

const observeResult = (
  result: unknown,
  calls: Parameters<typeof observeRequests>[0],
) => ({
  result,
  requests: observeRequests(calls),
})

describe('createTqClient', () => {
  it('creates a task using the tq API contract and returns its reference', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(taskResponse), { status: 201 }),
      )
    const client = createTqClient('http://tq.example.test:3001/', fetchImpl)

    const result = await client.createTask(taskRequest)

    expect(observeResult(result._unsafeUnwrap(), fetchImpl.mock.calls)).toEqual(
      {
        result: { id: '00000000-0000-4000-8000-000000000001', number: 42 },
        requests: [
          {
            url: 'http://tq.example.test:3001/api/tasks',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-author': 'service:webhook-hub',
            },
            body: JSON.stringify(taskRequest),
            signal: 'timeout',
          },
        ],
      },
    )
  })

  it('returns an API error when task creation fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }))
    const client = createTqClient('http://tq.example.test:3001', fetchImpl)

    const result = await client.createTask(taskRequest).match(
      (value) => ({ ok: true as const, value }),
      (error) => ({
        ok: false as const,
        name: error.name,
        message: error.message,
      }),
    )

    expect(result).toEqual({
      ok: false,
      name: 'TqApiError',
      message: 'TQ API returned HTTP 503',
    })
  })
})
