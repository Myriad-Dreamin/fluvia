/**
 * The app: pi-web-ui's ChatPanel with a pi `Agent`, and a side panel choosing
 * how the agent meets fluvia — a live runtime running in this page, or a
 * benchmark slice resumed from a recording. Both run the fluvia runtime in the
 * browser; nothing here talks to a server.
 *
 * @module pi-web-fluvia/ui/main
 */

import '@mariozechner/pi-web-ui/app.css'
import './styles.css'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core'
import { getModel, getModels, getProviders } from '@mariozechner/pi-ai'
import type { KnownProvider, Message, Model } from '@mariozechner/pi-ai'
import {
  ApiKeyPromptDialog,
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  ProvidersModelsTab,
  ProxyTab,
  SessionsStore,
  SettingsDialog,
  SettingsStore,
  defaultConvertToLlm,
  getAppStorage,
  setAppStorage,
} from '@mariozechner/pi-web-ui'
import { html, nothing, render } from 'lit'
import { live } from 'lit/directives/live.js'
import type { CallRecord, TraceEvent } from '../../../../src/core/types.ts'
import type { SliceReport } from '../../../../src/bench/session.ts'
import type { IndexedTrace } from '../../../../src/bench/slice.ts'
import toolbox from '../../../../src/toolbox/default.ts'
import { LiveSession } from '../live.ts'
import { buildRecord, parseRecord } from '../record.ts'
import type { SessionRecord } from '../record.ts'
import { Replay } from '../replay.ts'
import type { ReplayState } from '../replay.ts'
import { EXAMPLE_PROMPTS, EXAMPLE_TASKS } from '../examples.ts'
import { expandFluviaMessages } from '../messages.ts'
import { DEFAULT_TASK, SliceDriver, loadTrace } from '../slice.ts'
import type { SliceOutcome } from '../slice.ts'
import { registerFluviaRenderers } from './renderers.ts'

registerFluviaRenderers()
// Dark by default; pi-web-ui's theme keys off the `dark` class.
document.documentElement.classList.add('dark')

/* ------------------------------------------------------------------ storage */

const settings = new SettingsStore()
const providerKeys = new ProviderKeysStore()
const sessions = new SessionsStore()
const customProviders = new CustomProvidersStore()
const backend = new IndexedDBStorageBackend({
  dbName: 'pi-web-fluvia',
  version: 1,
  stores: [settings.getConfig(), SessionsStore.getMetadataConfig(), providerKeys.getConfig(), customProviders.getConfig(), sessions.getConfig()],
})
settings.setBackend(backend)
providerKeys.setBackend(backend)
customProviders.setBackend(backend)
sessions.setBackend(backend)
setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend))

/* -------------------------------------------------------------------- model */

/**
 * The model the agent talks to. Two kinds, because they are different things:
 *
 * - `endpoint`: any server speaking a known wire format at a base URL you give,
 *   with whatever model id it accepts. It is not filed under a catalogued
 *   provider; its API key is stored under the endpoint's host.
 * - `catalogue`: a provider pi-ai knows (its endpoint, request quirks and
 *   pricing), with one of its model ids or an id it does not list yet.
 */
interface ModelChoice {
  kind: 'endpoint' | 'catalogue'
  id: string
  /** `endpoint` only. */
  baseUrl: string
  /** `endpoint` only: the wire format the server speaks. */
  api: 'openai-completions' | 'anthropic-messages'
  /** `catalogue` only. */
  provider: string
}

const MODEL_KEY = 'pi-web-fluvia.model'
const DEFAULT_CHOICE: ModelChoice = { kind: 'catalogue', id: 'deepseek-v4-flash', baseUrl: '', api: 'openai-completions', provider: 'deepseek' }

