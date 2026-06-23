const path = require('node:path');
const MAX_PAGE_ITEMS = 9;
const MAX_SCHEDULE_ITEMS = 9;
const SCHEDULE_VISIBLE_ROWS_WITH_FEATURE = 4;
const SCHEDULE_VISIBLE_ROWS_WITHOUT_FEATURE = 5;
const UPCOMING_SCHEDULE_HIGHLIGHT_MS = 15 * 60 * 1000;

function clampPercent(value) {
  const n = Number.isFinite(value) ? value : null;
  return n === null ? null : Math.max(0, Math.min(100, Math.round(n)));
}

function remainingPercent(window) {
  return clampPercent(100 - Number(window?.usedPercent ?? 0));
}

function formatCompactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function timeRemainingPercent(window, nowMs = Date.now()) {
  const resetsAt = Number(window?.resetsAt || 0);
  const windowDurationMins = Number(window?.windowDurationMins || 0);
  if (!Number.isFinite(resetsAt) || !Number.isFinite(windowDurationMins) || resetsAt <= 0 || windowDurationMins <= 0) {
    return 0;
  }

  const diffMs = resetsAt * 1000 - nowMs;
  const windowMs = windowDurationMins * 60 * 1000;
  return clampPercent((diffMs / windowMs) * 100);
}

function formatWindowLabel(windowDurationMins) {
  if (windowDurationMins === 300) return '5 小时';
  if (windowDurationMins === 10080) return '1 周';
  if (windowDurationMins && windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60} 小时`;
  }
  return `${windowDurationMins ?? '-'} 分钟`;
}

function shanghaiParts(ms) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function shanghaiDateKey(ms) {
  const parts = shanghaiParts(ms);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDaysDateKey(ms, days) {
  return shanghaiDateKey(ms + days * 24 * 60 * 60 * 1000);
}

function formatEventTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const parts = shanghaiParts(ms);
  return `${parts.hour}:${parts.minute}`;
}

function isDateOnlyString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function parseTimeLike(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return parseTimeLike(Number(text));
    const normalized = isDateOnlyString(text) ? `${text}T00:00:00+08:00` : text;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'object') {
    return parseTimeLike(
      value.datetime
      ?? value.dateTime
      ?? value.timestamp
      ?? value.time
      ?? value.date
      ?? value.value,
    );
  }
  return null;
}

function formatResetLabel(resetsAtSeconds, nowMs = Date.now()) {
  if (!resetsAtSeconds) return '--';
  const resetMs = resetsAtSeconds * 1000;
  const now = shanghaiParts(nowMs);
  const reset = shanghaiParts(resetMs);
  if (now.month === reset.month && now.day === reset.day) {
    return `${reset.hour}:${reset.minute}`;
  }
  return `${Number(reset.month)}月${Number(reset.day)}日`;
}

function formatResetAscii(resetsAtSeconds, nowMs = Date.now()) {
  if (!resetsAtSeconds) return '--';
  const resetMs = resetsAtSeconds * 1000;
  const now = shanghaiParts(nowMs);
  const reset = shanghaiParts(resetMs);
  if (now.month === reset.month && now.day === reset.day) {
    return `${reset.hour}:${reset.minute}`;
  }
  return `${Number(reset.month)}/${Number(reset.day)}`;
}

function formatResetRemaining(resetsAtSeconds, nowMs = Date.now()) {
  if (!resetsAtSeconds) return '--';
  const resetMs = Number(resetsAtSeconds) * 1000;
  if (!Number.isFinite(resetMs)) return '--';

  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return '0分';

  const totalMinutes = Math.max(1, Math.floor(diffMs / (60 * 1000)));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${minutes}分`;
  return `${minutes}分`;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readNumberAtPath(input, path) {
  let cursor = input;
  for (const key of path.split('.')) {
    if (cursor == null || (typeof cursor !== 'object' && !Array.isArray(cursor))) return null;
    cursor = cursor[key];
  }
  return asNumber(cursor);
}

function readAnyNumber(input, paths) {
  for (const path of paths) {
    const value = readNumberAtPath(input, path);
    if (value !== null) return value;
  }
  return null;
}

function pickFromWindow(window) {
  if (!window || typeof window !== 'object') return null;

  const direct = readAnyNumber(window, [
    'usedPercent',
    'percentUsed',
    'usagePercent',
    'percent',
    'used_percent',
  ]);
  if (direct !== null) return direct;

  const remaining = readAnyNumber(window, ['remainingPercent', 'remaining_percent', 'remaining']);
  if (remaining !== null) return 100 - remaining;

  const usedTokens = readAnyNumber(window, [
    'usedTokens',
    'used_tokens',
    'tokensUsed',
    'currentTokens',
    'windowTokens',
    'tokenCount',
  ]);
  const limitTokens = readAnyNumber(window, [
    'maxTokens',
    'tokenLimit',
    'capacity',
    'totalTokens',
    'windowSize',
    'limit',
    'max',
  ]);
  if (usedTokens !== null && limitTokens !== null && limitTokens > 0) {
    return (usedTokens / limitTokens) * 100;
  }

  return null;
}

function sumTokens(promptTokens, completionTokens) {
  if (promptTokens === null && completionTokens === null) return null;
  return (promptTokens ?? 0) + (completionTokens ?? 0);
}

function extractLastTurnTokens(tokenUsage) {
  const direct = readAnyNumber(tokenUsage, [
    'lastTurnTokens',
    'last_turn_tokens',
    'turnTokens',
    'turn_tokens',
    'lastTurn.totalTokens',
    'lastTurn.total',
    'currentTurn.totalTokens',
    'currentTurn.total',
  ]);
  if (direct !== null) return direct;

  const prompt = readAnyNumber(tokenUsage, [
    'lastTurn.promptTokens',
    'lastTurn.prompt_tokens',
    'turn.promptTokens',
    'turn.prompt_tokens',
    'usage.promptTokens',
    'usage.prompt_tokens',
  ]);
  const completion = readAnyNumber(tokenUsage, [
    'lastTurn.completionTokens',
    'lastTurn.completion_tokens',
    'turn.completionTokens',
    'turn.completion_tokens',
    'usage.completionTokens',
    'usage.completion_tokens',
  ]);
  const sum = sumTokens(prompt, completion);
  if (sum !== null) return sum;

  return null;
}

function extractContextPercent(tokenUsage, fallbackPercent) {
  const direct = readAnyNumber(tokenUsage, [
    'contextWindowUsedPercent',
    'contextPercent',
    'context_usage_percent',
    'usedPercent',
    'usagePercent',
    'contextUsedPercent',
  ]);
  if (direct !== null) return direct;

  const windowPercent = readAnyNumber(tokenUsage, [
    'window.usedPercent',
    'window.usagePercent',
    'window.percentUsed',
    'windowContext.usedPercent',
    'windowContext.percentUsed',
    'contextWindow.usedPercent',
    'contextWindow.percentUsed',
  ]);
  if (windowPercent !== null) return windowPercent;

  const fromWindow = pickFromWindow(tokenUsage?.window)
    || pickFromWindow(tokenUsage?.windowUsage)
    || pickFromWindow(tokenUsage?.contextWindow)
    || pickFromWindow(tokenUsage?.contextWindowUsage)
    || pickFromWindow(tokenUsage?.usage?.window)
    || pickFromWindow(tokenUsage?.usage?.contextWindow)
    || pickFromWindow(tokenUsage?.token?.window);
  if (fromWindow !== null) return fromWindow;

  return fallbackPercent !== undefined ? fallbackPercent : null;
}

function parseTodayFromBuckets(accountUsage) {
  const buckets = Array.isArray(accountUsage?.dailyUsageBuckets) ? accountUsage.dailyUsageBuckets : [];
  let selected = null;
  let selectedDate = '';
  for (const bucket of buckets) {
    const date = String(bucket?.startDate || '');
    const value = asNumber(bucket?.tokens);
    if (date && value !== null) {
      if (date >= selectedDate) {
        selectedDate = date;
        selected = value;
      }
    }
  }
  return selected ?? null;
}

function formatTokenValue(value) {
  if (value === null || value === undefined) return '--';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n <= 0) return '0';
  return formatCompactNumber(n);
}

