# 72flow-nodejs

[![NPM Version](https://img.shields.io/npm/v/72flow-nodejs.svg)](https://www.npmjs.com/package/72flow-nodejs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)

**72flow-nodejs** 是 72flow 工作流编排引擎的轻量级 JavaScript 实现。它旨在提供一个与 Java 后端行为完全一致的、可在浏览器和 Node.js 环境中无缝运行的流程执行核心。

---

## 核心特性

- 🚀 **极轻量**：无重度依赖，压缩后产物极小。
- ✅ **全能力节点**：支持 START、END、SCRIPT、DECISION、CONDITION、PARALLEL、LOOP、API、LLM 等 9 种核心节点。
- ✅ **双运行时**：天然支持现代浏览器与 Node.js 18+ 环境。
- ✅ **精准输出**：END 节点支持根据 `sourceCode` 路由特定节点的产物作为流程结果。
- ✅ **脚本捕获**：SCRIPT 节点支持捕获显式 `return` 的值。
- ✅ **X6 友好**：内置对 `@antv/x6` 导出的图形 JSON 的原生解析支持。
- ✅ **事件驱动**：完整的生命周期钩子（starting, completed, failed）。
- ✅ **零配置 LLM**：内置对 OpenAI 协议大模型的支持。

---

## 安装

```bash
npm install 72flow-nodejs
```

> 需要 Node.js **18+**（使用原生 `fetch` 和 `EventTarget`）

---

## 快速开始

### 基础线性流程

```typescript
import { FlowEngine, FlowDefinition, NodeType } from '72flow-nodejs';

const definition: FlowDefinition = {
  id: 'hello-world',
  name: 'Hello World',
  version: '1.0',
  nodes: [
    { id: 'start',  type: NodeType.START },
    { id: 'script', type: NodeType.SCRIPT, config: { script: 'greeting = "Hello, " + name' } },
    { id: 'end',    type: NodeType.END },
  ],
  edges: [
    { id: 'e1', from: 'start',  to: 'script' },
    { id: 'e2', from: 'script', to: 'end' },
  ],
};

const engine = new FlowEngine();
const result = await engine.execute(definition, { name: 'World' });

console.log(result.status);           // 'COMPLETED'
console.log(result.variables.greeting); // 'Hello, World'
```

### 条件分支（DECISION）

```typescript
const definition: FlowDefinition = {
  id: 'branch-demo',
  name: '条件分支示例',
  version: '1.0',
  nodes: [
    { id: 'start',    type: NodeType.START },
    { id: 'decision', type: NodeType.DECISION, config: { decision: { scriptCode: 'score >= 60 ? "pass" : "fail"' } } },
    { id: 'pass',     type: NodeType.SCRIPT, config: { script: 'result = "通过"' } },
    { id: 'fail',     type: NodeType.SCRIPT, config: { script: 'result = "未通过"' } },
    { id: 'end',      type: NodeType.END },
  ],
  edges: [
    { id: 'e1', from: 'start',    to: 'decision' },
    { id: 'e2', from: 'decision', to: 'pass', condition: 'pass' },
    { id: 'e3', from: 'decision', to: 'fail', condition: 'fail' },
    { id: 'e4', from: 'pass',     to: 'end' },
    { id: 'e5', from: 'fail',     to: 'end' },
  ],
};

const result = await new FlowEngine().execute(definition, { score: 80 });
console.log(result.variables.result); // '通过'
```

### 并行分支（PARALLEL）

```typescript
const definition: FlowDefinition = {
  id: 'parallel-demo',
  name: '并行流程示例',
  version: '1.0',
  nodes: [
    { id: 'start',   type: NodeType.START },
    { id: 'par',     type: NodeType.PARALLEL },
    { id: 'taskA',   type: NodeType.SCRIPT, config: { script: 'a = 1' } },
    { id: 'taskB',   type: NodeType.SCRIPT, config: { script: 'b = 2' } },
    { id: 'join',    type: NodeType.SCRIPT, config: { script: 'sum = a + b' } },
    { id: 'end',     type: NodeType.END },
  ],
  edges: [
    { id: 'e1', from: 'start',  to: 'par' },
    { id: 'e2', from: 'par',    to: 'taskA' },
    { id: 'e3', from: 'par',    to: 'taskB' },
    { id: 'e4', from: 'taskA',  to: 'join' },
    { id: 'e5', from: 'taskB',  to: 'join' },
    { id: 'e6', from: 'join',   to: 'end' },
  ],
  convergeMap: { par: 'join' }, // 声明汇聚关系
};

const result = await new FlowEngine().execute(definition, {});
console.log(result.variables.sum); // 3
```

### 监听引擎事件

```typescript
const engine = new FlowEngine();

engine.on('node.starting',   ({ nodeId }) => console.log(`▶ 开始: ${nodeId}`));
engine.on('node.completed',  ({ nodeId, output }) => console.log(`✓ 完成: ${nodeId}`, output));
engine.on('node.failed',     ({ nodeId, error }) => console.error(`✗ 失败: ${nodeId}`, error));

await engine.execute(definition, variables);
```

### 解析 X6 画布 JSON

```typescript
import { parseX6 } from '72flow-nodejs';

// x6Json 是 @antv/x6 画布导出的 JSON 对象
const flowDefinition = parseX6(x6Json);
const result = await new FlowEngine().execute(flowDefinition, {});
```

---

## 节点类型说明

| 节点类型    | 说明                                             | 关键配置字段                                     |
|-------------|--------------------------------------------------|-------------------------------------------------|
| `START`     | 流程起始节点                                     | —                                               |
| `END`       | 流程结束周期。支持精准提取指定节点产物            | `config.outputResult.sourceCode`                |
| `SCRIPT`    | 执行 JavaScript 脚本。支持 `scriptResult` 返回值   | `config.scriptCode`                             |
| `DECISION`  | 运行脚本计算返回值，与出边 `condition` 字段匹配   | `config.decision.scriptCode`                    |
| `CONDITION` | 对每条出边独立求值布尔表达式                       | `config.condition.scriptCode`                   |
| `PARALLEL`  | 并发触发所有出边分支，需配合 `convergeMap` 使用   | `convergeMap` (流程定义级)                       |
| `LOOP`      | 数组/次数迭代，内联执行循环体                     | `config.loop.loopType` / `itemsExpr` / `itemVar`|
| `API`       | 调用 HTTP 接口，结果写入 `apiResponse` 变量       | `config.api.url` / `method` / `headers` / `body`|
| `LLM`       | 调用 OpenAI 兼容大语言模型接口                    | `config.llm.provider` / `modelName` / `userPrompt` |

---

## 流程变量

- 引擎所有节点**共享同一个变量空间**（`FlowContext.variables`）
- `SCRIPT` 节点通过 `with(vars)` 语法直接读写变量，**新增的变量也会生效**
- `API` 节点完成后，响应体自动写入 `variables.apiResponse`
- `LLM` 节点完成后，模型回复写入 `variables.llmResponse`
- `LOOP` 节点每轮迭代将当前元素写入 `item`（可自定义 `itemVar`），索引写入 `index`（可自定义 `indexVar`）

---

## 错误处理

节点可在 `config.error.mode` 中指定错误处理策略：

| 值              | 行为                                |
|----------------|-------------------------------------|
| `"throw"`      | 抛出异常，终止流程（默认）            |
| `"fail"`       | 标记流程失败，终止流程               |
| `"<nodeId>"`   | 跳转到指定节点 ID 继续执行（兜底逻辑）|

---

## API 参考

### `FlowEngine`

```typescript
class FlowEngine {
  // 执行流程定义，返回执行结果
  execute(definition: FlowDefinition, variables?: Record<string, any>): Promise<FlowResult>;

  // 事件监听（继承自 SimpleEmitter）
  on(event: string, handler: Function): this;
  once(event: string, handler: Function): this;
  off(event: string, handler: Function): this;
}
```

### `FlowResult`

```typescript
interface FlowResult {
  executionId: string;            // 本次执行唯一 ID
  status: NodeStatus;             // COMPLETED | FAILED | CANCELLED
  output?: any;                   // END 节点的输出
  error?: string;                 // 错误信息（失败时）
  duration: number;               // 执行耗时（ms）
  startTime: number;              // 开始时间戳（ms）
  endTime?: number;               // 结束时间戳（ms）
  variables: Record<string, any>; // 最终变量快照
  traces: TraceRecord[];          // 各节点执行轨迹
}
```

### `parseX6(x6Json)`

将 `@antv/x6` 导出的画布 JSON 转为 `FlowDefinition`，自动规范化节点类型、loop 配置字段等。

---

## 开发

```bash
# 安装依赖
npm install

# 运行测试（watch 模式）
npm run dev

# 单次运行所有测试
npm test

# 构建 ESM + CJS 产物
npm run build
```

### 项目结构

```
src/
├── index.ts              # 公开导出入口
├── types/
│   └── models.ts         # 核心类型定义（FlowDefinition、NodeDef、FlowResult 等）
├── core/
│   ├── flow-engine.ts    # 流程引擎调度核心
│   ├── flow-context.ts   # 执行上下文（变量、状态、轨迹）
│   └── flow-engine.test.ts # 集成测试
├── executors/
│   └── factory.ts        # 各类型节点执行器（Start/End/Script/Decision/Parallel/Loop/API/LLM）
├── parser/
│   └── x6-parser.ts      # X6 画布 JSON 解析器
└── support/
    └── logger.ts         # 轻量日志工具
```

---

## 与 Java 引擎的差异

| 能力              | Node.js 引擎  | Java 引擎      |
|-------------------|--------------|----------------|
| SCRIPT 语言        | **JavaScript only** | JavaScript + Groovy |
| API 跨域（浏览器）  | 需 Vite `/api-proxy` 代理 | 无限制 |
| 运行环境           | Node.js 18+ / 现代浏览器 | JVM 11+ |

> **注意**：在浏览器中调用 `API` 节点时，需确保 Vite dev server 已配置 `/api-proxy` 代理路由，以规避 CORS 限制。

---

## License

[MIT](./LICENSE)
