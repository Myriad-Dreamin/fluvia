/**
 * The default toolbox: the functions an agent finds preloaded when it opens a
 * fluvia session. They simulate a GPU-kernel / ML pipeline — prepare a kernel,
 * load a dataset, compile, quantize, benchmark, tune — plus the meta functions
 * an agent needs to react to its own failures (`explain`, `recover`) and to a
 * long-running call it may want to `cancel` (`sleep`).
 *
 * Three properties make this toolbox useful as the demo's workload:
 *
 * 1. **No real work, but real time.** Nothing touches a GPU, a disk or the
 *    network. Every implementation spends its time in `cx.sleep()`, which is
 *    abortable, so `cancel()` is instant and shutdown never hangs.
 * 2. **Deterministic.** All "random" quantities — durations, throughputs,
 *    whether a flaky probe fails — come from a PRNG seeded by a hash of the
 *    call's own arguments. The same call always behaves the same way, so the
 *    demo trace is reproducible and the perf report is comparable run to run.
 * 3. **Every outcome reachable.** Failures are thrown as {@link FluviaError}
 *    with structured `detail`, and several of them are argument-determined
 *    (an unsupported dtype/arch pair, an out-of-range opt level, an unknown
 *    dataset), so a script can provoke a specific failure on purpose rather
 *    than hoping for one.
 *
 * Return values follow the {@link TaggedValue} convention (`$type`,
 * `$summary`) so handles read well in `list`, `vars()` and notifications.
 *
 * @module @fluvia/toolbox-default
 */

import { FluviaError } from '@fluvia/core/types'
import type { CallContext, FunctionDef, TaggedValue } from '@fluvia/core/types'

/* --------------------------------------------------------------- determinism */

/**
 * Stable JSON: object keys are emitted in sorted order so that `{ a, b }` and
 * `{ b, a }` hash to the same seed. Without this, seeds would depend on the
 * order an agent happened to type its named arguments.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** FNV-1a over the stable rendering of the parts; cheap and well-spread. */
