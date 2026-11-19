import { describe, expect, it, vi } from 'vitest'
import { runAgentOperationPlan, settleAgentResponse } from '@/components/agent/agent-operation-runner'
import type { AgentChatResponse, AgentOperation } from '@/services/agent-api'

const executeIntents = vi.hoisted(() => vi.fn())
vi.mock('@/components/agent/agent-ui-intent', () => ({ executeAgentUiIntents: executeIntents }))

const response = (extra: Partial<AgentChatResponse> = {}): AgentChatResponse => ({
  session_id: 'test', reply: '模型预告全部完成', ui_intents: [], ...extra,
})
const steps: AgentOperation[] = [
  { id: 'a', message: '显示A', operation: 'show_layer', inherit_target: false, inherit_time: false },
  { id: 'b', message: '查询当前显示图层', operation: 'query_state', inherit_target: false, inherit_time: false },
]

describe('ordered operation flow (simulated service and UI receipts)', () => {
  it('binds numbered references to that step even after a different target', async () => {
    const refs: unknown[] = []
    const plan = [steps[0], { ...steps[0], id: 'b', message: '显示B' },
      { ...steps[0], id: 'c', message: '隐藏第一步的图层', target_step_id: 'a', depends_on: 'a', inherit_target: true }]
    let index = 0
    await runAgentOperationPlan(response({ operation_plan: plan }), {
      signal: new AbortController().signal, context: () => ({}),
      request: async (_m, _s, ctx) => {
        refs.push(ctx.operation_reference?.catalog_id)
        return response({ operation_status: 'success', operation_target: { catalog_id: index++ === 0 ? 'A' : 'B' } })
      }, execute: async r => r,
    })
    expect(refs).toEqual([undefined, 'A', 'A'])
  })

  it.each(['plan_only', 'read_only'] as const)('never executes a %s response or plan', async mode => {
    executeIntents.mockClear()
    const request = vi.fn()
    const initial = response({ request_mode: mode, operation_plan: steps,
      ui_intents: [{ name: 'set_layer_visibility', args: { catalog_id: 'A', visible: true } }] })
    const settled = await settleAgentResponse(initial, {})
    expect(settled.ui_intents).toEqual([])
    await runAgentOperationPlan(initial, { signal: new AbortController().signal,
      context: () => ({}), request, execute: async r => r })
    expect(request).not.toHaveBeenCalled()
    expect(executeIntents).not.toHaveBeenCalled()
  })
  it('uses the actual added instance for a dependent selection and refreshes its query state', async () => {
    let selected = false
    let added = false
    const seen: unknown[] = []
    const plan: AgentOperation[] = [
      { id: 'a', message: '添加SMAP平均SM', operation: 'add_layer', inherit_target: false, inherit_time: false },
      { id: 'b', message: '选中它', operation: 'select_layer', depends_on: 'a', inherit_target: true, inherit_time: false },
      { id: 'c', message: '当前选中图层是什么', operation: 'query_state', inherit_target: false, inherit_time: false },
    ]
    const result = await runAgentOperationPlan(response({ operation_plan: plan }), {
      signal: new AbortController().signal,
      context: () => ({ active_layers: added ? [{
        catalog_id: 'actual-sm', instance_id: 'actual-instance', visible: false, selected,
        requested_time: { date: '2025-07-25', hour: 6 },
      }] : [] }),
      request: async (message, _session, ctx) => {
        seen.push({ reference: ctx.operation_reference, selected: ctx.active_layers?.[0]?.selected })
        const name = message.startsWith('添加') ? 'add_layer' : message.startsWith('选中') ? 'select_layer' : ''
        return response({ operation_status: 'pending',
          ui_intents: name ? [{ name, args: { catalog_id: 'requested-family' } }] : [] })
      },
      execute: async res => {
        if (res.ui_intents[0]?.name === 'add_layer') added = true
        if (res.ui_intents[0]?.name === 'select_layer') selected = true
        return { ...res, operation_status: 'success', reply: '实际完成',
          operation_target: res.ui_intents.length ? { catalog_id: 'actual-sm', instance_id: 'actual-instance' } : undefined }
      },
    })
    expect((seen[1] as { reference: unknown }).reference).toMatchObject({
      catalog_id: 'actual-sm', instance_id: 'actual-instance', date: '2025-07-25', hour: 6,
    })
    expect((seen[2] as { selected: boolean }).selected).toBe(true)
    expect(result.operation_status).toBe('success')
  })

  it('settles add/select against their actual receipts instead of the requested family identity', async () => {
    executeIntents.mockResolvedValueOnce([
      { ok: true, message: '已添加，当前隐藏', target: { catalog_id: 'runtime-sm', instance_id: 'new-instance' } },
    ])
    const result = await settleAgentResponse(response({ ui_intents: [
      { name: 'add_layer', args: { catalog_id: 'family-sm' } },
    ] }), {})
    expect(result.operation_target).toEqual({ catalog_id: 'runtime-sm', instance_id: 'new-instance' })
    expect(result.reply).toBe('成功：已添加，当前隐藏')
  })

  it('waits for actual mutation before building the query context', async () => {
    let visible = false
    const observed: boolean[] = []
    const result = await runAgentOperationPlan(response({ operation_plan: steps }), {
      signal: new AbortController().signal,
      context: () => ({ active_layers: [{ catalog_id: 'a', visible }] }),
      request: async (_message, _session, context) => {
        observed.push(context.active_layers![0].visible!)
        return response({ operation_status: 'success' })
      },
      execute: async res => { await Promise.resolve(); visible = true; return res },
    })
    expect(observed).toEqual([false, true])
    expect(result.reply).toContain('2. 成功')
  })

  it('continues independent steps after failure and skips a dependent statistic', async () => {
    const plan = [steps[0], { ...steps[1], id: 'dependent', depends_on: 'a' }, steps[1]]
    const request = vi.fn(async () => response({ operation_status: 'failed', reply: '取数失败' }))
    const result = await runAgentOperationPlan(response({ operation_plan: plan }), {
      signal: new AbortController().signal, context: () => ({}), request,
      execute: async res => res,
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.reply).toContain('2. 未执行')
    expect(result.reply).toContain('3. 失败')
  })

  it('cancels future steps while retaining the completed operation receipt', async () => {
    const controller = new AbortController()
    const request = vi.fn(async () => response({ operation_status: 'success', reply: '已显示A' }))
    const result = await runAgentOperationPlan(response({ operation_plan: steps }), {
      signal: controller.signal, context: () => ({}), request,
      execute: async res => { controller.abort(); return res },
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(result.reply).toContain('1. 成功')
    expect(result.reply).toContain('已显示A')
    expect(result.reply).toContain('2. 未执行')
  })

  it('does not apply a late response after cancellation', async () => {
    const controller = new AbortController()
    const execute = vi.fn(async res => res)
    const result = await runAgentOperationPlan(response({ operation_plan: steps }), {
      signal: controller.signal, context: () => ({}), execute,
      request: async () => { controller.abort(); return response({ ui_intents: [{ name: 'set_timeline', args: {} }] }) },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(result.reply).toContain('未执行')
  })

  it('main answer and receipt both preserve successes and data failures', async () => {
    executeIntents.mockResolvedValueOnce([
      { ok: true, message: '已显示VOD', commandId: 'cmd-a' },
      { ok: false, message: '日期控件已改变，单日取数失败', commandId: 'cmd-b' },
    ])
    const result = await settleAgentResponse(response({ ui_intents: [
      { name: 'set_layer_visibility', args: { catalog_id: 'vod' } },
      { name: 'set_timeline', args: { catalog_id: 'vod' } },
    ] }), {})
    expect(result.reply).toBe('成功：已显示VOD\n\n失败：日期控件已改变，单日取数失败')
    expect(result.steps!.map(s => s.summary).join('\n\n')).toBe(result.reply)
    expect(result.operation_status).toBe('failed')
    expect(result.ui_intents).toEqual([])
  })

  it('preserves an actual NoData query instead of inventing a number', async () => {
    const result = await settleAgentResponse(response({ reply: '广州市：NoData，没有有效像元。', operation_status: 'success' }), {})
    expect(result.reply).toContain('NoData')
    expect(result.ui_intents).toEqual([])
  })

  it('keeps an unresolved parallel target alongside the successful UI receipt', async () => {
    executeIntents.mockResolvedValueOnce([{ ok: true, message: '已隐藏SM' }])
    const result = await settleAgentResponse(response({
      ui_intents: [{ name: 'set_layer_visibility', args: { catalog_id: 'sm', visible: false } }],
      operation_issues: [{ status: 'not_executed', message: '找不到星辰99图层' }],
    }), {})
    expect(result.operation_status).toBe('failed')
    expect(result.reply).toContain('成功：已隐藏SM')
    expect(result.reply).toContain('未执行：找不到星辰99图层')
    expect(result.steps!.map(s => s.summary).join('\n\n')).toBe(result.reply)
  })
})


describe('server-issued quota continuations', () => {
  it('forwards each exact authorized step and its own continuation token', async () => {
    const plan = [
      { ...steps[0], quota_token: 'server-token-a', constraints: ['其他图层保持不变'] },
      { ...steps[1], quota_token: 'server-token-b' },
    ]
    const request = vi.fn(async () => response({ operation_status: 'success' }))
    await runAgentOperationPlan(response({ operation_plan: plan }), {
      signal: new AbortController().signal, context: () => ({}), request,
      execute: async res => res,
    })
    expect(request).toHaveBeenNthCalledWith(1, '显示A，其他图层保持不变', 'test',
      expect.objectContaining({ operation_single: true, operation_step_id: 'a' }), 'server-token-a')
    expect(request).toHaveBeenNthCalledWith(2, '查询当前显示图层', 'test',
      expect.objectContaining({ operation_single: true, operation_step_id: 'b' }), 'server-token-b')
  })

  it('preserves account plans without inventing a continuation token', async () => {
    const request = vi.fn(async () => response({ operation_status: 'success' }))
    await runAgentOperationPlan(response({ operation_plan: steps }), {
      signal: new AbortController().signal, context: () => ({}), request,
      execute: async res => res,
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(call => call[3] === undefined)).toBe(true)
  })
})
