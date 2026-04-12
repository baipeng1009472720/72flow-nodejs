/**
 * 简易日志工具，兼容浏览器和 Node.js 环境
 */
const isDev = typeof process !== 'undefined'
  ? process.env.NODE_ENV !== 'production'
  : true;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, tag: string, message: string, ...args: any[]) {
  if (level === 'debug' && !isDev) return;
  const prefix = `[72flow][${tag}]`;
  switch (level) {
    case 'debug': console.debug(prefix, message, ...args); break;
    case 'info':  console.info(prefix, message, ...args); break;
    case 'warn':  console.warn(prefix, message, ...args); break;
    case 'error': console.error(prefix, message, ...args); break;
  }
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, ...args: any[]) => log('debug', tag, msg, ...args),
    info:  (msg: string, ...args: any[]) => log('info', tag, msg, ...args),
    warn:  (msg: string, ...args: any[]) => log('warn', tag, msg, ...args),
    error: (msg: string, ...args: any[]) => log('error', tag, msg, ...args),
  };
}