function seedOf(...parts: unknown[]): number {
  let hash = 0x811c9dc5
  const text = parts.map(stableStringify).join('|')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32: a small, fast, fully deterministic PRNG in `[0, 1)`. */
function rngFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded draw in `[min, max]`, rounded — used for durations and metrics. */
function span(rng: () => number, min: number, max: number, digits = 0): number {
  const raw = min + rng() * (max - min)
  const scale = 10 ** digits
  return Math.round(raw * scale) / scale
}

/* ------------------------------------------------------------------- helpers */

/**
 * One unit of simulated work: announce it, then spend the time abortably.
 * Progress is announced *before* the sleep so that a cancelled call still
 * leaves a note explaining how far it got.
 */
async function stage(cx: CallContext, note: string, pct: number, ms: number): Promise<void> {
  cx.progress(note, pct)
  await cx.sleep(ms)
}

/** `{ $type, $summary }` for a payload, tagged or not — used by `summarize`. */
function describe(payload: unknown): { type: string; summary: string } {
  if (payload && typeof payload === 'object') {
    const tagged = payload as TaggedValue
    if (typeof tagged.$type === 'string') {
      return { type: tagged.$type, summary: String(tagged.$summary ?? tagged.$type) }
    }
    if (Array.isArray(payload)) return { type: `Array(${payload.length})`, summary: `${payload.length} items` }
    const keys = Object.keys(payload as object)
    return { type: 'object', summary: `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }` }
  }
  return { type: typeof payload, summary: String(payload) }
}

/** Shape an error payload takes once the runtime flattens it onto a handle. */
interface ErrorPayload {
  kind: string
  message: string
  detail?: unknown
  retryable?: boolean
}

/**
 * Normalise whatever arrived on an error handle.
 *
 * The protocol says `explain(err3)` runs with "the error payload", and the
 * flattened form is `CallError`; but a toolbox should not fall over if the
 * runtime hands it an `Error`, a bare string, or a notification-shaped wrapper.
 * Returning `undefined` (rather than guessing) lets the caller fail loudly with
 * a message that tells the agent it passed the wrong channel.
 */
function asError(input: unknown): ErrorPayload | undefined {
  if (typeof input === 'string' && input.length > 0) return { kind: 'Error', message: input }
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (record.error && typeof record.error === 'object') return asError(record.error)
  const message = typeof record.message === 'string' ? record.message : undefined
  if (!message) return undefined
  const kind = typeof record.kind === 'string' ? record.kind : typeof record.name === 'string' ? record.name : 'Error'
  return {
    kind,
    message,
    detail: record.detail,
    retryable: typeof record.retryable === 'boolean' ? record.retryable : undefined,
  }
}

/** Assert that a handle argument carries the payload a function needs. */
function expectTagged(value: unknown, type: string, param: string, fn: string): TaggedValue {
  const got = describe(value)
  if (!value || typeof value !== 'object' || got.type !== type) {
    throw new FluviaError(
      'BadHandle',
      `${fn}: argument '${param}' must be a ${type} handle, got ${got.type}`,
      { param, expected: type, got: got.type, summary: got.summary },
      false,
    )
  }
  return value as TaggedValue
}

/* ------------------------------------------------------------ domain tables */

/** Architectures the simulated compiler knows, with their dtype support. */
const ARCHS: Record<string, { name: string; sms: number; dtypes: string[]; clockGHz: number }> = {
  sm70: { name: 'Volta', sms: 80, dtypes: ['f32', 'f16'], clockGHz: 1.38 },
  sm80: { name: 'Ampere', sms: 108, dtypes: ['f32', 'f16', 'bf16', 'int8'], clockGHz: 1.41 },
  sm89: { name: 'Ada', sms: 128, dtypes: ['f32', 'f16', 'bf16', 'int8', 'fp8'], clockGHz: 2.52 },
  sm90: { name: 'Hopper', sms: 132, dtypes: ['f32', 'f16', 'bf16', 'int8', 'fp8'], clockGHz: 1.98 },
}

/** Bytes per element, also used to scale simulated memory traffic. */
const DTYPE_BYTES: Record<string, number> = { f32: 4, f16: 2, bf16: 2, fp8: 1, int8: 1 }

/** The datasets `loadDataset` can serve; anything else is a hard failure. */
const CATALOGUE: Record<string, { rows: number; bytesPerRow: number; modality: string }> = {
  'imagenet-mini': { rows: 128_000, bytesPerRow: 3_072, modality: 'vision' },
  'wikitext-103': { rows: 1_800_000, bytesPerRow: 512, modality: 'text' },
  'openwebmath': { rows: 640_000, bytesPerRow: 1_024, modality: 'text' },
  'librispeech-clean': { rows: 28_500, bytesPerRow: 16_384, modality: 'audio' },
  'synthetic-gemm': { rows: 4_096, bytesPerRow: 65_536, modality: 'synthetic' },
}

/** Remediation knowledge `explain` and `recover` share, keyed by error kind. */
const PLAYBOOK: Record<string, { cause: string; fix: string; call: string }> = {
  KernelCompileError: {
    cause: 'the kernel dtype is not implemented by the target architecture',
    fix: 'lower the dtype to one the arch supports, or retarget a newer arch',
    call: 'prepareKernel({ size, dtype: "f16", arch })',
  },
  UnsupportedOptLevel: {
    cause: 'the requested optimisation level is outside the compiler range 0..3',
    fix: 'recompile at opt 3',
    call: 'compileKernel(kernel, { opt: 3 })',
  },
  RegisterSpill: {
    cause: 'the tile schedule needs more registers than the SM provides, so locals spilled to local memory',
    fix: 'halve the tile size or drop one optimisation level so the schedule fits',
    call: 'compileKernel(kernel, { opt: 2 })',
  },
  DatasetNotFound: {
    cause: 'the dataset name is not in the local catalogue',
    fix: 'pick a catalogued name',
    call: 'loadDataset({ name: "wikitext-103", shards: 4 })',
  },
  ShardChecksumMismatch: {
    cause: 'a shard was truncated in the local cache',
    fix: 're-read the shard with the cache disabled',
    call: 'loadDataset({ name, shards, cache: false })',
  },
  ProbeFailed: {
    cause: 'the link degraded below its error threshold during the probe window',
    fix: 'reprobe with more trials once the link settles',
    call: 'flakyProbe({ target, trials: 5 })',
  },
  KernelNotCompiled: {
    cause: 'benchmark was handed a kernel that is still source, not a compiled module',
    fix: 'compile the kernel first and benchmark the compiled handle',
    call: 'compileKernel(kernel, { opt: 3 })',
  },
  BadHandle: {
    cause: 'the handle passed carries a different payload than the function expects',
    fix: 'check vars() and pass the handle whose type matches the parameter',
    call: 'vars()',
  },
  BadArgument: {
    cause: 'an argument is outside the range the function accepts',
    fix: 'correct the argument and resubmit',
    call: 'help()',
  },
}

/** Fallback advice when a failure kind is not in the playbook. */
const GENERIC_ADVICE = {
  cause: 'the implementation reported a failure it does not classify further',
  fix: 'inspect the failing call for progress notes, then resubmit with adjusted arguments',
  call: 'inspect(call)',
}

/* ----------------------------------------------------------------- functions */

/**
 * Build a kernel *source* spec: tile schedule, register budget, shared memory.
 * Cheap on purpose — it is the root of the demo's dependency chains, so it
 * should settle quickly and unblock the graph.
 */
const prepareKernel: FunctionDef = {
  name: 'prepareKernel',
  out: 'kernel',
  summary: 'Emit a kernel source spec (tile schedule, register budget) for a matmul of the given size.',
  params: '({ size = 4096, dtype = "f32", arch = "sm90", layout = "row-major" })',
  positional: ['size', 'dtype'],
  async run(args, cx) {
    const size = Number(args?.size ?? 4096)
    const dtype = String(args?.dtype ?? 'f32')
    const arch = String(args?.arch ?? 'sm90')
    const layout = String(args?.layout ?? 'row-major')

    // Argument validation is deliberately strict and deterministic: a script
    // can provoke this failure exactly, without depending on the PRNG.
    if (!Number.isFinite(size) || size < 64 || size > 65_536 || (size & (size - 1)) !== 0) {
      throw new FluviaError(
        'BadArgument',
        `prepareKernel: size must be a power of two in 64..65536, got ${args?.size}`,
        { param: 'size', got: args?.size },
        false,
      )
    }
    if (!DTYPE_BYTES[dtype]) {
      throw new FluviaError('BadArgument', `prepareKernel: unknown dtype ${dtype}`, { known: Object.keys(DTYPE_BYTES) }, false)
    }
    if (!ARCHS[arch]) {
      throw new FluviaError('BadArgument', `prepareKernel: unknown arch ${arch}`, { known: Object.keys(ARCHS) }, false)
    }

    const rng = rngFrom(seedOf('prepareKernel', { size, dtype, arch, layout }))
    const tile = [128, 128, 64, 256][Math.floor(rng() * 4)]!
    const budget = size / 1024

    await stage(cx, `resolving ${arch} (${ARCHS[arch]!.name}) descriptor`, 10, span(rng, 40, 90))
    await stage(cx, `planning ${tile}x${tile} tiles for ${size}x${size}`, 45, span(rng, 90, 220) + budget * 12)
    await stage(cx, 'allocating shared memory and registers', 80, span(rng, 60, 160))

    const registers = 32 + Math.floor(rng() * 96)
    const sharedBytes = tile * tile * DTYPE_BYTES[dtype]! * 2
    const sourceLines = 240 + Math.floor(rng() * 600)
    cx.progress(`source ready: ${sourceLines} lines`, 100)

    return {
      $type: 'Kernel',
      $summary: `${size}x${size} ${dtype} matmul · ${tile}x${tile} tiles · source (${sourceLines} lines)`,
      stage: 'source',
      name: `gemm_${size}_${dtype}`,
      size,
      dtype,
      arch,
      layout,
      tile,
      registers,
      sharedBytes,
      sourceLines,
    } satisfies TaggedValue
  },
}

/**
 * Stream a dataset in from the local catalogue. Slower than `prepareKernel`
 * and scaled by shard count, so a dataset load overlaps several other calls —
 * which is what makes the concurrency profile in the perf report interesting.
 */
const loadDataset: FunctionDef = {
  name: 'loadDataset',
  out: 'dataset',
  summary: 'Load a catalogued dataset split, shard by shard, into the local cache.',
  params: '({ name, shards = 4, split = "train", cache = true })',
  positional: ['name', 'shards'],
  async run(args, cx) {
    const name = String(args?.name ?? '')
    const shards = Math.max(1, Math.min(32, Math.trunc(Number(args?.shards ?? 4))))
    const split = String(args?.split ?? 'train')
    const cache = args?.cache !== false

    const entry = CATALOGUE[name]
    if (!entry) {
      throw new FluviaError(
        'DatasetNotFound',
        `loadDataset: '${name}' is not in the local catalogue`,
        { requested: name, known: Object.keys(CATALOGUE) },
        false,
      )
    }

    const rng = rngFrom(seedOf('loadDataset', { name, shards, split, cache }))
    const rows = Math.round(entry.rows * (split === 'train' ? 1 : 0.08))
    const bytes = rows * entry.bytesPerRow

    for (let i = 0; i < shards; i++) {
      const pct = Math.round(((i + 1) / shards) * 95)
      await stage(cx, `shard ${i + 1}/${shards} (${split})`, pct, span(rng, 70, 240) + (cache ? 0 : 60))
      // A truncated cache entry is the one transient failure here: retryable,
      // and reachable by a script through the shard count in the seed.
      if (cache && rng() < 0.03) {
        throw new FluviaError(
          'ShardChecksumMismatch',
          `loadDataset: shard ${i + 1}/${shards} of ${name} failed its checksum`,
          { shard: i + 1, shards, name },
          true,
        )
      }
    }

    const throughput = span(rng, 380, 1_450, 1)
    cx.progress(`${(bytes / 1e9).toFixed(2)} GB resident`, 100)

    return {
      $type: 'Dataset',
      $summary: `${name}/${split} · ${shards} shards · ${(rows / 1e3).toFixed(0)}k rows · ${(bytes / 1e9).toFixed(2)} GB`,
      name,
      split,
      modality: entry.modality,
      shards,
      rows,
      bytes,
      cached: cache,
      readMBps: throughput,
    } satisfies TaggedValue
  },
}

/**
 * Compile a kernel source spec into a loadable module. The slowest step in the
 * pipeline, and the one with the most interesting failure modes: an unsupported
 * dtype/arch pair (deterministic — this is the failure the demo provokes), an
 * out-of-range opt level, and a seeded register spill at opt 3.
 */
const compileKernel: FunctionDef = {
  name: 'compileKernel',
  out: 'kernel',
  summary: 'Compile a kernel source handle to a loadable module at the given optimisation level.',
  params: '(kernel, { opt = 2, fastMath = false })',
  positional: ['kernel', 'opt'],
  async run(args, cx) {
    const kernel = expectTagged(args?.kernel, 'Kernel', 'kernel', 'compileKernel')
    const opt = Math.trunc(Number(args?.opt ?? 2))
    const fastMath = args?.fastMath === true
    const size = Number(kernel.size ?? 4096)
    const dtype = String(kernel.dtype ?? 'f32')
    const arch = String(kernel.arch ?? 'sm90')
    const tile = Number(kernel.tile ?? 128)

    if (!Number.isFinite(opt) || opt < 0 || opt > 3) {
      throw new FluviaError(
        'UnsupportedOptLevel',
        `compileKernel: opt ${args?.opt} is outside the supported range 0..3`,
        { opt: args?.opt, supported: [0, 1, 2, 3] },
        false,
      )
    }

    const rng = rngFrom(seedOf('compileKernel', { size, dtype, arch, tile, opt, fastMath }))
    await stage(cx, `parsing ${kernel.name} (${kernel.sourceLines ?? '?'} lines)`, 12, span(rng, 80, 180))

    const target = ARCHS[arch]
    if (target && !target.dtypes.includes(dtype)) {
      // Deterministic, argument-determined failure: the demo builds its
      // "dependency fails, dependents are skipped" branch on exactly this.
      throw new FluviaError(
        'KernelCompileError',
        `compileKernel: ${dtype} tensor cores are not implemented on ${arch} (${target.name})`,
        { dtype, arch, supported: target.dtypes, pass: 'lower-tensorop' },
        false,
      )
    }

    await stage(cx, `lowering to PTX (opt ${opt}${fastMath ? ', fast-math' : ''})`, 45, span(rng, 260, 900) + opt * 120)

    const registers = Number(kernel.registers ?? 64) + opt * 12
    if (opt === 3 && registers > 100 && rng() < 0.25) {
      throw new FluviaError(
        'RegisterSpill',
        `compileKernel: schedule needs ${registers} registers/thread, ${registers - 96} spilled to local memory`,
        { registers, limit: 96, opt, tile },
        true,
      )
    }

    await stage(cx, 'assembling cubin and running peephole passes', 85, span(rng, 180, 560))

    const ptxBytes = Math.round(Number(kernel.sourceLines ?? 400) * span(rng, 26, 48))
    const occupancy = Math.min(1, span(rng, 0.42, 0.94, 3) + opt * 0.02)
    cx.progress(`cubin ${(ptxBytes / 1024).toFixed(1)} KiB · occupancy ${(occupancy * 100).toFixed(0)}%`, 100)

    return {
      $type: 'Kernel',
      $summary: `${kernel.name} compiled · opt ${opt} · ${(ptxBytes / 1024).toFixed(1)} KiB cubin · ${(occupancy * 100).toFixed(0)}% occupancy`,
      stage: 'compiled',
      name: kernel.name,
      size,
      dtype,
      arch,
      tile,
      opt,
      fastMath,
      registers,
      ptxBytes,
      occupancy,
    } satisfies TaggedValue
  },
}

/**
 * Post-training quantisation: takes any kernel handle and returns a *source*
 * kernel in a narrower dtype, so the natural next step is another
 * `compileKernel`. That is what gives the demo graph a second, deeper branch
 * off a single root.
 */
const quantize: FunctionDef = {
  name: 'quantize',
  out: 'kernel',
  summary: 'Quantise a kernel to a narrower dtype, returning a source spec to recompile.',
  params: '(kernel, { bits = 8, scheme = "per-channel" })',
  positional: ['kernel', 'bits'],
  async run(args, cx) {
    const kernel = expectTagged(args?.kernel, 'Kernel', 'kernel', 'quantize')
    const bits = Math.trunc(Number(args?.bits ?? 8))
    const scheme = String(args?.scheme ?? 'per-channel')
    if (bits !== 8 && bits !== 16) {
      throw new FluviaError('BadArgument', `quantize: bits must be 8 or 16, got ${args?.bits}`, { bits: args?.bits }, false)
    }

    const dtype = bits === 8 ? 'int8' : 'f16'
    const rng = rngFrom(seedOf('quantize', { name: kernel.name, bits, scheme, arch: kernel.arch }))

    await stage(cx, 'collecting activation ranges', 25, span(rng, 120, 340))
    await stage(cx, `fitting ${scheme} scales`, 60, span(rng, 200, 620))
    await stage(cx, 'rewriting tensor ops', 90, span(rng, 100, 280))

    const errorPct = span(rng, 0.08, 1.4, 2)
    return {
      $type: 'Kernel',
      $summary: `${kernel.name} → ${dtype} (${scheme}) · ${errorPct}% max abs error · source`,
      stage: 'source',
      name: `${kernel.name}_q${bits}`,
      size: kernel.size,
      dtype,
      arch: kernel.arch,
      layout: kernel.layout,
      tile: kernel.tile,
      registers: Math.round(Number(kernel.registers ?? 64) * 0.75),
      sourceLines: Math.round(Number(kernel.sourceLines ?? 400) * 1.15),
      quantized: { bits, scheme, errorPct },
    } satisfies TaggedValue
  },
}

/**
 * Time a compiled kernel over a dataset. Two handle dependencies, which is
 * what makes it the join node of the demo graph — and it refuses a kernel that
 * was never compiled, so a mis-wired graph fails with a message that says so.
 */
const benchmark: FunctionDef = {
  name: 'benchmark',
  out: 'report',
  summary: 'Time a compiled kernel over a dataset and report latency, throughput and percentiles.',
  params: '(kernel, dataset, { iters = 100, warmup = 10 })',
  positional: ['kernel', 'dataset', 'iters'],
  async run(args, cx) {
    const kernel = expectTagged(args?.kernel, 'Kernel', 'kernel', 'benchmark')
    const dataset = expectTagged(args?.dataset, 'Dataset', 'dataset', 'benchmark')
    const iters = Math.max(1, Math.min(2_000, Math.trunc(Number(args?.iters ?? 100))))
    const warmup = Math.max(0, Math.min(200, Math.trunc(Number(args?.warmup ?? 10))))

    if (kernel.stage !== 'compiled') {
      throw new FluviaError(
        'KernelNotCompiled',
        `benchmark: ${kernel.name} is still source; compile it before benchmarking`,
        { kernel: kernel.name, stage: kernel.stage },
        false,
      )
    }

    const rng = rngFrom(seedOf('benchmark', { kernel: kernel.$summary, dataset: dataset.$summary, iters, warmup }))
    const size = Number(kernel.size ?? 4096)
    const arch = ARCHS[String(kernel.arch ?? 'sm90')] ?? ARCHS.sm90!
    const flops = 2 * size ** 3

    await stage(cx, `warmup ${warmup} iters`, 10, span(rng, 60, 200) + warmup * 2)

    // Four measured windows so the trace has progress mid-run for a call that
    // takes a couple of seconds; each window contributes samples.
    const samples: number[] = []
    const base = (flops / (arch.sms * arch.clockGHz * 1e12)) * 1e3 * (DTYPE_BYTES[String(kernel.dtype)] ?? 4)
    for (let window = 0; window < 4; window++) {
      await stage(cx, `measuring ${Math.round((iters / 4) * (window + 1))}/${iters} iters`, 10 + (window + 1) * 20, span(rng, 120, 420) + iters * 0.9)
      samples.push(span(rng, base * 0.9, base * 1.35, 3))
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const msPerIter = span(rng, sorted[0]!, sorted[sorted.length - 1]!, 3)
    const gflops = Math.round(flops / (msPerIter / 1e3) / 1e9)
    const p50 = sorted[Math.floor(sorted.length / 2)]!
    const p95 = sorted[sorted.length - 1]!
    cx.progress(`${msPerIter} ms/iter · ${gflops} GFLOP/s`, 100)

    return {
      $type: 'Report',
      $summary: `${kernel.name} on ${dataset.name}: ${msPerIter} ms/iter · ${gflops} GFLOP/s · occ ${(Number(kernel.occupancy ?? 0) * 100).toFixed(0)}%`,
      kernel: kernel.name,
      dataset: dataset.name,
      dtype: kernel.dtype,
      arch: kernel.arch,
      tile: kernel.tile,
      opt: kernel.opt,
      iters,
      warmup,
      msPerIter,
      gflops,
      p50,
      p95,
      occupancy: kernel.occupancy,
      samples,
    } satisfies TaggedValue
  },
}

/**
 * Search a tile/opt space against a benchmark report. Its cost scales with the
 * trial budget, which makes it an easy knob for keeping the scheduler busy
 * while later, cheaper calls queue behind it.
 */
const tune: FunctionDef = {
  name: 'tune',
  out: 'plan',
  summary: 'Search tile and optimisation settings against a benchmark report; returns a retune plan.',
  params: '(report, { budget = 8, target = "latency" })',
  positional: ['report', 'budget'],
  async run(args, cx) {
    const report = expectTagged(args?.report, 'Report', 'report', 'tune')
    const budget = Math.max(1, Math.min(64, Math.trunc(Number(args?.budget ?? 8))))
    const target = String(args?.target ?? 'latency')
    if (target !== 'latency' && target !== 'throughput' && target !== 'occupancy') {
      throw new FluviaError(
        'BadArgument',
        `tune: target must be latency|throughput|occupancy, got ${target}`,
        { target, supported: ['latency', 'throughput', 'occupancy'] },
        false,
      )
    }

    const rng = rngFrom(seedOf('tune', { report: report.$summary, budget, target }))
    const baseline = Number(report.msPerIter ?? 1)
    let best = { tile: Number(report.tile ?? 128), opt: Number(report.opt ?? 2), msPerIter: baseline }
    const trials: { tile: number; opt: number; msPerIter: number }[] = []

    for (let i = 0; i < budget; i++) {
      const tile = [64, 128, 256][Math.floor(rng() * 3)]!
      const opt = Math.floor(rng() * 4)
      await cx.sleep(span(rng, 45, 190))
      const msPerIter = span(rng, baseline * 0.62, baseline * 1.25, 3)
      trials.push({ tile, opt, msPerIter })
      if (msPerIter < best.msPerIter) best = { tile, opt, msPerIter }
      // Progress every other trial keeps the note stream readable rather than
      // one line per trial at budget 32.
      if (i % 2 === 1 || i === budget - 1) {
        cx.progress(`trial ${i + 1}/${budget} · best ${best.msPerIter} ms (tile ${best.tile}, opt ${best.opt})`, Math.round(((i + 1) / budget) * 100))
      }
    }

    const speedup = Math.round((baseline / best.msPerIter) * 100) / 100
    return {
      $type: 'Plan',
      $summary: `retune ${report.kernel}: tile ${best.tile}, opt ${best.opt} → ${best.msPerIter} ms/iter (${speedup}x)`,
      target,
      kernel: report.kernel,
      baselineMsPerIter: baseline,
      best,
      speedup,
      trials,
      apply: `compileKernel(kernel, { opt: ${best.opt} })`,
    } satisfies TaggedValue
  },
}

/**
 * A hardware probe that fails a controllable fraction of the time. The draw is
 * seeded by the arguments, so `failRate` is a knob a script can turn to *decide*
 * the outcome rather than gamble on it: 0 never fails, 1 always fails.
 */
const flakyProbe: FunctionDef = {
  name: 'flakyProbe',
  out: 'probe',
  summary: 'Probe an interconnect a few times; fails (retryably) when a trial trips the error threshold.',
  params: '({ target = "pcie-link", failRate = 0.35, trials = 3 })',
  positional: ['target', 'failRate'],
  async run(args, cx) {
    const target = String(args?.target ?? 'pcie-link')
    const failRate = Math.max(0, Math.min(1, Number(args?.failRate ?? 0.35)))
    const trials = Math.max(1, Math.min(16, Math.trunc(Number(args?.trials ?? 3))))
    const rng = rngFrom(seedOf('flakyProbe', { target, failRate, trials }))
    const samples: number[] = []

    for (let i = 0; i < trials; i++) {
      await stage(cx, `trial ${i + 1}/${trials} on ${target}`, Math.round(((i + 1) / trials) * 90), span(rng, 90, 280))
      const draw = rng()
      const gbps = span(rng, 11.2, 27.9, 1)
      samples.push(gbps)
      if (draw < failRate) {
        throw new FluviaError(
          'ProbeFailed',
          `flakyProbe: ${target} tripped the error threshold on trial ${i + 1}/${trials}`,
          { target, trial: i + 1, trials, failRate, errorRate: Math.round(draw * 1e4) / 1e4, samples },
          true,
        )
      }
    }

    const mean = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10
    cx.progress(`${trials}/${trials} clean · ${mean} GB/s`, 100)
    return {
      $type: 'Probe',
      $summary: `${target} ok · ${trials}/${trials} clean · ${mean} GB/s`,
      target,
      trials,
      failRate,
      meanGBps: mean,
      samples,
    } satisfies TaggedValue
  },
}

/**
 * Diagnose a failure. Meant to be called on an **error** handle — `explain(err3)`
 * — which only runs when the producing call actually failed; if the producer
 * succeeded the runtime skips this call with `upstream_ok`, and the agent has
 * paid nothing for asking.
 */
const explain: FunctionDef = {
  name: 'explain',
  out: 'note',
  summary: 'Diagnose an error handle: likely cause, evidence from the detail payload, and what to try next.',
  params: '(error, { depth = "short" })',
  positional: ['error', 'depth'],
  async run(args, cx) {
    const error = asError(args?.error)
    if (!error) {
      throw new FluviaError(
        'BadHandle',
        'explain: expects an error handle (e.g. explain(err3)), not a value handle',
        { got: describe(args?.error) },
        false,
      )
    }
    const depth = String(args?.depth ?? 'short')
    const rng = rngFrom(seedOf('explain', { kind: error.kind, message: error.message, depth }))
    const advice = PLAYBOOK[error.kind] ?? GENERIC_ADVICE

    await stage(cx, `classifying ${error.kind}`, 30, span(rng, 90, 260))
    await stage(cx, 'correlating with the failure detail', 70, span(rng, 120, 380) + (depth === 'deep' ? 400 : 0))

    const evidence = error.detail && typeof error.detail === 'object'
      ? Object.entries(error.detail as Record<string, unknown>)
          .slice(0, 6)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.slice(0, 4).join(', ')}]` : String(v)}`)
      : []
    cx.progress('note written', 100)

    return {
      $type: 'Note',
      $summary: `why ${error.kind}: ${advice.cause}`,
      topic: 'diagnosis',
      kind: error.kind,
      message: error.message,
      cause: advice.cause,
      evidence,
      retryable: error.retryable ?? false,
      suggestion: advice.fix,
      suggestedCall: advice.call,
      depth,
    } satisfies TaggedValue
  },
}

