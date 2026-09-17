/**
 * A browser recording, cut at a model turn.
 *
 * `traces/preset-trace.json` is a pi-web run: one agent, one lane, a fluvia
 * runtime inside the page. Its first turn fired nine calls in one burst — a
 * kernel sweep with one unsupported dtype/arch pair in it — and then waited.
 * Two turns later it read what had settled and asked for the digest.
 *
 * `cut: { turn: 3 }` puts the cut there without anyone counting lines: the
 * conversation says which lines belonged to which turn, so the cut moves with
 * the recording rather than with a number someone wrote down. What is replayed
 * is the summary line, against a world restored from the burst — including the
 * compile that fails on fp8/sm80 and the two calls it skips.
 */

import { defineBench, judges } from '@fluvia/core/bench/case'

export default defineBench({
  name: 'preset · the summary turn, replayed',
  trace: '../traces/preset-trace.json',
  cut: { turn: 3 },
  judge: [
    judges.outcomes({ same: true }),
    judges.settled('summarize', 'done'),
    judges.handleReady('digest9'),
    // One failure, and it is the one the recording had: fp8 on Ampere. A second
    // failure would mean the restored world drifted.
    judges.count('failed', 1),
    judges.failed('compileKernel', 'KernelCompileError'),
  ],
})