function loadChoice(): ModelChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_KEY) ?? 'null') as Partial<ModelChoice> | null
    if (saved && typeof saved.id === 'string') {
      const baseUrl = typeof saved.baseUrl === 'string' ? saved.baseUrl : ''
      return {
        // An earlier version stored a base URL next to a provider; that was an endpoint.
        kind: saved.kind === 'endpoint' || saved.kind === 'catalogue' ? saved.kind : baseUrl ? 'endpoint' : 'catalogue',
        id: saved.id,
        baseUrl,
        api: saved.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
        provider: typeof saved.provider === 'string' ? saved.provider : DEFAULT_CHOICE.provider,
      }
    }
  } catch {
    // storage unavailable: fall back to the default
  }
  return { ...DEFAULT_CHOICE }
}

function saveChoice(choice: ModelChoice): void {
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(choice))
  } catch {
    // not persisted; the choice still applies to this page
  }
}

/** Where an endpoint's key is stored: its host, e.g. `llm.example.com`. */
function endpointKeyName(baseUrl: string): string {
  return new URL(baseUrl).host
}

function buildModel(choice: ModelChoice): Model<any> {
  const id = choice.id.trim()
  if (!id) throw new Error('Enter a model id.')
  if (choice.kind === 'endpoint') {
    const baseUrl = choice.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('Enter the endpoint base URL, e.g. https://llm.example.com/v1')
    return {
      id,
      name: id,
      api: choice.api,
      provider: endpointKeyName(baseUrl),
      baseUrl,
      // Unknown server: no thinking parameters are sent, and pricing is not known.
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }
  }
  const catalogue = getModels(choice.provider as KnownProvider) as Model<any>[]
  const exact = catalogue.find((model) => model.id === id)
  if (exact) return { ...exact }
  const template = catalogue[0]
  if (!template) throw new Error(`pi-ai has no provider named ${choice.provider}`)
  // An id the catalogue does not list yet keeps the provider's request format.
  return { ...template, id, name: id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}

function describeModel(model: Model<any>, choice: ModelChoice): string {
  if (choice.kind === 'endpoint') return `Using ${model.id} at ${model.baseUrl}. Its API key is stored as “${model.provider}”.`
  const listed = getModels(choice.provider as KnownProvider).some((m) => m.id === model.id)
  return `Using ${model.id} from ${model.provider} at ${model.baseUrl}${listed ? '' : ' (not in pi’s catalogue)'}.`
}

/* -------------------------------------------------------------------- state */

type Mode = 'live' | 'slice'

const ui = {
  mode: 'live' as Mode,
  model: loadChoice(),
  modelNote: '',
  // live
  concurrency: 4,
  live: undefined as LiveSession | undefined,
  liveStatus: 'stopped',
  liveBusy: false,
  deliveries: 0,
  // slice
  trace: undefined as IndexedTrace | undefined,
  traceName: '',
  from: 0,
  to: '' as string,
  takeover: '',
  task: DEFAULT_TASK,
  maxTurns: 12,
  driver: undefined as SliceDriver | undefined,
  sliceStatus: '',
  sliceBusy: false,
  wakes: [] as string[],
  outcome: undefined as SliceOutcome | undefined,
  /** What the last slice run was started with, for export. */
  sliceRun: undefined as { setup: { from: number; to?: number; takeover: string }; task: string; maxTurns: number; traceName: string; events: TraceEvent[] } | undefined,
  examplesOpen: false,
  // replay, driven from the console
  replay: undefined as Replay | undefined,
  error: '',
}

const chatPanel = new ChatPanel()
let agent: Agent | undefined

function convertToLlm(messages: AgentMessage[]): Message[] {
  return defaultConvertToLlm(expandFluviaMessages(messages))
}

/** A fresh agent in the chat panel, keeping whatever model the user picked. */
async function installAgent(systemPrompt: string, tools: AgentTool<any>[], explicit?: Model<any>): Promise<Agent> {
  // Keep a model picked in the chat's own selector, but never carry a replay's
  // scripted model into a real run.
  const previous = agent?.state.model
  const model: Model<any> = explicit ?? (previous && previous.provider !== 'replay' ? previous : currentModel())
  const thinkingLevel = agent?.state.thinkingLevel ?? 'off'
  agent?.abort()
  agent = new Agent({ initialState: { systemPrompt, model, thinkingLevel, messages: [], tools: [] }, convertToLlm })
  await chatPanel.setAgent(agent, { onApiKeyRequired: (provider) => ApiKeyPromptDialog.prompt(provider) })
  // Only fluvia: the panel's artifacts tool is not part of this app.
  agent.state.tools = tools
  // The message list is handed the agent's (mutated-in-place) message array and
  // only re-renders when another property changes. A run this app starts on its
  // own (a notification wake-up) has no tool call to change one, so refresh the
  // chat once the run has fully settled and `isStreaming` has flipped back.
  const current = agent
  current.subscribe((event) => {
    if (event.type === 'agent_end') void current.waitForIdle().then(refreshChat)
    // The examples card belongs to an empty conversation; redraw when that changes.
    if (event.type === 'agent_start') ui.examplesOpen = false
    if (event.type === 'agent_start' || event.type === 'message_start' || event.type === 'agent_end') draw()
  })
  return agent
}

function refreshChat(): void {
  chatPanel.agentInterface?.requestUpdate()
}

/** The model named in the side panel, or a catalogued fallback if it cannot be built. */
function currentModel(): Model<any> {
  try {
    return buildModel(ui.model)
  } catch {
    return getModel('anthropic', 'claude-sonnet-4-5')
  }
}

function applyModel(): void {
  ui.error = ''
  try {
    const model = buildModel(ui.model)
    ui.model = { ...ui.model, id: model.id, baseUrl: ui.model.kind === 'endpoint' ? model.baseUrl : ui.model.baseUrl }
    saveChoice(ui.model)
    if (agent) {
      agent.state.model = model
      refreshChat()
    }
    ui.modelNote = describeModel(model, ui.model)
  } catch (error) {
    ui.modelNote = ''
    ui.error = (error as Error).message
  }
  draw()
}

/** Programmatic prompts bypass the editor's key check, so do it here. */
async function ensureKey(model: Model<any>): Promise<boolean> {
  if (await getAppStorage().providerKeys.get(model.provider)) return true
  return ApiKeyPromptDialog.prompt(model.provider)
}

const IDLE_PROMPT = 'No fluvia runtime yet. Start the live runtime or resume a slice from the panel on the left.'

/* --------------------------------------------------------------------- live */

function clearReplay(): void {
  ui.replay?.stop()
  ui.replay?.live?.close()
  ui.replay = undefined
}

async function startLive(): Promise<void> {
  clearReplay()
  ui.liveBusy = true
  ui.error = ''
  ui.liveStatus = 'starting…'
  draw()
  try {
    const live = await LiveSession.start({
      toolbox,
      concurrency: ui.concurrency,
      onDeliver: () => {
        ui.deliveries++
        draw()
      },
      onError: (error) => {
        ui.error = error.message
        draw()
      },
    })
    ui.live = live
    ui.deliveries = 0
    live.attach(await installAgent(live.systemPrompt, [live.tool]))
    ui.liveStatus = `running in this page · agent ${live.agent} · session ${live.session}`
  } catch (error) {
    ui.liveStatus = 'stopped'
    ui.error = (error as Error).message
  } finally {
    ui.liveBusy = false
    draw()
  }
}

function stopLive(): void {
  const live = ui.live
  ui.live = undefined
  live?.close()
  ui.liveStatus = 'stopped'
  draw()
}

/* -------------------------------------------------------------------- slice */

function useTrace(events: unknown, name: string): void {
  ui.error = ''
  try {
    if (!Array.isArray(events)) throw new Error('expected a JSON array of trace events (pnpm bench export)')
    const trace = loadTrace(events as TraceEvent[])
    ui.trace = trace
    ui.traceName = name
    ui.takeover = trace.agents[0] ?? ''
    ui.from = Math.min(ui.from, Math.max(0, trace.lines.length - 1))
    ui.to = ''
    ui.outcome = undefined
    ui.wakes = []
  } catch (error) {
    ui.trace = undefined
    ui.error = `${name}: ${(error as Error).message}`
  }
  draw()
}

async function loadDemoTrace(): Promise<void> {
  try {
    const response = await fetch(new URL('demo-trace.json', document.baseURI))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    useTrace(await response.json(), 'demo-trace.json')
  } catch (error) {
    ui.error = `demo trace: ${(error as Error).message}`
    draw()
  }
}

async function loadTraceFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    useTrace(JSON.parse(await file.text()), file.name)
  } catch (error) {
    ui.error = `${file.name}: ${(error as Error).message}`
    draw()
  }
}