/**
 * Turn a failure into a remediation plan. Same error-channel contract as
 * {@link explain}: it exists to run *because* something failed, so the demo's
 * recovery branch runs concurrently with the branches that succeeded.
 */
const recover: FunctionDef = {
  name: 'recover',
  out: 'note',
  summary: 'Plan a remediation for an error handle and validate it against the failure detail.',
  params: '(error, { strategy = "auto" })',
  positional: ['error', 'strategy'],
  async run(args, cx) {
    const error = asError(args?.error)
    if (!error) {
      throw new FluviaError(
        'BadHandle',
        'recover: expects an error handle (e.g. recover(err3)), not a value handle',
        { got: describe(args?.error) },
        false,
      )
    }
    const strategy = String(args?.strategy ?? 'auto')
    const rng = rngFrom(seedOf('recover', { kind: error.kind, message: error.message, strategy }))
    const advice = PLAYBOOK[error.kind] ?? GENERIC_ADVICE

    const steps: string[] = []
    await stage(cx, `selecting strategy for ${error.kind}`, 20, span(rng, 80, 220))
    steps.push(`classify: ${error.kind} (${error.retryable ? 'retryable' : 'not retryable'})`)

    // A retryable failure is simply retried; a permanent one needs the argument
    // change from the playbook. Both paths end in a concrete call to submit.
    if (error.retryable && strategy !== 'rewrite') {
      await stage(cx, 'backing off before retry', 55, span(rng, 200, 700))
      steps.push('backoff: 1 attempt after jittered delay')
    } else {
      await stage(cx, 'rewriting the failing arguments', 55, span(rng, 240, 820))
      steps.push(`rewrite: ${advice.fix}`)
    }
    await stage(cx, 'validating the proposed call', 85, span(rng, 120, 320))
    steps.push(`submit: ${advice.call}`)

    const confidence = Math.round((error.retryable ? span(rng, 0.62, 0.93, 2) : span(rng, 0.45, 0.81, 2)) * 100) / 100
    cx.progress(`plan ready · confidence ${(confidence * 100).toFixed(0)}%`, 100)

    return {
      $type: 'Note',
      $summary: `recovery for ${error.kind}: ${advice.fix} (confidence ${(confidence * 100).toFixed(0)}%)`,
      topic: 'recovery',
      kind: error.kind,
      strategy: error.retryable && strategy !== 'rewrite' ? 'retry' : 'rewrite',
      steps,
      suggestedCall: advice.call,
      confidence,
    } satisfies TaggedValue
  },
}

