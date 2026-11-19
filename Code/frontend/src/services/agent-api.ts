import { requestJson, resolveApiUrl } from './_http'
import { handleSessionExpired, isAuthBootstrapPath } from './session-expired'
import { withWriteAuthHeaders } from './backend-auth'
import { getVisitorId } from './visitor-id'

export type AgentProtocol = 'openai' | 'anthropic' | 'demo'
export type AgentScope = 'global' | 'personal'

export interface AgentUiIntent {
  name: string
  args: Record<string, unknown>
  /** 后端为每条指令分配的编号（`cmd-xxxxxxxx`），用于把「命令」和「实际执行结果」串起来 */
  command_id?: string
}

export interface AgentTokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated?: boolean
}

export interface AgentStep {
  type: 'thought' | 'tool' | 'tool_result'
  summary: string
  detail?: string | null
}

export interface AgentConfirmation {
  confirmation_id: string
  action?: string
  expires_at?: string
  summary?: Record<string, unknown>
  message?: string
}

export type AgentOperationStatus = 'success' | 'failed' | 'not_executed' | 'needs_clarification' | 'pending'

export interface AgentOperationTarget {
  catalog_id: string
  instance_id?: string
  name?: string
  date?: string | null
  hour?: number | null
}

export interface AgentOperation {
  /** Server-issued one-use continuation, bound to this already-counted step. */
  quota_token?: string
  id: string
  message: string
  operation: string
  target_step_id?: string | null
  depends_on?: string | null
  inherit_target: boolean
  inherit_time: boolean
  constraints?: string[]
}

export interface AgentChatClientContext {
  operation_protocol?: number
  operation_single?: boolean
  operation_step_id?: string
  operation_inherit_target?: boolean
  operation_inherit_time?: boolean
  operation_reference?: AgentOperationTarget | null
  active_catalog_ids?: string[]
  active_layers?: Array<{
    catalog_id: string
    instance_id?: string
    name?: string
    visible?: boolean
    selected?: boolean
    requested_time?: { date: string; hour: number }
    actual_time?: string | null
    loading?: boolean
    load_state?: string
  }>
  /** WGS84 map pick; used by sample_layer_point when lng/lat omitted */
  map_point?: { lng: number; lat: number } | null
  timeline?: {
    hour?: number
    date?: string
    playing?: boolean
  }
  viewport?: {
    center?: [number, number] | number[]
    zoom?: number
    bbox?: [number, number, number, number] | number[]
  }
  basemap_id?: string
}

export interface AgentChatRequest {
  message: string
  session_id?: string | null
  client_context?: AgentChatClientContext
}

export interface AgentChatResponse {
  request_mode?: "execute" | "read_only" | "plan_only"
  operation_plan?: AgentOperation[]
  operation_status?: AgentOperationStatus | null
  operation_target?: AgentOperationTarget | null
  operation_issues?: Array<{ status: 'failed' | 'not_executed' | 'needs_clarification'; message: string }>
  session_id: string
  reply: string
  ui_intents: AgentUiIntent[]
  provider?: string
  profile_id?: string | null
  usage?: AgentTokenUsage | null
  steps?: AgentStep[]
  confirmations?: AgentConfirmation[]
}

export interface AgentConfirmRequest {
  confirmation_id: string
  decision: 'approve' | 'reject'
}

export interface AgentConfirmResponse {
  confirmation_id: string
  status: string
  summary?: Record<string, unknown>
  run_id?: string | null
  status_url?: string | null
  message?: string
}

export interface AgentProfile {
  id: string
  name: string
  provider_kind: string
  protocol: AgentProtocol
  base_url: string
  model: string
  context_window_input: number
  context_window_output: number
  preset_id?: string | null
  scope: AgentScope
  enabled: boolean
  has_api_key: boolean
}

export interface AgentPreset {
  id: string
  name: string
  provider_kind: string
  protocol: AgentProtocol
  base_url: string
  model: string
  context_window_input: number
  context_window_output: number
  needs_api_key: boolean
}

export interface AgentConfigBundle {
  active_profile_id: string
  active_scope: AgentScope
  can_manage_global: boolean
  can_manage_personal: boolean
  profiles: AgentProfile[]
  presets: AgentPreset[]
}

export interface AgentProfileUpdate {
  scope?: AgentScope
  name?: string
  protocol?: AgentProtocol
  base_url?: string
  model?: string
  context_window_input?: number
  context_window_output?: number
  api_key?: string | null
  clear_api_key?: boolean
}

export interface AgentModelsRefreshResult {
  profile_id: string
  models: string[]
  manual: boolean
  error?: string | null
}

