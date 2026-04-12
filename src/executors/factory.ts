import {NodeDef, NodeResult, NodeType} from '../types/models.js';
import {FlowContext} from '../core/flow-context.js';
import {createLogger} from '../support/logger.js';

const log = createLogger('Executor');

export interface NodeExecutor {
    execute(node: NodeDef, context: FlowContext): Promise<NodeResult>;
}

// ─────────────────────────────────────────────────────────
// 工厂入口
// ─────────────────────────────────────────────────────────
export class NodeExecutorFactory {
    static async execute(node: NodeDef, context: FlowContext): Promise<NodeResult> {
        const type = String(node.type).toUpperCase();
        log.info(`执行节点 [${node.id}] 类型=${type}`);
        switch (type) {
            case 'START':
                return StartExecutor.execute(node, context);
            case 'END':
                return EndExecutor.execute(node, context);
            case 'SCRIPT':
                return ScriptExecutor.execute(node, context);
            case 'DECISION':
            case 'CONDITION':
                return DecisionExecutor.execute(node, context);
            case 'PARALLEL':
                return ParallelExecutor.execute(node, context);
            case 'LOOP':
                return await LoopExecutor.execute(node, context);
            case 'API':
                return await ApiExecutor.execute(node, context);
            case 'LLM':
                return await LlmExecutor.execute(node, context);
            default:
                log.warn(`不支持的节点类型: ${type}`);
                return {success: false, message: `Unsupported node type: ${type}`};
        }
    }
}

// ─────────────────────────────────────────────────────────
// START 节点
// ─────────────────────────────────────────────────────────
class StartExecutor {
    static execute(node: NodeDef, context: FlowContext): NodeResult {
        // START 节点的 config.params 会作为初始输入变量（已由引擎在创建 context 时注入）
        return {success: true};
    }
}

class EndExecutor {
    static execute(node: NodeDef, context: FlowContext): NodeResult {
        const cfg = node.config as any;

        // 根据日志确认，字段路径为 outputResult.sourceCode
        const sourceNodeCode = cfg?.outputResult?.sourceCode || cfg?.sourceCode || cfg?.end?.sourceCode;

        if (sourceNodeCode) {
            const allOutputs = context.getNodeOutputs();
            const targetOutput = allOutputs[sourceNodeCode];

            if (targetOutput !== undefined) {
                log.info(`END 节点 [${node.id}] 匹配到 sourceCode=${sourceNodeCode}，返回指定节点输出`);
                return {success: true, data: targetOutput};
            } else {
                log.warn(`END 节点 [${node.id}] sourceCode=${sourceNodeCode} 未找到目标节点输出，回退到全量变量`);
            }
        }

        return {success: true, data: context.getVariables()};
    }
}

