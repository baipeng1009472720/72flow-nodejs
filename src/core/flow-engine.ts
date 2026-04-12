import {
  FlowDefinition, FlowResult, NodeStatus, NodeType, NodeDef,
} from '../types/models.js';
import { FlowContext } from './flow-context.js';
import { NodeExecutorFactory } from '../executors/factory.js';
import { createLogger } from '../support/logger.js';

const log = createLogger('Engine');

// 浏览器原生 EventTarget —— 兼容 Browser 和 Node.js (18+)
// 避免依赖 Node.js 专有的 'events' 模块
type EventHandler = (...args: any[]) => void;

class SimpleEmitter {
  private handlers: Map<string, EventHandler[]> = new Map();

  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }

  once(event: string, handler: EventHandler) {
    const wrapper = (...args: any[]) => {
      handler(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  off(event: string, handler: EventHandler) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter(h => h !== handler));
    return this;
  }

  emit(event: string, ...args: any[]) {
    const list = this.handlers.get(event) ?? [];
    for (const h of list) {
      try { h(...args); } catch (e) { /* ignore listener errors */ }
    }
    return this;
  }
}

export class FlowEngine extends SimpleEmitter {
  private activeContexts: Map<string, FlowContext> = new Map();

  constructor() {
    super();
  }

  // ─── 公开入口 ────────────────────────────────────────────
  public async execute(
    definition: FlowDefinition, 
    variables: Record<string, any> = {},
    options: { stream?: boolean } = {}
  ): Promise<FlowResult> {
    const executionId = `exec-${Math.random().toString(36).slice(2, 10)}`;
    const context = new FlowContext(executionId, definition, variables);
    
    // 设置流式模式
    if (options.stream !== undefined) {
      context.setStreamingMode(options.stream);
    }
    
    this.activeContexts.set(executionId, context);

    // 注入流式转发逻辑
    context.setStreamHandler((nodeId, chunk) => {
      if (nodeId === '__node_event__') {
        const { type, ...payload } = chunk;
        if (type === 'completed') {
           this.emit('node.completed', payload);
        } else if (type === 'failed') {
           this.emit('node.failed', payload);
        }
      } else {
        this.emit('node.stream', { executionId, nodeId, chunk });
      }
    });

    return new Promise<FlowResult>((resolve) => {
      this.once(`flow.finished.${executionId}`, () => {
        this.activeContexts.delete(executionId);
        resolve(this.buildResult(context));
      });

      // 找到 START 节点，开始驱动
      const startNode = context.getNodes().find(
        n => String(n.type).toUpperCase() === 'START'
      );
      if (!startNode) {
        context.setStatus(NodeStatus.FAILED);
        this.emit(`flow.finished.${executionId}`);
        return;
      }
      this.scheduleNode(context, startNode.id);
    });
  }

  // ─── 调度单个节点（setTimeout(0) 让并行可以真正并发，兼容浏览器）────
  private scheduleNode(context: FlowContext, nodeId: string) {
    setTimeout(() => this.runNode(context, nodeId), 0);
  }

