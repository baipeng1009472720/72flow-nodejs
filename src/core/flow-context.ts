import { FlowDefinition, NodeDef, EdgeDef, NodeStatus } from '../types/models.js';

export interface ExecutionTrace {
  nodeId: string;
  /** 节点业务编码（如 DECISION_abc），用于 UI 图标和 nodeMap 查询 */
  code?: string;
  status: NodeStatus;
  startTime: number;
  endTime?: number;
  /** 耗时毫秒 */
  duration?: number;
  /** 耗时纳秒（与 Java 后端格式对齐，供 ExecutionResultModal 使用）*/
  durationNs?: number;
  data?: any;
  error?: string;
}

export class FlowContext {
  private executionId: string;
  private definition: FlowDefinition;
  private variables: Record<string, any>;
  private status: NodeStatus = NodeStatus.PENDING;
  private startTime: number;
  private endTime?: number;

  // ── 性能索引（O(1) 查询）────────────────
  private nodeMap: Map<string, NodeDef> = new Map();
  private outgoingMap: Map<string, EdgeDef[]> = new Map();
  private incomingMap: Map<string, EdgeDef[]> = new Map();

  // ── 执行状态 ─────────────────────────────
  private completedNodes: Set<string> = new Set();
  private executingNodes: Set<string> = new Set();
  private skippedNodes: Set<string> = new Set();
  private nodeOutputs: Record<string, any> = {};
  private convergeStates: Map<string, { arrived: Set<string>; expected: number }> = new Map();
  private traces: ExecutionTrace[] = [];
  private onStreamHandler?: (nodeId: string, chunk: any) => void;
  private streamingMode: boolean = false;

  constructor(executionId: string, definition: FlowDefinition, variables: Record<string, any>) {
    this.executionId = executionId;
    this.definition = definition;
    this.variables = { ...variables };
    this.startTime = Date.now();
    this.buildIndex();
  }

  public setStreamingMode(enabled: boolean) {
    this.streamingMode = enabled;
  }

  public isStreamingEnabled(): boolean {
    return this.streamingMode;
  }

  /** 构造时预建索引，所有后续查询均为 O(1) */
  private buildIndex() {
    for (const node of this.definition.nodes) {
      this.nodeMap.set(node.id, node);
    }
    for (const edge of this.definition.edges) {
      if (!this.outgoingMap.has(edge.from)) this.outgoingMap.set(edge.from, []);
      if (!this.incomingMap.has(edge.to))   this.incomingMap.set(edge.to, []);
      this.outgoingMap.get(edge.from)!.push(edge);
      this.incomingMap.get(edge.to)!.push(edge);
    }
  }

  // ── Getters ──────────────────────────────
  public getExecutionId()  { return this.executionId; }
  public getDefinition()   { return this.definition; }
  public getVariables()    { return { ...this.variables }; }
  public getStatus()       { return this.status; }
  public getStartTime()    { return this.startTime; }
  public getEndTime()      { return this.endTime; }
  public getDuration()     { return (this.endTime ?? Date.now()) - this.startTime; }
  public getNodes()        { return this.definition.nodes; }
  public getNode(id: string) { return this.nodeMap.get(id); }
  public getOutgoing(nodeId: string): EdgeDef[] { return this.outgoingMap.get(nodeId) ?? []; }
  public getIncoming(nodeId: string): EdgeDef[] { return this.incomingMap.get(nodeId) ?? []; }
  public getCompletedNodes()  { return this.completedNodes; }
  public getSkippedNodes()    { return this.skippedNodes; }
  public getExecutingNodes()  { return this.executingNodes; }
  public getNodeOutputs()     { return { ...this.nodeOutputs }; }
  public getTraces()          { return [...this.traces]; }

  public setStatus(status: NodeStatus) {
    this.status = status;
    if ([NodeStatus.COMPLETED, NodeStatus.FAILED, NodeStatus.CANCELLED].includes(status)) {
      this.endTime = Date.now();
    }
  }

  /** 设置单个变量（供 LoopExecutor 写入 item/index 等迭代变量） */
  public setVariable(key: string, value: any) {
    this.variables[key] = value;
  }

  public skipNode(nodeId: string) {
    this.skippedNodes.add(nodeId);
  }

  /** 注册并行汇聚点，expected = 分支数 */
  public registerConvergence(nodeId: string, expected: number) {
    this.convergeStates.set(nodeId, { arrived: new Set(), expected });
  }