// ─────────────────────────────────────────────────────────
// SCRIPT 节点  —  修复：Proxy 代理确保新变量能写入
// ─────────────────────────────────────────────────────────
class ScriptExecutor {
    static execute(node: NodeDef, context: FlowContext): NodeResult {
        // 兼容 config.script（来自简单字段）和 config.script.scriptCode（来自 Java 结构）
        const cfg = node.config as any;
        const scriptCfg = cfg?.script ?? {};
        const scriptCode: string | undefined =
            typeof scriptCfg === 'string'
                ? scriptCfg
                : (scriptCfg?.scriptCode ?? scriptCfg?.code ?? cfg?.scriptCode ?? cfg?.code);

        // 脚本语言类型：浏览器引擎只支持 JavaScript，Groovy 不可用
        const scriptType = String(scriptCfg?.scriptType ?? 'javascript').toLowerCase();
        if (scriptType === 'groovy') {
            log.warn(`SCRIPT 节点 [${node.id}] 使用 Groovy 语法，浏览器引擎不支持，请切换到 Java 执行模式`);
            return {
                success: false,
                message: '浏览器引擎不支持 Groovy 脚本，请在节点配置中将语言改为 JavaScript，或切换到 Java 执行模式',
            };
        }

        if (!scriptCode?.trim()) {
            log.warn(`SCRIPT 节点 [${node.id}] 无脚本，跳过`);
            return {success: true};
        }

        try {
            // 使用 Proxy 代理 variables，拦截所有 get/set，
            // 这样脚本通过 with(vars) 语法既能读又能新增属性
            const vars = context.getVariables();
            const writes: Record<string, any> = {};

            const proxy = new Proxy(vars, {
                get(target, key: string) {
                    return key in writes ? writes[key] : target[key];
                },
                set(_target, key: string, value) {
                    writes[key] = value;
                    return true;
                },
                has(_target, key) {
                    return true;
                }, // with(){} 需要 has 返回 true
            });

            // eslint-disable-next-line no-new-func
            const fn = new Function('__vars', `with(__vars) { ${scriptCode} }`);
            const scriptResult = fn(proxy);

            // 将写入的变量回写到 context
            for (const [k, v] of Object.entries(writes)) {
                context.setVariable(k, v);
            }

            // ⚠️ 只返回脚本实际写入的变量（writes），不展开全量 vars 快照
            // 记录显式 return 的脚本结果为 scriptResult
            const resultData: Record<string, any> = {...writes};
            if (scriptResult !== undefined) {
                resultData.scriptResult = scriptResult;
            }

            return {success: true, data: Object.keys(resultData).length > 0 ? resultData : null};
        } catch (e: any) {
            log.error(`SCRIPT 节点 [${node.id}] 执行失败: ${e.message}`);
            return {success: false, message: e.message};
        }
    }
}