async function startSlice(): Promise<void> {
  if (!ui.trace || !ui.takeover) return
  clearReplay()
  ui.error = ''
  ui.outcome = undefined
  ui.wakes = []
  ui.sliceBusy = true
  ui.sliceStatus = 'restoring the runtime to the cut…'
  stopLive()
  draw()
  try {
    const model = agent?.state.model && agent.state.model.provider !== 'replay' ? agent.state.model : currentModel()
    if (!(await ensureKey(model))) throw new Error(`no API key for ${model.provider}`)
    const to = ui.to.trim() === '' ? undefined : Number(ui.to)
    const driver = await SliceDriver.open(ui.trace, { from: ui.from, to, takeover: ui.takeover }, toolbox)
    ui.driver = driver
    ui.sliceRun = { setup: driver.setup, task: ui.task.trim() || DEFAULT_TASK, maxTurns: ui.maxTurns, traceName: ui.traceName, events: ui.trace.events }
    const sliceAgent = await installAgent(driver.systemPrompt, [driver.tool])
    ui.sliceStatus = `running · lane ${ui.takeover} from line ${driver.session.from} to ${driver.session.to}`
    draw()
    ui.outcome = await driver.run(sliceAgent, ui.task.trim() || DEFAULT_TASK, {
      maxTurns: ui.maxTurns,
      onWake: (message, wake) => {
        ui.wakes.push(`+${Math.round(wake.at)}ms · ${message ? `${message.count} notification${message.count === 1 ? '' : 's'}` : 'nothing'}${wake.idle ? ' · idle' : ''}`)
        draw()
      },
    })
    refreshChat()
    ui.sliceStatus = `stopped: ${ui.outcome.reason}${ui.outcome.detail ? ` (${ui.outcome.detail})` : ''}`
  } catch (error) {
    ui.error = (error as Error).message
    ui.sliceStatus = ''
  } finally {
    ui.sliceBusy = false
    draw()
  }
}

