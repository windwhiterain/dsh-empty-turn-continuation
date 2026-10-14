/**
 * dsh-empty-turn-continuation — carry on when a turn ended without a reply.
 *
 * A model sometimes stops a turn having produced nothing a reader can see: the
 * final assistant message carries only reasoning, only a tool call, or no
 * content blocks at all. The turn closes, the task looks finished, and the user
 * is left with an empty bubble. This row listens at `agent/turn-stopping` —
 * the boundary across which the machine re-reads its own inbox — and steers one
 * continuation step whenever the newest assistant message of the turn carried
 * no visible text.
 *
 * Three situations are deliberately left alone:
 *
 *   * a turn whose last assistant message carried text already answered the
 *     user, whatever the earlier steps of that turn looked like;
 *   * a cancelled turn never reaches this boundary, so a user interrupt is
 *     never converted into forced work;
 *   * a turn a tool concluded carries `concludesTurn` — an explicit "the task is
 *     done" from a structured subagent result, PTC, or any tool that calls
 *     `concludeTurn()` — and that outranks a missing body. The marker never
 *     reaches the durable `tool/result` event, so it is observed live on
 *     `tools/post-execute` instead.
 *
 * Every other empty stop spends one of `maxContinuations` in that turn, so a
 * model that answers nothing at all cannot loop forever.
 *
 * @module dsh-empty-turn-continuation
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name. */
export const name = 'empty-turn-continuation'

/** The text the model reads when its turn ended without a reply. */
const CONTINUATION_MESSAGE
  = 'Your previous response ended without any visible text. '
  + 'Continue the task and reply with real content for the user. '
  + 'If the task is already finished, restate the result.'

/** One-line account of the injection, shown without expanding the notice row. */
const CONTINUATION_SUMMARY = 'Continue: the previous response produced no visible text'

/** Deployment defaults for {@link resolveConfig}. */
const DEFAULT_CONFIG = {
  maxContinuations: 3,
  message: CONTINUATION_MESSAGE,
}

/**
 * Validate and complete the row configuration.
 *
 * Every supplied value is checked here: a wrong one must fail the activation
 * instead of silently disabling the guard or steering the model with garbage.
 * @param raw - the row's `config` object, or undefined.
 * @returns the complete configuration.
 * @throws {TypeError} when a supplied field has the wrong type or an unusable value.
 */
function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!Number.isSafeInteger(config.maxContinuations) || config.maxContinuations < 0) {
    throw new TypeError(`dsh-empty-turn-continuation: config.maxContinuations must be an integer >= 0, got ${JSON.stringify(config.maxContinuations)}`)
  }
  if (typeof config.message !== 'string' || config.message.trim() === '') {
    throw new TypeError(`dsh-empty-turn-continuation: config.message must be a non-empty string, got ${JSON.stringify(config.message)}`)
  }
  return config
}

/**
 * Whether one assistant message carries text a reader can see.
 *
 * Reasoning, tool calls, images, and blank text are not a reply; whitespace-only
 * text is the degenerate case worth catching too.
 * @param message - the message recorded by an `assistant/message` event.
 * @returns whether any text block holds non-whitespace characters.
 */
function carriesBodyText(message) {
  return Array.isArray(message?.content) && message.content.some(
    block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '',
  )
}

/**
 * Build the steered message the loop claims at its next step.
 *
 * The object is plain JSON on purpose: it is serialized into the
 * `agent/inbox/spliced` event, then appended as a `user/message`, so the log
 * records it and the transcript can rebuild it. The `notice` form is what keeps
 * Chat from rendering the injection as a prompt the user typed.
 * @param text - the configured continuation text.
 * @returns a user-role message carrying one text block.
 */
function continuationMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'empty-turn-continuation',
      form: 'notice',
      summary: CONTINUATION_SUMMARY,
    },
  }
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param raw - the row's `config` object, or undefined.
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)

  /**
   * What one open turn owes its reader. Keyed by the live session object, so an
   * agent that is disposed takes its entry with it.
   * @type {WeakMap<object, { hasBody: boolean, concluded: boolean, continuations: number }>}
   */
  const turns = new WeakMap()

  /** The record for one session, created on the first event that can need it. */
  function observationFor(session) {
    let state = turns.get(session)
    if (state === undefined) {
      state = { hasBody: false, concluded: false, continuations: 0 }
      turns.set(session, state)
    }
    return state
  }

  // Fold the two durable facts the decision needs. `append()` publishes
  // `session/event` synchronously before the boundary runs, so the record is
  // current by the time `agent/turn-stopping` reads it.
  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        // A new turn starts with nothing owed and its whole continuation budget.
        turns.set(session, { hasBody: false, concluded: false, continuations: 0 })
        break
      case 'assistant/message':
        // Only the newest message counts: the guard answers "did this turn end
        // on a reply", not "did this turn ever say anything".
        observationFor(session).hasBody = carriesBodyText(event.data.message)
        break
      default:
        break
    }
  })

  // `concludesTurn` never reaches the durable tool result, so the explicit
  // end-of-turn decision is read where it still exists. It survives the rest of
  // the pipeline only for an accepted call — a later `tools/post-execute` policy
  // that blocks the call turns it into an error and drops the marker — so the
  // downstream decision decides, not this row's arrival order.
  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (decision.kind === 'accept' && result.concludesTurn === true && execution.agent) {
      observationFor(execution.agent.session).concluded = true
    }
    return decision
  })

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    const state = turns.get(agent.session)
    // No record means this session never opened a turn under this row.
    if (state === undefined) return
    if (state.hasBody || state.concluded) return
    if (state.continuations >= config.maxContinuations) return
    state.continuations += 1
    agent.steer(continuationMessage(config.message))
  })
}