// ─────────────────────────────────────────────────────────
// DECISION 节点  —  执行 decision.scriptCode 得到返回值，与出边 branchResult 比对
// CONDITION 节点 —  执行 condition.scriptCode 得到布尔值，true 走该出边
// ─────────────────────────────────────────────────────────
class DecisionExecutor {
    static execute(node: NodeDef, context: FlowContext): NodeResult {
        const cfg = node.config as any;
        const type = String(node.type).toUpperCase();
        const vars = context.getVariables();
        const proxy = new Proxy(vars, {has: () => true});

        // ── DECISION：运行 scriptCode 得到一个值，与出边 branchResult 匹配 ──
        if (type === 'DECISION') {
            const decCfg = cfg?.decision ?? {};
            const scriptCode = decCfg.scriptCode ?? decCfg.script ?? '';
            const scriptType = String(decCfg.scriptType ?? 'javascript').toLowerCase();

            if (scriptType === 'groovy') {
                return {success: false, message: '浏览器引擎不支持 Groovy，请切换 Java 模式'};
            }

            const outgoing = context.getOutgoing(node.id);

            // ── 格式 A（Java / X6 格式）：节点有 scriptCode，与 branchResult 字符串比对 ──
            if (scriptCode.trim()) {
                let exprResult: any = undefined;
                try {
                    const code = scriptCode.includes('return') ? scriptCode : `return (${scriptCode})`;
                    // eslint-disable-next-line no-new-func
                    exprResult = new Function('__vars', `with(__vars){ ${code} }`)(proxy);
                } catch (e: any) {
                    log.warn(`DECISION [${node.id}] scriptCode 求值失败: ${e.message}`);
                }

                const resultStr = String(exprResult ?? '');
                log.info(`DECISION [${node.id}] scriptCode → ${resultStr}`);

                let selectedBranch: string | null = null;
                let defaultBranch: string | null = null;

                for (const edge of outgoing) {
                    const branchResult = edge.condition;
                    if (!branchResult?.trim()) defaultBranch = edge.to;
                    else if (branchResult === resultStr) selectedBranch = edge.to;
                }
                if (!selectedBranch) selectedBranch = defaultBranch;
                for (const edge of outgoing) {
                    if (edge.to !== selectedBranch) context.skipNode(edge.to);
                }
                if (selectedBranch) {
                    return {success: true, data: {selectedBranch, decisionResult: exprResult}};
                }
                return {success: false, message: 'DECISION: 没有匹配的分支'};
            }

            // ── 格式 B（内部定义 / 测试格式）：出边 condition 是直接的 JS 布尔表达式 ──
            let selectedBranch: string | null = null;
            for (const edge of outgoing) {
                if (selectedBranch) {
                    context.skipNode(edge.to);
                    continue;
                }
                let matched = false;
                if (!edge.condition?.trim()) {
                    matched = true;                                    // 无条件 = 默认分支
                } else {
                    try {
                        // eslint-disable-next-line no-new-func
                        matched = !!new Function('__vars', `with(__vars){ return !!(${edge.condition}); }`)(proxy);
                    } catch (e) {
                        log.warn(`DECISION [${node.id}] 边条件求值失败: ${edge.condition}`);
                    }
                }
                if (matched) selectedBranch = edge.to;
                else context.skipNode(edge.to);
            }
            log.info(`DECISION [${node.id}] → ${selectedBranch}`);
            if (selectedBranch) return {success: true, data: {selectedBranch}};
            return {success: false, message: 'DECISION: 没有匹配的分支'};
        }

        // ── CONDITION / IF：每条出边的 branchResult 是独立的布尔表达式 ──
        const condCfg = cfg?.condition ?? {};
        const scriptCode = condCfg.scriptCode ?? condCfg.script ?? '';
        const scriptType = String(condCfg.scriptType ?? 'javascript').toLowerCase();

        if (scriptType === 'groovy') {
            return {success: false, message: '浏览器引擎不支持 Groovy，请切换 Java 模式'};
        }

        // Condition 节点：运行顶层 scriptCode（若有），结果作为 matched 布尔值
        // 若无 scriptCode，则对每条出边单独 eval branchResult 表达式
        const outgoing = context.getOutgoing(node.id);
        let selectedBranch: string | null = null;

        // 方式 A：节点有统一 scriptCode → 布尔结果走 true/false 分支
        if (scriptCode.trim()) {
            let condResult = false;
            try {
                const code = scriptCode.includes('return') ? scriptCode : `return !!(${scriptCode})`;
                // eslint-disable-next-line no-new-func
                condResult = !!new Function('__vars', `with(__vars){ ${code} }`)(proxy);
            } catch (e: any) {
                log.warn(`CONDITION [${node.id}] scriptCode 求值失败: ${e.message}`);
            }
            log.info(`CONDITION [${node.id}] → ${condResult}`);

            for (const edge of outgoing) {
                const br = edge.condition?.trim();
                // branchResult 为 'true'/'false' 字符串，或为空（默认分支）
                const edgeExpected = !br || br === 'true';
                const match = condResult ? br === 'true' || !br : br === 'false' || !br;
                if (!selectedBranch && (br === String(condResult) || !br)) {
                    selectedBranch = edge.to;
                } else {
                    context.skipNode(edge.to);
                }
            }
        } else {
            // 方式 B：无节点级 scriptCode → 每条出边的 branchResult 是独立布尔表达式
            for (const edge of outgoing) {
                if (selectedBranch) {
                    context.skipNode(edge.to);
                    continue;
                }
                let matched = false;
                if (!edge.condition?.trim()) {
                    matched = true;   // 空条件 = 默认分支
                } else {
                    try {
                        // eslint-disable-next-line no-new-func
                        matched = !!new Function('__vars', `with(__vars){ return !!(${edge.condition}); }`)(proxy);
                    } catch (e) {
                        log.warn(`CONDITION [${node.id}] 边条件求值失败: ${edge.condition}`);
                    }
                }
                if (matched) selectedBranch = edge.to;
                else context.skipNode(edge.to);
            }
        }

        if (selectedBranch) {
            log.info(`CONDITION [${node.id}] → ${selectedBranch}`);
            return {success: true, data: {selectedBranch}};
        }
        return {success: false, message: 'CONDITION: 没有匹配的分支'};
    }
}