function formatPercentValue(value) {
  if (!Number.isFinite(Number(value))) return '--';
  return `${Math.round(Math.max(0, Math.min(100, Number(value))))}%`;
}

function extractTotalTokens(tokenUsage, accountUsage) {
  const normalizedAccountUsage = accountUsage && (accountUsage.result || accountUsage.data || accountUsage);
  const direct = readAnyNumber(tokenUsage, [
    'totalTokens',
    'total_tokens',
    'tokensTotal',
    'tokens.total',
    'usage.totalTokens',
    'usage.total',
    'usage.total_tokens',
    'total.tokenCount',
  ]);
  if (direct !== null) return direct;

  const fromWindow = readAnyNumber(tokenUsage, [
    'window.totalTokens',
    'usage.totalTokens',
    'currentWindow.totalTokens',
    'usage.total',
    'contextWindow.totalTokens',
  ]);
  if (fromWindow !== null) return fromWindow;

  const account = readAnyNumber(normalizedAccountUsage || {}, [
    'totalTokens',
    'total_tokens',
    'tokensTotal',
    'usage.totalTokens',
    'usage.total',
    'usage.total_tokens',
    'stats.totalTokens',
    'totals.totalTokens',
    'summary.lifetimeTokens',
    'summary.totalTokens',
    'usageSummary.totalTokens',
    'summary.totalTokens',
  ]);
  if (account !== null) return account;
  return parseTodayFromBuckets(normalizedAccountUsage || {});
}

function extractTodayTokens(accountUsage, tokenUsage) {
  const normalizedAccountUsage = accountUsage && (accountUsage.result || accountUsage.data || accountUsage);
  const fromBuckets = parseTodayFromBuckets(normalizedAccountUsage || {});
  const direct = readAnyNumber(normalizedAccountUsage || {}, [
    'todayTokens',
    'today_tokens',
    'usage.todayTokens',
    'usage.today',
    'todayUsage',
    'usageSummary.todayTokens',
    'stats.todayTokens',
    'summary.todayTokens',
    'summary.peakDailyTokens',
  ]);
  if (direct !== null) return direct;
  if (fromBuckets !== null) return fromBuckets;

  return readAnyNumber(tokenUsage, [
    'todayTokens',
    'today_tokens',
    'usage.today',
    'usage.todayTokens',
  ]) || 0;
}

