/**
 * The environment is the agent-visible namespace: variable name → handle, plus
 * the roster of agents that have spoken this session.
 *
 * Whether bindings are shared depends on who the agents are, so the namespace
 * has a **scope**:
 *
 * - `runtime` — one namespace for everyone. `@planner` submits
 *   `prepareKernel(...)` and `@tuner` immediately passes `kernel0` onward.
 *   Handing several agents one dataflow graph is the point of multiplexing them
 *   over a single CLI, and it is right when one operator drives all of them.
 * - `agent` — a namespace per agent. Required as soon as the agents are
 *   mutually untrusted, because a handle is a capability: passing someone
 *   else's handle runs an implementation over their payload and returns a
 *   digest of it. A server that accepts connections (`fluvia serve`) therefore
 *   defaults to `agent`, and sharing has to be arranged deliberately.
 *
 * @module @fluvia/core/plugins/env
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentRecord, ChannelKind, HandleRecord } from '../types.ts'
import type { Tracer } from '../trace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    env: Environment
  }
}

/** How widely a bound handle name is visible. See the module doc. */
export type HandleScope = 'runtime' | 'agent'

/** Environment configuration, supplied by whichever entry point composes it. */
export interface EnvironmentConfig {
  /** The session tracer. */
  tracer: Tracer
  /** Namespace scope; `runtime` keeps the single-operator behaviour. */
  scope?: HandleScope
}

export class Environment extends Service {
  /** Keyed by `scopeKey(owner) + name`, so one map serves both scopes. */
  private readonly byName = new Map<string, HandleRecord>()
  private readonly byId = new Map<string, HandleRecord>()
  private readonly values = new Map<string, unknown>()
  private readonly agentMap = new Map<string, AgentRecord>()
  private nextHandle = 0

  private readonly tracer: Tracer

  /** The namespace scope in force. */
  readonly scope: HandleScope

  constructor(ctx: Context, config: EnvironmentConfig) {
    super(ctx, 'env')
    this.tracer = config.tracer
    this.scope = config.scope ?? 'runtime'
  }

  /**
   * Namespace prefix for an owner. Under `runtime` scope every owner collapses
   * to the same namespace, which is what makes the two scopes one code path.
   */
  private key(owner: string, name: string): string {
    return this.scope === 'agent' ? `${owner}\u0000${name}` : name
  }

  /**
   * Create a pending handle and bind it to `name`.
   *
   * @param name — the agent-visible variable, e.g. `kernel0` or `err0`.
   * @param kind — which channel of `call` it carries.
   */
  bind(name: string, kind: ChannelKind, call: string, owner: string): HandleRecord {
    // Names are unique by construction (`<out><seq>`), except for a toolbox
    // that declares `out: "err"`, which would collide with its own error
    // channel. Rebinding a live name would silently steal a dependency, so the
    // colliding one is suffixed and the acknowledgement reports what was bound.
    while (this.byName.has(this.key(owner, name))) name = `${name}_`
    const handle: HandleRecord = { id: `h${this.nextHandle++}`, name, kind, call, state: 'pending', owner }
    this.byName.set(this.key(owner, name), handle)
    this.byId.set(handle.id, handle)
    return handle
  }

  /**
   * Resolve a variable name an agent wrote.
   *
   * @param owner — the agent doing the lookup. Under `agent` scope a name
   * resolves only inside that agent's namespace, so one agent cannot name
   * another's handle at all.
   */
  lookup(name: string, owner: string): HandleRecord | undefined {
    return this.byName.get(this.key(owner, name))
  }

  /** Resolve a handle id. */
  handle(id: string): HandleRecord | undefined {
    return this.byId.get(id)
  }

  /**
   * Every handle, in creation order.
   *
   * @param owner — when given, only handles that agent may name.
   */
  handles(owner?: string): HandleRecord[] {
    const all = [...this.byId.values()]
    if (owner === undefined || this.scope === 'runtime') return all
    return all.filter((handle) => handle.owner === owner)
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
