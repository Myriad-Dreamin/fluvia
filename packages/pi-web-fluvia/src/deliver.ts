/**
 * Waking the agent with a notification.
 *
 * Idle → `agent.prompt(message)` starts a turn. Running → `agent.followUp`
 * queues it for when the agent would otherwise stop. A follow-up queued in the
 * instant between the loop's last poll and the run settling would sit in the
 * queue forever, so once the agent is idle again any leftover queue is drained
 * with `continue()`.
 *
 * @module pi-web-fluvia/deliver
 */

import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core'

export function deliverToAgent(agent: Agent, message: AgentMessage, onError?: (error: Error) => void): void {
  const report = (error: unknown) => onError?.(error instanceof Error ? error : new Error(String(error)))
  if (!agent.state.isStreaming) {
    agent.prompt(message).catch((error) => {
      // Lost the race with a run that just started: queue instead.
      if (agent.state.isStreaming) {
        agent.followUp(message)
        drainWhenIdle(agent, report)
      } else report(error)
    })
    return
  }
  agent.followUp(message)
  drainWhenIdle(agent, report)
}

function drainWhenIdle(agent: Agent, report: (error: unknown) => void): void {
  void agent.waitForIdle().then(() => {
    if (agent.state.isStreaming || !agent.hasQueuedMessages()) return
    agent.continue().catch(report)
  })
}