function normalizeStatusType(status = {}) {
  return String(status?.type || status?.state || '').toLowerCase();
}

function isActiveStatus(status = {}) {
  const type = normalizeStatusType(status);
  return type === 'active' || type === 'running' || type === 'working' || type === 'busy';
}

function summarizeThreadStatus(statuses = []) {
  const activeStatuses = statuses.filter((status) => isActiveStatus(status));
  if (activeStatuses.length > 0) {
    const waitingOnApproval = activeStatuses.filter((status) => {
      const flags = new Set(status?.activeFlags || []);
      return flags.has('waitingOnApproval');
    });
    const waitingOnUserInput = activeStatuses.filter((status) => {
      const flags = new Set(status?.activeFlags || []);
      return flags.has('waitingOnUserInput');
    });

    if (waitingOnApproval.length > 0) {
      return { state: 'waiting', label: '需要确认', count: waitingOnApproval.length };
    }
    if (waitingOnUserInput.length > 0) {
      return { state: 'waiting', label: '等待输入', count: waitingOnUserInput.length };
    }
    return { state: 'working', label: '工作中', count: activeStatuses.length };
  }
  if (statuses.some((status) => status?.type === 'systemError')) {
    return {
      state: 'error',
      label: '异常',
      count: statuses.filter((status) => status?.type === 'systemError').length,
    };
  }
  return { state: 'idle', label: '空闲', count: 0 };
}

function normalizePlanStatus(status) {
  const text = String(status || '').toLowerCase();
  if (['completed', 'complete', 'done', 'success', 'finished'].includes(text)) return 'completed';
  if (['in_progress', 'in-progress', 'running', 'active', 'working', 'current'].includes(text)) return 'in_progress';
  return 'pending';
}

function normalizePlanItems(plan = {}) {
  const rawItems = Array.isArray(plan)
    ? plan
    : (Array.isArray(plan?.items) ? plan.items : (Array.isArray(plan?.steps) ? plan.steps : []));

  return rawItems.map((item, index) => ({
    text: boundedText(item?.step || item?.title || item?.text || item?.name || `步骤 ${index + 1}`, `步骤 ${index + 1}`, 22),
    status: normalizePlanStatus(item?.status || item?.state),
  }));
}

function summarizePlan(plan = {}) {
  const normalizedItems = normalizePlanItems(plan);
  const total = normalizedItems.length;
  const completed = normalizedItems.filter((item) => item.status === 'completed').length;
  const currentIndex = normalizedItems.findIndex((item) => item.status === 'in_progress');
  const firstPendingIndex = normalizedItems.findIndex((item) => item.status === 'pending');
  const current = total === 0 ? 0 : ((currentIndex >= 0 ? currentIndex : (firstPendingIndex >= 0 ? firstPendingIndex : total - 1)) + 1);
  const currentText = current > 0 ? normalizedItems[current - 1]?.text || '' : '';
  const pendingSeen = { pending: 0, completed: 0 };

  const items = normalizedItems.slice(0, 5).map((item, index) => {
    if (item.status === 'completed') {
      pendingSeen.completed += 1;
      return { state: 'done', label: `完成 ${pendingSeen.completed}`, title: item.text, meta: `${index + 1}/${total}` };
    }
    if (item.status === 'in_progress') {
      return { state: 'work', label: '进行中', title: item.text, meta: `${index + 1}/${total}` };
    }
    pendingSeen.pending += 1;
    return { state: 'idle', label: `待办 ${pendingSeen.pending}`, title: item.text, meta: `${index + 1}/${total}` };
  });

  return {
    current,
    total,
    completed,
    currentText,
    summary: total > 0 ? `步骤 ${current}/${total} 完成 ${completed}` : '暂无计划',
    home: total > 0 ? `步骤 ${current}/${total} · ${currentText}` : '',
    items,
  };
}

function summarizeActivity(activity = {}) {
  const kind = String(activity.kind || activity.type || '').toLowerCase();
  const status = String(activity.status || activity.state || '').toLowerCase();
  const command = boundedText(activity.command || activity.cmd || '', '', 32);
  const file = boundedText(activity.file || activity.path || '', '', 28);
  const message = boundedText(activity.message || activity.summary || activity.title || '', '', 28);
  const exitCode = Number(activity.exitCode ?? activity.code);
  const failed = status === 'error' || status === 'failed' || (Number.isFinite(exitCode) && exitCode !== 0);
  const done = status === 'completed' || status === 'done' || status === 'success' || (Number.isFinite(exitCode) && exitCode === 0);
  const state = failed ? 'error' : (done ? 'done' : 'work');

  let title = message || '等待事件';
  let label = '事件';
  let prefix = done ? '已完成' : (failed ? '失败' : '正在处理');
  if (kind.includes('command') || command) {
    title = command || message || '命令';
    label = '命令';
    prefix = failed ? '命令失败' : (done ? '命令完成' : '正在执行');
  } else if (kind.includes('file') || file) {
    title = file || message || '文件';
    label = '文件';
    prefix = failed ? '改动失败' : (done ? '改动完成' : '正在改');
  }

  const summary = title === '等待事件' ? '等待事件' : `${prefix} ${title}`;
  return {
    state,
    summary,
    items: [{ state, label, title, meta: failed ? '失败' : (done ? '完成' : '运行中') }],
    home: summary,
  };
}

