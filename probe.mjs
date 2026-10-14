/**
 * Offline probe for dsh-empty-turn-continuation: drives `apply()` against fakes
 * and checks which empty stops are carried on. Run with `node probe.mjs`.
 *
 * The fakes mirror the three facts the row depends on: `session/event` is
 * published synchronously by `session.append()`, `agent/turn-stopping` hands
 * over the live session, and `agent.steer()` queues the next step of the same
 * turn.
 */

import assert from 'node:assert/strict'
import { apply, name } from './index.js'

/** A context recording one listener per event name. */
function fakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(event, listener) {
      assert.equal(listeners.has(event), false, `two listeners for ${event}`)
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
}

/**
 * Mount the row and return the handles a turn is driven through.
 * @param {object} [config] - the row config under test.
 */
function mount(config) {
  const ctx = fakeCtx()
  apply(ctx, config)
  const session = {}
  const agent = { session, steered: [], steer(message) { this.steered.push(message) } }
  const driver = {
    ctx,
    agent,
    /** Open a turn, which resets the observation and the continuation budget. */
    start(turn = 1) {
      ctx.listeners.get('session/event')(session, { type: 'turn/start', data: { turn } })
    },
    /** Record one assistant message with the given content blocks. */
    say(content, turn = 1) {
      ctx.listeners.get('session/event')(session, {
        type: 'assistant/message',
        data: { turn, step: 1, message: { role: 'assistant', content } },
      })
    },
    /** Run one tool execution through the post-execute waterfall. */
    async tool(result, decision = { kind: 'accept' }) {
      await ctx.listeners.get('tools/post-execute')(
        { name: 'subagent', agent },
        result,
        () => Promise.resolve(decision),
      )
    },
    /** Reach the turn's closing boundary and report what it steered. */
    async stop({ aborted = false } = {}) {
      await ctx.listeners.get('agent/turn-stopping')({
        agent,
        turn: 1,
        signal: { aborted },
      })
      return agent.steered.splice(0)
    },
  }
  return driver
}

const text = (value) => ({ type: 'text', text: value })
const reasoning = (value) => ({ type: 'reasoning', text: value })
const toolCall = { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }

assert.equal(name, 'empty-turn-continuation')

{
  // An empty final message is the failure this row exists for.
  const d = mount()
  d.start()
  d.say([])
  const steered = await d.stop()
  assert.equal(steered.length, 1)
  assert.equal(steered[0].role, 'user')
  assert.deepEqual(steered[0].source, {
    kind: 'empty-turn-continuation',
    form: 'notice',
    summary: 'Continue: the previous response produced no visible text',
  })
  assert.match(steered[0].content[0].text, /without any visible text/)
  assert.match(steered[0].id, /^[0-9a-f-]{36}$/)
}

{
  // A real reply is left alone.
  const d = mount()
  d.start()
  d.say([text('done')])
  assert.deepEqual(await d.stop(), [])
}

{
  // Whitespace is not a reply.
  const d = mount()
  d.start()
  d.say([text('   \n')])
  assert.equal((await d.stop()).length, 1)
}

{
  // Thinking without an answer, and an unanswered tool call, are both empty.
  for (const content of [[], [reasoning('hmm')], [reasoning('a'), reasoning('b')], [toolCall]]) {
    const d = mount()
    d.start()
    d.say(content)
    assert.equal((await d.stop()).length, 1, `content ${JSON.stringify(content)}`)
  }
}

{
  // Text beside a tool call is still an answer to the user.
  const d = mount()
  d.start()
  d.say([text('on it'), toolCall])
  assert.deepEqual(await d.stop(), [])
}

{
  // The scope is the LAST message only: text earlier in the turn does not count.
  const d = mount()
  d.start()
  d.say([text('checking the file')])
  d.say([])
  assert.equal((await d.stop()).length, 1)
}

{
  // A cancelled turn never reaches the boundary; an aborted signal must not steer.
  const d = mount()
  d.start()
  d.say([])
  assert.deepEqual(await d.stop({ aborted: true }), [])
}

{
  // The budget is per turn: three continuations, then the turn is left to close.
  const d = mount()
  d.start()
  for (let expected = 1; expected <= 3; expected += 1) {
    d.say([])
    assert.equal((await d.stop()).length, 1, `continuation ${expected}`)
  }
  d.say([])
  assert.deepEqual(await d.stop(), [], 'a fourth empty stop is not carried on')
}

{
  // A fresh turn gets a fresh budget.
  const d = mount()
  for (let turn = 1; turn <= 2; turn += 1) {
    for (let expected = 1; expected <= 3; expected += 1) {
      d.start(turn)
      d.say([], turn)
      assert.equal((await d.stop()).length, 1, `turn ${turn} continuation ${expected}`)
    }
  }
}

{
  // `maxContinuations: 0` keeps the row mounted and inert.
  const d = mount({ maxContinuations: 0 })
  d.start()
  d.say([])
  assert.deepEqual(await d.stop(), [])
}

{
  // A tool that concluded the turn said so explicitly; that wins.
  const d = mount()
  d.start()
  d.say([toolCall])
  await d.tool({ isError: false, content: [text('{}')], value: {}, concludesTurn: true })
  assert.deepEqual(await d.stop(), [])
}

{
  // The conclusion is per turn: a later turn's empty stop steers again.
  const d = mount()
  d.start(1)
  d.say([toolCall])
  await d.tool({ isError: false, content: [text('{}')], value: {}, concludesTurn: true })
  d.start(2)
  d.say([])
  assert.equal((await d.stop()).length, 1)
}

{
  // An ordinary tool result concludes nothing.
  const d = mount()
  d.start()
  d.say([toolCall])
  await d.tool({ isError: false, content: [text('ok')], value: 'ok' })
  assert.equal((await d.stop()).length, 1)
}

{
  // A result a later policy blocked never concludes the turn, so the guard keeps
  // its say: observing before `next()` would lose the continuation here.
  const d = mount()
  d.start()
  d.say([toolCall])
  await d.tool(
    { isError: false, content: [text('{}')], value: {}, concludesTurn: true },
    { kind: 'block', feedback: [text('denied')] },
  )
  assert.equal((await d.stop()).length, 1)
}

{
  // Configured continuation text reaches the model verbatim.
  const d = mount({ message: 'Say something.' })
  d.start()
  d.say([])
  const [steered] = await d.stop()
  assert.equal(steered.content[0].text, 'Say something.')
}

for (const config of [
  { maxContinuations: -1 },
  { maxContinuations: 1.5 },
  { maxContinuations: '3' },
  { message: '' },
  { message: '   ' },
  { message: 7 },
]) {
  assert.throws(() => apply(fakeCtx(), config), TypeError, `config ${JSON.stringify(config)}`)
}

console.log('dsh-empty-turn-continuation probe: ok')