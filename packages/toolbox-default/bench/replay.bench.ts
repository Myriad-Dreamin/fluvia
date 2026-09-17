/**
 * The demo session, cut where the second half of the pipeline begins.
 *
 * `traces/demo.jsonl.gz` is one `pnpm demo` run: two lanes, `planner` and
 * `tuner`, building a kernel pipeline over 25 lines. Line 9 is the first line
 * typed after the first wave of results came back, so cutting there restores a
 * world that already has kernels, datasets, a failed probe and a cancellation
 * in it — the interesting state to replay against.
 *
 * Three questions are asked of it: that a plain replay reproduces the recording
 * exactly, that halving the scheduler's concurrency reorders the world without
 * changing any outcome, and that a deliberately broken line fails in the way it
 * should and is recovered from in the way it should.
 *
 * Run them with `fluvia run .`.
 */

import { defineBench, judges } from '@fluvia/core/bench/case'
import type { World } from '@fluvia/core/bench/case'

/**
 * The recovery call downstream of the edited compile reads the error handle, so
 * its note has to name the error the edit actually caused — not the one the
 * recording failed with.
 */
function recoveryNamesTheNewError(world: World): string | true {
  const note = world.handles.find((handle) => handle.name === 'note11')
  if (!note) return 'note11 was never bound'
  if (note.state !== 'ready') return `note11 is ${note.state}: recover() did not run`
  if (!note.summary?.includes('UnsupportedOptLevel')) return `note11 does not mention the new error: ${note.summary}`
  return true
}

export default [
  defineBench({
    name: 'demo · replay from line 9',
    trace: '../traces/demo.jsonl.gz',
    cut: { line: 9 },
    judge: [judges.outcomes({ same: true }), judges.order('unchanged')],
  }),

  defineBench({
    name: 'demo · concurrency 2 reorders, outcomes hold',
    trace: '../traces/demo.jsonl.gz',
    cut: { line: 9 },
    subject: { concurrency: 2 },
    // Two calls at a time is a real change: the lanes are notified in a
    // different order. It is a *safe* change exactly when the outcomes survive
    // it, which is what makes both judges load-bearing — if the scheduler ever
    // stops reordering here, `order('changed')` says so instead of quietly
    // passing.
    judge: [judges.outcomes({ same: true }), judges.order('changed')],
  }),

  defineBench({
    name: 'demo · opt 7 is rejected and recovered from',
    trace: '../traces/demo.jsonl.gz',
    cut: { line: 9 },
    // Line 10 is `@tuner compileKernel(kernel5, { opt: 3 })`; opt 7 is outside
    // the range the toolbox supports.
    subject: { edits: { 10: '@tuner compileKernel(kernel5, { opt: 7 })' } },
    // Divergence is the point here, so it is asserted rather than tolerated:
    // the compile and the recovery note that reads its error handle, and
    // nothing else.
    judge: [judges.failed('c9', 'UnsupportedOptLevel'), judges.outcomes({ diverged: 2, missing: 0 }), recoveryNamesTheNewError],
  }),
]