/** 助手日额度（`GET /agent/quota`，只读，不消耗额度）。 */
export interface AgentQuota {
  /** account=已登录（不占访客额度）；guest=未登录访客。 */
  scope: 'account' | 'guest'
  /** 当日上限；0 表示不限。 */
  limit: number
  /** 今日已用次数。 */
  used: number
  /** 剩余次数；不限时为 -1。 */
  remaining: number
  /** 剩余百分比 0~100；不限时为 100。 */
  percent: number
  /** 恢复时刻（ISO 8601，北京时间次日 0 点）。 */
  reset_at: string
  /** 今日是否已用尽。 */
  blocked: boolean
  /** 用尽时的原因文案（直接展示给用户）。 */
  message?: string | null
}

/**
 * 查询今日助手额度。
 *
 * `silent`：拉额度是背景请求，不触发全局 loading，避免每次发完消息闪一下。
 */
export function getAgentQuota(): Promise<AgentQuota> {
  return requestJson<AgentQuota>('/agent/quota', { silent: true })
}

export function postAgentChat(
  body: AgentChatRequest,
  init?: { signal?: AbortSignal; timeoutMs?: number; quotaToken?: string },
): Promise<AgentChatResponse> {
  return requestJson<AgentChatResponse>('/agent/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: init?.signal,
    timeoutMs: init?.timeoutMs,
    headers: init?.quotaToken ? { 'X-Agent-Quota-Continuation': init.quotaToken } : undefined,
  })
}

export interface AgentStreamHandlers {
  onToken?: (text: string) => void
  onStep?: (step: AgentStep) => void
  onIntent?: (intent: AgentUiIntent) => void
  onDone?: (res: AgentChatResponse) => void
  onError?: (detail: string) => void
  /** Fired once the HTTP response is OK and the SSE body is ready to read. */
  onConnected?: () => void
  /** The original request is being checked read-only after a broken stream. */
  onRecovering?: () => void
}

type AgentRecoveryProof = { requestId: string; recoveryKey: string }

function createAgentRecoveryProof(): AgentRecoveryProof | null {
  try {
    const bytes = new Uint8Array(48)
    if (!globalThis.crypto?.getRandomValues) return null
    globalThis.crypto.getRandomValues(bytes)
    const hex = (part: Uint8Array) => Array.from(part, byte => byte.toString(16).padStart(2, '0')).join('')
    return { requestId: hex(bytes.subarray(0, 16)), recoveryKey: hex(bytes.subarray(16)) }
  } catch {
    return null // Never replace a missing secure random source with predictable proof.
  }
}

function waitForRecoveryPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = globalThis.setTimeout(finish, 1000)
    const abort = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Recovery never submits the operation again. Its deadline is independent of the broken SSE. */