  // ─── 执行单个节点 ────────────────────────────────────────
  private async runNode(context: FlowContext, nodeId: string) {
    const executionId = context.getExecutionId();

    // 防重入 & 已跳过 & 已完成
    if (context.getCompletedNodes().has(nodeId)) return;
    if (context.getSkippedNodes().has(nodeId))   return;
    if (!context.tryExecute(nodeId))             return;

    // 前置依赖检查（汇聚节点：等所有入边都完成/跳过才能执行）
    if (!context.arePrerequisitesMet(nodeId)) {
      // 还没到条件，释放锁，等其他分支完成后再次触发
      context.getExecutingNodes().delete(nodeId);
      return;
    }

    const node = context.getNode(nodeId);
    if (!node) {
      log.warn(`节点 [${nodeId}] 不存在，跳过`);
      return;
    }

    const type = String(node.type).toUpperCase();
    log.debug(`RUN [${nodeId}] type=${type}`);
    this.emit('node.starting', { executionId, nodeId });

    const t0 = Date.now();
    try {
      const result = await NodeExecutorFactory.execute(node, context);
      if (!result.success) {
        context.fail(nodeId, result.message ?? 'Unknown error', t0);
        this.handleFailure(context, nodeId, result.message ?? '');
        return;
      }

      context.complete(nodeId, result.data, t0);
      this.emit('node.completed', { executionId, nodeId, output: result.data });

      // ── END 节点 → 流程完成 ──
      if (type === 'END') {
        context.setStatus(NodeStatus.COMPLETED);
        this.emit(`flow.finished.${executionId}`);
        return;
      }

      // ── LOOP_START 完成 → 路由到 loopEndNodeId 的下游 ──
      if (type === 'LOOP') {
        const loopType = String((node.config as any)?.loop?.loopType ?? '').toUpperCase();
        if (loopType === 'START') {
          const loopEndNodeId = result.data?.__loopEndNodeId;
          if (loopEndNodeId) {
            // LOOP_START 已内联完成了 LOOP_END，从 LOOP_END 的下游继续
            for (const e of context.getOutgoing(loopEndNodeId)) {
              this.triggerDownstream(context, loopEndNodeId, e.to);
            }
          } else {
            // 没有 loopEndNodeId，从自身出边（排除回路的 loop 出边）触发
            for (const e of context.getOutgoing(nodeId)) {
              this.triggerDownstream(context, nodeId, e.to);
            }
          }
          return;
        }
      }

      // ── DECISION / CONDITION → 只触发选中分支 ──
      if (type === 'DECISION' || type === 'CONDITION') {
        const selected = result.data?.selectedBranch;
        if (selected) {
          this.scheduleNode(context, selected);
        } else {
          this.handleFailure(context, nodeId, 'No branch matched');
        }
        return;
      }

      // ── PARALLEL → 并行触发所有出边 ──
      // (convergeMap 已在 ParallelExecutor 中注册)
      if (type === 'PARALLEL') {
        for (const e of context.getOutgoing(nodeId)) {
          this.scheduleNode(context, e.to);
        }
        return;
      }

      // ── 普通节点 → 触发下游 ──
      for (const e of context.getOutgoing(nodeId)) {
        this.triggerDownstream(context, nodeId, e.to);
      }
    } catch (e: any) {
      context.fail(nodeId, e.message, t0);
      this.handleFailure(context, nodeId, e.message);
    }
  }

  /**
   * 触发下游节点。有汇聚时，等所有【非跳过】入边到达后才 schedule。
   */
  private triggerDownstream(context: FlowContext, fromNodeId: string, toNodeId: string) {
    const incoming = context.getIncoming(toNodeId);

    // 单入边：直接调度
    if (incoming.length <= 1) {
      this.scheduleNode(context, toNodeId);
      return;
    }

    // 多入边（汇聚节点）：计算实际需要等待的入边数量（排除已跳过的）
    // 这里不能依赖 convergeStates，因为分支场景下 end 节点不是 PARALLEL 的汇聚点
    // 统计当前「有效到达」的入边：已完成 or 已跳过的节点
    const effectiveDone = incoming.filter(e =>
      context.getCompletedNodes().has(e.from) ||
      context.getSkippedNodes().has(e.from)
    ).length;

    if (effectiveDone >= incoming.length) {
      // 所有有效入边已就绪
      this.scheduleNode(context, toNodeId);
    }
    // 否则等待其他分支
  }

  // ─── 失败处理 ─────────────────────────────────────────
  private handleFailure(context: FlowContext, nodeId: string, error: string) {
    const executionId = context.getExecutionId();
    const node = context.getNode(nodeId);
    const errorMode = (node?.config as any)?.error?.mode;

    log.error(`节点 [${nodeId}] 失败: ${error}`);
    this.emit('node.failed', { executionId, nodeId, error });

    // 错误路由（error.mode 为目标节点 ID）
    if (errorMode && errorMode !== 'throw' && errorMode !== 'fail') {
      const target = context.getNode(errorMode);
      if (target) {
        this.scheduleNode(context, target.id);
        return;
      }
    }

    context.setStatus(NodeStatus.FAILED);
    this.emit(`flow.finished.${executionId}`);
  }

  // ─── 结果构建 ─────────────────────────────────────────
  private buildResult(context: FlowContext): FlowResult {
    const traces = context.getTraces();
    // 优先从 traces 找最后一个成功的 END 节点产出
    const endTrace = [...traces].reverse().find(t => {
      const node = context.getNode(t.nodeId);
      return (node?.type?.toUpperCase() === 'END' || t.code?.startsWith('END')) && t.status === NodeStatus.COMPLETED;
    });

    const endOutput = endTrace ? endTrace.data : undefined;

    return {
      executionId: context.getExecutionId(),
      status:  context.getStatus(),
      output:  endOutput,
      error:   context.getTraces().find(t => t.status === NodeStatus.FAILED)?.error,
      duration:  context.getDuration(),
      startTime: context.getStartTime(),
      endTime:   context.getEndTime(),
      variables: context.getVariables(),
      traces:    context.getTraces(),
    };
  }
}
