import {
  FlowDefinition,
  NodeDef,
  EdgeDef,
  NodeConfigDef,
} from '../types/models.js';
import { createLogger } from '../support/logger.js';

const log = createLogger('X6Parser');

// ─── 前端 X6 JSON 的原始类型 ───────────────────────────
interface X6Node {
  id: string;
  shape: string;
  position?: { x: number; y: number };
  data?: {
    meta?:   Record<string, any>;
    config?: Record<string, any>;
  };
}

interface X6Edge {
  id?: string;
  source: string | { cell: string; port?: string };
  target: string | { cell: string; port?: string };
  data?: {
    config?:   { branchResult?: string; [k: string]: any };
    priority?: number;
  };
}

interface X6Graph {
  nodes: X6Node[];
  edges: X6Edge[];
}

// ─── 解析器 ─────────────────────────────────────────────
export class X6Parser {
  /**
   * 将前端 X6 序列化的 JSON 解析为引擎可执行的 FlowDefinition
   */
  parse(x6Json: X6Graph | string): FlowDefinition {
    const raw: X6Graph = typeof x6Json === 'string' ? JSON.parse(x6Json) : x6Json;
    const nodes = this.parseNodes(raw.nodes ?? []);
    const edges = this.parseEdges(raw.edges ?? []);

    const convergeMap    = this.computeConvergeMap(nodes, edges);
    const loopBodyPaths  = this.computeLoopBodyPaths(nodes, edges);

    log.debug(`解析完成: nodes=${nodes.length}, edges=${edges.length}, convergeMap keys=${Object.keys(convergeMap).length}`);

    return {
      id:      `flow-${Date.now()}`,
      name:    'x6-flow',
      version: '1.0',
      nodes,
      edges,
      convergeMap,
      loopBodyPaths,
    };
  }

  // ── 节点解析 ──────────────────────────────────────────
  private parseNodes(x6Nodes: X6Node[]): NodeDef[] {
    return x6Nodes.map(n => {
      const rawConfig = n.data?.config ?? {};
      const meta      = n.data?.meta   ?? {};

      // type 优先从 meta.type 取，其次 shape
      const type = (meta.type ?? n.shape ?? 'UNKNOWN').toUpperCase();
      const code = rawConfig.code ?? type;

      const config = this.normalizeConfig(rawConfig, type);

      return {
        id:   n.id,
        type,
        name: rawConfig.title ?? meta.label ?? type,
        code,
        config,
        metadata: meta,
      } as NodeDef;
    });
  }

  private normalizeConfig(raw: Record<string, any>, type: string): NodeConfigDef {
    const cfg: any = { ...raw };

    // ── loop 字段规范化（前端字段名 → 引擎字段名）──
    if (cfg.loop) {
      const loop = cfg.loop;
      // nodeType: 'start'/'end' → loopType: 'START'/'END'
      if (!loop.loopType && loop.nodeType) {
        loop.loopType = String(loop.nodeType).toUpperCase();
        delete loop.nodeType;
      } else if (loop.loopType) {
        loop.loopType = String(loop.loopType).toUpperCase();
      }
      // arrayExpression → itemsExpr
      if (!loop.itemsExpr && loop.arrayExpression) {
        loop.itemsExpr = loop.arrayExpression;
        delete loop.arrayExpression;
      }
      // resultExpression → resultExpr
      if (!loop.resultExpr && loop.resultExpression) {
        loop.resultExpr = loop.resultExpression;
        delete loop.resultExpression;
      }
    }

    // ── api 字段：params/headers 可能是字符串 "{}" ──
    if (cfg.api) {
      cfg.api = this.normalizeApiField(cfg.api, 'params');
      cfg.api = this.normalizeApiField(cfg.api, 'headers');
    }

    return cfg as NodeConfigDef;
  }