function stopSlice(): void {
  ui.driver?.stop()
  agent?.abort()
}

/* ------------------------------------------------------------ examples */

async function useExamplePrompt(text: string): Promise<void> {
  ui.examplesOpen = false
  draw()
  if (!ui.live) await startLive()
  chatPanel.agentInterface?.setInput(text)
}

/* ------------------------------------------------------------------ export */

/** The run the chat currently shows, if it is one worth exporting. */
function exportable(): { mode: 'live' | 'slice'; runtime: TraceEvent[] } | undefined {
  if (!agent || !agent.state.messages.some((m) => m.role === 'assistant')) return undefined
  if (agent.state.model.provider === 'replay') return undefined
  if (ui.live) return { mode: 'live', runtime: ui.live.events }
  if (ui.driver && ui.sliceRun) return { mode: 'slice', runtime: ui.driver.session.events }
  return undefined
}

/** Build the trace of the run the chat shows; see `fluvia.exportTrace` in the console. */
function exportTrace(options: { download?: boolean } = {}): SessionRecord {
  const source = exportable()
  if (!agent || !source) {
    throw new Error('Nothing to export yet: run the live runtime or a slice with a real model first.')
  }
  const model = agent.state.model
  const record = buildRecord({
    mode: source.mode,
    model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl },
    systemPrompt: agent.state.systemPrompt,
    live: source.mode === 'live' && ui.live ? { agent: ui.live.agent, concurrency: ui.concurrency } : undefined,
    slice:
      source.mode === 'slice' && ui.sliceRun
        ? { setup: ui.sliceRun.setup, task: ui.sliceRun.task, maxTurns: ui.sliceRun.maxTurns, traceName: ui.sliceRun.traceName, traceEvents: ui.sliceRun.events }
        : undefined,
    messages: agent.state.messages,
    runtime: source.runtime,
  })
  if (options.download !== false) {
    const blob = new Blob([JSON.stringify(record, null, 1)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `trace-${source.mode}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
  }
  return record
}

/* ------------------------------------------------------------------ replay */

/** A real run shipped with the app, replayed without any model. */
const PRESET_TRACE = 'preset-trace.json'

/**
 * Play a trace again without a model; see `fluvia.replayTrace` in the console.
 *
 * @param source — a trace object, its JSON text, or a URL to fetch it from.
 */
async function replayTrace(source: unknown, options: { speed?: 'typing' | 'instant' } = {}): Promise<ReplayState> {
  let value = source
  if (typeof source === 'string') {
    const text = source.trim()
    value = text.startsWith('{') ? JSON.parse(text) : await (await fetch(new URL(text, document.baseURI))).json()
  }
  const record = parseRecord(value)
  clearReplay()
  stopLive()
  ui.driver = undefined
  ui.sliceRun = undefined
  ui.error = ''
  draw()
  const replay = Replay.start(record, {
    toolbox,
    tokensPerSecond: options.speed === 'instant' ? undefined : 90,
    installAgent: (systemPrompt, tools, model) => installAgent(systemPrompt, tools, model),
    onUpdate: (state) => {
      const drift = state.divergences.length ? `, ${state.divergences.length} drift` : ''
      console.info(`[fluvia replay] ${state.phase} · model turn ${state.turnsPlayed}/${state.turnsRecorded}${drift}`)
    },
  })
  ui.replay = replay
  const state = await replay.done
  refreshChat()
  if (state.divergences.length) console.table(state.divergences)
  else if (state.phase === 'done') console.info('[fluvia replay] no drift: every model turn saw what it saw in the recording')
  if (state.slice) console.info('[fluvia replay] slice report', state.slice.report.agent)
  draw()
  return state
}

/** The console surface. Trace export and replay are developer tools, not UI. */
const consoleApi = {
  /** Download the current run as trace-*.json and return it. Pass `{ download: false }` to only return it. */
  exportTrace,
  /** Replay a trace object, JSON text or URL without any model. `{ speed: 'instant' }` skips streaming. */
  replayTrace,
  /** Stop a replay in progress. */
  stopReplay: () => ui.replay?.stop(),
  /** The bundled preset trace, a real run. */
  replayExample: (options?: { speed?: 'typing' | 'instant' }) => replayTrace(PRESET_TRACE, options),
  help() {
    console.info(
      [
        'fluvia.exportTrace()                  download the current run as trace-*.json (and return it)',
        'fluvia.exportTrace({ download: false }) return it without downloading',
        'fluvia.replayTrace(trace)             replay a trace object, JSON text or URL with no model',
        "fluvia.replayTrace(trace, { speed: 'instant' })",
        'fluvia.replayExample()                replay the bundled scripted example',
        'fluvia.stopReplay()',
      ].join('\n'),
    )
  },
}
;(window as unknown as { fluvia: typeof consoleApi }).fluvia = consoleApi

/* ------------------------------------------------------------------- render */

function draw(): void {
  const app = document.getElementById('app')
  if (!app) return
  render(
    html`
      <div class="app">
        <header class="bar">
          <strong>pi × fluvia</strong>
          <nav class="tabs">
            ${(['live', 'slice'] as Mode[]).map(
              (mode) => html`<button class=${ui.mode === mode ? 'tab on' : 'tab'} @click=${() => setMode(mode)}>
                ${mode === 'live' ? 'Live runtime' : 'Resume from a slice'}
              </button>`,
            )}
          </nav>
          <span class="grow"></span>
          <button class="btn ghost" @click=${() => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()])}>Settings</button>
        </header>
        <div class="body">
          <aside class="side">
            ${modelForm()}${ui.mode === 'live' ? liveForm() : sliceForm()}
            ${ui.error ? html`<p class="error">${ui.error}</p>` : nothing}
          </aside>
          <main class="chat">${chatPanel}${progress()}${examples()}</main>
        </div>
      </div>
    `,
    app,
  )
}

function setMode(mode: Mode): void {
  if (ui.mode === mode) return
  ui.mode = mode
  ui.error = ''
  draw()
}

function modelForm() {
  const choice = ui.model
  const set = (patch: Partial<ModelChoice>) => {
    ui.model = { ...ui.model, ...patch }
    ui.modelNote = ''
    draw()
  }
  const value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value
  const idInput = (list?: string) => html`<label
    >Model id
    <input
      list=${list ?? nothing}
      .value=${live(choice.id)}
      placeholder=${choice.kind === 'endpoint' ? 'e.g. kimi-k3' : 'pick or type an id'}
      @input=${(e: Event) => set({ id: value(e) })}
      @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && applyModel()}
  /></label>`
  return html`
    <section class="model">
      <h2>Model</h2>
      <div class="row" role="group" aria-label="Kind of model">
        <button class=${choice.kind === 'endpoint' ? 'tab on' : 'tab'} @click=${() => set({ kind: 'endpoint' })}>Custom endpoint</button>
        <button class=${choice.kind === 'catalogue' ? 'tab on' : 'tab'} @click=${() => set({ kind: 'catalogue' })}>Known provider</button>
      </div>
      ${choice.kind === 'endpoint'
        ? html`
            <label
              >Base URL
              <input
                .value=${live(choice.baseUrl)}
                placeholder="https://llm.example.com/v1"
                @input=${(e: Event) => set({ baseUrl: value(e) })}
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && applyModel()}
            /></label>
            ${idInput()}
            <label
              >API format
              <select .value=${live(choice.api)} @change=${(e: Event) => set({ api: value(e) as ModelChoice['api'] })}>
                <option value="openai-completions">OpenAI-compatible chat completions</option>
                <option value="anthropic-messages">Anthropic messages</option>
              </select>
            </label>
          `
        : html`
            <label
              >Provider
              <select .value=${live(choice.provider)} @change=${(e: Event) => set({ provider: value(e) })}>
                ${getProviders().map((provider) => html`<option value=${provider} ?selected=${provider === choice.provider}>${provider}</option>`)}
              </select>
            </label>
            ${idInput('model-ids')}
            <datalist id="model-ids">
              ${getModels(choice.provider as KnownProvider).map((model) => html`<option value=${model.id}>${model.name}</option>`)}
            </datalist>
          `}
      <div class="row"><button class="btn primary" @click=${applyModel}>Use this model</button></div>
      ${ui.modelNote ? html`<p class="hint">${ui.modelNote}</p>` : nothing}
    </section>
  `
}

function liveForm() {
  const live = ui.live
  return html`
    <section>
      <h2>Live runtime</h2>
      <label
        >Concurrency
        <input
          type="number"
          min="1"
          max="16"
          .value=${String(ui.concurrency)}
          ?disabled=${!!live}
          @input=${(e: Event) => (ui.concurrency = Math.max(1, Number((e.target as HTMLInputElement).value) || 4))}
      /></label>
      <div class="row">
        ${live
          ? html`<button class="btn" @click=${stopLive}>Stop runtime</button>`
          : html`<button class="btn primary" ?disabled=${ui.liveBusy} @click=${startLive}>Start runtime</button>`}
      </div>
      <p class="status">${ui.liveStatus}${live ? html`<br />${ui.deliveries} notification deliveries` : nothing}</p>
      ${live
        ? html`<details>
            <summary>Instruction set (${live.isa.length})</summary>
            <ul class="isa">
              ${live.isa.map((entry) => html`<li><code>${entry.name}${entry.kind === 'async' ? entry.params : ''}</code> ${entry.summary}</li>`)}
            </ul>
          </details>`
        : nothing}
    </section>
  `
}

function sliceForm() {
  const trace = ui.trace
  const running = ui.sliceBusy
  return html`
    <section>
      <h2>Resume from a slice</h2>
      <div class="row">
        <input type="file" accept=".json,application/json" ?disabled=${running} @change=${loadTraceFile} />
        <button class="btn" ?disabled=${running} @click=${loadDemoTrace}>Demo trace</button>
      </div>
      ${trace
        ? html`
            <p class="status">${ui.traceName} · session ${trace.meta.session} · ${trace.lines.length} lines · lanes ${trace.agents.join(', ')}</p>
            <label
              >Cut before line (from)
              <select ?disabled=${running} @change=${(e: Event) => (ui.from = Number((e.target as HTMLSelectElement).value))}>
                ${trace.lines.map((line) => html`<option value=${line.index} ?selected=${line.index === ui.from}>${line.index}  ${line.line}</option>`)}
              </select>
            </label>
            <label
              >Replay up to line (to, exclusive; blank = end)
              <input type="number" min="0" max=${trace.lines.length} .value=${ui.to} ?disabled=${running} @input=${(e: Event) => (ui.to = (e.target as HTMLInputElement).value)} />
            </label>
            <label
              >Take over lane
              <select ?disabled=${running} @change=${(e: Event) => (ui.takeover = (e.target as HTMLSelectElement).value)}>
                ${trace.agents.map((a) => html`<option ?selected=${a === ui.takeover}>${a}</option>`)}
              </select>
            </label>
            <div class="row">
              ${(EXAMPLE_TASKS[ui.takeover] ? [EXAMPLE_TASKS[ui.takeover]!] : []).map(
                (task) => html`<button class="btn" ?disabled=${running} @click=${() => { ui.task = task; draw() }}>Example task for ${ui.takeover}</button>`,
              )}
              <button class="btn ghost" ?disabled=${running} @click=${() => { ui.task = DEFAULT_TASK; draw() }}>Generic task</button>
            </div>
            <label>Task <textarea rows="5" .value=${ui.task} ?disabled=${running} @input=${(e: Event) => (ui.task = (e.target as HTMLTextAreaElement).value)}></textarea></label>
            <label
              >Turn budget (wake-ups)
              <input type="number" min="1" .value=${String(ui.maxTurns)} ?disabled=${running} @input=${(e: Event) => (ui.maxTurns = Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
            </label>
            <div class="row">
              ${running ? html`<button class="btn" @click=${stopSlice}>Stop</button>` : html`<button class="btn primary" @click=${startSlice}>Start</button>`}
            </div>
          `
        : html`<p class="hint">Load a trace exported with <code>pnpm bench export --trace &lt;gz&gt; --out &lt;json&gt;</code>, or the demo trace.</p>`}
      ${ui.sliceStatus ? html`<p class="status">${ui.sliceStatus}</p>` : nothing}
      ${ui.wakes.length ? html`<details open><summary>Wakes (${ui.wakes.length})</summary><ol class="wakes">${ui.wakes.map((w) => html`<li>${w}</li>`)}</ol></details>` : nothing}
      ${ui.outcome ? scorecard(ui.outcome.report, ui.outcome) : nothing}
    </section>
  `
}

/* ---------------------------------------------------------------- progress */

/** Calls of whichever runtime the chat is driving right now. */
function runtimeCalls(): CallRecord[] {
  if (ui.live) return ui.live.calls()
  if (ui.driver) return ui.driver.session.calls()
  return ui.replay?.live?.calls() ?? ui.replay?.driver?.session.calls() ?? []
}

function progressCounts(): { label: string; value: number }[] {
  const calls = runtimeCalls()
  const count = (...states: CallRecord['state'][]) => calls.filter((call) => states.includes(call.state)).length
  return [
    { label: 'running', value: count('running') },
    { label: 'queued', value: count('queued') },
    { label: 'waiting', value: count('waiting') },
    { label: 'done', value: count('done') },
    { label: 'failed', value: count('failed') },
    { label: 'skipped', value: count('skipped', 'cancelled') },
  ].filter((entry) => entry.value > 0)
}

function progress() {
  const counts = progressCounts()
  if (!counts.length) return nothing
  return html`<div class="runtime-progress" aria-live="polite">
    ${counts.map((entry, i) => html`${i ? html`<span class="sep">·</span>` : nothing}<span><b>${entry.value}</b> ${entry.label}</span>`)}
  </div>`
}

// Calls change state without any agent event; redraw when the counts move.
let lastProgress = ''
setInterval(() => {
  const key = JSON.stringify(progressCounts())
  if (key !== lastProgress) {
    lastProgress = key
    draw()
  }
}, 250)

const BUBBLE = html`<svg class="example-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>`
const PLAY = html`<svg class="example-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l11-7z" /></svg>`
const ARROW = html`<svg class="example-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>`