async function recoverAgentChat(
  proof: AgentRecoveryProof, originalHeaders: Record<string, string>, external?: AbortSignal,
): Promise<AgentChatResponse | null> {
  external?.throwIfAborted()
  const controller = new AbortController()
  const stop = () => controller.abort(external?.reason)
  external?.addEventListener('abort', stop, { once: true })
  const timer = globalThis.setTimeout(() => controller.abort(
    new DOMException('原请求结果确认超时', 'TimeoutError'),
  ), 20_000)
  const headers = withWriteAuthHeaders({ ...originalHeaders, Accept: 'application/json',
    'X-Agent-Recovery-Key': proof.recoveryKey }, 'GET', true)
  try {
    for (;;) {
      controller.signal.throwIfAborted()
      let response: Response
      try {
        response = await fetch(resolveApiUrl(`/agent/chat/recovery/${encodeURIComponent(proof.requestId)}`), {
          method: 'GET', credentials: 'include', headers, signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        await waitForRecoveryPoll(controller.signal)
        continue
      }
      controller.signal.throwIfAborted()
      if (response.status === 404) return null
      if (!response.ok) {
        if (response.status === 401) handleSessionExpired()
        throw new Error(`无法确认原请求结果（HTTP ${response.status}）`)
      }
      const raw: unknown = await response.json()
      controller.signal.throwIfAborted()
      const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
      if (data?.state === 'failed') throw new Error('原请求未能完成，未重新提交操作。')
      if (data?.state === 'completed') {
        const result = data.result as Partial<AgentChatResponse> | undefined
        return result && typeof result.session_id === 'string' && typeof result.reply === 'string'
          && Array.isArray(result.ui_intents) ? result as AgentChatResponse : null
      }
      if (data?.state !== 'pending') return null
      await waitForRecoveryPoll(controller.signal)
    }
  } catch (error) {
    external?.throwIfAborted()
    if (controller.signal.aborted) return null
    throw error
  } finally {
    globalThis.clearTimeout(timer)
    external?.removeEventListener('abort', stop)
  }
}

/** POST SSE once; after a transport interruption only read back that same request. */
export async function streamAgentChat(
  body: AgentChatRequest,
  handlers: AgentStreamHandlers = {},
  init?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<AgentChatResponse> {
  init?.signal?.throwIfAborted()
  const timeoutMs = init?.timeoutMs ?? 180_000
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort(new DOMException(`请求超时（${timeoutMs}ms）`, 'AbortError'))
  }, timeoutMs)
  let forwardAbort: (() => void) | undefined
  let signal: AbortSignal = controller.signal
  if (init?.signal && typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any([init.signal, controller.signal])
  } else if (init?.signal) {
    const external = init.signal
    forwardAbort = () => controller.abort(external.reason)
    external.addEventListener('abort', forwardAbort, { once: true })
  }
  const proof = createAgentRecoveryProof()
  const headers = withWriteAuthHeaders({
    'Content-Type': 'application/json', Accept: 'text/event-stream',
    'X-Visitor-Id': getVisitorId(),
    ...(proof ? { 'X-Agent-Request-ID': proof.requestId, 'X-Agent-Recovery-Key': proof.recoveryKey } : {}),
  }, 'POST')
  let transportFailure = false
  let final: AgentChatResponse | null = null
  let streamError: string | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let response: Response
    try {
      response = await fetch(resolveApiUrl('/agent/chat/stream'), {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify(body), signal,
      })
    } catch (error) {
      transportFailure = true
      throw error
    }
    init?.signal?.throwIfAborted()
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const raw: unknown = await response.json()
        const rec = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
        detail = typeof rec?.detail === 'string' ? rec.detail
          : typeof rec?.user_message === 'string' ? rec.user_message : detail
      } catch { /* keep the HTTP failure */ }
      if (response.status === 401 && !isAuthBootstrapPath('/agent/chat/stream')) handleSessionExpired()
      throw new Error(detail)
    }
    if (!response.body) {
      transportFailure = true
      throw new Error('流式响应无 body')
    }
    handlers.onConnected?.()
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const dispatchBlock = (rawEvent: string, rawData: string) => {
      if (final || streamError) return
      let data: Record<string, unknown>
      try { data = JSON.parse(rawData) as Record<string, unknown> } catch { return }
      const event = rawEvent || 'message'
      if (event === 'token') {
        const text = typeof data.text === 'string' ? data.text : ''
        if (text) handlers.onToken?.(text)
      } else if (event === 'step') {
        handlers.onStep?.({ type: (data.type as AgentStep['type']) || 'thought',
          summary: String(data.summary || ''), detail: typeof data.detail === 'string' ? data.detail : null })
      } else if (event === 'intent') {
        handlers.onIntent?.({ name: String(data.name || ''), args: (data.args as Record<string, unknown>) || {} })
      } else if (event === 'done') {
        final = data as unknown as AgentChatResponse
        handlers.onDone?.(final)
      } else if (event === 'error') {
        streamError = String(data.detail || '流式对话失败')
        handlers.onError?.(streamError)
      }
    }
    const flushBuffer = (chunk: string) => {
      buffer = (buffer + chunk).replace(/\r\n/g, '\n')
      for (;;) {
        const sep = buffer.indexOf('\n\n')
        if (sep < 0) break
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        let event = 'message'
        const lines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart())
        }
        if (lines.length) dispatchBlock(event, lines.join('\n'))
      }
    }
    while (!final && !streamError) {
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await reader.read() } catch (error) { transportFailure = true; throw error }
      init?.signal?.throwIfAborted()
      if (part.done) break
      flushBuffer(decoder.decode(part.value, { stream: true }))
    }
    flushBuffer(decoder.decode())
    if (streamError) throw new Error(streamError)
    if (!final) {
      transportFailure = true
      throw new Error('流式对话未收到 done 事件')
    }
    return final
  } catch (error) {
    init?.signal?.throwIfAborted()
    if (!transportFailure || streamError || !proof) throw error
    globalThis.clearTimeout(timeoutId)
    void reader?.cancel().catch(() => {})
    handlers.onRecovering?.()
    const recovered = await recoverAgentChat(proof, headers, init?.signal)
    init?.signal?.throwIfAborted()
    if (!recovered) throw error
    handlers.onDone?.(recovered)
    return recovered
  } finally {
    globalThis.clearTimeout(timeoutId)
    if (forwardAbort) init?.signal?.removeEventListener('abort', forwardAbort)
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

export function confirmAgentAction(body: AgentConfirmRequest): Promise<AgentConfirmResponse> {
  return requestJson<AgentConfirmResponse>('/agent/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function fetchAgentConfig(): Promise<AgentConfigBundle> {
  const raw = await requestJson<Partial<AgentConfigBundle> & Record<string, unknown>>(
    '/agent/config',
    { sensitiveGet: true },
  )
  // 旧版单配置响应：无 profiles[]
  if (!Array.isArray(raw?.profiles) && (raw?.provider != null || raw?.has_api_key != null)) {
    throw new Error(
      '后端 Agent API 仍为旧版（无多配置档）。请执行 launch.py restart fastapi 后硬刷新页面。',
    )
  }
  const rawProfiles = Array.isArray(raw?.profiles) ? raw.profiles : []
  const profiles: AgentProfile[] = rawProfiles.map((p) => ({
    ...p,
    scope: p.scope === 'personal' ? 'personal' : 'global',
    enabled: Boolean(p.enabled),
    has_api_key: Boolean(p.has_api_key),
    name: String(p.name || p.id || '未命名'),
    id: String(p.id || ''),
    provider_kind: String(p.provider_kind || 'custom'),
    protocol: (p.protocol === 'anthropic' || p.protocol === 'demo'
      ? p.protocol
      : 'openai') as AgentProtocol,
    base_url: String(p.base_url || ''),
    model: String(p.model || ''),
    context_window_input: Number(p.context_window_input) || 8192,
    context_window_output: Number(p.context_window_output) || 4096,
  }))
  const presets = Array.isArray(raw?.presets) ? (raw.presets as AgentPreset[]) : []
  return {
    active_profile_id: String(raw?.active_profile_id ?? profiles[0]?.id ?? ''),
    active_scope: raw?.active_scope === 'personal' ? 'personal' : 'global',
    can_manage_global: Boolean(raw?.can_manage_global),
    can_manage_personal: Boolean(raw?.can_manage_personal),
    profiles,
    presets,
  }
}

export function createAgentProfile(body: {
  preset_id: string
  name?: string
  scope?: AgentScope
}): Promise<AgentProfile> {
  return requestJson<AgentProfile>('/agent/config/profiles', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAgentProfile(
  profileId: string,
  body: AgentProfileUpdate,
): Promise<AgentProfile> {
  return requestJson<AgentProfile>(`/agent/config/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteAgentProfile(
  profileId: string,
  scope: AgentScope = 'personal',
): Promise<AgentConfigBundle> {
  return requestJson<AgentConfigBundle>(
    `/agent/config/profiles/${encodeURIComponent(profileId)}?scope=${encodeURIComponent(scope)}`,
    { method: 'DELETE' },
  )
}

export function setActiveAgentProfile(
  profileId: string,
  scope: AgentScope = 'personal',
): Promise<AgentConfigBundle> {
  return requestJson<AgentConfigBundle>('/agent/config/active', {
    method: 'POST',
    body: JSON.stringify({ profile_id: profileId, scope }),
  })
}

export function useGlobalAgentProfile(): Promise<AgentConfigBundle> {
  return requestJson<AgentConfigBundle>('/agent/config/use-global', {
    method: 'POST',
    body: '{}',
  })
}

export function refreshAgentModels(
  profileId?: string,
  scope?: AgentScope,
  options?: { base_url?: string | null; api_key?: string | null },
): Promise<AgentModelsRefreshResult> {
  return requestJson<AgentModelsRefreshResult>('/agent/models/refresh', {
    method: 'POST',
    body: JSON.stringify({
      profile_id: profileId ?? null,
      scope: scope ?? null,
      base_url: options?.base_url?.trim() || null,
      api_key: options?.api_key?.trim() || null,
    }),
  })
}

export interface AgentSessionSummary {
  session_id: string
  updated_at: string
  preview: string
  message_count: number
}

export interface AgentSessionDetail {
  session_id: string
  updated_at: string
  messages: Array<{ role: string; content: string }>
}

export function listAgentSessions(
  limit = 40,
): Promise<{ sessions: AgentSessionSummary[]; count: number }> {
  const q = new URLSearchParams({ limit: String(limit) })
  return requestJson<{ sessions: AgentSessionSummary[]; count: number }>(
    `/agent/sessions?${q.toString()}`,
    { sensitiveGet: true },
  )
}

export function getAgentSession(sessionId: string): Promise<AgentSessionDetail> {
  return requestJson<AgentSessionDetail>(`/agent/sessions/${encodeURIComponent(sessionId)}`, {
    sensitiveGet: true,
  })
}

export function deleteAgentSession(
  sessionId: string,
): Promise<{ ok: boolean; session_id: string }> {
  return requestJson<{ ok: boolean; session_id: string }>(
    `/agent/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  )
}