function summarizeTokenUsage(tokenUsage = {}, accountUsage = {}, options = {}) {
  const normalizedOptions = options || {};
  const contextPercent = clampPercent(extractContextPercent(
    tokenUsage,
    normalizedOptions.contextPercentFallback,
  ));
  const extractedLastTurn = extractLastTurnTokens(tokenUsage);
  const extractedTotalTokens = extractTotalTokens(tokenUsage, accountUsage);
  const previousTotalTokens = Number(normalizedOptions.previousTotalTokens);

  let lastTurnTokens = extractedLastTurn;
  if (lastTurnTokens === null && Number.isFinite(previousTotalTokens) && Number.isFinite(extractedTotalTokens)) {
    const delta = Number(extractedTotalTokens) - previousTotalTokens;
    if (delta >= 0) lastTurnTokens = delta;
  }

  let totalTokens = extractedTotalTokens;
  if (totalTokens === null && Number.isFinite(previousTotalTokens)) totalTokens = previousTotalTokens;

  const todayTokens = Number(extractTodayTokens(accountUsage, tokenUsage) || 0);
  const contextLabel = formatPercentValue(contextPercent);
  const lastTurnLabel = formatTokenValue(lastTurnTokens);
  const totalLabel = formatTokenValue(totalTokens);

  const items = [
    {
      state: contextPercent !== null && contextPercent >= 80 ? 'check' : 'idle',
      label: '上下文',
      title: contextLabel,
      meta: '窗口占比',
    },
    { state: 'idle', label: '本轮', title: lastTurnLabel, meta: 'tokens' },
    {
      state: 'idle',
      label: '累计',
      title: totalLabel,
      meta: todayTokens > 0 ? `今日 ${formatCompactNumber(todayTokens)}` : (Number.isFinite(extractedTotalTokens) ? 'tokens' : '未返回'),
    },
  ];

  return {
    contextPercent,
    lastTurnTokens: Number.isFinite(lastTurnTokens) ? lastTurnTokens : null,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
    todayTokens,
    summary: `上下文 ${contextLabel} 本轮 ${lastTurnLabel}`,
    items,
  };
}

function summarizeHealth({ account, appServer, transport, warning, error } = {}) {
  const accountKnown = Boolean(account && typeof account === 'object' && Object.keys(account).length > 0);
  const loggedIn = Boolean(account?.email || account?.user?.email || account?.id || account?.accountId);
  const appConnected = (appServer?.state || 'connected') === 'connected';
  const transportConnected = transport?.state === 'connected';
  const state = error ? 'error' : ((!appConnected || !transportConnected || warning || !loggedIn) ? 'check' : 'done');
  const loginText = loggedIn ? '已登录' : (accountKnown ? '未登录' : '账号未知');
  const serviceText = appConnected && transportConnected ? '服务正常' : '链路异常';
  const transportText = `${transport?.mode === 'ble' ? '蓝牙' : '串口'}${transportConnected ? '已连接' : '异常'}`;
  return {
    state,
    summary: `${loginText} · ${serviceText}`,
    items: [
      { state: loggedIn ? 'done' : 'check', label: '账号', title: loginText, meta: boundedText(account?.email || account?.user?.email || '', accountKnown ? '未登录' : '接口未返回', 18) },
      { state: appConnected ? 'done' : 'error', label: '服务', title: appConnected ? 'app-server 正常' : '服务离线', meta: boundedText(error || warning || '', '', 18) },
      { state: transportConnected ? 'done' : 'error', label: '通信', title: transportText, meta: boundedText(transport?.detail || transport?.target || '', '', 18) },
    ],
  };
}

function summarizeGoal(goal = {}) {
  const text = boundedText(goal.objective || goal.goal || goal.title || goal.text || '', '未设置目标', 28);
  const status = String(goal.status || goal.state || '').toLowerCase();
  const state = status === 'complete' || status === 'completed' ? 'done' : (text === '未设置目标' ? 'idle' : 'work');
  return {
    state,
    summary: text,
    items: [{ state, label: '目标', title: text, meta: status || '当前线程' }],
  };
}

function summarizeAccount({ account, models, rateLimits } = {}) {
  const accountKnown = Boolean(account && typeof account === 'object' && Object.keys(account).length > 0);
  const email = boundedText(account?.email || account?.user?.email || account?.account?.email || '', accountKnown ? '账号未登录' : '账号未知', 24);
  const plan = boundedText(account?.plan || account?.account?.plan || account?.subscription?.plan || 'Plan 未返回', 'Plan 未返回', 16);
  const modelList = Array.isArray(models?.data) ? models.data : (Array.isArray(models?.models) ? models.models : []);
  const firstModel = boundedText(modelList[0]?.id || modelList[0]?.slug || modelList[0]?.name || '', '模型未返回', 18);
  const limited = Boolean(rateLimits?.rateLimitReachedType);
  return {
    state: limited ? 'check' : 'idle',
    summary: `${plan} · ${email}`,
    items: [
      { state: limited ? 'check' : 'idle', label: '套餐', title: plan, meta: limited ? '已触发限额' : '限额正常' },
      { state: 'idle', label: '账号', title: email, meta: '' },
      { state: 'idle', label: '模型', title: firstModel, meta: modelList.length > 0 ? `${modelList.length} 个可用` : '' },
    ],
  };
}

