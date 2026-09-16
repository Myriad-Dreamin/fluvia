/**
 * The environment is the agent-visible namespace: variable name → handle, plus
 * the roster of agents that have spoken this session.
 *
 * Bindings are **shared across agents in one runtime**, which is deliberate:
 * `@planner` can submit `prepareKernel(...)` and `@tuner` can immediately
 * `benchmark(kernel0, ...)`. Handing several agents one dataflow graph is the
 * point of multiplexing them over a single CLI, and it is how a dsh subagent
 * picks up work its parent started.
 *
 * @module fluvia/plugins/env
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentRecord, ChannelKind, HandleRecord } from '../core/types.ts'
import type { Tracer } from '../core/trace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    env: Environment
  }
}

export class Environment extends Service {
  private readonly byName = new Map<string, HandleRecord>()
  private readonly byId = new Map<string, HandleRecord>()
  private readonly values = new Map<string, unknown>()
  private readonly agentMap = new Map<string, AgentRecord>()
  private nextHandle = 0

  constructor(
    ctx: Context,
    private readonly tracer: Tracer,
  ) {
    super(ctx, 'env')
  }

  /**
   * Create a pending handle and bind it to `name`.
   *
   * @param name — the agent-visible variable, e.g. `kernel0` or `err0`.
   * @param kind — which channel of `call` it carries.
   */
  bind(name: string, kind: ChannelKind, call: string): HandleRecord {
    // Names are unique by construction (`<out><seq>`), except for a toolbox
    // that declares `out: "err"`, which would collide with its own error
    // channel. Rebinding a live name would silently steal a dependency, so the
    // colliding one is suffixed and the acknowledgement reports what was bound.
    while (this.byName.has(name)) name = `${name}_`
    const handle: HandleRecord = { id: `h${this.nextHandle++}`, name, kind, call, state: 'pending' }
    this.byName.set(name, handle)
    this.byId.set(handle.id, handle)
    return handle
  }

  /** Resolve a variable name an agent wrote. */
  lookup(name: string): HandleRecord | undefined {
    return this.byName.get(name)
  }

  /** Resolve a handle id. */
  handle(id: string): HandleRecord | undefined {
    return this.byId.get(id)
  }

  /** Every handle, in creation order. */
  handles(): HandleRecord[] {
    return [...this.byId.values()]
  }

  /**
   * Settle a handle. A `ready` handle carries a payload; a `void` handle never
   * will, because its call settled on the other channel.
   */
  settle(handle: HandleRecord, state: 'ready' | 'void', value?: unknown, digest?: { type: string; summary: string }): void {
    handle.state = state
    if (state === 'ready') {
      this.values.set(handle.id, value)
      handle.type = digest?.type
      handle.summary = digest?.summary
    }
    this.tracer.emit('handle.settle', {
      handle: handle.id,
      name: handle.name,
      call: handle.call,
      kind: handle.kind,
      state,
      type: handle.type,
      summary: handle.summary,
    })
  }

  /** The payload of a ready handle. */
  value(id: string): unknown {
    return this.values.get(id)
  }

  /** Record that an agent spoke, creating its record on first sight. */
  agent(id: string): AgentRecord {
    let record = this.agentMap.get(id)
    if (!record) {
      record = { id, joinedAt: this.tracer.now(), lines: 0, calls: [] }
      this.agentMap.set(id, record)
      this.tracer.emit('agent.join', { agent: id })
    }
    return record
  }

  /** Every agent seen, in join order. */
  agents(): AgentRecord[] {
    return [...this.agentMap.values()]
  }
}