// ─────────────────────────────────────────────────────────
// PARALLEL 节点
// ─────────────────────────────────────────────────────────
class ParallelExecutor {
    static execute(node: NodeDef, context: FlowContext): NodeResult {
        const outgoing = context.getOutgoing(node.id);
        if (outgoing.length === 0) {
            return {success: true, data: {branches: 0}};
        }

        // 从 convergeMap 找汇聚点并预注册
        const convergeNodeId = context.getDefinition().convergeMap?.[node.id];
        if (convergeNodeId) {
            context.registerConvergence(convergeNodeId, outgoing.length);
            log.info(`PARALLEL [${node.id}] 注册汇聚节点 ${convergeNodeId}`);
        } else {
            log.warn(`PARALLEL [${node.id}] 未找到汇聚点（convergeMap 缺失）`);
        }

        return {
            success: true,
            data: {branches: outgoing.length, convergeTo: convergeNodeId},
        };
    }
}

// ─────────────────────────────────────────────────────────
// LOOP 节点  —  内联同步执行，与 Java LoopExecutor 逻辑一致
// ─────────────────────────────────────────────────────────
class LoopExecutor {
    static async execute(node: NodeDef, context: FlowContext): Promise<NodeResult> {
        const cfg = (node.config as any)?.loop;
        if (!cfg?.loopType) {
            return {success: false, message: 'LOOP 节点缺少 loopType (START|END)'};
        }

        const loopType = String(cfg.loopType).toUpperCase();
        if (loopType === 'START') return LoopExecutor.executeStart(node, cfg, context);
        if (loopType === 'END') return {success: true, data: {action: 'collected'}};
        return {success: false, message: `未知 loopType: ${cfg.loopType}`};
    }

    private static async executeStart(
        node: NodeDef,
        cfg: any,
        context: FlowContext,
    ): Promise<NodeResult> {
        const itemsExpr = cfg.itemsExpr ?? cfg.arrayExpression;
        const maxIter = cfg.maxIterations ?? Infinity;
        const itemVar = cfg.itemVar ?? 'item';
        const indexVar = cfg.indexVar ?? 'index';

        const items: any[] = LoopExecutor.evalItems(itemsExpr, context);

        const bodyPath = context.getLoopBodyPath(node.id);
        const loopEndNodeId = bodyPath.length > 0 ? bodyPath[bodyPath.length - 1] : null;

        log.info(`LOOP_START [${node.id}] items=${items.length}, bodyPath=${bodyPath.join('->')}`);

        if (items.length === 0) {
            if (loopEndNodeId) {
                context.complete(loopEndNodeId, {results: []}, Date.now());
            }
            return {
                success: true,
                data: {action: 'exit', totalIterations: 0, results: [], __loopEndNodeId: loopEndNodeId},
            };
        }

        const allResults: any[] = [];
        let iteration = 0;

        for (let i = 0; i < items.length && i < maxIter; i++) {
            context.setVariable(itemVar, items[i]);
            context.setVariable(indexVar, i);
            iteration++;

            for (const nodeId of bodyPath) {
                const bodyNode = context.getNode(nodeId);
                if (!bodyNode) continue;

                // 每轮循环重置节点状态，使其可重新执行
                context.getCompletedNodes().delete(nodeId);
                context.getExecutingNodes().delete(nodeId);

                const t0 = Date.now();
                const result = await NodeExecutorFactory.execute(bodyNode, context);
                context.complete(nodeId, result.data, t0);

                // 如果是 LOOP_END，收集结果
                if (String(bodyNode.type).toUpperCase() === 'LOOP') {
                    const endCfg = (bodyNode.config as any)?.loop;
                    if (endCfg?.loopType?.toUpperCase() === 'END') {
                        const resultExpr = endCfg.resultExpr ?? endCfg.resultExpression;
                        if (resultExpr) {
                            try {
                                const val = LoopExecutor.evalExpr(resultExpr, context);
                                if (val !== undefined) allResults.push(val);
                            } catch (e) { /* ignore */
                            }
                        } else if (result.data !== undefined) {
                            allResults.push(result.data);
                        }
                    }
                }
            }
        }

        const resultData: Record<string, any> = {
            action: 'exit',
            totalIterations: iteration,
            results: allResults,
        };
        if (loopEndNodeId) resultData['__loopEndNodeId'] = loopEndNodeId;

        log.info(`LOOP_START [${node.id}] 执行完成，totalIterations=${iteration}`);
        return {success: true, data: resultData};
    }