function normalizeScheduleEvent(event, index) {
  const startMs = parseTimeLike(
    event?.start_time
    ?? event?.startTime
    ?? event?.start
    ?? event?.startsAt
    ?? event?.begin,
  );
  if (!Number.isFinite(startMs)) return null;

  const parsedEndMs = parseTimeLike(
    event?.end_time
    ?? event?.endTime
    ?? event?.end
    ?? event?.endsAt
    ?? event?.finish,
  );
  const endMs = Number.isFinite(parsedEndMs) && parsedEndMs > startMs
    ? parsedEndMs
    : startMs + 30 * 60 * 1000;
  const title = boundedText(
    event?.summary || event?.title || event?.subject || event?.name || event?.description,
    `日程 ${index + 1}`,
    24,
  );

  return {
    title,
    startMs,
    endMs,
    dateKey: shanghaiDateKey(startMs),
    time: `${formatEventTime(startMs)}-${formatEventTime(endMs)}`,
  };
}

function scheduleItem(state, label, event, metaPrefix = '') {
  const meta = metaPrefix ? `${metaPrefix} ${event.time}` : event.time;
  return {
    state,
    label,
    title: event.title,
    meta: boundedText(meta, '--', 16),
  };
}

function tomorrowCountItem(count) {
  return {
    state: 'idle',
    label: '明日',
    title: `明日 ${Math.max(0, Number(count) || 0)} 条`,
    meta: '次日日程',
  };
}

function isFeaturedScheduleItem(item) {
  return item?.label === '当前' || item?.label === '即将';
}

function shouldAppendTomorrowCount(items, tomorrowCount) {
  if (!tomorrowCount) return false;
  const hasFeatured = isFeaturedScheduleItem(items[0]);
  const listStart = hasFeatured ? 1 : 0;
  const visibleRows = hasFeatured ? SCHEDULE_VISIBLE_ROWS_WITH_FEATURE : SCHEDULE_VISIBLE_ROWS_WITHOUT_FEATURE;
  return Math.max(0, items.length - listStart) >= visibleRows;
}

function summarizeSchedule(events = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const normalized = (Array.isArray(events) ? events : [])
    .map(normalizeScheduleEvent)
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);
  const todayKey = shanghaiDateKey(nowMs);
  const tomorrowKey = addDaysDateKey(nowMs, 1);
  const current = normalized.find((event) => event.startMs <= nowMs && event.endMs > nowMs) || null;
  const next = normalized.find((event) => event.startMs > nowMs) || null;
  const todayAllEvents = normalized.filter((event) => event.dateKey === todayKey);
  const todayEvents = todayAllEvents.filter((event) => event.endMs > nowMs);
  const todayNext = todayEvents.find((event) => event.startMs > nowMs) || null;
  const tomorrowEvents = normalized.filter((event) => event.dateKey === tomorrowKey);
  const todayTotalCount = todayAllEvents.length;
  const todayStartedCount = todayAllEvents.filter((event) => event.startMs <= nowMs).length;
  const todayRemainingCount = todayEvents.length;
  const upcoming = !current
    && todayNext
    && todayNext.startMs - nowMs <= UPCOMING_SCHEDULE_HIGHLIGHT_MS
    ? todayNext
    : null;
  const items = [];

  if (current) {
    items.push(scheduleItem('work', '当前', current));
  }
  if (upcoming) {
    items.push(scheduleItem('check', '即将', upcoming));
  } else if (todayNext && todayRemainingCount > 0 && (!current || todayNext.startMs !== current.startMs)) {
    items.push(scheduleItem('check', '下一个', todayNext));
  }

  if (todayRemainingCount > 0) {
    const todayItemLimit = tomorrowEvents.length > 0 ? MAX_SCHEDULE_ITEMS - 1 : MAX_SCHEDULE_ITEMS;
    for (const event of todayEvents) {
      if (items.some((item) => item.title === event.title && item.meta === event.time)) continue;
      if (items.length >= todayItemLimit) break;
      items.push(scheduleItem('idle', `待办 ${items.length + 1}`, event));
    }
    if (shouldAppendTomorrowCount(items, tomorrowEvents.length)) {
      items.push(tomorrowCountItem(tomorrowEvents.length));
    }
  } else {
    let tomorrowIndex = 1;
    for (const event of tomorrowEvents) {
      items.push(scheduleItem('idle', `明日 ${tomorrowIndex}`, event, '明天'));
      tomorrowIndex += 1;
      if (items.length >= MAX_SCHEDULE_ITEMS) break;
    }
  }

  let summary = '今日无日程 · 明日无日程';
  if (current) {
    summary = `当前 ${current.title} · 今日剩余 ${todayRemainingCount} 条`;
  } else if (upcoming) {
    summary = `即将 ${upcoming.title} · 今日剩余 ${todayRemainingCount} 条`;
  } else if (todayRemainingCount > 0 && todayNext) {
    summary = `下一个 ${todayNext.title} · 今日剩余 ${todayRemainingCount} 条`;
  } else if (tomorrowEvents.length > 0) {
    summary = `今日无日程 · 明日 ${tomorrowEvents.length} 条`;
  } else if (normalized.length > 0) {
    summary = '今日无剩余日程';
  }

  const progressText = todayTotalCount > 0 && !current && todayRemainingCount === 0
    ? '恭喜！日程全部完成！'
    : `日程进度：${todayStartedCount}/${todayTotalCount}`;

  return {
    current,
    next,
    upcoming,
    todayTotalCount,
    todayStartedCount,
    todayRemainingCount,
    todayEvents,
    tomorrowEvents,
    progressText,
    summary: boundedText(summary, '今日无日程', 40),
    items: items.slice(0, MAX_SCHEDULE_ITEMS),
  };
}