/**
 * Do nothing, slowly, in abortable slices. This is the call the demo cancels:
 * it proves that `cancel(cN)` interrupts work in flight rather than waiting for
 * it, and that a cancelled call still carries the progress it made.
 */
const sleep: FunctionDef = {
  name: 'sleep',
  out: 'tick',
  summary: 'Idle for a while in abortable slices — a long call to cancel(), or a deliberate pause.',
  params: '({ ms = 1000, label = "idle" })',
  positional: ['ms', 'label'],
  async run(args, cx) {
    const ms = Math.max(1, Math.min(600_000, Math.trunc(Number(args?.ms ?? 1_000))))
    const label = String(args?.label ?? 'idle')
    // Slicing is what makes progress notes possible; cancellation itself is
    // handled by cx.sleep rejecting on the signal, in whatever slice is current.
    const slice = Math.max(50, Math.min(250, Math.round(ms / 8)))
    const slices = Math.ceil(ms / slice)
    const started = Date.now()

    for (let i = 0; i < slices; i++) {
      const take = Math.min(slice, ms - i * slice)
      await cx.sleep(take)
      const pct = Math.round(((i + 1) / slices) * 100)
      if (i % 2 === 1 || i === slices - 1) cx.progress(`${label}: ${(i + 1) * slice}/${ms} ms`, pct)
    }

    const elapsed = Date.now() - started
    return {
      $type: 'Tick',
      $summary: `slept ${ms} ms as '${label}' (${slices} slices, ${elapsed} ms wall)`,
      label,
      ms,
      slices,
      elapsedMs: elapsed,
    } satisfies TaggedValue
  },
}