function exampleRows() {
  return EXAMPLE_PROMPTS.map(
    (example) => html`<li>
      <button class="example" title=${example.text} @click=${() => useExamplePrompt(example.text)}>
        ${BUBBLE}<span class="example-title">${example.title}</span>${ARROW}
      </button>
    </li>`,
  ).concat(html`<li class="examples-divider">
    <button class="example" @click=${playPreset}>
      ${PLAY}<span class="example-title">Check workflow using preset trace (zero cost)</span>${ARROW}
    </button>
  </li>`)
}

function playPreset(): void {
  ui.examplesOpen = false
  void replayTrace(PRESET_TRACE).catch((error: Error) => {
    ui.error = `preset trace: ${error.message}`
    draw()
  })
}

/**
 * Example prompts. An empty conversation shows them as a small card in the
 * middle of the chat; once the conversation has started they move behind an
 * "Examples" button so they never cover or push the messages.
 */
function examples() {
  if (ui.mode !== 'live' || agent?.state.isStreaming) return nothing
  const empty = !agent || agent.state.messages.length === 0
  if (empty) {
    return html`
      <section class="examples-card" aria-label="Example prompts">
        <p class="examples-heading">Try an example</p>
        <ul class="examples-list">${exampleRows()}</ul>
      </section>
    `
  }
  return html`
    <div class="examples-menu">
      <button class="examples-toggle" aria-expanded=${ui.examplesOpen ? 'true' : 'false'} @click=${() => { ui.examplesOpen = !ui.examplesOpen; draw() }}>
        ${BUBBLE}Examples
      </button>
      ${ui.examplesOpen ? html`<ul class="examples-list examples-popover">${exampleRows()}</ul>` : nothing}
    </div>
  `
}

