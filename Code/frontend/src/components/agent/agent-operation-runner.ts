import type {
  AgentChatClientContext, AgentChatResponse, AgentOperationStatus, AgentOperationTarget,
} from '../../services/agent-api'
import { executeAgentUiIntents, type AgentUiIntentHandlers } from './agent-ui-intent'

const statusLabels: Record<AgentOperationStatus, string> = {
  success: '成功', failed: '失败', not_executed: '未执行',
  needs_clarification: '需要澄清', pending: '处理中',
}

/** The same actual receipt supplies the main reply and the execution details. */
export async function settleAgentResponse(
  response: AgentChatResponse, handlers: AgentUiIntentHandlers, signal?: AbortSignal,
): Promise<AgentChatResponse> {
  if (response.request_mode && response.request_mode !== "execute") return { ...response, ui_intents: [], operation_plan: [] }
  if (!response.ui_intents.length) return response
  const results = await executeAgentUiIntents(response.ui_intents, handlers, { signal })
  const issues = response.operation_issues ?? []
  const actualTarget = [...results].reverse().find(r => r.target)?.target
  const status = results.every(r => r.status === 'not_executed') ? 'not_executed'
    : results.some(r => r.status === 'pending') && results.every(r => r.ok || r.status === 'pending') && !issues.length ? 'pending'
    : results.some(r => !r.ok) || issues.length ? 'failed' : 'success'
  const lines = results.map(r => `${statusLabels[r.status ?? (r.ok ? 'success' : 'failed')]}：${r.message}`)
  const issueLines = issues.map(issue => `${statusLabels[issue.status]}：${issue.message}`)
  return {
    ...response, ui_intents: [], operation_status: status,
    operation_target: actualTarget ?? response.operation_target,
    reply: [...lines, ...issueLines].join('\n\n'),
    steps: [...(response.steps ?? []), ...results.map((r, i) => ({
      type: 'tool_result' as const, summary: lines[i],
      detail: JSON.stringify({ command_id: r.commandId, operation: response.ui_intents[i].name, args: response.ui_intents[i].args, ...r }),
    })), ...issueLines.map(summary => ({ type: 'tool_result' as const, summary }))],
  }
}

export async function runAgentOperationPlan(
  initial: AgentChatResponse,
  deps: {
    signal: AbortSignal
    initialContext?: AgentChatClientContext
    context: () => AgentChatClientContext
    request: (message: string, sessionId: string, context: AgentChatClientContext, quotaToken?: string) => Promise<AgentChatResponse>
    execute: (response: AgentChatResponse) => Promise<AgentChatResponse>
    progress?: (text: string) => void
  },
): Promise<AgentChatResponse> {
  if (initial.request_mode && initial.request_mode !== "execute") return { ...initial, ui_intents: [], operation_plan: [] }
  const plan = initial.operation_plan ?? []
  const references = new Map<string, AgentOperationTarget | null>()
  const outcomes = new Map<string, AgentOperationStatus>()
  let reference: AgentOperationTarget | null = null
  let expectedSelection = (deps.initialContext ?? deps.context()).active_layers?.find(l => l.selected)?.instance_id
  let sessionId = initial.session_id
  let totalTokens = 0
  const replies: string[] = []
  const evidence = [...(initial.steps ?? [])]
  const confirmations = [...(initial.confirmations ?? [])]
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]
    let status: AgentOperationStatus = 'not_executed'
    let message: string
    if (deps.signal.aborted) {
      message = '用户已取消，尚未执行本步骤。'
    } else if (step.depends_on && outcomes.get(step.depends_on) !== 'success') {
      message = '依赖的前一步没有成功，未继续执行。'
    } else {
      deps.progress?.(`正在执行 ${i + 1}/${plan.length}：${step.message}`)
      try {
        const context = deps.context()
        const selection = context.active_layers?.find(l => l.selected)?.instance_id
        if (step.operation !== 'query_state' && /当前.*图层/.test(step.message) &&
          expectedSelection !== selection) {
          outcomes.set(step.id, 'needs_clarification')
          const line = `${i + 1}. 需要澄清：${step.message}\n执行期间选中对象已变化，请确认要操作的图层。`
          replies.push(line)
          evidence.push({ type: 'tool_result', summary: line })
          reference = null
          continue
        }
        const response = await deps.request(
          [step.message, ...(step.constraints ?? [])].join('，'), sessionId,
          { ...context, operation_protocol: 1, operation_single: true, operation_step_id: step.id,
            operation_inherit_target: step.inherit_target, operation_inherit_time: step.inherit_time,
            operation_reference: step.target_step_id ? references.get(step.target_step_id) ?? null : reference },
          step.quota_token,
        )
        sessionId = response.session_id
        const settled = deps.signal.aborted
          ? { ...response, operation_status: 'not_executed' as const, reply: '请求已取消；未执行后续界面操作。' }
          : await deps.execute(response)
        status = settled.operation_status ?? 'success'
        message = settled.reply
        totalTokens += settled.usage?.total_tokens ?? 0
        evidence.push(...(settled.steps ?? []))
        confirmations.push(...(settled.confirmations ?? []))
        // A reference is an explicit resolved identity, never the last arbitrary click.
        const targeted = [...response.ui_intents].reverse().find(intent => intent.args.catalog_id)
        const target = settled.operation_target ?? (targeted ? {
          catalog_id: String(targeted.args.catalog_id),
          instance_id: targeted.args.instance_id ? String(targeted.args.instance_id) : undefined,
          date: targeted.args.date ? String(targeted.args.date) : undefined,
        } : response.operation_target)
        const targetIds = new Set(response.ui_intents.map(intent => intent.args.catalog_id).filter(Boolean))
        reference = targetIds.size > 1 ? null : target ?? null
        if (reference) {
          const rows = deps.context().active_layers ?? []
          const row = rows.find(l => l.catalog_id === reference!.catalog_id &&
            (!reference!.instance_id || reference!.instance_id === l.instance_id))
          if (row) reference = { ...reference, instance_id: row.instance_id,
            date: row.requested_time?.date ?? reference.date,
            hour: row.requested_time?.hour ?? reference.hour }
        }
        if (response.ui_intents.length) {
          expectedSelection = deps.context().active_layers?.find(l => l.selected)?.instance_id
        }
      } catch (error) {
        status = deps.signal.aborted ? 'not_executed' : 'failed'
        message = deps.signal.aborted ? '用户已取消；服务端已开始的只读计算可能仍在结束，后续界面操作未执行。'
          : `本步骤请求失败：${error instanceof Error ? error.message : String(error)}`
        reference = null
      }
    }
    references.set(step.id, reference)
    outcomes.set(step.id, status)
    const line = `${i + 1}. ${statusLabels[status]}：${step.message}\n${message}`
    replies.push(line)
    evidence.push({ type: 'tool_result', summary: line,
      detail: JSON.stringify({ step_id: step.id, status, target: reference }) })
  }
  return {
    ...initial, session_id: sessionId, operation_plan: [], ui_intents: [],
    reply: replies.join('\n\n'), steps: evidence, confirmations,
    operation_status: [...outcomes.values()].every(s => s === 'success') ? 'success'
      : [...outcomes.values()].some(s => s === 'pending') ? 'pending'
      : [...outcomes.values()].every(s => s === 'not_executed') ? 'not_executed' : 'failed',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: totalTokens, estimated: true },
  }
}
