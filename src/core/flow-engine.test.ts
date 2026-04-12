import { describe, it, expect, vi } from 'vitest';
import { FlowEngine } from './flow-engine.js';
import { FlowDefinition, NodeType, NodeStatus } from '../types/models.js';
import { X6Parser, parseX6 } from '../parser/x6-parser.js';

// ── 辅助：构建最简流程 ─────────────────────────────────
function linearFlow(scriptCode: string): FlowDefinition {
  return {
    id: 'test', name: 'test', version: '1.0',
    nodes: [
      { id: 'start',   type: NodeType.START },
      { id: 'script1', type: NodeType.SCRIPT, config: { script: scriptCode } as any },
      { id: 'end',     type: NodeType.END },
    ],
    edges: [
      { id: 'e1', from: 'start',   to: 'script1' },
      { id: 'e2', from: 'script1', to: 'end' },
    ],
  };
}

// ─────────────────────────────────────────────────────────
describe('FlowEngine — 基础流程', () => {
  it('线性流程：START → SCRIPT → END', async () => {
    const engine = new FlowEngine();
    const def = linearFlow('count = (count || 0) + 1');
    const result = await engine.execute(def, { count: 0 });
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.count).toBe(1);
    expect(result.traces).toHaveLength(3);
  });

  it('SCRIPT 可以新增变量（Proxy 修复验证）', async () => {
    const engine = new FlowEngine();
    const def = linearFlow('newVar = "hello"');
    const result = await engine.execute(def, {});
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.newVar).toBe('hello');
  });

  it('SCRIPT 执行失败时流程失败', async () => {
    const engine = new FlowEngine();
    const def = linearFlow('throw new Error("boom")');
    const result = await engine.execute(def, {});
    expect(result.status).toBe(NodeStatus.FAILED);
  });
});

// ─────────────────────────────────────────────────────────
describe('FlowEngine — 分支流程', () => {
  function branchFlow(): FlowDefinition {
    return {
      id: 'branch', name: 'branch', version: '1.0',
      nodes: [
        { id: 'start',    type: NodeType.START },
        { id: 'decision', type: NodeType.DECISION },
        { id: 'pathA',    type: NodeType.SCRIPT, config: { script: 'path = "A"' } as any },
        { id: 'pathB',    type: NodeType.SCRIPT, config: { script: 'path = "B"' } as any },
        { id: 'end',      type: NodeType.END },
      ],
      edges: [
        { id: 'e1', from: 'start',    to: 'decision' },
        { id: 'e2', from: 'decision', to: 'pathA', condition: 'val > 10' },
        { id: 'e3', from: 'decision', to: 'pathB', condition: 'val <= 10' },
        { id: 'e4', from: 'pathA',    to: 'end' },
        { id: 'e5', from: 'pathB',    to: 'end' },
      ],
    };
  }

  it('条件 val>10 → 走 pathA', async () => {
    const result = await new FlowEngine().execute(branchFlow(), { val: 20 });
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.path).toBe('A');
  });

  it('条件 val<=10 → 走 pathB', async () => {
    const result = await new FlowEngine().execute(branchFlow(), { val: 5 });
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.path).toBe('B');
  });
});