function scorecard(report: SliceReport, outcome: SliceOutcome) {
  const score = report.agent
  if (!score) return nothing
  return html`
    <section class="card">
      <h3>Scorecard · ${score.agent}</h3>
      <dl class="stats">
        <div><dt>coverage</dt><dd>${Math.round(score.coverage * 100)}%</dd></div>
        <div><dt>wasted</dt><dd>${score.wasted}</dd></div>
        <div><dt>span</dt><dd>${ms(score.spanMs.agent)} <small>vs ${ms(score.spanMs.recorded)} recorded</small></dd></div>
      </dl>
      <p class="hint">lines ${report.from}–${report.to - 1} · stopped: ${outcome.reason} · ${outcome.wakes} wake${outcome.wakes === 1 ? '' : 's'}</p>
      <h4>Recorded lane</h4>
      <ul class="calls">${score.reference.map((ref) => html`<li><code>${ref.fn}</code> ${ref.outcome}</li>`)}</ul>
      <h4>Agent</h4>
      <ul class="calls">
        ${score.calls.length ? score.calls.map((call) => html`<li><code>${call.id} ${call.fn}</code> ${call.outcome}${call.summary ? html` — ${call.summary}` : nothing}</li>`) : html`<li>no calls</li>`}
        ${score.errors.map((error) => html`<li class="error">${error}</li>`)}
      </ul>
    </section>
  `
}

function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`
}

/* --------------------------------------------------------------------- init */

await installAgent(IDLE_PROMPT, [])
draw()
