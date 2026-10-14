/**
 * Real-composition probe for dsh-empty-turn-continuation: mounts the row into a
 * real AgentLoop driven by a scripted mock adapter, and proves the loop actually
 * continues past an empty reply instead of closing the turn on it.
 *
 * Run it from a DeepSeek Harness checkout:
 *
 *   node --import tsx/esm C:/resource/dsh-empty-turn-continuation/probe/real-loop-probe.mjs
 *
 * The offline `probe.mjs` next to this file covers the decision table; this one
 * covers the parts a fake cannot: that `session.append` publishes
 * `session/event` before the boundary runs, that an empty assistant message
 * really does close a turn, and that a steer taken at `agent/turn-stopping`
 * really does run another step of the same turn.
 */

import assert from 'node:assert/strict'

import { Context } from '../../deepseek-harness/vendor/cordis/src/index.ts'
import LlmRuntime, { createUserMessage } from '../../deepseek-harness/packages/llm/llm/src/index.ts'
import SessionStore, { SessionId } from '../../deepseek-harness/packages/core/session/src/index.ts'
import SystemPrompt from '../../deepseek-harness/packages/core/system-prompt/src/index.ts'
import ToolRuntime, { defineContentToolFixture } from '../../deepseek-harness/packages/core/tools/src/index.ts'
import AgentRegistry from '../../deepseek-harness/packages/core/agent/src/index.ts'
import AgentLoop from '../../deepseek-harness/packages/core/agent-loop/src/index.ts'
import SessionProjectionRegistry from '../../deepseek-harness/packages/session/session-projection/src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'

import * as continuation from '../index.js'

/** A model that stops having produced nothing at all: usage, then a clean stop. */
function emptyResponse() {
  return [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A model that thinks for a while and then stops without saying anything. */
function reasoningOnlyResponse() {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Mount the harness services plus the row under test, and register the adapter. */
async function harness(script, { maxContinuations = 3, tools = [] } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const tool of tools) ctx.tools.register(tool)
  await ctx.plugin(continuation, { maxContinuations })
  return { ctx, adapter }
}

/** Resolve on the agent's next transition to idle after a waking follow-up. */
function whenIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

/** Run one turn that starts with `text` and report what the model was asked. */
async function runTurn(setup, text, options = {}) {
  const { ctx, adapter } = await harness(setup, options)
  try {
    const agent = await ctx.agentLoop.create(SessionId('probe'), { provider: 'mock', model: 'mock' })
    const idle = whenIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await idle
    const continuations = agent.session.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'empty-turn-continuation',
    )
    return { requests: adapter.requests.length, continuations: continuations.length }
  } finally {
    await ctx.fiber.dispose()
  }
}

{
  // The failure this row exists for: an empty reply, then a real one.
  const { requests, continuations } = await runTurn(
    [emptyResponse(), emptyResponse(), textResponse('here is the answer')],
    'hi',
  )
  assert.equal(requests, 3, 'the turn ran one step per model call')
  assert.equal(continuations, 2, 'each empty stop injected exactly one continuation')
}

{
  // Thinking out loud and stopping still owes the user a reply.
  const { requests, continuations } = await runTurn(
    [reasoningOnlyResponse(), textResponse('here is the answer')],
    'hi',
  )
  assert.equal(requests, 2)
  assert.equal(continuations, 1)
}

{
  // The budget is real: a model that never answers is left to close the turn.
  const { requests, continuations } = await runTurn(
    [emptyResponse(), emptyResponse(), emptyResponse(), emptyResponse(), emptyResponse()],
    'hi',
  )
  assert.equal(requests, 4, 'three continuations, then the turn closed')
  assert.equal(continuations, 3)
}

{
  // A model that answers is not touched at all.
  const { requests, continuations } = await runTurn([textResponse('done')], 'hi')
  assert.equal(requests, 1)
  assert.equal(continuations, 0)
}

{
  // A tool that concluded the turn said the task is done; that outranks an empty
  // body, and the loop must not be restarted on top of it.
  const finalize = defineContentToolFixture({
    name: 'finalize',
    description: '',
    parameters: {},
    async execute(_args, exec) {
      exec.concludeTurn()
      return [{ type: 'text', text: 'done' }]
    },
  })
  const { requests, continuations } = await runTurn(
    [toolCallResponse('c1', 'finalize', {}), textResponse('restarted')],
    'hi',
    { tools: [finalize] },
  )
  assert.equal(requests, 1, 'the concluding tool ended the turn')
  assert.equal(continuations, 0)
}

{
  // An ordinary tool result concludes nothing: the model owes a reply afterwards.
  const read = defineContentToolFixture({
    name: 'read',
    description: '',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'contents' }]
    },
  })
  const { requests, continuations } = await runTurn(
    [toolCallResponse('c1', 'read', {}), emptyResponse(), textResponse('here is the answer')],
    'hi',
    { tools: [read] },
  )
  assert.equal(requests, 3)
  assert.equal(continuations, 1)
}

console.log('dsh-empty-turn-continuation real-loop probe: ok')