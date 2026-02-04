/**
 * BiDi Log Monitor
 * Real-time console and JavaScript error monitoring
 */

import type { BiDiConnection } from './connection.js';
import type { BrowsingContext, LogEntry, LogLevel, RemoteValue, StackTrace } from './types.js';

export interface ConsoleMessage {
  type: 'console';
  level: LogLevel;
  text: string;
  timestamp: Date;
  method: string;
  args: unknown[];
  stackTrace?: StackFrame[];
  context?: BrowsingContext;
}

export interface JavaScriptError {
  type: 'javascript';
  level: 'error';
  text: string;
  timestamp: Date;
  stackTrace?: StackFrame[];
  context?: BrowsingContext;
}

export interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export type LogMessage = ConsoleMessage | JavaScriptError;

export type LogHandler = (message: LogMessage) => void;
export type ConsoleHandler = (message: ConsoleMessage) => void;
export type ErrorHandler = (error: JavaScriptError) => void;

export class LogMonitor {
  private connection: BiDiConnection;
  private subscribed = false;
  private context?: BrowsingContext;

  private allHandlers = new Set<LogHandler>();
  private levelHandlers = new Map<LogLevel, Set<LogHandler>>();
  private consoleHandlers = new Set<ConsoleHandler>();
  private errorHandlers = new Set<ErrorHandler>();

  private logs: LogMessage[] = [];
  private maxLogs = 1000;

  constructor(connection: BiDiConnection, context?: BrowsingContext) {
    this.connection = connection;
    this.context = context;
  }

  /**
   * Initialize log event subscriptions
   */
  async initialize(): Promise<void> {
    if (this.subscribed) return;

    await this.connection.subscribe(
      ['log.entryAdded'],
      this.context ? [this.context] : undefined
    );

    this.connection.on('log.entryAdded', (params) => {
      this.handleLogEntry(params as unknown as LogEntry);
    });

    this.subscribed = true;
  }

  /**
   * Listen to all log messages
   */
  onLog(handler: LogHandler): () => void {
    this.allHandlers.add(handler);
    return () => this.allHandlers.delete(handler);
  }

  /**
   * Listen to console messages only
   */
  onConsole(handler: ConsoleHandler): () => void {
    this.consoleHandlers.add(handler);
    return () => this.consoleHandlers.delete(handler);
  }

  /**
   * Listen to JavaScript errors only
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Listen to specific log levels
   */
  on(level: LogLevel, handler: LogHandler): () => void {
    if (!this.levelHandlers.has(level)) {
      this.levelHandlers.set(level, new Set());
    }
    this.levelHandlers.get(level)!.add(handler);
    return () => this.levelHandlers.get(level)?.delete(handler);
  }

