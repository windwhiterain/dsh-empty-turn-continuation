# dsh-empty-turn-continuation

Continue a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) turn that ended
without a reply, instead of closing the task on an empty message.

Some models stop a turn having produced nothing a reader can see: the final assistant message
carries only reasoning, only a tool call, or no content blocks at all. The turn closes, the task
looks finished, and the user is left with an empty bubble. This row keeps the turn open and asks
the model to actually answer.

## What it does

The row listens at `agent/turn-stopping` — the boundary across which the machine re-reads its own
inbox — and steers one continuation step whenever **the newest assistant message of the turn
carried no visible text**.

One `turn/start` starts one observation. Each `assistant/message` overwrites the "did the turn end
on a reply" fact, so the decision is about the turn's **last** message: a turn that narrated while
working and then fell silent still gets carried on, and a turn that answered is never touched.

### Three cases it leaves alone

| Case | Why |
|---|---|
| The last assistant message carried text | The user already has an answer. |
| The turn was cancelled | A cancelled turn never reaches this boundary, so a user interrupt is never converted into forced work. |
| A tool concluded the turn | `concludesTurn` is an explicit "the task is done" from a structured subagent result, a PTC, or any tool that calls `exec.concludeTurn()`. It outranks a missing body. |

## Configuration

Both fields live in [cordis.patch.yml](cordis.patch.yml).

| Field | Default | Meaning |
|---|---|---|
| `maxContinuations` | `3` | How many times ONE turn may be carried on after an empty stop. Resets at every `turn/start`. `0` keeps the row mounted and inert. |
| `message` | see the patch | The text the model reads on the continuation step. |

A wrong value fails the row's activation rather than silently disabling the guard or steering the
model with garbage: `maxContinuations` must be an integer `>= 0` and `message` a non-empty string.

## What the model sees

One `user/message` per continuation, carrying `config.message` as its single text block. It rides
the ordinary model request — the log records it, so the transcript rebuilds it — and it is
presented to the model like any other user turn.

Its source is `{ kind: 'empty-turn-continuation', form: 'notice' }`. The `notice` form is what
keeps Chat from rendering the injection as a prompt the user typed: the row appears in the
transcript as a collapsed notice, not as something the human said.

## How the conclusion is observed

`concludesTurn` never reaches the durable `tool/result` event, so the row reads it on
`tools/post-execute`, where it still exists. It survives the rest of the pipeline only for an
**accepted** call — a later `tools/post-execute` policy that blocks the call turns it into an error
and drops the marker — so the downstream decision decides, not this row's arrival order.

The other two facts come from the session log. `session/event` is published synchronously by
`session.append()` before the closing boundary runs, so the observation is current by the time the
row reads it. State lives in a `WeakMap` keyed by the live session object, so a disposed agent
takes its entry with it and no cleanup is needed.

The row imports nothing from DSH. It runs entirely on the `ctx` its fiber receives, which is why
it resolves from any profile without a dependency on the harness packages.

## Probes

The offline probe drives `apply()` against fakes and checks the whole decision table — every empty
content shape, whitespace, a real reply, the per-turn budget and its reset, an aborted boundary, the
conclusion marker, and every rejected config value:

```sh
node C:/resource/dsh-empty-turn-continuation/probe.mjs
```

The real-composition probe mounts this row into a real `AgentLoop` driven by a scripted mock
adapter, and covers what a fake cannot: that `session/event` is published before the boundary runs,
that an empty assistant message really does close a turn, that a steer taken at `agent/turn-stopping`
really does run another step of the same turn, and that a concluding tool really does end one.
Run it from a DeepSeek Harness checkout:

```sh
node --import tsx/esm C:/resource/dsh-empty-turn-continuation/probe/real-loop-probe.mjs
```

## Install

The package is a bundle: it ships a patch file that inserts one row, declared through
`dsh.bundle.patch`. Add it to a profile and install it there.

```sh
dsh plugin   # or the Web plugin manager, with the spec below
```

Use `link:C:/resource/dsh-empty-turn-continuation` as the install spec, then restart the host if the
profile manager reports `restart-required`.

## Files

| File | Role |
|---|---|
| `index.js` | The row: config validation, observation, and the continuation decision |
| `cordis.patch.yml` | The whole package: one inserted row with its config |
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the row's export |
| `probe.mjs` | Offline probe over the decision table |
| `probe/real-loop-probe.mjs` | Real `AgentLoop` probe over the loop behavior |