function buildScheduleLine(schedule) {
  return buildPageLine({
    key: 'schedule',
    title: '飞书日程',
    summary: schedule?.progressText || schedule?.summary || '今日无日程 · 明日无日程',
    items: schedule?.items || [],
  });
}

function buildHomeHint({ status, plan, activity } = {}) {
  if (status?.state === 'waiting') return status.label || '需要处理';
  if (plan?.home) return plan.home;
  if (activity?.home && activity.home !== '等待事件') return activity.home;
  return '点按查看详情';
}

function buildPageLine({ key, title, summary, items = [] }) {
  const parts = ['PAGE', key, boundedText(title, key, 10), boundedText(summary, '--', 40)];
  for (const item of items.slice(0, MAX_PAGE_ITEMS)) {
    parts.push([
      boundedText(item.state || 'idle', 'idle', 8),
      boundedText(item.label || '--', '--', 8),
      boundedText(item.title || '--', '--', 24),
      boundedText(item.meta || '', '', 16),
    ].join(','));
  }
  return parts.join('|');
}

function buildHealthPage(health, account) {
  const healthItems = Array.isArray(health?.items) ? health.items : [];
  const accountItems = Array.isArray(account?.items)
    ? account.items.filter((item) => item.label !== '账号')
    : [];
  return {
    key: 'health',
    title: '健康',
    summary: health?.summary || account?.summary || '等待桥接状态',
    items: [...healthItems, ...accountItems],
  };
}

function buildDetailPageLines({ plan, activity, token, health, goal, account, schedule } = {}) {
  const pages = [
    token && { key: 'token', title: 'Token', summary: token.summary, items: token.items },
    (health || account) && buildHealthPage(health, account),
    schedule && {
      key: 'schedule',
      title: '飞书日程',
      summary: schedule.progressText || schedule.summary,
      items: schedule.items,
    },
  ].filter(Boolean);
  return pages.map(buildPageLine);
}