/** Option keys `summarize` must not mistake for a payload handle. */
const SUMMARIZE_OPTIONS = new Set(['title', 'items', 'format'])

/**
 * Fold several handles into one digest. It is the demo's sink node: it takes
 * whatever the session produced — kernels, reports, plans, notes — and renders
 * a single handle an agent can read in one line.
 *
 * Argument handling is deliberately permissive. Positional handles arrive under
 * the declared names, `{ items: [...] }` works too, and any other object-valued
 * argument is treated as a payload, so the function keeps working whichever way
 * an agent writes the call.
 */
const summarize: FunctionDef = {
  name: 'summarize',
  out: 'digest',
  summary: 'Fold several handles (kernels, reports, plans, notes) into one readable digest.',
  params: '(a, b, c, …, { title = "session digest" }) — or summarize({ items: [...] })',
  positional: ['a', 'b', 'c', 'd', 'e', 'f'],
  async run(args, cx) {
    const payloads: unknown[] = []
    const seen = new Set<unknown>()
    const push = (value: unknown) => {
      if (value === undefined || value === null || seen.has(value)) return
      seen.add(value)
      payloads.push(value)
    }
    if (Array.isArray(args?.items)) for (const item of args.items) push(item)
    for (const name of summarize.positional!) push(args?.[name])
    for (const [key, value] of Object.entries(args ?? {})) {
      if (SUMMARIZE_OPTIONS.has(key) || summarize.positional!.includes(key)) continue
      if (value && typeof value === 'object') push(value)
    }
    if (payloads.length === 0) {
      throw new FluviaError(
        'BadArgument',
        'summarize: needs at least one handle to fold, e.g. summarize(report2, plan5)',
        { got: Object.keys(args ?? {}) },
        false,
      )
    }

    const title = String(args?.title ?? 'session digest')
    const rng = rngFrom(seedOf('summarize', { title, items: payloads.map((p) => describe(p).summary) }))

    await stage(cx, `collecting ${payloads.length} handles`, 35, span(rng, 60, 180))
    const items = payloads.map(describe)
    await stage(cx, 'rendering digest', 80, span(rng, 90, 260) + payloads.length * 25)

    const byType = new Map<string, number>()
    for (const item of items) byType.set(item.type, (byType.get(item.type) ?? 0) + 1)
    const mix = [...byType].map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''}`).join(', ')
    cx.progress('digest ready', 100)

    return {
      $type: 'Digest',
      $summary: `${title}: ${items.length} handles (${mix})`,
      title,
      count: items.length,
      mix: Object.fromEntries(byType),
      items,
      lines: items.map((item, i) => `${i + 1}. [${item.type}] ${item.summary}`),
    } satisfies TaggedValue
  },
}

/**
 * The preloaded toolbox, in the order `help()` and `defs()` should list it:
 * pipeline first (roots, then transforms, then measurement), then the meta
 * functions an agent reaches for when something goes wrong.
 */
export const toolbox: FunctionDef[] = [
  prepareKernel,
  loadDataset,
  compileKernel,
  quantize,
  benchmark,
  tune,
  flakyProbe,
  explain,
  recover,
  sleep,
  summarize,
]

export default toolbox
