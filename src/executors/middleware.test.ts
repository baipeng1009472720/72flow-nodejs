/**
 * DATABASE & REDIS 执行器测试
 * 使用 vitest mock 模拟 mysql2 / ioredis，无需真实数据库连接
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlowEngine } from '../core/flow-engine.js';
import { FlowDefinition, NodeType, NodeStatus } from '../types/models.js';

// ─────────────────────────────────────────────────────────
// 公共辅助
// ─────────────────────────────────────────────────────────
function makeFlow(nodeId: string, nodeType: string, config: any): FlowDefinition {
    return {
        id: 'test',
        name: 'test',
        version: '1.0',
        nodes: [
            { id: 'start', type: NodeType.START },
            { id: nodeId,  type: nodeType as any, config },
            { id: 'end',   type: NodeType.END },
        ],
        edges: [
            { id: 'e1', from: 'start',  to: nodeId },
            { id: 'e2', from: nodeId,   to: 'end' },
        ],
    };
}

// ─────────────────────────────────────────────────────────
// DATABASE 节点测试
// ─────────────────────────────────────────────────────────
describe('DatabaseExecutor', () => {
    let mockConnection: any;

    beforeEach(() => {
        // 构建 mock mysql2 连接对象
        mockConnection = {
            execute: vi.fn(),
            end:     vi.fn().mockResolvedValue(undefined),
        };

        // mock 动态 import 的 mysql2/promise
        vi.doMock('mysql2/promise', () => ({
            default: {
                createConnection: vi.fn().mockResolvedValue(mockConnection),
            },
            createConnection: vi.fn().mockResolvedValue(mockConnection),
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('SELECT 成功：返回 dbResult.rows 和 rowCount', async () => {
        const fakeRows = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
        const fakeFields = [{ name: 'id' }, { name: 'name' }];
        mockConnection.execute.mockResolvedValue([fakeRows, fakeFields]);

        const def = makeFlow('db', 'DATABASE', {
            database: {
                dbType: 'mysql',
                host: 'localhost',
                port: 3306,
                user: 'root',
                password: '123456',
                database: 'testdb',
                sql: 'SELECT * FROM users',
            },
        });

        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.COMPLETED);
        const dbResult = result.variables['dbResult'] as any;
        expect(dbResult).toBeDefined();
        expect(dbResult.rowCount).toBe(2);
        expect(dbResult.rows).toEqual(fakeRows);
        expect(dbResult.fields).toEqual(['id', 'name']);
    });

    it('SQL 变量插值：{{userId}} 被替换为 context 中的值', async () => {
        mockConnection.execute.mockResolvedValue([[{ id: 42 }], [{ name: 'id' }]]);

        const def = makeFlow('db', 'DATABASE', {
            database: {
                dbType: 'mysql',
                host: 'localhost',
                port: 3306,
                user: 'root', password: '', database: 'testdb',
                sql: 'SELECT * FROM users WHERE id = {{userId}}',
            },
        });

        await new FlowEngine().execute(def, { userId: 42 });

        // 确认 execute 被调用时 SQL 已经插值
        const calledSql = mockConnection.execute.mock.calls[0][0];
        expect(calledSql).toBe('SELECT * FROM users WHERE id = 42');
    });

    it('缺少 SQL 时返回失败', async () => {
        const def = makeFlow('db', 'DATABASE', {
            database: { dbType: 'mysql', host: 'localhost', port: 3306, user: 'root', password: '', database: 'testdb', sql: '' },
        });
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.FAILED);
    });

    it('数据库连接异常时流程失败并记录错误', async () => {
        mockConnection.execute.mockRejectedValue(new Error('Access denied'));
        const def = makeFlow('db', 'DATABASE', {
            database: { dbType: 'mysql', host: 'localhost', port: 3306, user: 'root', password: 'wrong', database: 'testdb', sql: 'SELECT 1' },
        });
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.FAILED);
    });
});

// ─────────────────────────────────────────────────────────
// REDIS 节点测试
// ─────────────────────────────────────────────────────────
describe('RedisExecutor', () => {
    let mockRedisInstance: any;

    beforeEach(() => {
        mockRedisInstance = {
            connect: vi.fn().mockResolvedValue(undefined),
            quit:    vi.fn().mockResolvedValue(undefined),
            set:     vi.fn().mockResolvedValue('OK'),
            get:     vi.fn().mockResolvedValue('test-value'),
            del:     vi.fn().mockResolvedValue(1),
            exists:  vi.fn().mockResolvedValue(1),
            expire:  vi.fn().mockResolvedValue(1),
            incr:    vi.fn().mockResolvedValue(42),
        };

        // 正确 mock 一个 class 构造函数：必须用 function 关键字
        const instance = mockRedisInstance;
        const MockRedis = function(this: any) {
            Object.assign(this, instance);
        };
        vi.doMock('ioredis', () => ({ default: MockRedis }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    function redisFlow(command: string, extra: Record<string, any> = {}) {
        return makeFlow('redis', 'REDIS', {
            redis: {
                host: '127.0.0.1', port: 6379, password: '', dbIndex: 0,
                command, key: 'test-key',
                ...extra,
            },
        });
    }

    it('SET：成功写入并返回 OK', async () => {
        const def = redisFlow('SET', { value: 'hello', ttl: -1 });
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.COMPLETED);
        expect(mockRedisInstance.set).toHaveBeenCalledWith('test-key', 'hello');
        const rd = result.variables['redisResult'];
        expect(rd).toBe('OK');
    });

    it('SET with TTL：调用 set(key, val, EX, ttl)', async () => {
        const def = redisFlow('SET', { value: 'tmp', ttl: 60 });
        await new FlowEngine().execute(def, {});
        expect(mockRedisInstance.set).toHaveBeenCalledWith('test-key', 'tmp', 'EX', 60);
    });

    it('GET：返回 redisResult 字符串值', async () => {
        const def = redisFlow('GET');
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.COMPLETED);
        expect(result.variables['redisResult']).toBe('test-value');
    });

    it('DEL：返回删除行数', async () => {
        const def = redisFlow('DEL');
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.COMPLETED);
        expect(result.variables['redisResult']).toBe(1);
    });

    it('INCR：返回递增后的值', async () => {
        const def = redisFlow('INCR');
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.COMPLETED);
        expect(result.variables['redisResult']).toBe(42);
    });

    it('key 变量插值：{{keyName}} 被替换', async () => {
        const def = makeFlow('redis', 'REDIS', {
            redis: { host: '127.0.0.1', port: 6379, password: '', dbIndex: 0, command: 'GET', key: 'user:{{userId}}' },
        });
        await new FlowEngine().execute(def, { userId: 999 });
        expect(mockRedisInstance.get).toHaveBeenCalledWith('user:999');
    });

    it('缺少 key 时流程失败', async () => {
        const def = makeFlow('redis', 'REDIS', {
            redis: { host: '127.0.0.1', port: 6379, password: '', dbIndex: 0, command: 'GET', key: '' },
        });
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.FAILED);
    });

    it('不支持的指令时流程失败', async () => {
        const def = redisFlow('HGETALL');
        const result = await new FlowEngine().execute(def, {});
        expect(result.status).toBe(NodeStatus.FAILED);
    });
});