function normalizeUpdatedAtMs(value) {
  const updatedAt = Number(value || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 0;
  return updatedAt < 10_000_000_000 ? updatedAt * 1000 : updatedAt;
}

function isSystemErrorStatus(status = {}) {
  return status?.type === 'systemError';
}

function isRecentlyActiveThread(thread, nowMs, recentActivityMs) {
  const windowMs = Number(recentActivityMs || 0);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
  if (isActiveStatus(thread?.status) || isSystemErrorStatus(thread?.status)) return false;
  const updatedAt = normalizeUpdatedAtMs(thread?.updatedAt);
  if (updatedAt <= 0) return false;
  const ageMs = nowMs - updatedAt;
  return ageMs >= 0 && ageMs <= windowMs;
}

function sessionState(status = {}) {
  if (isActiveStatus(status)) {
    const flags = new Set(status.activeFlags || []);
    if (flags.has('waitingOnApproval') || flags.has('waitingOnUserInput')) return 'check';
    return 'work';
  }
  if (status.type === 'systemError') return 'error';
  return 'idle';
}

function stateLabel(state) {
  if (state === 'work') return '运行';
  if (state === 'check') return '待检';
  if (state === 'error') return '异常';
  return '空闲';
}

function threadSuffix(thread) {
  return String(thread?.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-2) || '--';
}

function normalizeWireText(value) {
  return String(value || '')
    .replace(/[,|]/g, ' ')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedText(value, fallback, maxLength) {
  const text = normalizeWireText(value) || fallback;
  return Array.from(text).slice(0, maxLength).join('').trim() || fallback;
}

function compactTitle(value) {
  let text = normalizeWireText(value).replace(/https?:\/\/\S+/g, '').trim();
  if (!text) return '';

  if (text.includes('资料')) {
    const firstClause = text.split(/[，,。.!？?]/).map((part) => part.trim()).find(Boolean) || '';
    let subject = firstClause
      .replace(/^我有[个一]?/, '')
      .replace(/^帮我/, '')
      .replace(/^请/, '')
      .replace(/^看下/, '')
      .trim();
    subject = subject.replace(/开发版/g, '开发板');
    if (subject && Array.from(subject).length <= 12) {
      return `查阅${subject}资料`;
    }
  }

  return text;
}

function sessionTitle(thread) {
  const fallback = `Thread ${threadSuffix(thread)}`;
  return boundedText(compactTitle(thread?.title || thread?.preview), fallback, 24);
}

function sessionProject(thread) {
  const cwd = normalizeWireText(thread?.cwd);
  if (cwd) {
    const project = path.basename(cwd);
    return boundedText(project, '项目', 16);
  }
  return '项目';
}

function sessionAge(thread, nowMs) {
  const updatedAt = normalizeUpdatedAtMs(thread?.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const diffMs = Math.max(0, nowMs - updatedAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diffMs < minuteMs) return '刚刚';
  if (diffMs < hourMs) return `${Math.max(1, Math.floor(diffMs / minuteMs))}分`;
  if (diffMs < dayMs) return `${Math.max(1, Math.floor(diffMs / hourMs))}时`;
  if (diffMs < 7 * dayMs) return `${Math.max(1, Math.floor(diffMs / dayMs))}天`;
  const parts = shanghaiParts(updatedAt);
  return `${Number(parts.month)}/${Number(parts.day)}`;
}

function summarizeThreadSessions(threads = [], maxItems = 5, nowMs = Date.now(), options = {}) {
  const counts = { work: 0, check: 0, idle: 0, error: 0 };
  const order = { work: 0, check: 1, error: 2, idle: 3 };
  const numbered = { work: 0, check: 0, idle: 0, error: 0 };
  const recentActivityMs = Number(options.recentActivityMs || 0);
  const stateForThread = (thread) => (
    isRecentlyActiveThread(thread, nowMs, recentActivityMs) ? 'work' : sessionState(thread.status)
  );
  const sorted = [...threads].sort((a, b) => {
    const stateDiff = order[stateForThread(a)] - order[stateForThread(b)];
    if (stateDiff !== 0) return stateDiff;
    return normalizeUpdatedAtMs(b.updatedAt) - normalizeUpdatedAtMs(a.updatedAt);
  });

  for (const thread of sorted) {
    counts[stateForThread(thread)] += 1;
  }

  const items = sorted.slice(0, maxItems).map((thread) => {
    const state = stateForThread(thread);
    numbered[state] += 1;
    const title = sessionTitle(thread);
    const threadId = String(thread?.id || '').trim();
    return {
      state,
      label: `${stateLabel(state)} ${numbered[state]}`,
      detail: title,
      project: sessionProject(thread),
      title,
      age: sessionAge(thread, nowMs),
      id: threadId,
    };
  });

  return { counts, items };
}

function normalizeFallbackRunningState({
  statusSummary,
  sessionsPayload,
}) {
  if (
    statusSummary.state !== 'working'
    || (statusSummary.label !== '最近活动' && statusSummary.label !== '工作中')
    ) {
    return { sessions: sessionsPayload, status: statusSummary };
  }

  const counts = sessionsPayload?.counts || { work: 0, check: 0, idle: 0, error: 0 };
  const targetRunning = Number.isFinite(statusSummary.count) ? statusSummary.count : ((counts.work || 0) > 0 ? counts.work : 1);
  if ((counts.work || 0) >= targetRunning) {
    return {
      sessions: {
        ...sessionsPayload,
        counts: {
          ...counts,
          work: targetRunning,
        },
      },
      status: {
        ...statusSummary,
        count: targetRunning,
      },
    };
  }

  const items = Array.isArray(sessionsPayload?.items) ? [...sessionsPayload.items] : [];
  if (items.length === 0) {
    const fallback = [
      {
        state: 'work',
        label: '运行 1',
        detail: '最近活动会话',
        title: '最近活动会话',
        project: '项目',
        age: '',
        id: '',
      },
    ];
    const extra = Array.from({ length: Math.max(0, targetRunning - 1) }).map((_, index) => ({
      state: 'work',
      label: `运行 ${index + 2}`,
      detail: '最近活动会话',
      title: '最近活动会话',
      project: '项目',
      age: '',
      id: '',
    }));
    return {
      status: { ...statusSummary, count: targetRunning },
      sessions: {
        counts: { ...counts, work: targetRunning },
        items: [...fallback, ...extra],
      },
    };
  }

  const needed = targetRunning - (counts.work || 0);
  let converted = 0;
  for (let index = 0; index < items.length && converted < needed; index += 1) {
    if (items[index].state === 'work') continue;
    items[index] = { ...items[index], state: 'work' };
    converted += 1;
  }
  const currentWork = (counts.work || 0) + converted;
  const missing = Math.max(0, targetRunning - currentWork);
  if (missing > 0) {
    const baseWork = items.reduce((total, item) => total + (item.state === 'work' ? 1 : 0), 0);
    const fallbackItems = Array.from({ length: missing }).map((_, index) => ({
      state: 'work',
      label: '',
      detail: '最近活动会话',
      title: '最近活动会话',
      project: '项目',
      age: '',
      id: '',
    }));
    for (let index = 0; index < fallbackItems.length; index += 1) {
      fallbackItems[index].label = `运行 ${baseWork + index + 1}`;
    }
    items.push(...fallbackItems);
  }

  const labels = { work: 0, check: 0, idle: 0, error: 0 };
  const adjustedCounts = { work: 0, check: 0, idle: 0, error: 0 };
  const adjustedItems = items.map((item) => {
    const state = item.state || 'idle';
    labels[state] += 1;
    adjustedCounts[state] += 1;
    return {
      ...item,
      state,
      label: `${stateLabel(state)} ${labels[state]}`,
    };
  });

  return {
    status: { ...statusSummary, count: targetRunning },
    sessions: {
      counts: {
        ...adjustedCounts,
        work: targetRunning,
      },
      items: adjustedItems,
    },
  };
}

function buildWindowPayload(window, nowMs) {
  return {
    label: formatWindowLabel(window?.windowDurationMins),
    remainingPercent: remainingPercent(window),
    usedPercent: clampPercent(Number(window?.usedPercent ?? 0)),
    reset: formatResetLabel(window?.resetsAt, nowMs),
    resetAscii: formatResetAscii(window?.resetsAt, nowMs),
    resetRemaining: formatResetRemaining(window?.resetsAt, nowMs),
    timeRemainingPercent: timeRemainingPercent(window, nowMs),
  };
}

function buildDisplayPayload({ rateLimits, status, statuses, sessions, enhancements, nowMs = Date.now() }) {
  const statusSummary = status || summarizeThreadStatus(statuses);
  const sessionPayload = sessions || summarizeThreadSessions([], 5, nowMs);
  const normalized = normalizeFallbackRunningState({
    statusSummary,
    sessionsPayload: sessionPayload,
  });
  const normalizedSessionPayload = normalized.sessions;
  const normalizedStatusSummary = normalized.status;

  return {
    v: 1,
    ts: Math.floor(nowMs / 1000),
    short: buildWindowPayload(rateLimits?.primary, nowMs),
    long: buildWindowPayload(rateLimits?.secondary, nowMs),
    status: normalizedStatusSummary,
    sessions: normalizedSessionPayload,
    homeHint: buildHomeHint({
      status: normalizedStatusSummary,
      plan: enhancements?.plan,
      activity: enhancements?.activity,
    }),
    enhancements,
    limited: Boolean(rateLimits?.rateLimitReachedType),
  };
}

function buildWirePayload(displayPayload) {
  const state = displayPayload.status?.state || 'idle';
  const counts = displayPayload.sessions?.counts || {};
  const statusLabel = displayPayload.status?.label || '';
  let statusCount = counts.idle || 0;
  if (state === 'working') {
    const statusFromState = Number.isFinite(displayPayload.status?.count)
      ? displayPayload.status.count
      : 0;
    statusCount = Math.max(counts.work || 0, statusFromState);
  }
  else if (state === 'waiting') statusCount = counts.check || 0;
  else if (state === 'error') statusCount = counts.error || 0;

  if (
    state === 'working'
    && statusCount === 0
    && (statusLabel === '最近活动' || statusLabel === '工作中')
    && (counts.work || counts.check || counts.idle || counts.error)
  ) {
    statusCount = 1;
  }

  return {
    v: displayPayload.v,
    ts: displayPayload.ts,
    s: {
      r: displayPayload.short?.remainingPercent ?? 0,
      u: displayPayload.short?.usedPercent ?? 0,
      t: displayPayload.short?.timeRemainingPercent ?? 0,
      x: displayPayload.short?.reset || displayPayload.short?.resetAscii || '--',
      d: displayPayload.short?.resetRemaining || '--',
    },
    l: {
      r: displayPayload.long?.remainingPercent ?? 0,
      x: displayPayload.long?.reset || displayPayload.long?.resetAscii || '--',
      d: displayPayload.long?.resetRemaining || '--',
    },
    st: {
      s: state,
      c: statusCount,
      ...(state === 'waiting' && statusLabel ? { l: statusLabel } : {}),
    },
    h: displayPayload.homeHint || '点按查看详情',
    m: Boolean(displayPayload.limited),
  };
}

function buildSessionLine(sessions = summarizeThreadSessions([])) {
  const counts = sessions.counts || { work: 0, check: 0, idle: 0, error: 0 };
  const parts = [
    'SESS',
    `${counts.work || 0},${counts.check || 0},${counts.idle || 0},${counts.error || 0}`,
  ];
  for (const item of (sessions.items || []).slice(0, 5)) {
    const state = String(item.state || 'idle').replace(/[,|]/g, '');
    const label = String(item.label || '空闲').replace(/[,|]/g, ' ').slice(0, 10).trim();
    const title = boundedText(item.title || item.detail, '--', 24);
    const project = boundedText(item.project, '项目', 16);
    const idSuffix = boundedText(item.id, '', 5);
    const meta = idSuffix && idSuffix !== '--' ? `${project} (${idSuffix})` : project;
    const age = boundedText(item.age, '', 8);
    parts.push(`${state},${label},${title},${meta},${age}`);
  }
  return parts.join('|');
}

module.exports = {
  buildDisplayPayload,
  buildDetailPageLines,
  buildSessionLine,
  buildWirePayload,
  formatResetRemaining,
  formatResetLabel,
  summarizeActivity,
  summarizeAccount,
  summarizeGoal,
  summarizeHealth,
  summarizePlan,
  summarizeSchedule,
  summarizeTokenUsage,
  buildScheduleLine,
  timeRemainingPercent,
  summarizeThreadSessions,
  summarizeThreadStatus,
};
