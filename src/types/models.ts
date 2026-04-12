/**
 * 节点状态枚举
 */
export enum NodeStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
  CANCELLED = 'CANCELLED'
}

/**
 * 节点类型枚举
 */
export enum NodeType {
  START = 'START',
  END = 'END',
  SCRIPT = 'SCRIPT',
  DECISION = 'DECISION',
  CONDITION = 'CONDITION',
  PARALLEL = 'PARALLEL',
  LOOP = 'LOOP',
  API = 'API',
  SUBFLOW = 'SUBFLOW',
  LLM = 'LLM',
  BUSINESS = 'BUSINESS'
}

/**
 * 边定义
 */
export interface EdgeDef {
  id: string;
  name?: string;
  from: string;
  to: string;
  condition?: string;
  metadata?: Record<string, any>;
}

/**
 * 节点配置定义
 */
export interface NodeConfigDef {
  script?: string;
  api?: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  };
  loop?: {
    condition?: string;
    items?: string;
    endNodeId?: string;
  };
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  error?: {
    mode: 'throw' | 'fail' | string; // string 为跳转的节点 ID
  };
  [key: string]: any;
}

/**
 * 节点定义
 */
export interface NodeDef {
  id: string;
  type: string | NodeType;
  name?: string;
  code?: string;
  config?: NodeConfigDef;
  metadata?: Record<string, any>;
}

/**
 * 流程定义
 */
export interface FlowDefinition {
  id: string;
  name: string;
  version: string;
  nodes: NodeDef[];
  edges: EdgeDef[];
  metadata?: Record<string, any>;
  convergeMap?: Record<string, string>; // 并行节点 ID -> 汇聚节点 ID
  loopBodyPaths?: Record<string, string[]>; // LOOP_START 节点 ID -> 循环体路径
}

/**
 * 节点执行结果
 */
export interface NodeResult {
  success: boolean;
  data?: any;
  message?: string;
  code?: string;
}

/**
 * 流程执行结果
 */
export interface FlowResult {
  executionId: string;
  status: NodeStatus;
  output?: any;
  error?: string;
  duration: number;
  startTime: number;
  endTime?: number;
  variables: Record<string, any>;
  traces: any[];
}