    private static evalItems(expr: string | undefined, context: FlowContext): any[] {
        if (!expr?.trim()) return [];
        try {
            const vars = context.getVariables();
            const proxy = new Proxy(vars, {has: () => true});
            // eslint-disable-next-line no-new-func
            const result = new Function('__vars', `with(__vars){ return (${expr}); }`)(proxy);
            if (Array.isArray(result)) return result;
            if (typeof result === 'number') return Array.from({length: result}, (_, i) => i);
            return [];
        } catch (e) {
            log.error(`LOOP items 表达式求值失败: ${expr}`);
            return [];
        }
    }

    private static evalExpr(expr: string, context: FlowContext): any {
        const vars = {...context.getVariables(), outputs: context.getNodeOutputs()};
        const proxy = new Proxy(vars, {has: () => true});
        // eslint-disable-next-line no-new-func
        return new Function('__vars', `with(__vars){ return (${expr}); }`)(proxy);
    }
}

// ─────────────────────────────────────────────────────────
// API 节点  —  基于 fetch，对齐 Java ApiExecutor
// ─────────────────────────────────────────────────────────
class ApiExecutor {
    static async execute(node: NodeDef, context: FlowContext): Promise<NodeResult> {
        const cfg = (node.config as any)?.api;
        if (!cfg?.url) {
            return {success: false, message: 'API 节点缺少 url 配置'};
        }

        const vars = context.getVariables();
        let url = ApiExecutor.interpolate(cfg.url, vars);
        const method = (cfg.method ?? 'GET').toUpperCase();
        const timeoutMs = (cfg.timeout ?? 30) * 1000;

        // 构建 Headers
        const rawHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(cfg.headers ?? {}),
        };

        // 拼接查询参数（GET 时）
        if (cfg.params && Object.keys(cfg.params).length > 0) {
            const qs = new URLSearchParams(
                Object.entries(cfg.params).map(([k, v]) => [k, String(v)])
            ).toString();
            url = url + (url.includes('?') ? '&' : '?') + qs;
        }

        // 构建 Body（POST / PUT / PATCH）
        let body: string | undefined;
        if (cfg.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
            const rawBody = typeof cfg.body === 'string'
                ? ApiExecutor.interpolate(cfg.body, vars)
                : JSON.stringify(cfg.body);
            body = rawBody;
        }

