#!/usr/bin/env node

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { existsSync, readdirSync, writeFileSync } = require('node:fs');
const { SerialPort } = require('serialport');

function resolveUsageFormatModule() {
  const scriptDir = path.dirname(process.argv[1] || process.cwd());
  const candidates = [
    path.resolve(scriptDir, 'src/usage-format'),
    path.resolve(scriptDir, '../src/usage-format'),
    path.resolve(process.cwd(), 'src/usage-format'),
    path.resolve(process.cwd(), '..', 'src', 'usage-format'),
    path.resolve(__dirname, 'src/usage-format'),
    path.resolve(__dirname, '../src/usage-format'),
  ];

  for (const candidate of candidates) {
    const candidateFile = `${candidate}.js`;
    if (existsSync(candidateFile)) {
      return require(candidateFile);
    }
  }

  throw new Error('cannot locate usage-format.js module in script or bundle resources');
}

const {
  buildDisplayPayload,
  buildDetailPageLines,
  buildSessionLine,
  buildWirePayload,
  summarizeAccount,
  summarizeActivity,
  summarizeGoal,
  summarizeHealth,
  summarizePlan,
  summarizeSchedule,
  summarizeTokenUsage,
  summarizeThreadSessions,
  summarizeThreadStatus,
} = resolveUsageFormatModule();

const DEFAULT_CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_PORT = '/dev/cu.usbmodem1401';
const DEFAULT_TRANSPORT = 'serial';
const DEFAULT_BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_BLE_WRITE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_BLE_DEVICE_NAME = 'CodexStatusDisplay';
const BLE_WRITE_CHUNK_SIZE = 18;
const BLE_DISCOVERY_TIMEOUT_MS = 20_000;
const SCHEDULE_CACHE_MS = 60_000;
const LARK_AUTH_CACHE_MS = 60_000;
const LARK_CALENDAR_SCOPE = 'calendar:calendar.event:read';

function recentActivityWindowMs(intervalMs) {
  return Math.max(Number(intervalMs || 0) * 2, 30_000);
}

function shanghaiDayStartIso(offsetDays = 0, nowMs = Date.now()) {
  const target = new Date(nowMs + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(target);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}T00:00:00+08:00`;
}

function uniqueExisting(paths) {
  const seen = new Set();
  return paths.filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return existsSync(item);
  });
}

function resolveLarkCliBin() {
  if (process.env.LARK_CLI_BIN && existsSync(process.env.LARK_CLI_BIN)) {
    return process.env.LARK_CLI_BIN;
  }

  const pathCandidates = String(process.env.PATH || '')
    .split(':')
    .filter(Boolean)
    .map((dir) => path.join(dir, 'lark-cli'));
  const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
  let nvmCandidates = [];
  try {
    nvmCandidates = readdirSync(nvmDir)
      .map((version) => path.join(nvmDir, version, 'bin/lark-cli'));
  } catch {
    nvmCandidates = [];
  }
  const candidates = uniqueExisting([
    ...pathCandidates,
    ...nvmCandidates,
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
  ]);
  return candidates[0] || 'lark-cli';
}

function normalizeBleId(value) {
  return String(value || '').toLowerCase().replace(/[:\s-]/g, '');
}

function normalizeBleUuid(value) {
  return String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

function makeTransportState(options) {
  const target = options.transport === 'ble'
    ? (options.bleName || options.bleDeviceId || DEFAULT_BLE_DEVICE_NAME)
    : options.port;
  return {
    mode: options.transport || DEFAULT_TRANSPORT,
    state: 'connecting',
    target,
    detail: '',
  };
}

function parseArgs(argv) {
  const options = {
    codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,
    intervalMs: 15000,
    port: DEFAULT_PORT,
    baudRate: 115200,
    transport: process.env.CODEX_TRANSPORT || DEFAULT_TRANSPORT,
    bleDeviceId: process.env.CODEX_BLE_DEVICE_ID || '',
    bleName: process.env.CODEX_BLE_NAME || '',
    bleServiceUuid: process.env.CODEX_BLE_SERVICE_UUID || DEFAULT_BLE_SERVICE_UUID,
    bleWriteCharUuid: process.env.CODEX_BLE_WRITE_CHAR_UUID || DEFAULT_BLE_WRITE_CHAR_UUID,
    dryRun: false,
    once: false,
    stateFile: '',
    sessionId: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--port') options.port = argv[++i];
    else if (arg === '--baud') options.baudRate = Number(argv[++i]);
    else if (arg === '--interval') options.intervalMs = Number(argv[++i]);
    else if (arg === '--transport') options.transport = argv[++i] || DEFAULT_TRANSPORT;
    else if (arg === '--ble-device-id') options.bleDeviceId = argv[++i];
    else if (arg === '--ble-name') options.bleName = argv[++i];
    else if (arg === '--ble-service-uuid') options.bleServiceUuid = argv[++i];
    else if (arg === '--ble-write-char-uuid') options.bleWriteCharUuid = argv[++i];
    else if (arg === '--codex-bin') options.codexBin = argv[++i];
    else if (arg === '--state-file') options.stateFile = argv[++i] || '';
    else if (arg === '--session-id') options.sessionId = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.transport = options.transport === 'ble' ? 'ble' : 'serial';
  if (options.transport === 'ble') {
    if (!options.bleServiceUuid) options.bleServiceUuid = DEFAULT_BLE_SERVICE_UUID;
    if (!options.bleWriteCharUuid) options.bleWriteCharUuid = DEFAULT_BLE_WRITE_CHAR_UUID;
    if (!options.bleName && !options.bleDeviceId) options.bleName = DEFAULT_BLE_DEVICE_NAME;
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run bridge -- [options]

Options:
  --transport <serial|ble> Transport: serial 或 ble (default: ${DEFAULT_TRANSPORT})
  --port <path>       Serial port for the ESP32 (default: ${DEFAULT_PORT})
  --baud <number>     Serial baud rate (default: 115200)
  --ble-device-id <id> BLE 设备地址/ID，优先于名称匹配
  --ble-name <name>   BLE 设备广播名
  --ble-service-uuid <uuid> BLE Service UUID
  --ble-write-char-uuid <uuid> BLE write Characteristic UUID
  --interval <ms>     Refresh interval (default: 15000)
  --codex-bin <path>  Codex CLI binary (default: ${DEFAULT_CODEX_BIN})
  --state-file <path> Write status snapshot for UI consumption
  --session-id <id>   Runtime session id for UI to ignore stale snapshots
  --dry-run           Print payloads instead of opening serial
  --once              Send one payload and exit
`);
}