  // ── 前置依赖检查（带跳过传播）────────────

  public arePrerequisitesMet(nodeId: string): boolean {
    const incoming = this.getIncoming(nodeId);
    if (incoming.length === 0) return true;
    return incoming.every(e =>
      this.completedNodes.has(e.from) ||
      this.isEffectivelySkipped(e.from, new Set())
    );
  }

  private isEffectivelySkipped(nodeId: string, visited: Set<string>): boolean {
    if (this.skippedNodes.has(nodeId))   return true;
    if (this.completedNodes.has(nodeId)) return false;
    if (visited.has(nodeId))             return false;
    visited.add(nodeId);
    const incoming = this.getIncoming(nodeId);
    if (incoming.length === 0) return false;
    return incoming.every(e => this.isEffectivelySkipped(e.from, visited));
  }

  // ── 执行状态管理 ─────────────────────────

  public tryExecute(nodeId: string): boolean {
    if (this.executingNodes.has(nodeId)) return false;
    this.executingNodes.add(nodeId);
    return true;
  }

  public complete(nodeId: string, output: any, startTime: number) {
    const endTime = Date.now();
    this.executingNodes.delete(nodeId);
    this.completedNodes.add(nodeId);

    const node = this.getNode(nodeId);
    if (node) {
      const key = node.code ?? nodeId;
      if (output !== undefined && output !== null) {
        this.nodeOutputs[key] = output;
      }
      // 将输出对象合并到全局变量（排除引擎内部私有字段）
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        for (const [k, v] of Object.entries(output)) {
          if (!k.startsWith('__')) {
            this.variables[k] = v;
          }
        }
      }
    }

    const durationMs = endTime - startTime;
    const durationNs = durationMs * 1_000_000;

    this.traces.push({
      nodeId,
      code:       node?.code ?? nodeId,
      status:     NodeStatus.COMPLETED,
      startTime,
      endTime,
      duration:   durationMs,
      durationNs: durationNs,   // 毫秒 → 纳秒，与 Java 对齐
      data:       output,
    });

    // 发射带完整执行报告的完成事件
    this.emitStream('__node_event__', {
      type: 'completed',
      nodeId,
      output,
      startTime,
      endTime,
      duration: durationMs,
      durationNs
    });
  }

  public fail(nodeId: string, error: Error | string, startTime: number) {
    const endTime = Date.now();
    this.executingNodes.delete(nodeId);
    const message = error instanceof Error ? error.message : error;
    const durationMs = endTime - startTime;
    const failNode = this.getNode(nodeId);
    this.traces.push({
      nodeId,
      code:       failNode?.code ?? nodeId,
      status:     NodeStatus.FAILED,
      startTime,
      endTime,
      duration:   durationMs,
      durationNs: durationMs * 1_000_000,
      error:      message,
    });
  }

  /** 并行汇聚：返回 true 代表当前节点所有分支已全部到达 */
  public tryConverge(nodeId: string, fromNodeId: string): boolean {
    const state = this.convergeStates.get(nodeId);
    if (state) {
      state.arrived.add(fromNodeId);
      return state.arrived.size >= state.expected;
    }
    // 未注册汇聚 → 按多入边数量判断（兼容未使用 PARALLEL 节点的场景）
    const incoming = this.getIncoming(nodeId);
    if (incoming.length > 1) {
      if (!this.convergeStates.has(nodeId)) {
        this.convergeStates.set(nodeId, { arrived: new Set(), expected: incoming.length });
      }
      const s = this.convergeStates.get(nodeId)!;
      s.arrived.add(fromNodeId);
      return s.arrived.size >= s.expected;
    }
    return true;
  }

  /** 获取 LOOP_START 节点的循环体路径（来自解析器预计算的 loopBodyPaths） */
  public getLoopBodyPath(loopStartNodeId: string): string[] {
    return this.definition.loopBodyPaths?.[loopStartNodeId] ?? [];
  }

  /** 设置流式消息处理器（内部由 FlowEngine 调用以向外广播） */
  public setStreamHandler(handler: (nodeId: string, chunk: any) => void) {
    this.onStreamHandler = handler;
  }

  /** 发射流式消息块（由执行器调用） */
  public emitStream(nodeId: string, chunk: any) {
    if (this.onStreamHandler) {
      this.onStreamHandler(nodeId, chunk);
    }
  }
}