        log.info(`API [${node.id}] ${method} ${url}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            let response: Response;

            // 浏览器环境：通过 /api-proxy 代理转发，绕过 CORS 限制
            // Node.js 环境：直接 fetch（服务端无 CORS 限制）
            const isBrowser = typeof window !== 'undefined';

            if (isBrowser) {
                // 向 Vite dev server 的代理中间件发 POST 请求
                const proxyBase = window.location.origin;
                response = await fetch(`${proxyBase}/api-proxy`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({url, method, headers: rawHeaders, body: body ?? null}),
                    signal: controller.signal,
                });
            } else {
                response = await fetch(url, {
                    method,
                    headers: rawHeaders,
                    body,
                    signal: controller.signal,
                });
            }

            clearTimeout(timer);

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                return {success: false, message: `HTTP ${response.status}: ${errText}`};
            }

            const contentType = response.headers.get('content-type') ?? '';
            let data: any;
            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                data = {rawResponse: await response.text()};
            }

            return {success: true, data: {apiResponse: data}};
        } catch (e: any) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                return {success: false, message: `API 请求超时（${cfg.timeout ?? 30}s）`};
            }
            log.error(`API [${node.id}] 请求失败: ${e.message}`);
            return {success: false, message: `API call failed: ${e.message}`};
        }
    }

    /** 简单字符串插值：{{变量名}} → 变量值 */
    private static interpolate(template: string, vars: Record<string, any>): string {
        return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
            key in vars ? String(vars[key]) : `{{${key}}}`
        );
    }
}

// ─────────────────────────────────────────────────────────
// LLM 节点  —  OpenAI 兼容接口（用户在节点配置中填写 apiKey）
// ─────────────────────────────────────────────────────────
class LlmExecutor {
    static async execute(node: NodeDef, context: FlowContext): Promise<NodeResult> {
        const cfg = (node.config as any)?.llm;
        if (!cfg) {
            return {success: false, message: 'LLM 节点缺少配置'};
        }
        if (!cfg.userPrompt?.trim()) {
            return {success: false, message: '缺少 userPrompt（用户提示词）'};
        }

        const vars = context.getVariables();
        const apiKey = cfg.apiKey ?? '';
        const provider = cfg.provider ?? 'openai';
        const model = cfg.modelName ?? 'gpt-3.5-turbo';
        const endpoint = cfg.endpoint ?? LlmExecutor.defaultEndpoint(provider);
        const temperature = cfg.temperature ?? 0.7;
        const maxTokens = cfg.maxTokens ?? 2048;

        // 变量插值（允许在 prompt 中使用 {{变量名}}）
        const userPrompt = LlmExecutor.interpolate(cfg.userPrompt, vars);
        const systemPrompt = LlmExecutor.interpolate(cfg.systemPrompt ?? '', vars);

        const messages: any[] = [];
        if (systemPrompt.trim()) messages.push({role: 'system', content: systemPrompt});
        messages.push({role: 'user', content: userPrompt});

        log.info(`LLM [${node.id}] provider=${provider} model=${model}`);

        try {
            const response = await fetch(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                    stream: true, // 强制开启流式以支持吐字效果
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({error: {message: response.statusText}}));
                return {success: false, message: `LLM 调用失败: ${err?.error?.message ?? response.status}`};
            }

            // 处理流式响应
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let modelId = model;

            if (reader) {
                while (true) {
                    const {done, value} = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data: ')) continue;
                        const dataStr = trimmed.slice(6);
                        if (dataStr === '[DONE]') break;

                        try {
                            const json = JSON.parse(dataStr);
                            const delta = json.choices?.[0]?.delta?.content ?? '';
                            if (delta) {
                                fullContent += delta;
                                // 实时发射流片段
                                context.emitStream(node.id, {delta, fullContent});
                            }
                            if (json.model) modelId = json.model;
                        } catch (e) {
                            // 忽略部分 JSON 解析错误（多行拼接情况）
                        }
                    }
                }
            } else {
                // 回退到非流式处理（或处理不支持 ReadableStream 的环境）
                const data = await response.json();
                fullContent = data.choices?.[0]?.message?.content ?? '';
                modelId = data.model ?? model;
            }

            return {
                success: true,
                data: {
                    llmResponse: fullContent,
                    model: modelId,
                    inputTokens: 0, // 流式协议通常不包含实时 usage，需后期计算或忽略
                    outputTokens: 0,
                },
            };
        } catch (e: any) {
            log.error(`LLM [${node.id}] 请求失败: ${e.message}`);
            return {success: false, message: `LLM call failed: ${e.message}`};
        }
    }

    private static defaultEndpoint(provider: string): string {
        switch (provider.toLowerCase()) {
            case 'openai':
                return 'https://api.openai.com/v1';
            case 'qwen':
                return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
            case 'claude':
                return 'https://api.anthropic.com/v1';
            case 'ollama':
                return 'http://localhost:11434/v1';
            default:
                return 'https://api.openai.com/v1';
        }
    }

    private static interpolate(template: string, vars: Record<string, any>): string {
        return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
            key in vars ? String(vars[key]) : `{{${key}}}`
        );
    }
}
