/**
 * Example prompts for the live runtime and example tasks for slices. They are
 * written against the default toolbox, so each one exercises something fluvia
 * is for: parallel roots, a dependency chain, a failure that feeds a recovery
 * branch, and a join.
 *
 * @module pi-web-fluvia/examples
 */

export interface ExamplePrompt {
  title: string
  text: string
}

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  {
    title: 'Two kernels, one fails',
    text:
      'Prepare a 4096 f32 kernel for sm90 and a 16384 fp8 kernel for sm80, and load the imagenet-mini dataset with 6 shards. Compile both kernels at opt 3 and benchmark whichever compiles on imagenet-mini. For whichever fails, get a recovery note. When everything has settled, summarise the results as "kernel sweep".',
  },
  {
    title: 'Quantised variant',
    text:
      'Build an int8 variant of a 4096 f32 sm90 kernel: prepare it, compile at opt 3, quantize the compiled kernel to 8 bits and recompile that at opt 2. Load wikitext-103 (4 shards), benchmark both compiled kernels on it, then tune the faster one for latency with a budget of 6.',
  },
  {
    title: 'Interconnect health',
    text:
      'Probe pcie-link with failRate 1, and nvlink and hbm3 with failRate 0, 3 trials each. Explain every probe that fails, and summarise the interconnect health as "interconnects" once the diagnoses are in.',
  },
]

/** Tasks for the demo trace's lanes when cut at line 9. */
export const EXAMPLE_TASKS: Record<string, string> = {
  planner:
    'Finish the main GPU pipeline from where the session stands: a compiled f32 kernel from kernel0 (opt 3, fastMath) benchmarked on imagenet-mini (200 iters, 20 warmup); an int8 quantised variant of that compiled kernel, recompiled at opt 2 so tuner can benchmark it; the openwebmath dataset (3 shards) loaded for that benchmark; and, once tuner has produced a latency plan from your benchmark report, one summary titled "gpu pipeline" that also folds in tuner\'s recovery note and the probe diagnosis.',
  tuner:
    'Take the fp8 kernel on sm80 as far as it goes: compile it at opt 3, benchmark it on wikitext-103 and tune it if that works, and get a recovery note if it does not. Probe the nvlink and hbm3 interconnects. Then turn planner\'s imagenet-mini benchmark report into a latency tuning plan, benchmark planner\'s recompiled int8 kernel on the openwebmath dataset, and summarise that branch as "quantised branch".',
}