function activityFromNotification(message, status) {
  const params = message.params || {};
  const item = params.item || params;
  const command = item.command || item.cmd || item.title || item.name || '';
  const file = item.file || item.path || '';
  const kind = command ? 'command' : (file ? 'file' : (item.type || 'event'));
  return {
    kind,
    status,
    command,
    file,
    message: item.summary || item.text || item.title || '',
    exitCode: item.exitCode ?? item.code,
  };
}

class CodexRpc extends EventEmitter {
  constructor(codexBin) {
    super();
    this.codexBin = codexBin;
    this.nextId = 1;
    this.pending = new Map();
    this.statusByThread = new Map();
    this.latestThreadId = '';
    this.telemetry = {
      plan: null,
      activity: null,
      tokenUsage: null,
      goal: null,
      warning: '',
      error: '',
      accountUsage: null,
      lastTotalTokens: null,
    };
    this.scheduleCache = {
      fetchedAt: 0,
      summary: null,
    };
    this.larkAuthCache = {
      fetchedAt: 0,
      summary: null,
    };
    this.buffer = '';
    this.proc = null;
  }

  start() {
    this.proc = spawn(this.codexBin, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => this.consumeStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    this.proc.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit('exit', error);
    });
  }

  consumeStdout(chunk) {
    this.buffer += chunk.toString();
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.handleMessage(JSON.parse(line));
    }
  }

  handleMessage(message) {
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === 'thread/status/changed') {
      this.statusByThread.set(message.params.threadId, message.params.status);
      this.latestThreadId = message.params.threadId || this.latestThreadId;
    } else if (message.method === 'turn/plan/updated') {
      this.telemetry.plan = message.params?.plan || message.params;
    } else if (message.method === 'item/started') {
      this.telemetry.activity = activityFromNotification(message, 'running');
    } else if (message.method === 'item/completed') {
      this.telemetry.activity = activityFromNotification(message, 'completed');
    } else if (message.method === 'command/exec/outputDelta') {
      this.telemetry.activity = {
        kind: 'command',
        status: 'running',
        command: message.params?.command || message.params?.cmd || this.telemetry.activity?.command || '命令输出',
        message: message.params?.delta || message.params?.text || '命令输出',
      };
    } else if (message.method === 'process/exited') {
      this.telemetry.activity = {
        kind: 'command',
        status: Number(message.params?.exitCode ?? message.params?.code ?? 0) === 0 ? 'completed' : 'error',
        command: message.params?.command || this.telemetry.activity?.command || '命令',
        exitCode: message.params?.exitCode ?? message.params?.code,
      };
    } else if (message.method === 'thread/tokenUsage/updated') {
      this.telemetry.tokenUsage = message.params?.tokenUsage || message.params;
    } else if (message.method === 'thread/goal/updated') {
      this.telemetry.goal = message.params?.goal || message.params;
    } else if (message.method === 'warning') {
      this.telemetry.warning = message.params?.message || message.params?.warning || 'Codex 警告';
    } else if (message.method === 'error') {
      this.telemetry.error = message.params?.message || message.params?.error || 'Codex 异常';
    }
    this.emit('notification', message);
  }

  request(method, params, timeoutMs = 12000) {
    const id = this.nextId;
    this.nextId += 1;
    const body = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${body}\n`);
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex-status-display', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  }

  async readRateLimits() {
    const result = await this.request('account/rateLimits/read', null);
    return result.rateLimitsByLimitId?.codex || result.rateLimits;
  }

  async safeRequest(method, params = null, timeoutMs = 5000) {
    try {
      return await this.request(method, params, timeoutMs);
    } catch (error) {
      this.telemetry.warning = `${method}: ${error.message}`;
      return null;
    }
  }

  async buildEnhancements(transport, rateLimits) {
    const account = await this.safeRequest('account/read', {}, 5000);
    const accountUsage = await this.safeRequest('account/usage/read', {}, 5000);
    const models = await this.safeRequest('model/list', {}, 5000);
    if (accountUsage) {
      this.telemetry.accountUsage = accountUsage;
    }

    let goal = this.telemetry.goal;
    if (this.latestThreadId) {
      const goalResult = await this.safeRequest('thread/goal/get', { threadId: this.latestThreadId }, 5000);
      goal = goalResult?.goal || goalResult || goal;
    }

    const tokenSummary = summarizeTokenUsage(
      this.telemetry.tokenUsage || {},
      this.telemetry.accountUsage || {},
      {
        contextPercentFallback: rateLimits?.primary?.usedPercent,
        previousTotalTokens: this.telemetry.lastTotalTokens,
      },
    );
    if (Number.isFinite(tokenSummary.totalTokens)) {
      this.telemetry.lastTotalTokens = tokenSummary.totalTokens;
    }

    const accountInfo = account?.account || account?.user || account || null;
    const larkAuth = await this.readLarkAuthSummary();
    const schedule = await this.readScheduleSummary();
    return {
      plan: summarizePlan(this.telemetry.plan || {}),
      activity: summarizeActivity(this.telemetry.activity || {}),
      token: tokenSummary,
      health: summarizeHealth({
        account: accountInfo,
        appServer: { state: this.proc ? 'connected' : 'error' },
        transport,
        warning: this.telemetry.warning,
        error: this.telemetry.error,
      }),
      goal: summarizeGoal(goal || {}),
      account: summarizeAccount({ account: accountInfo, models, rateLimits }),
      larkAuth,
      schedule,
    };
  }

  async readLarkAuthSummary(nowMs = Date.now()) {
    if (
      this.larkAuthCache.summary
      && nowMs - this.larkAuthCache.fetchedAt < LARK_AUTH_CACHE_MS
    ) {
      return this.larkAuthCache.summary;
    }

    const summary = await readLarkAuthSummary();
    this.larkAuthCache = { fetchedAt: nowMs, summary };
    return summary;
  }

  async readScheduleSummary(nowMs = Date.now()) {
    if (
      this.scheduleCache.summary
      && nowMs - this.scheduleCache.fetchedAt < SCHEDULE_CACHE_MS
    ) {
      return this.scheduleCache.summary;
    }

    try {
      const events = await readFeishuEvents(nowMs);
      const summary = summarizeSchedule(events, { nowMs });
      this.scheduleCache = { fetchedAt: nowMs, summary };
      return summary;
    } catch (error) {
      const summary = scheduleErrorSummary(error.message);
      this.scheduleCache = { fetchedAt: nowMs, summary };
      return summary;
    }
  }

  async refreshLoadedThreads() {
    const threads = [];
    try {
      const loaded = await this.request('thread/loaded/list', { limit: 50 });
      await Promise.all((loaded.data || []).map(async (threadId) => {
        try {
          const result = await this.request('thread/read', { threadId, includeTurns: false });
          if (result.thread?.status) {
            this.statusByThread.set(threadId, result.thread.status);
            this.latestThreadId = threadId || this.latestThreadId;
            threads.push({
              id: threadId,
              title: result.thread.title || '',
              preview: result.thread.preview || '',
              cwd: result.thread.cwd || '',
              status: result.thread.status,
              updatedAt: Number(result.thread.updatedAt || 0) * 1000,
            });
          }
        } catch {
          // A thread can unload between list and read; the next tick will settle it.
          const status = this.statusByThread.get(threadId);
          if (status) threads.push({ id: threadId, preview: '', status, updatedAt: 0 });
          else threads.push({ id: threadId, preview: '', status: null, updatedAt: 0 });
        }
      }));
    } catch {
      // Some standalone app-server sessions do not have loaded desktop threads.
    }
    return threads;
  }

  stop() {
    if (!this.proc) return Promise.resolve();
    return new Promise((resolve) => {
      const proc = this.proc;
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      proc.once('close', finish);
      proc.once('error', finish);
      setTimeout(finish, 2000);
      proc.kill('SIGTERM');
    }).finally(() => {
      this.proc = null;
    });
  }
}

function larkAuthStatusItem(state, label, title, meta) {
  return {
    state,
    label,
    title,
    meta: String(meta || '').slice(0, 16),
  };
}

function parseLarkAuthCheck(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function readLarkAuthSummary() {
  try {
    const larkCliBin = resolveLarkCliBin();
    const raw = await execFileText(larkCliBin, [
      'auth',
      'check',
      '--scope',
      LARK_CALENDAR_SCOPE,
      '--json',
    ], 8000);
    const parsed = parseLarkAuthCheck(raw);
    if (parsed.ok === true || parsed.authorized === true || parsed.status === 'ok') {
      return {
        state: 'done',
        summary: '已授权',
        items: [larkAuthStatusItem('done', '授权', '飞书日历已授权', LARK_CALENDAR_SCOPE)],
      };
    }

    const errorMessage = parsed.error?.message || parsed.error?.hint || parsed.message || '';
    const missingScopes = Array.isArray(parsed.missing_scopes)
      ? parsed.missing_scopes
      : (Array.isArray(parsed.missingScopes) ? parsed.missingScopes : []);
    return {
      state: 'check',
      summary: '需要飞书授权',
      items: [
        larkAuthStatusItem(
          'check',
          '授权',
          '需要飞书日历权限',
          errorMessage || missingScopes.join(',') || LARK_CALENDAR_SCOPE,
        ),
      ],
    };
  } catch (error) {
    return {
      state: 'error',
      summary: '授权检查异常',
      items: [
        larkAuthStatusItem('error', '异常', '飞书授权检查失败', error.message || '稍后重试'),
      ],
    };
  }
}

function execFileText(file, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve(stdout || stderr || '');
    });
  });
}

function execShellText(command, timeoutMs = 8000) {
  return execFileText('/bin/zsh', ['-lc', command], timeoutMs);
}

function parseScheduleEvents(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (parsed && parsed.ok === false) {
    throw new Error(parsed.error?.message || parsed.error?.hint || '日程读取失败');
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.events)) return parsed.events;
  if (Array.isArray(parsed.result?.data)) return parsed.result.data;
  if (Array.isArray(parsed.result?.events)) return parsed.result.events;
  return [];
}

function scheduleErrorSummary(message) {
  return {
    current: null,
    next: null,
    todayRemainingCount: 0,
    todayEvents: [],
    tomorrowEvents: [],
    summary: '日程服务异常',
    items: [
      {
        state: 'error',
        label: '异常',
        title: '飞书日程不可用',
        meta: String(message || '稍后重试').slice(0, 16),
      },
    ],
  };
}

async function readFeishuEvents(nowMs = Date.now()) {
  if (process.env.FEISHU_EVENTS_COMMAND) {
    return parseScheduleEvents(await execShellText(process.env.FEISHU_EVENTS_COMMAND, 8000));
  }

  const larkCliBin = resolveLarkCliBin();
  const stdout = await execFileText(larkCliBin, [
    'calendar',
    '+agenda',
    '--as', 'user',
    '--start', shanghaiDayStartIso(0, nowMs),
    '--end', shanghaiDayStartIso(2, nowMs),
    '--format', 'json',
  ], 8000);
  return parseScheduleEvents(stdout);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setPortSignals(port, signals) {
  return new Promise((resolve) => port.set(signals, () => resolve()));
}

function writeRaw(port, payload) {
  return new Promise((resolve, reject) => {
    port.write(payload, (writeError) => {
      if (writeError) {
        reject(writeError);
        return;
      }
      port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
    });
  });
}

function openSerialPortWithTimeout(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`串口打开超时: ${port.path}`));
    }, timeoutMs);

    port.open((error) => finish(error));
  });
}

function createSerialOutput(options, transportState) {
  let activePort = null;
  let connectingPromise = null;
  let isClosing = false;
  let detachListeners = null;

  function detachActivePort() {
    if (detachListeners) {
      detachListeners();
      detachListeners = null;
    }
  }

  function setState(state, detail) {
    transportState.state = state;
    if (detail) transportState.detail = detail;
  }

  async function closePort(port) {
    if (!port || !port.isOpen) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, 1500);
      port.close((error) => {
        clearTimeout(timer);
        if (error && error.message !== 'Closed already') {
          console.error(`[serial] close error: ${error.message}`);
        }
        resolve();
      });
    });
  }

  function onPortClose() {
    if (isClosing) return;
    if (!activePort) return;
    setState('disconnected', '串口已断开');
    activePort = null;
    detachActivePort();
  }

  function onPortError(error) {
    if (isClosing) return;
    if (error?.message) {
      setState('error', error.message);
    } else {
      setState('error', '串口异常');
    }
  }

  function setupPortListeners(port) {
    const closeListener = () => {
      if (activePort !== port) return;
      onPortClose();
    };
    const errorListener = (error) => {
      if (activePort !== port) return;
      onPortError(error);
    };
    port.on('close', closeListener);
    port.on('error', errorListener);
    return () => {
      port.removeListener('close', closeListener);
      port.removeListener('error', errorListener);
    };
  }

  async function openPort() {
    const port = new SerialPort({
      path: options.port,
      baudRate: options.baudRate,
      autoOpen: false,
    });

    setState('connecting', `正在连接串口 ${options.port}`);
    console.error(`[serial] opening ${options.port}`);

    try {
      await openSerialPortWithTimeout(port);
      console.error('[serial] connected');
      attachBoardLogger(port);
      await setPortSignals(port, { dtr: true, rts: false });
      await sleep(4000);
      await writeRaw(port, '\n');
      await sleep(250);
      transportState.target = options.port;
      setState('connected', '串口已连接');
      return port;
    } catch (error) {
      setState('error', error.message || '串口连接失败');
      await closePort(port);
      throw error;
    }
  }

  async function ensureConnected() {
    if (activePort?.isOpen) {
      if (transportState.state === 'error') {
        setState('connected');
      }
      return activePort;
    }

    if (!connectingPromise) {
      connectingPromise = (async () => {
        detachActivePort();
        activePort = null;
        const port = await openPort();
        if (isClosing) {
          await closePort(port);
          return null;
        }
        activePort = port;
        detachListeners = setupPortListeners(port);
        return port;
      })();

      connectingPromise.finally(() => {
        connectingPromise = null;
      });
    }

    return connectingPromise;
  }

  return {
    write: async (payload) => {
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const port = await ensureConnected();
        if (!port) {
          throw new Error('串口未连接');
        }

        try {
          await writeRaw(port, `${payload}\n`);
          setState('connected', '串口已连接');
          return;
        } catch (error) {
          lastError = error;
          setState('error', error.message || '串口写入失败');
          await closePort(port);
          detachActivePort();
          activePort = null;
        }

        if (attempt === 1) {
          setState('connecting', '串口重连中');
        }
      }
      throw lastError || new Error('串口发送失败');
    },
    close: async () => {
      isClosing = true;
      setState('disconnected', '串口关闭中');
      if (connectingPromise) {
        await connectingPromise.catch(() => {});
      }
      connectingPromise = null;
      detachActivePort();
      await closePort(activePort);
      activePort = null;
      isClosing = false;
    },
    transport: transportState,
  };
}

function writeTimeout(work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BLE write timeout')), 5000);
    work((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function eventWaiter(emitter, eventName) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const cleanup = () => {
      if (done) return;
      done = true;
      emitter.removeListener(eventName, handler);
      if (timer) clearTimeout(timer);
    };

    const handler = (...args) => {
      if (done) return;
      cleanup();
      resolve(args);
    };

    emitter.on(eventName, handler);
    timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new Error(`wait ${eventName} timeout`));
    }, 8000);
  });
}

function normalizeBuffer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(String(value || ''));
}

function waitForBlePowerOn(noble) {
  if (noble.state === 'poweredOn') return Promise.resolve();
  return eventWaiter(noble, 'stateChange').then(([state]) => {
    if (state === 'poweredOn') return;
    throw new Error('Bluetooth adapter is not powered on');
  });
}

function isTargetPeripheral(peripheral, options) {
  const targetId = normalizeBleId(options.bleDeviceId);
  if (targetId) {
    const id = normalizeBleId(peripheral.id);
    const address = normalizeBleId(peripheral.address);
    return id === targetId || address === targetId;
  }

  const targetName = String(options.bleName || '').trim();
  if (!targetName) return true;
  return String(peripheral.advertisement?.localName || '').trim() === targetName;
}

function findCharacteristicByUuid(characteristics, charUuid) {
  const target = normalizeBleUuid(charUuid);
  return characteristics.find((characteristic) => {
    const uuid = normalizeBleUuid(characteristic.uuid);
    return uuid === target;
  });
}

function findAnyWritableCharacteristic(characteristics) {
  return characteristics.find((characteristic) => {
    const props = characteristic.properties || [];
    return props.includes('write') || props.includes('writeWithoutResponse');
  });
}

async function openBleOutput(options) {
  const transportState = makeTransportState(options);
  let noble;
  try {
    // eslint-disable-next-line import/no-unresolved
    noble = require('@abandonware/noble');
  } catch {
    transportState.state = 'error';
    transportState.detail = 'BLE 依赖缺失';
    throw new Error('BLE 依赖缺失，请先执行 npm install');
  }

  try {
    await waitForBlePowerOn(noble);
  } catch (error) {
    transportState.state = 'error';
    transportState.detail = error.message;
    throw error;
  }

  const serviceUuid = normalizeBleUuid(options.bleServiceUuid);
  const peripheral = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      noble.removeListener('discover', onDiscover);
      noble.stopScanning();
      transportState.state = 'error';
      transportState.detail = '未在 BLE 扫描中发现目标设备';
      reject(new Error('未在 BLE 扫描中发现目标设备'));
    }, BLE_DISCOVERY_TIMEOUT_MS);

    const onDiscover = (candidate) => {
      if (!isTargetPeripheral(candidate, options)) return;
      noble.removeListener('discover', onDiscover);
      clearTimeout(timeout);
      noble.stopScanning();
      transportState.state = 'connected';
      transportState.detail = String(candidate.advertisement?.localName || candidate.id).trim() || transportState.target;
      transportState.target = transportState.detail;
      resolve(candidate);
    };

    noble.on('discover', onDiscover);
    noble.startScanning([], false);
  });

  try {
    await writeTimeout((done) => peripheral.connect(done));
  } catch (error) {
    transportState.state = 'error';
    transportState.detail = error.message || 'BLE 连接失败';
    throw error;
  }

  const services = await new Promise((resolve, reject) => {
    peripheral.discoverServices([serviceUuid], (error, serviceList) => {
      if (error) return reject(error);
      if (!serviceList || serviceList.length === 0) return reject(new Error('BLE 未找到目标服务'));
      resolve(serviceList);
    });
  });

  const service = services.find((item) => normalizeBleUuid(item.uuid) === normalizeBleUuid(serviceUuid)) || services[0];
  const characteristics = await new Promise((resolve, reject) => {
    service.discoverCharacteristics([], (error, characteristicList) => {
      if (error) return reject(error);
      if (!characteristicList || characteristicList.length === 0) {
        reject(new Error('BLE 写入特征列表为空'));
        return;
      }
      resolve(characteristicList);
    });
  });

  let writeCharacteristic = findCharacteristicByUuid(characteristics, options.bleWriteCharUuid);
  if (!writeCharacteristic) {
    writeCharacteristic = findAnyWritableCharacteristic(characteristics);
  }
  if (!writeCharacteristic) {
    throw new Error('BLE 没有可写特征');
  }

  peripheral.on('disconnect', () => {
    if (transportState.state !== 'error') {
      transportState.state = 'disconnected';
      transportState.detail = 'BLE 已断开';
    }
  });

  return {
    transport: transportState,
    close: () => new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        console.error('[ble] disconnect timeout, force exit');
        transportState.state = 'error';
        transportState.detail = 'BLE 关闭超时';
        finish();
      }, 3000);

      peripheral.disconnect((disconnectError) => {
        clearTimeout(timer);
        if (disconnectError && disconnectError.message !== 'not connected') {
          console.error(`[ble] disconnect error: ${disconnectError.message}`);
          transportState.state = 'error';
          transportState.detail = disconnectError.message || 'BLE 关闭失败';
        } else if (!transportState.state || transportState.state === 'connected') {
          transportState.state = 'disconnected';
          transportState.detail = 'BLE 已断开';
        }
        finish();
      });
    }),
    write: async (payload) => {
      if (transportState.state !== 'connected') {
        transportState.state = 'connecting';
      }
      const message = normalizeBuffer(`${payload}\n`);
      for (let offset = 0; offset < message.length; offset += BLE_WRITE_CHUNK_SIZE) {
        const chunk = message.slice(offset, offset + BLE_WRITE_CHUNK_SIZE);
        try {
          await writeTimeout((done) => writeCharacteristic.write(chunk, true, done));
        } catch (error) {
          transportState.state = 'error';
          transportState.detail = String(error.message || 'BLE 写入失败');
          throw error;
        }
        await sleep(20);
      }
      transportState.state = 'connected';
      if (!transportState.detail) {
        transportState.detail = 'BLE 已连接';
      }
    },
  };
}

function sanitizeStateSessionPayload(sessions) {
  const counts = sessions?.counts || sessions || {};
  const snapshot = {
    work: Number(counts.work || 0),
    check: Number(counts.check || 0),
    idle: Number(counts.idle || 0),
    error: Number(counts.error || 0),
  };

  const items = Array.isArray(sessions?.items) ? sessions.items : [];
  if (items.length > 0) {
    snapshot.items = items
      .slice(0, 3)
      .map((item) => ({
        state: String(item.state || 'idle'),
        label: String(item.label || ''),
        title: String(item.title || item.detail || ''),
        meta: String(item.project || item.meta || ''),
      }));
  }

  return snapshot;
}

function writeStateFile(stateFile, payload, sessions, transport) {
  if (!stateFile) return;
  const sessionsSnapshot = sanitizeStateSessionPayload(sessions);
  const snapshot = {
    v: payload.v,
    clientSessionId: payload.clientSessionId,
    ts: payload.ts,
    short: payload.short,
    long: payload.long,
    status: payload.status,
    sessions: sessionsSnapshot,
    homeHint: payload.homeHint,
    enhancements: payload.enhancements,
    limited: payload.limited,
    transport,
  };
  writeFileSync(stateFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function attachBoardLogger(port) {
  let buffer = '';
  port.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) console.error(`[board] ${line}`);
    }
  });
}

async function detectRecentCodexActivity(intervalMs) {
  const db = path.join(os.homedir(), '.codex/state_5.sqlite');
  const query = 'select coalesce(max(updated_at_ms), max(updated_at) * 1000, 0) from threads where archived=0;';
  const stdout = await execFileText('/usr/bin/sqlite3', [db, query]);
  const updatedAtMs = Number(stdout.trim());
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null;
  const ageMs = Date.now() - updatedAtMs;
  if (ageMs >= 0 && ageMs < Math.max(intervalMs * 2, 30000)) {
    return { state: 'working', label: '最近活动' };
  }
  return null;
}

async function readRecentThreads(limit = 5) {
  const db = path.join(os.homedir(), '.codex/state_5.sqlite');
  const query = [
    "select id,",
    "replace(replace(title, char(10), ' '), char(9), ' '),",
    "replace(replace(preview, char(10), ' '), char(9), ' '),",
    "replace(replace(cwd, char(10), ' '), char(9), ' '),",
    'coalesce(updated_at_ms, updated_at * 1000, 0)',
    'from threads',
    'where archived=0',
    'order by coalesce(updated_at_ms, updated_at * 1000, 0) desc',
    `limit ${Number(limit) || 5};`,
  ].join(' ');
  const stdout = await execFileText('/usr/bin/sqlite3', ['-separator', '\t', db, query]);
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [id, title, preview, cwd, updatedAt] = line.split('\t');
    return {
      id,
      title,
      preview,
      cwd,
      updatedAt: Number(updatedAt) || 0,
      status: null,
    };
  });
}

function mergeThreadMetadata(threads, fallbackThreads) {
  const fallbackById = new Map(fallbackThreads.map((thread) => [thread.id, thread]));
  const byId = new Map();

  for (const thread of threads) {
    if (!thread?.id) continue;
    const fallback = fallbackById.get(thread.id) || {};
    byId.set(thread.id, {
      id: thread.id,
      title: thread.title || fallback.title || '',
      preview: thread.preview || fallback.preview || '',
      cwd: thread.cwd || fallback.cwd || '',
      updatedAt: Number(thread.updatedAt || fallback.updatedAt || 0),
      status: thread.status ?? fallback.status ?? null,
    });
  }

  for (const thread of fallbackThreads) {
    if (!thread?.id || byId.has(thread.id)) continue;
    byId.set(thread.id, {
      id: thread.id,
      title: thread.title || '',
      preview: thread.preview || '',
      cwd: thread.cwd || '',
      updatedAt: Number(thread.updatedAt || 0),
      status: thread.status ?? null,
    });
  }

  return [...byId.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

async function hydrateThreadStatuses(rpc, threads) {
  await Promise.all(
    threads.map(async (thread) => {
      if (thread.status) return;
      try {
        const result = await rpc.request('thread/read', {
          threadId: thread.id,
          includeTurns: false,
        });
        if (result.thread?.status) {
          thread.status = result.thread.status;
        }
      } catch {
        thread.status = null;
      }
    }),
  );
}

async function detectCpuActivity(rpcPid) {
  const stdout = await execFileText('/bin/ps', ['-axo', 'pid=,pcpu=,command=']);
  const active = stdout.split('\n').some((line) => {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) return false;
    const pid = Number(match[1]);
    const cpu = Number(match[2]);
    const command = match[3];
    if (pid === process.pid || pid === rpcPid) return false;
    return cpu >= 5 && command.includes('/Applications/Codex.app/');
  });
  return active ? { state: 'working', label: '工作中' } : null;
}

async function buildStatusAndSessions(rpc, intervalMs) {
  const loadedThreads = await rpc.refreshLoadedThreads();
  const recentThreads = await readRecentThreads(20);
  const sessionsThreads = mergeThreadMetadata(loadedThreads, recentThreads);
  await hydrateThreadStatuses(rpc, sessionsThreads);
  const summarized = summarizeThreadStatus(sessionsThreads.map((thread) => thread.status));
  const sessionPayload = summarizeThreadSessions(sessionsThreads, 5, Date.now(), {
    recentActivityMs: recentActivityWindowMs(intervalMs),
  });

  if (summarized.state !== 'idle') {
    if (summarized.state === 'working') {
      return {
        status: {
          ...summarized,
          count: Math.max(Number(summarized.count || 0), Number(sessionPayload.counts?.work || 0)),
        },
        sessions: sessionPayload,
      };
    }
    return {
      status: summarized,
      sessions: sessionPayload,
    };
  }

  if ((sessionPayload.counts?.work || 0) > 0) {
    return {
      status: {
        state: 'working',
        label: '最近活动',
        count: sessionPayload.counts.work,
      },
      sessions: sessionPayload,
    };
  }

  const recentActivity = await detectRecentCodexActivity(intervalMs);
  if (recentActivity) {
    return {
      status: recentActivity,
      sessions: sessionPayload,
    };
  }

  const cpuActivity = await detectCpuActivity(rpc.proc?.pid);
  if (cpuActivity) {
    return {
      status: cpuActivity,
      sessions: sessionPayload,
    };
  }

  return {
    status: summarized,
    sessions: sessionPayload,
  };
}

async function openOutput(options) {
  const transportState = makeTransportState(options);

  if (options.dryRun) {
    return {
      write: async (payload) => process.stdout.write(`${payload}\n`),
      close: async () => {},
      transport: transportState,
    };
  }

  if (options.transport === 'ble') {
    return openBleOutput(options);
  }

  return createSerialOutput(options, transportState);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rpc = new CodexRpc(options.codexBin);
  const output = await openOutput(options);

  rpc.on('stderr', (text) => {
    if (text.trim()) console.error(`[codex] ${text.trim()}`);
  });

  rpc.start();
  await rpc.initialize();

  async function tick() {
    try {
      const rateLimits = await rpc.readRateLimits();
      const { status, sessions } = await buildStatusAndSessions(rpc, options.intervalMs);
      const transport = output.transport;
      const enhancements = await rpc.buildEnhancements(transport, rateLimits);
      const payload = buildDisplayPayload({ rateLimits, status, sessions, enhancements });
      const wirePayload = JSON.stringify(buildWirePayload(payload));
      const detailLines = buildDetailPageLines(payload.enhancements);
      payload.clientSessionId = options.sessionId;
      await output.write(wirePayload);
      await sleep(250);
      await output.write(buildSessionLine(payload.sessions));
      for (const detailLine of detailLines) {
        await sleep(120);
        await output.write(detailLine);
      }
      await sleep(250);
      await output.write(wirePayload);
      payload.transport = {
        mode: transport?.mode || options.transport,
        state: transport?.state || 'unknown',
        target: transport?.target || '',
        detail: transport?.detail || '',
      };
      writeStateFile(options.stateFile, payload, payload.sessions, payload.transport);
      const loggedSessions = payload.sessions?.counts || sessions?.counts || { work: 0, check: 0, idle: 0, error: 0 };
      console.error(`[sent] ${payload.short.label} ${payload.short.remainingPercent}% | ${payload.long.label} ${payload.long.remainingPercent}% | ${payload.status.label} | W${loggedSessions.work}/C${loggedSessions.check}/I${loggedSessions.idle}`);
    } catch (error) {
      const transport = output.transport || makeTransportState(options);
      if (transport.state === 'error') {
        transport.detail = String(error.message || transport.detail || '连接异常');
      }
      const fallback = {
        v: 1,
        clientSessionId: options.sessionId,
        ts: Math.floor(Date.now() / 1000),
        error: error.message,
        status: { state: 'error', label: '连接异常' },
        sessions: { work: 0, check: 0, idle: 0, error: 0 },
        transport: {
          mode: transport.mode || options.transport,
          state: transport.state || 'unknown',
          target: transport.target || '',
          detail: transport.detail || '',
        },
      };
      await output.write(JSON.stringify(fallback)).catch(() => {});
      writeStateFile(options.stateFile, fallback, fallback.sessions, fallback.transport);
      console.error(`[error] ${error.message}`);
    }
  }

  await tick();
  if (options.once) {
    await sleep(4000);
    await rpc.stop();
    await Promise.race([
      output.close(),
      sleep(5000).then(() => {
        console.error('[warn] output close timeout, force exit');
      }),
    ]);
    process.exit(0);
    return;
  }

  const timer = setInterval(tick, options.intervalMs);
  process.on('SIGINT', async () => {
    clearInterval(timer);
    rpc.stop();
    await output.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