  private normalizeApiField(api: Record<string, any>, field: string): Record<string, any> {
    const value = api[field];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          api[field] = JSON.parse(trimmed);
        } catch {
          log.warn(`api.${field} 不是合法 JSON，已忽略`);
          delete api[field];
        }
      } else if (!trimmed || trimmed === 'null') {
        delete api[field];
      }
    }
    return api;
  }

  // ── 边解析 ────────────────────────────────────────────
  private parseEdges(x6Edges: X6Edge[]): EdgeDef[] {
    const result: EdgeDef[] = [];
    for (const e of x6Edges) {
      const from = this.extractCellId(e.source);
      const to   = this.extractCellId(e.target);
      if (!from || !to) {
        log.warn(`边缺少 source 或 target，已跳过`);
        continue;
      }
      const condition = e.data?.config?.branchResult ?? undefined;
      result.push({
        id:        e.id ?? `edge-${from}-${to}`,
        from,
        to,
        condition,
        metadata:  { priority: e.data?.priority ?? 0 },
      });
    }
    return result;
  }

  private extractCellId(value: string | { cell: string; port?: string }): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    return value.cell ?? null;
  }

  // ── 预计算：PARALLEL 汇聚点（BFS 找公共后继）────────
  private computeConvergeMap(nodes: NodeDef[], edges: EdgeDef[]): Record<string, string> {
    const nodeMap      = new Map(nodes.map(n => [n.id, n]));
    const outgoingMap  = this.buildOutgoingMap(edges);
    const result: Record<string, string> = {};

    for (const node of nodes) {
      if (String(node.type).toUpperCase() !== 'PARALLEL') continue;
      const outgoing = outgoingMap.get(node.id) ?? [];
      if (outgoing.length === 0) continue;
      const convergeId = this.findConvergeNode(outgoing.map(e => e.to), outgoingMap);
      if (convergeId) {
        result[node.id] = convergeId;
        log.debug(`PARALLEL ${node.id} → converge ${convergeId}`);
      }
    }
    return result;
  }

  /** BFS 找所有分支的第一个公共后继节点 */
  private findConvergeNode(
    starts: string[],
    outgoingMap: Map<string, EdgeDef[]>,
  ): string | null {
    const reachCount = new Map<string, number>();
    for (const start of starts) {
      const visited = new Set<string>();
      const queue   = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        reachCount.set(cur, (reachCount.get(cur) ?? 0) + 1);
        if (reachCount.get(cur) === starts.length && !starts.includes(cur)) {
          return cur;
        }
        for (const e of outgoingMap.get(cur) ?? []) queue.push(e.to);
      }
    }
    return null;
  }

  // ── 预计算：LOOP_START 循环体路径（BFS）──────────────
  private computeLoopBodyPaths(nodes: NodeDef[], edges: EdgeDef[]): Record<string, string[]> {
    const nodeMap     = new Map(nodes.map(n => [n.id, n]));
    const outgoingMap = this.buildOutgoingMap(edges);
    const result: Record<string, string[]> = {};

    for (const node of nodes) {
      if (String(node.type).toUpperCase() !== 'LOOP') continue;
      const loopType = String((node.config as any)?.loop?.loopType ?? '').toUpperCase();
      if (loopType !== 'START') continue;

      const path = this.computeSingleLoopPath(node, nodeMap, outgoingMap);
      result[node.id] = path;
      log.debug(`LOOP_START ${node.id} bodyPath=[${path.join(',')}]`);
    }
    return result;
  }

  private computeSingleLoopPath(
    loopStart: NodeDef,
    nodeMap: Map<string, NodeDef>,
    outgoingMap: Map<string, EdgeDef[]>,
  ): string[] {
    const path    : string[] = [];
    const visited  = new Set<string>();
    const queue   : string[] = [];

    // 从 LOOP_START 的出边入手，跳过 END 节点
    for (const e of outgoingMap.get(loopStart.id) ?? []) {
      const toNode = nodeMap.get(e.to);
      if (!toNode || String(toNode.type).toUpperCase() === 'END') continue;
      if (visited.add(e.to)) queue.push(e.to);
    }

    while (queue.length > 0) {
      const cur = queue.shift()!;
      path.push(cur);
      const curNode = nodeMap.get(cur);
      if (!curNode) continue;

      // 遇到 LOOP_END 停止向下展开
      if (
        String(curNode.type).toUpperCase() === 'LOOP' &&
        String((curNode.config as any)?.loop?.loopType ?? '').toUpperCase() === 'END'
      ) break;

      for (const e of outgoingMap.get(cur) ?? []) {
        if (e.to === loopStart.id) continue; // 避免回路
        const toNode = nodeMap.get(e.to);
        if (!toNode || String(toNode.type).toUpperCase() === 'END') continue;
        if (visited.add(e.to)) queue.push(e.to);
      }
    }
    return path;
  }

  private buildOutgoingMap(edges: EdgeDef[]): Map<string, EdgeDef[]> {
    const map = new Map<string, EdgeDef[]>();
    for (const e of edges) {
      if (!map.has(e.from)) map.set(e.from, []);
      map.get(e.from)!.push(e);
    }
    return map;
  }
}

/** 便捷函数：直接解析 X6 JSON → FlowDefinition */
export function parseX6(x6Json: X6Graph | string): FlowDefinition {
  return new X6Parser().parse(x6Json);
}
