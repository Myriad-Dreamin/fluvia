/**
 * A takeover with no model in it.
 *
 * `subject: { takeover }` hands one lane to a live driver at the cut while the
 * other lanes keep replaying their recording around it. Usually the driver is
 * an agent; here it is a scripted stand-in that does what the `planner` lane
 * did — submit a compile, wait to be told it finished, fan out from its handle,
 * and compile the quantised kernel once that lands.
 *
 * Which makes this the case that proves the takeover machinery itself: the
 * stand-in reads only what an agent reads (the runtime's answer to each line
 * and the notifications a wake delivers), it learns its handle names from the
 * answers rather than from the recording, and the `tuner` lane — whose recorded
 * lines consume the planner's handles — has to keep working against whatever
 * the stand-in actually produced. It costs nothing to run, so it can guard the
 * agent path in a tree with no API key in it.
 */

import { defineBench, judges } from '@fluvia/core/bench/case'
import type { TakeoverContext, World } from '@fluvia/core/bench/case'

/** What the runtime answered a submitted line with: `→ c8 fn ⇒ value8, err8`. */
function bind(answer: string): { call: string; value: string } {
  const found = /→\s*(c\d+)\s+\S+\s*⇒\s*(\w+)/.exec(answer)
  if (!found) throw new Error(`the line was refused: ${answer}`)
  return { call: found[1]!, value: found[2]! }
}

/** Let the world move until this call is notified, or until nothing is left. */
async function waitFor(ctx: TakeoverContext, call: string): Promise<void> {
  for (;;) {
    const wake = await ctx.wake()
    if (wake.notifications.some((text) => text.startsWith(`${call} `))) return
    if (wake.idle) return
  }
}

async function scriptedPlanner(ctx: TakeoverContext): Promise<void> {
  const compiled = bind(ctx.submit('compileKernel(kernel0, { opt: 3, fastMath: true })'))
  await waitFor(ctx, compiled.call)
  ctx.submit(`benchmark(${compiled.value}, dataset1, { iters: 200, warmup: 20 })`)
  const quantized = bind(ctx.submit(`quantize(${compiled.value}, { bits: 8 })`))
  ctx.submit('loadDataset({ name: "openwebmath", shards: 3 })')
  await waitFor(ctx, quantized.call)
  ctx.submit(`compileKernel(${quantized.value}, { opt: 2 })`)
}

/** The lane did five useful things and wasted nothing. */
function theLaneDidItsWork(world: World): string | true {
  const score = world.report.agent
  if (!score) return 'the report carries no agent score'
  const bad = score.calls.filter((call) => call.outcome !== 'done')
  if (bad.length) return `${bad.map((call) => `${call.id} ${call.fn} ${call.outcome}`).join(', ')}`
  if (score.errors.length) return `the runtime refused ${score.errors.length} line(s): ${score.errors[0]}`
  if (score.calls.length !== 5) return `submitted ${score.calls.length} calls, expected 5`
  return true
}

export default defineBench({
  name: 'demo · planner taken over by a scripted stand-in',
  trace: '../../toolbox-default/traces/demo.jsonl.gz',
  cut: { line: 9 },
  subject: { takeover: { lane: 'planner', driver: scriptedPlanner } },
  goal: 'Compile the prepared kernel, measure it, quantise it, and compile the quantised kernel.',
  // The tuner lane consumes the stand-in's handles, so `outcomes` is the real
  // assertion here: if the takeover bound the wrong names, the tuner's recorded
  // lines would fail or skip instead of settling as recorded.
  judge: [judges.outcomes({ same: true }), theLaneDidItsWork],
})