// ─────────────────────────────────────────────────────────
describe('FlowEngine — 并行流程', () => {
  it('PARALLEL 两分支都执行后汇聚', async () => {
    const def: FlowDefinition = {
      id: 'parallel', name: 'par', version: '1.0',
      nodes: [
        { id: 'start',  type: NodeType.START },
        { id: 'par',    type: NodeType.PARALLEL },
        { id: 'branchA', type: NodeType.SCRIPT, config: { script: 'a = 1' } as any },
        { id: 'branchB', type: NodeType.SCRIPT, config: { script: 'b = 2' } as any },
        { id: 'join',   type: NodeType.SCRIPT, config: { script: 'sum = (a||0) + (b||0)' } as any },
        { id: 'end',    type: NodeType.END },
      ],
      edges: [
        { id: 'e1', from: 'start',   to: 'par' },
        { id: 'e2', from: 'par',     to: 'branchA' },
        { id: 'e3', from: 'par',     to: 'branchB' },
        { id: 'e4', from: 'branchA', to: 'join' },
        { id: 'e5', from: 'branchB', to: 'join' },
        { id: 'e6', from: 'join',    to: 'end' },
      ],
      convergeMap: { par: 'join' },
    };
    const result = await new FlowEngine().execute(def, {});
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.sum).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────
describe('FlowEngine — LOOP 循环', () => {
  it('数组迭代：items=[1,2,3]，每次累加', async () => {
    const def: FlowDefinition = {
      id: 'loop', name: 'loop', version: '1.0',
      nodes: [
        { id: 'start',      type: NodeType.START },
        { id: 'loop_start', type: 'LOOP', config: { loop: { loopType: 'START', itemsExpr: 'items', itemVar: 'item', indexVar: 'idx' } } as any },
        { id: 'script',     type: NodeType.SCRIPT, config: { script: 'total = (total||0) + item' } as any },
        { id: 'loop_end',   type: 'LOOP', config: { loop: { loopType: 'END' } } as any },
        { id: 'end',        type: NodeType.END },
      ],
      edges: [
        { id: 'e1', from: 'start',      to: 'loop_start' },
        { id: 'e2', from: 'loop_start', to: 'script' },
        { id: 'e3', from: 'script',     to: 'loop_end' },
        { id: 'e4', from: 'loop_end',   to: 'end' },
      ],
      loopBodyPaths: { loop_start: ['script', 'loop_end'] },
    };
    const result = await new FlowEngine().execute(def, { items: [1, 2, 3], total: 0 });
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.total).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────
describe('X6Parser', () => {
  it('解析简单线性 X6 流程', () => {
    const x6Json = {
      nodes: [
        { id: 'n1', shape: 'START', data: { meta: { type: 'START' }, config: { code: 'START_n1', type: 'START' } } },
        { id: 'n2', shape: 'SCRIPT', data: { meta: { type: 'SCRIPT' }, config: { code: 'SCRIPT_n2', type: 'SCRIPT', script: 'x = 1' } } },
        { id: 'n3', shape: 'END', data: { meta: { type: 'END' }, config: { code: 'END_n3', type: 'END' } } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    };
    const def = parseX6(x6Json as any);
    expect(def.nodes).toHaveLength(3);
    expect(def.edges).toHaveLength(2);
    expect(def.nodes[0].type).toBe('START');
  });

  it('规范化 loop 字段：nodeType→loopType 大写', () => {
    const x6Json = {
      nodes: [
        { id: 'l1', shape: 'LOOP', data: { meta: { type: 'LOOP' }, config: { type: 'LOOP', loop: { nodeType: 'start', arrayExpression: 'items' } } } },
      ],
      edges: [],
    };
    const def = parseX6(x6Json as any);
    const loopNode = def.nodes[0];
    expect((loopNode.config as any).loop.loopType).toBe('START');
    expect((loopNode.config as any).loop.itemsExpr).toBe('items');
  });
});

// ─────────────────────────────────────────────────────────
describe('FlowEngine — API 节点（mock fetch）', () => {
  it('GET 请求成功返回 apiResponse', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ result: 42 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const def: FlowDefinition = {
      id: 'api', name: 'api', version: '1.0',
      nodes: [
        { id: 'start', type: NodeType.START },
        { id: 'api',   type: NodeType.API, config: { api: { url: 'https://example.com/api', method: 'GET' } } as any },
        { id: 'end',   type: NodeType.END },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'api' },
        { id: 'e2', from: 'api',   to: 'end' },
      ],
    };
    const result = await new FlowEngine().execute(def, {});
    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.variables.apiResponse).toEqual({ result: 42 });

    vi.unstubAllGlobals();
  });
});