  /**
   * Get all captured logs
   */
  getLogs(): LogMessage[] {
    return [...this.logs];
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(level: LogLevel): LogMessage[] {
    return this.logs.filter((log) => log.level === level);
  }

  /**
   * Get all console messages
   */
  getConsoleLogs(): ConsoleMessage[] {
    return this.logs.filter((log): log is ConsoleMessage => log.type === 'console');
  }

  /**
   * Get all JavaScript errors
   */
  getErrors(): JavaScriptError[] {
    return this.logs.filter((log): log is JavaScriptError => log.type === 'javascript');
  }

  /**
   * Clear captured logs
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Wait for a console message matching predicate
   */
  waitForConsole(
    predicate: (msg: ConsoleMessage) => boolean,
    timeout = 30000
  ): Promise<ConsoleMessage> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timeout waiting for console message'));
      }, timeout);

      const unsubscribe = this.onConsole((msg) => {
        if (predicate(msg)) {
          clearTimeout(timeoutId);
          unsubscribe();
          resolve(msg);
        }
      });
    });
  }

  /**
   * Wait for a JavaScript error
   */
  waitForError(
    predicate?: (err: JavaScriptError) => boolean,
    timeout = 30000
  ): Promise<JavaScriptError> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timeout waiting for JavaScript error'));
      }, timeout);

      const unsubscribe = this.onError((err) => {
        if (!predicate || predicate(err)) {
          clearTimeout(timeoutId);
          unsubscribe();
          resolve(err);
        }
      });
    });
  }

  /**
   * Assert no JavaScript errors occurred
   */
  assertNoErrors(): void {
    const errors = this.getErrors();
    if (errors.length > 0) {
      const errorMessages = errors.map((e) => e.text).join('\n');
      throw new Error(`JavaScript errors detected:\n${errorMessages}`);
    }
  }

  private handleLogEntry(entry: LogEntry): void {
    const message = this.convertLogEntry(entry);

    // Store log
    this.logs.push(message);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Notify handlers
    this.notifyHandlers(message);
  }

  private convertLogEntry(entry: LogEntry): LogMessage {
    const stackTrace = entry.stackTrace
      ? this.convertStackTrace(entry.stackTrace)
      : undefined;

    if (entry.type === 'javascript') {
      const error: JavaScriptError = {
        type: 'javascript',
        level: 'error',
        text: entry.text,
        timestamp: new Date(entry.timestamp),
        stackTrace,
        context: entry.source.context,
      };
      return error;
    }

    const consoleMsg: ConsoleMessage = {
      type: 'console',
      level: entry.level,
      text: entry.text,
      timestamp: new Date(entry.timestamp),
      method: entry.method || entry.level,
      args: entry.args ? entry.args.map((arg) => this.deserializeValue(arg)) : [],
      stackTrace,
      context: entry.source.context,
    };
    return consoleMsg;
  }

  private convertStackTrace(trace: StackTrace): StackFrame[] {
    return trace.callFrames.map((frame) => ({
      functionName: frame.functionName,
      url: frame.url,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    }));
  }

  private deserializeValue(value: RemoteValue): unknown {
    switch (value.type) {
      case 'undefined':
        return undefined;
      case 'null':
        return null;
      case 'string':
        return value.value;
      case 'number':
        if (value.value === 'NaN') return NaN;
        if (value.value === 'Infinity') return Infinity;
        if (value.value === '-Infinity') return -Infinity;
        if (value.value === '-0') return -0;
        return value.value;
      case 'boolean':
        return value.value;
      case 'bigint':
        return BigInt(value.value);
      case 'array':
        return value.value?.map((v) => this.deserializeValue(v)) ?? [];
      case 'object':
        if (!value.value) return {};
        return Object.fromEntries(
          value.value.map(([k, v]) => [
            typeof k === 'string' ? k : this.deserializeValue(k),
            this.deserializeValue(v),
          ])
        );
      case 'regexp':
        return new RegExp(value.value.pattern, value.value.flags);
      case 'date':
        return new Date(value.value);
      case 'function':
        return '[Function]';
      case 'node':
        return `[${value.value.nodeName || 'Node'}]`;
      case 'window':
        return `[Window: ${value.value.context}]`;
      default:
        return '[Unknown]';
    }
  }

  private notifyHandlers(message: LogMessage): void {
    // All handlers
    for (const handler of this.allHandlers) {
      try {
        handler(message);
      } catch (err) {
        console.error('Error in log handler:', err);
      }
    }

    // Level-specific handlers
    const levelHandlers = this.levelHandlers.get(message.level);
    if (levelHandlers) {
      for (const handler of levelHandlers) {
        try {
          handler(message);
        } catch (err) {
          console.error('Error in level log handler:', err);
        }
      }
    }

    // Type-specific handlers
    if (message.type === 'console') {
      for (const handler of this.consoleHandlers) {
        try {
          handler(message);
        } catch (err) {
          console.error('Error in console handler:', err);
        }
      }
    } else if (message.type === 'javascript') {
      for (const handler of this.errorHandlers) {
        try {
          handler(message);
        } catch (err) {
          console.error('Error in error handler:', err);
        }
      }
    }
  }
}
