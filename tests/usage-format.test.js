const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
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
  timeRemainingPercent,
  summarizeThreadSessions,
  summarizeThreadStatus,
} = require('../src/usage-format');

test('converts Codex used percent into remaining percent for display', () => {
  const payload = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1781144543 },
      rateLimitReachedType: null,
    },
    status: { type: 'idle' },
  });

  assert.equal(payload.short.label, '5 小时');
  assert.equal(payload.short.remainingPercent, 96);
  assert.equal(payload.long.label, '1 周');
  assert.equal(payload.long.remainingPercent, 19);
});

test('formats same-day and later reset labels like the Codex usage popover', () => {
  const nowMs = Date.parse('2026-06-10T12:00:00+08:00');

  assert.equal(formatResetLabel(1781074024, nowMs), '14:47');
  assert.equal(formatResetLabel(1781144543, nowMs), '6月11日');
});

test('formats reset remaining time for firmware display', () => {
  const nowMs = Date.parse('2026-06-10T12:00:00+08:00');

  assert.equal(formatResetRemaining(1781074024, nowMs), '2时47分');
  assert.equal(formatResetRemaining(1781144543, nowMs), '22时22分');
  assert.equal(formatResetRemaining((nowMs / 1000) + 60 * 60 * 26, nowMs), '1天2时');
  assert.equal(formatResetRemaining((nowMs / 1000) - 1, nowMs), '0分');
});

test('calculates reset time remaining percent for the five hour marker', () => {
  const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
  const nowSeconds = Math.floor(nowMs / 1000);

  assert.equal(timeRemainingPercent({ resetsAt: nowSeconds + 4 * 60 * 60, windowDurationMins: 300 }, nowMs), 80);
  assert.equal(timeRemainingPercent({ resetsAt: nowSeconds, windowDurationMins: 300 }, nowMs), 0);
  assert.equal(timeRemainingPercent({ resetsAt: nowSeconds + 6 * 60 * 60, windowDurationMins: 300 }, nowMs), 100);
  assert.equal(timeRemainingPercent({ resetsAt: null, windowDurationMins: 300 }, nowMs), 0);
});

test('adds ascii reset labels for firmware fonts', () => {
  const payload = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { type: 'idle' },
  });

  assert.equal(payload.short.resetAscii, '14:47');
  assert.equal(payload.long.resetAscii, '6/11');
});

test('font generator keeps local live state behind explicit opt-in', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/generate-codex-cjk-font.js'), 'utf8');

  assert.match(script, /CODEX_FONT_INCLUDE_LOCAL_STATE/);
  assert.match(script, /if \(includeLocalState\) \{/);
  assert.match(script, /weixue-codex-bridge/);
  assert.match(script, /codex-status-menu-state\.json/);
  assert.match(script, /0x00b7|0xb7/);
});

test('summarizes thread statuses into compact display states', () => {
  assert.deepEqual(summarizeThreadStatus([{ type: 'idle' }]), {
    state: 'idle',
    label: '空闲',
    count: 0,
  });

  assert.deepEqual(
    summarizeThreadStatus([{ type: 'active', activeFlags: ['waitingOnApproval'] }]),
    { state: 'waiting', label: '需要确认', count: 1 },
  );

  assert.deepEqual(summarizeThreadStatus([{ type: 'active', activeFlags: [] }]), {
    state: 'working',
    label: '工作中',
    count: 1,
  });

  assert.deepEqual(summarizeThreadStatus([{ type: 'running', activeFlags: [] }]), {
    state: 'working',
    label: '工作中',
    count: 1,
  });

  assert.deepEqual(
    summarizeThreadStatus([{ state: 'working', activeFlags: ['waitingOnUserInput'] }]),
    { state: 'waiting', label: '等待输入', count: 1 },
  );
});

test('summarizes plan progress for homepage and detail page', () => {
  const plan = summarizePlan({
    items: [
      { step: '检查接口事件', status: 'completed' },
      { step: '运行 npm test', status: 'in_progress' },
      { step: '烧录开发板', status: 'pending' },
    ],
  });

  assert.equal(plan.current, 2);
  assert.equal(plan.total, 3);
  assert.equal(plan.completed, 1);
  assert.equal(plan.summary, '步骤 2/3 完成 1');
  assert.equal(plan.home, '步骤 2/3 · 运行 npm test');
  assert.deepEqual(plan.items.map((item) => [item.state, item.label, item.title]), [
    ['done', '完成 1', '检查接口事件'],
    ['work', '进行中', '运行 npm test'],
    ['idle', '待办 1', '烧录开发板'],
  ]);
});

test('summarizes activity token health goal and account diagnostics', () => {
  assert.deepEqual(summarizeActivity({
    kind: 'command',
    status: 'running',
    command: 'npm test -- --watch=false',
  }), {
    state: 'work',
    summary: '正在执行 npm test -- --watch=false',
    items: [
      { state: 'work', label: '命令', title: 'npm test -- --watch=false', meta: '运行中' },
    ],
    home: '正在执行 npm test -- --watch=false',
  });

  assert.equal(summarizeTokenUsage({
    contextWindowUsedPercent: 42,
    lastTurnTokens: 1800,
    totalTokens: 92000,
  }).summary, '上下文 42% 本轮 1.8k');

  assert.equal(summarizeHealth({
    account: { email: 'a@example.com' },
    appServer: { state: 'connected' },
    transport: { state: 'connected', mode: 'serial' },
  }).summary, '已登录 · 服务正常');

  assert.equal(summarizeGoal({ objective: '把状态屏做完', status: 'active' }).summary, '把状态屏做完');

  assert.equal(summarizeAccount({
    account: { plan: 'Pro', email: 'a@example.com' },
    models: { data: [{ id: 'gpt-5' }, { id: 'o4-mini' }] },
    rateLimits: { rateLimitReachedType: null },
  }).summary, 'Pro · a@example.com');

  assert.equal(summarizeHealth({
    account: null,
    appServer: { state: 'connected' },
    transport: { state: 'connected', mode: 'serial' },
  }).summary, '账号未知 · 服务正常');

  assert.deepEqual(summarizeTokenUsage({
    contextWindow: { usedTokens: 48000, maxTokens: 60000 },
    lastTurn: { promptTokens: 1200, completionTokens: 300 },
  }, {
    result: { totalTokens: 210000, today_tokens: 3600 },
  }), {
    contextPercent: 80,
    lastTurnTokens: 1500,
    totalTokens: 210000,
    todayTokens: 3600,
    summary: '上下文 80% 本轮 1.5k',
    items: [
      { state: 'check', label: '上下文', title: '80%', meta: '窗口占比' },
      { state: 'idle', label: '本轮', title: '1.5k', meta: 'tokens' },
      { state: 'idle', label: '累计', title: '210k', meta: '今日 3.6k' },
    ],
  });

  const fallbackSummary = summarizeTokenUsage({}, {
    summary: { lifetimeTokens: 910000 },
  }, {
    contextPercentFallback: 88,
    previousTotalTokens: 900000,
  });
  assert.equal(fallbackSummary.summary, '上下文 88% 本轮 10k');
  assert.equal(fallbackSummary.items[2].title, '910k');

  const missingContext = summarizeTokenUsage({}, {}, {
    contextPercentFallback: 12,
    previousTotalTokens: 1000,
  });
  assert.equal(missingContext.items[0].title, '12%');
  assert.equal(missingContext.items[1].title, '--');
});

test('builds compact detail page lines for firmware', () => {
  const lines = buildDetailPageLines({
    plan: summarizePlan({
      items: [
        { step: '检查接口事件', status: 'completed' },
        { step: '运行 npm test', status: 'in_progress' },
      ],
    }),
    activity: summarizeActivity({ kind: 'file', status: 'running', file: 'src/usage-format.js' }),
    token: summarizeTokenUsage({ contextWindowUsedPercent: 42, lastTurnTokens: 1800 }),
    health: summarizeHealth({
      account: { email: 'a@example.com' },
      appServer: { state: 'connected' },
      transport: { state: 'connected', mode: 'serial' },
    }),
    account: summarizeAccount({ account: { plan: 'Pro', email: 'a@example.com' } }),
  });

  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    'PAGE|token|Token|上下文 42% 本轮 1.8k|idle,上下文,42%,窗口占比|idle,本轮,1.8k,tokens|idle,累计,--,未返回',
  );
  assert.ok(lines.some((line) => line.startsWith('PAGE|health|健康|已登录 · 服务正常|')));
  assert.ok(lines.some((line) => line.includes('|idle,套餐,Pro,限额正常')));
  assert.ok(lines.every((line) => !line.startsWith('PAGE|progress|')));
  assert.ok(lines.every((line) => !line.startsWith('PAGE|goal|')));
  assert.ok(lines.every((line) => !line.startsWith('PAGE|account|')));
  assert.ok(lines.every((line) => Buffer.byteLength(line) < 360));
});

test('summarizes Feishu schedule with current next and today list', () => {
  const nowMs = Date.parse('2026-06-18T10:15:00+08:00');
  const schedule = summarizeSchedule([
    {
      summary: '已经结束的早会',
      start_time: { datetime: '2026-06-18T09:00:00+08:00' },
      end_time: { datetime: '2026-06-18T09:30:00+08:00' },
    },
    {
      summary: '当前同步会议',
      start_time: { datetime: '2026-06-18T10:00:00+08:00' },
      end_time: { datetime: '2026-06-18T10:30:00+08:00' },
    },
    {
      summary: '下午产品评审',
      start_time: { datetime: '2026-06-18T14:00:00+08:00' },
      end_time: { datetime: '2026-06-18T15:00:00+08:00' },
    },
  ], { nowMs });

  assert.equal(schedule.current.title, '当前同步会议');
  assert.equal(schedule.next.title, '下午产品评审');
  assert.equal(schedule.todayRemainingCount, 2);
  assert.equal(schedule.todayTotalCount, 3);
  assert.equal(schedule.progressText, '日程进度：2/3');
  assert.equal(schedule.summary, '当前 当前同步会议 · 今日剩余 2 条');
  assert.deepEqual(schedule.items.map((item) => [item.state, item.label, item.title, item.meta]), [
    ['work', '当前', '当前同步会议', '10:00-10:30'],
    ['check', '下一个', '下午产品评审', '14:00-15:00'],
    ['idle', '明日', '明日 0 条', '次日日程'],
  ]);
});

test('highlights next Feishu schedule when it starts within fifteen minutes', () => {
  const nowMs = Date.parse('2026-06-18T13:45:00+08:00');
  const schedule = summarizeSchedule([
    {
      summary: '刚结束的会议',
      start_time: { datetime: '2026-06-18T13:00:00+08:00' },
      end_time: { datetime: '2026-06-18T13:30:00+08:00' },
    },
    {
      summary: '马上开始的评审',
      start_time: { datetime: '2026-06-18T14:00:00+08:00' },
      end_time: { datetime: '2026-06-18T15:00:00+08:00' },
    },
  ], { nowMs });
  const lines = buildDetailPageLines({ schedule });

  assert.equal(schedule.current, null);
  assert.equal(schedule.next.title, '马上开始的评审');
  assert.equal(schedule.summary, '即将 马上开始的评审 · 今日剩余 1 条');
  assert.deepEqual(schedule.items.map((item) => [item.state, item.label, item.title, item.meta]), [
    ['check', '即将', '马上开始的评审', '14:00-15:00'],
    ['idle', '明日', '明日 0 条', '次日日程'],
  ]);
  assert.equal(
    lines[0],
    'PAGE|schedule|飞书日程|日程进度：1/2|check,即将,马上开始的评审,14:00-15:00|idle,明日,明日 0 条,次日日程',
  );
});

test('adds tomorrow count at the end of a scrollable schedule list', () => {
  const nowMs = Date.parse('2026-06-18T10:15:00+08:00');
  const schedule = summarizeSchedule([
    {
      summary: '当前同步会议',
      start_time: { datetime: '2026-06-18T10:00:00+08:00' },
      end_time: { datetime: '2026-06-18T10:30:00+08:00' },
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      summary: `今日事项 ${index + 1}`,
      start_time: { datetime: `2026-06-18T${String(11 + index).padStart(2, '0')}:00:00+08:00` },
      end_time: { datetime: `2026-06-18T${String(11 + index).padStart(2, '0')}:30:00+08:00` },
    })),
    {
      summary: '明天站会',
      start_time: { datetime: '2026-06-19T10:00:00+08:00' },
      end_time: { datetime: '2026-06-19T10:30:00+08:00' },
    },
    {
      summary: '明天下午评审',
      start_time: { datetime: '2026-06-19T15:00:00+08:00' },
      end_time: { datetime: '2026-06-19T16:00:00+08:00' },
    },
  ], { nowMs });
  const lines = buildDetailPageLines({ schedule });

  assert.equal(schedule.items.length, 9);
  assert.deepEqual(schedule.items.at(-1), {
    state: 'idle',
    label: '明日',
    title: '明日 2 条',
    meta: '次日日程',
  });
  assert.ok(lines[0].includes('|idle,明日,明日 2 条,次日日程'));
  assert.ok(Buffer.byteLength(lines[0]) < 1024);
});

test('shows completed schedule progress when all today events are done', () => {
  const nowMs = Date.parse('2026-06-18T21:15:00+08:00');
  const schedule = summarizeSchedule([
    {
      summary: '上午站会',
      start_time: { datetime: '2026-06-18T10:00:00+08:00' },
      end_time: { datetime: '2026-06-18T10:30:00+08:00' },
    },
    {
      summary: '下午评审',
      start_time: { datetime: '2026-06-18T15:00:00+08:00' },
      end_time: { datetime: '2026-06-18T16:00:00+08:00' },
    },
  ], { nowMs });

  assert.equal(schedule.current, null);
  assert.equal(schedule.todayRemainingCount, 0);
  assert.equal(schedule.todayTotalCount, 2);
  assert.equal(schedule.progressText, '恭喜！日程全部完成！');
});

test('summarizes tomorrow schedule when today has no remaining events', () => {
  const nowMs = Date.parse('2026-06-18T21:15:00+08:00');
  const schedule = summarizeSchedule([
    {
      summary: '明天站会',
      start_time: { datetime: '2026-06-19T10:00:00+08:00' },
      end_time: { datetime: '2026-06-19T10:30:00+08:00' },
    },
  ], { nowMs });

  assert.equal(schedule.current, null);
  assert.equal(schedule.next.title, '明天站会');
  assert.equal(schedule.todayRemainingCount, 0);
  assert.equal(schedule.tomorrowEvents.length, 1);
  assert.equal(schedule.summary, '今日无日程 · 明日 1 条');
  assert.deepEqual(schedule.items.map((item) => [item.state, item.label, item.title, item.meta]), [
    ['idle', '明日 1', '明天站会', '明天 10:00-10:30'],
  ]);
});

test('keeps schedule summary off the Codex home page', () => {
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-18T10:15:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781778600 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1782316800 },
    },
    status: { state: 'idle', label: '空闲', count: 0 },
    enhancements: {
      schedule: summarizeSchedule([
        {
          summary: '当前同步会议',
          start_time: { datetime: '2026-06-18T10:00:00+08:00' },
          end_time: { datetime: '2026-06-18T10:30:00+08:00' },
        },
      ], { nowMs: Date.parse('2026-06-18T10:15:00+08:00') }),
    },
  });

  assert.equal(display.homeHint, '点按查看详情');
});

test('builds schedule detail page line for firmware', () => {
  const schedule = summarizeSchedule([
    {
      summary: '很长很长很长很长很长的中文日程标题需要截断',
      start_time: { datetime: '2026-06-18T14:00:00+08:00' },
      end_time: { datetime: '2026-06-18T15:00:00+08:00' },
    },
  ], { nowMs: Date.parse('2026-06-18T10:15:00+08:00') });

  const lines = buildDetailPageLines({ schedule });

  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    'PAGE|schedule|飞书日程|日程进度：0/1|check,下一个,很长很长很长很长很长的中文日程标题需要截断,14:00-15:00|idle,明日,明日 0 条,次日日程',
  );
  assert.ok(Buffer.byteLength(lines[0]) < 420);
});

test('builds a compact firmware wire payload', () => {
  const sessions = summarizeThreadSessions([
    {
      id: '019eaf35-73cd-7463-9dff-81b744c29a40',
      title: '我有个微雪开发版',
      cwd: '/Users/example/Documents/weixue',
      status: { type: 'active', activeFlags: [] },
      updatedAt: Date.parse('2026-06-10T12:00:00+08:00'),
    },
  ], 5, Date.parse('2026-06-10T12:00:00+08:00'));
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '最近活动' },
    sessions,
  });

  const wire = buildWirePayload(display);

  assert.deepEqual(wire, {
    v: 1,
    ts: 1781064000,
    s: { r: 96, u: 4, t: 56, x: '14:47', d: '2时47分' },
    l: { r: 19, x: '6月11日', d: '22时22分' },
    st: { s: 'working', c: 1 },
    h: '点按查看详情',
    m: false,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < 260);
});

test('firmware binds 5 hour remaining percent to the edge arc', () => {
  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'Firmware', 'CodexStatusDisplay', 'CodexDashboard.cpp'),
    'utf8',
  );
  const sketchSource = fs.readFileSync(
    path.join(__dirname, '..', 'Firmware', 'CodexStatusDisplay', 'CodexStatusDisplay.ino'),
    'utf8',
  );

  assert.match(dashboardSource, /lv_obj_t \*shortArc;/);
  assert.match(dashboardSource, /lv_obj_t \*shortTimeDot;/);
  assert.match(dashboardSource, /lv_obj_set_size\(ui\.shortArc,\s*360,\s*360\)/);
  assert.match(dashboardSource, /lv_obj_set_style_arc_width\(ui\.shortArc,\s*5,\s*LV_PART_MAIN\)/);
  assert.match(dashboardSource, /lv_obj_set_style_arc_width\(ui\.shortArc,\s*5,\s*LV_PART_INDICATOR\)/);
  assert.match(dashboardSource, /lv_arc_set_rotation\(ui\.shortArc,\s*270\)/);
  assert.match(dashboardSource, /lv_arc_set_value\(ui\.shortArc,\s*remainingValue\)/);
  assert.match(dashboardSource, /lv_color_t shortRemainingColor\(int remaining\)/);
  assert.match(dashboardSource, /if \(value < 20\) return lv_color_hex\(0xF04438\)/);
  assert.match(dashboardSource, /if \(value < 50\) return lv_color_hex\(0xF79009\)/);
  assert.match(dashboardSource, /return lv_color_hex\(0x12B76A\)/);
  assert.match(dashboardSource, /positionShortTimeDot\(timeRemainingPercent,\s*color\)/);
  assert.match(dashboardSource, /lv_obj_align\(ui\.shortTimeDot,\s*LV_ALIGN_CENTER,\s*offsetX,\s*offsetY\)/);
  assert.match(dashboardSource, /lv_obj_set_style_arc_color\(ui\.shortArc,\s*color,\s*LV_PART_INDICATOR\)/);
  assert.match(dashboardSource, /lv_obj_set_style_text_color\(ui\.shortCard\.value,\s*shortRemainingColor\(shortPercent\),\s*LV_PART_MAIN\)/);
  assert.match(dashboardSource, /JsonVariantConst shortDoc = jsonObject\(doc,\s*"short",\s*"s"\)/);
  assert.match(dashboardSource, /JsonVariantConst statusDoc = jsonObject\(doc,\s*"status",\s*"st"\)/);
  assert.match(dashboardSource, /jsonInt\(shortDoc\["timeRemainingPercent"\],\s*jsonInt\(shortDoc\["t"\]/);
  assert.match(dashboardSource, /updateEdgeProgress\(shortPercent,\s*shortTimeRemainingPercent\)/);
  assert.match(dashboardSource, /struct DetailPage/);
  assert.match(dashboardSource, /void parsePageLine\(const String &line\)/);
  assert.match(dashboardSource, /line\.startsWith\("PAGE\|"\)/);
  assert.match(dashboardSource, /renderDetailPage\(\)/);
  assert.match(dashboardSource, /constexpr int DETAIL_PAGE_COUNT = 3/);
  assert.match(dashboardSource, /constexpr int TAP_DETAIL_PAGE_COUNT = 3/);
  assert.match(dashboardSource, /constexpr int DETAIL_ITEM_COUNT = 9/);
  assert.match(dashboardSource, /constexpr uint32_t AUTO_SCHEDULE_HOLD_MS = 120000/);
  assert.match(dashboardSource, /constexpr uint32_t AUTO_IDLE_TO_SCHEDULE_MS = 120000/);
  assert.doesNotMatch(dashboardSource, /if \(key == "progress"\) return/);
  assert.doesNotMatch(dashboardSource, /if \(key == "goal"\) return/);
  assert.doesNotMatch(dashboardSource, /if \(key == "token"\) return/);
  assert.match(dashboardSource, /if \(key == "schedule"\) return 0/);
  assert.match(dashboardSource, /if \(key == "sessions"\) return 1/);
  assert.match(dashboardSource, /if \(key == "health"\) return 2/);
  assert.match(dashboardSource, /LV_EVENT_GESTURE/);
  assert.match(dashboardSource, /LV_EVENT_PRESSED/);
  assert.match(dashboardSource, /LV_EVENT_RELEASED/);
  assert.match(dashboardSource, /SWIPE_THRESHOLD_PX/);
  assert.match(dashboardSource, /handleSwipeRelease/);
  assert.match(dashboardSource, /touchSuppressClick/);
  assert.match(dashboardSource, /lv_indev_get_gesture_dir/);
  assert.match(dashboardSource, /LV_DIR_LEFT/);
  assert.match(dashboardSource, /LV_DIR_RIGHT/);
  assert.match(dashboardSource, /LV_DIR_TOP/);
  assert.match(dashboardSource, /LV_DIR_BOTTOM/);
  assert.match(dashboardSource, /scheduleScrollOffset/);
  assert.match(dashboardSource, /handleScheduleScroll/);
  assert.match(dashboardSource, /currentScheduleSignature/);
  assert.match(dashboardSource, /scheduleAutoUntilMs/);
  assert.match(dashboardSource, /idleScheduleDueMs/);
  assert.match(dashboardSource, /openSessionsPage/);
  assert.match(dashboardSource, /handleCodexSessionCount/);
  assert.match(dashboardSource, /handleAutoPageTick/);
  assert.match(dashboardSource, /lastActiveSessionCount == 0 && activeCount > 0/);
  assert.doesNotMatch(dashboardSource, /lastActiveSessionCount == 0 && activeCount > 0[\s\S]{0,160}openSessionsPage\(\)/);
  assert.match(dashboardSource, /lastActiveSessionCount > 0 && activeCount == 0/);
  assert.match(dashboardSource, /scheduleAutoUntilMs = nowMs \+ AUTO_SCHEDULE_HOLD_MS/);
  assert.match(dashboardSource, /idleScheduleDueMs = nowMs \+ AUTO_IDLE_TO_SCHEDULE_MS/);
  assert.match(dashboardSource, /lv_label_set_text\(ui\.detailHint,\s*page\.summary\.c_str\(\)\)/);
  assert.doesNotMatch(dashboardSource, /右滑返回/);
  assert.match(dashboardSource, /if \(!showingDetail\) \{\s*currentDetailIndex = detailPageIndexForKey\("schedule"\);\s*setDetailVisible\(true\);/);
  assert.match(dashboardSource, /currentDetailIndex \+= 1/);
  assert.match(dashboardSource, /if \(currentDetailIndex >= TAP_DETAIL_PAGE_COUNT\) \{\s*setDetailVisible\(false\);/);
  assert.match(dashboardSource, /if \(direction == LV_DIR_RIGHT && showingDetail\)/);
  assert.match(dashboardSource, /return showingDetail\s*&& currentDetailIndex >= 0/);
  assert.match(dashboardSource, /void openSchedulePage\(\) \{\s*currentDetailIndex = detailPageIndexForKey\("schedule"\);\s*scheduleScrollOffset = 0;\s*setDetailVisible\(true\);/);
  assert.doesNotMatch(dashboardSource, /void openSchedulePage\(\) \{\s*currentDetailIndex = detailPageIndexForKey\("schedule"\);\s*scheduleScrollOffset = 0;\s*setScheduleVisible\(true\);/);
  assert.doesNotMatch(dashboardSource, /if \(timerReached\(nowMs,\s*scheduleAutoUntilMs\)\) \{\s*scheduleAutoUntilMs = 0;\s*if \(activeSessionCount > 0\) \{\s*openSessionsPage\(\)/);
  assert.match(dashboardSource, /page\.count < DETAIL_ITEM_COUNT/);
  assert.match(dashboardSource, /showScheduleCurrentCard/);
  assert.match(dashboardSource, /hideScheduleCurrentCard/);
  assert.match(dashboardSource, /isFeaturedScheduleItem/);
  assert.match(dashboardSource, /item\.label == "当前" \|\| item\.label == "即将"/);
  assert.match(dashboardSource, /lv_obj_add_flag\(ui\.sessionSummary,\s*LV_OBJ_FLAG_HIDDEN\)/);
  assert.match(dashboardSource, /lv_obj_clear_flag\(ui\.sessionSummary,\s*LV_OBJ_FLAG_HIDDEN\)/);
  assert.match(dashboardSource, /isScheduleTimeMeta/);
  assert.match(dashboardSource, /String itemLabel = isSchedulePage && isScheduleTimeMeta\(item\.meta\) \? item\.meta : item\.label/);
  assert.match(dashboardSource, /String itemMeta = isSchedulePage && isScheduleTimeMeta\(item\.meta\) \? item\.label : item\.meta/);
  assert.match(dashboardSource, /void applyRowLayout\(SessionRow &row,\s*bool wideLabel\)/);
  assert.match(dashboardSource, /lv_obj_set_width\(row\.label,\s*wideLabel \? 86 : 64\)/);
  assert.match(dashboardSource, /lv_obj_align\(row\.title,\s*LV_ALIGN_TOP_LEFT,\s*wideLabel \? 112 : 92,\s*2\)/);
  assert.match(dashboardSource, /applyRowLayout\(row,\s*label && strchr\(label,\s*':'\) != nullptr\)/);
  assert.match(dashboardSource, /const char \*statusLabel = jsonString\(statusDoc\["label"\],\s*nullptr\)/);
  assert.match(dashboardSource, /if \(!statusLabel\) statusLabel = jsonString\(statusDoc\["l"\],\s*nullptr\)/);
  assert.match(dashboardSource, /setStatusVisual\(displayState,\s*displayCount,\s*statusLabel\)/);
  assert.match(dashboardSource, /jsonString\(doc\["h"\],\s*"点按查看详情"\)/);
  assert.match(dashboardSource, /strcmp\(state,\s*"working"\) == 0 \|\| strcmp\(state,\s*"waiting"\) == 0/);
  assert.match(dashboardSource, /jsonString\(shortDoc\["d"\],\s*"--"\)/);
  assert.match(dashboardSource, /setLabelFmt\(card\.note,\s*"剩余 %s"/);
  assert.match(sketchSource, /Serial\.setRxBufferSize\(2048\)/);
  assert.match(sketchSource, /Serial\.begin\(115200\)/);
  assert.ok(sketchSource.indexOf('Serial.setRxBufferSize(2048)') < sketchSource.indexOf('Serial.begin(115200)'));
});

test('falls back to 1 running session when status is 最近活动 without explicit work count', () => {
  const sessions = {
    counts: { work: 0, check: 0, idle: 2, error: 0 },
    items: [
      { state: 'idle', label: '空闲 1', detail: '会话一', title: '会话一', project: 'projA', age: '10分' },
      { state: 'idle', label: '空闲 2', detail: '会话二', title: '会话二', project: 'projB', age: '20分' },
    ],
  };
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '最近活动' },
    sessions,
  });

  const wire = buildWirePayload(display);

  assert.equal(wire.st.c, 1);
});

test('normalizes session counts to show one running item when in 最近活动 and work count is missing', () => {
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '最近活动' },
    sessions: {
      counts: { work: 0, check: 0, idle: 3, error: 0 },
      items: [],
    },
  });

  assert.equal(display.sessions.counts.work, 1);
  assert.equal(buildWirePayload(display).st.c, 1);
});

test('normalizes session list so one item appears as running when status says working', () => {
  const sessions = summarizeThreadSessions([
    {
      id: '019eaf35-73cd-7463-9dff-81b744c29a40',
      title: '我有个微雪开发版，已经连接上电脑了，资料在这https://docs.waveshare.net/ESP32-S3-Touch-LCD-1.85',
      preview: '我有个微雪开发版',
      cwd: '/Users/example/Documents/weixue',
      status: { type: 'idle' },
      updatedAt: Date.parse('2026-06-10T12:00:00+08:00'),
    },
  ], 5, Date.parse('2026-06-10T12:00:00+08:00'));
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '最近活动' },
    sessions,
  });

  assert.equal(display.sessions.counts.work, 1);
  assert.equal(buildWirePayload(display).st.c, 1);
  assert.equal(display.sessions.items.length, 1);
  assert.equal(display.sessions.items[0].state, 'work');
  assert.equal(display.sessions.items[0].label, '运行 1');
});

test('fills missing running items when working status count is larger than session items', () => {
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '工作中', count: 2 },
    sessions: {
      counts: { work: 1, check: 0, idle: 1, error: 0 },
      items: [
        {
          state: 'work',
          label: '运行 1',
          title: '会话一',
          project: '项目A',
          age: '10分',
        },
      ],
    },
  });

  assert.equal(display.sessions.counts.work, 2);
  assert.equal(display.sessions.items.length, 2);
  assert.equal(display.sessions.items[0].state, 'work');
  assert.equal(display.sessions.items[0].label, '运行 1');
  assert.equal(display.sessions.items[1].state, 'work');
  assert.equal(display.sessions.items[1].label, '运行 2');
  assert.equal(buildWirePayload(display).st.c, 2);
});

test('synthesizes running items when status says working and no running session rows exist', () => {
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '最近活动', count: 2 },
    sessions: {
      counts: { work: 0, check: 0, idle: 3, error: 0 },
      items: [],
    },
  });

  assert.equal(display.sessions.counts.work, 2);
  assert.equal(display.sessions.items.length, 2);
  assert.equal(display.sessions.items[0].label, '运行 1');
  assert.equal(display.sessions.items[1].label, '运行 2');
  assert.equal(display.sessions.items[1].title, '最近活动会话');
});

test('synthesizes running items when status says running but no sessions exist', () => {
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '工作中', count: 2 },
    sessions: {
      counts: { work: 0, check: 0, idle: 0, error: 0 },
      items: [],
    },
  });

  assert.equal(display.sessions.counts.work, 2);
  assert.equal(display.sessions.items.length, 2);
  assert.equal(display.sessions.items[0].label, '运行 1');
  assert.equal(display.sessions.items[1].label, '运行 2');
  assert.equal(buildWirePayload(display).st.c, 2);
});

test('keeps multiple running rows when status says 工作中 with multi-run count', () => {
  const sessions = summarizeThreadSessions([
    {
      id: '019eaf35-73cd-7463-9dff-81b744c29a40',
      title: '会话一',
      cwd: '/Users/example/Documents/weixue',
      status: { type: 'active', activeFlags: [] },
      updatedAt: Date.parse('2026-06-10T12:00:00+08:00'),
    },
    {
      id: '019eaf35-73cd-7463-9dff-81b744c29a41',
      title: '会话二',
      cwd: '/Users/example/Documents/weixue',
      status: { type: 'active', activeFlags: [] },
      updatedAt: Date.parse('2026-06-10T12:00:00+08:00') - 30_000,
    },
  ], 5, Date.parse('2026-06-10T12:00:00+08:00'));
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '工作中', count: 2 },
    sessions,
  });

  assert.deepEqual(display.sessions.counts, {
    work: 2,
    check: 0,
    idle: 0,
    error: 0,
  });
  assert.equal(display.sessions.items.length, 2);
  assert.equal(display.sessions.items[0].label, '运行 1');
  assert.equal(display.sessions.items[1].label, '运行 2');
  assert.equal(buildWirePayload(display).st.c, 2);
});

test('summarizes sessions for the firmware detail page', () => {
  const sessions = summarizeThreadSessions([
    {
      id: '019eaf35-73cd-7463-9dff-81b744c29a40',
      title: '我有个微雪开发版，已经连接上电脑了，资料在这https://docs.waveshare.net/ESP32-S3-Touch-LCD-1.85',
      preview: '我有个微雪开发版，已经连接上电脑了',
      cwd: '/Users/example/Documents/weixue',
      status: { type: 'active', activeFlags: [] },
      updatedAt: Date.parse('2026-06-10T12:00:00+08:00'),
    },
    {
      id: '019eaf92-cbd0-78d3-af28-d5f5fa9bf4b3',
      title: '明确插件能力边界',
      cwd: '/Users/example/code/sample-toolkit/tooling-cli',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      updatedAt: Date.parse('2026-06-10T11:00:00+08:00'),
    },
    {
      id: '019eaf52-98d4-7b71-a4d2-c1a5b9e1a1b7',
      title: '安装飞书 CLI',
      preview: '安装飞书 CLI',
      cwd: '/Users/example/Documents/feishu',
      status: { type: 'idle' },
      updatedAt: Date.parse('2026-06-09T19:00:00+08:00'),
    },
  ], 5, Date.parse('2026-06-10T12:00:00+08:00'));

  assert.deepEqual(sessions.counts, {
    work: 1,
    check: 1,
    idle: 1,
    error: 0,
  });
  assert.deepEqual(sessions.items.map((item) => [item.state, item.label, item.detail]), [
    ['work', '运行 1', '查阅微雪开发板资料'],
    ['check', '待检 1', '明确插件能力边界'],
    ['idle', '空闲 1', '安装飞书 CLI'],
  ]);
  assert.deepEqual(sessions.items.map((item) => [item.title, item.project, item.age]), [
    ['查阅微雪开发板资料', 'weixue', '刚刚'],
    ['明确插件能力边界', 'tooling-cli', '1时'],
    ['安装飞书 CLI', 'feishu', '17时'],
  ]);
});

test('infers multiple running sessions from recently updated unloaded threads', () => {
  const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
  const sessions = summarizeThreadSessions([
    {
      id: '019eaf35-73cd-7463-9dff-81b744c29a40',
      title: '会话一',
      cwd: '/Users/example/Documents/weixue',
      status: { type: 'notLoaded' },
      updatedAt: nowMs - 5_000,
    },
    {
      id: '019ea51b-7c77-7533-b094-a543a600305e',
      title: '会话二',
      cwd: '/Users/example/code/sample-app',
      status: { type: 'notLoaded' },
      updatedAt: nowMs - 12_000,
    },
    {
      id: '019eaf52-98d4-7b71-a4d2-c1a5b9e1a1b7',
      title: '旧会话',
      cwd: '/Users/example/Documents/feishu',
      status: { type: 'notLoaded' },
      updatedAt: nowMs - 120_000,
    },
  ], 5, nowMs, { recentActivityMs: 30_000 });

  assert.deepEqual(sessions.counts, {
    work: 2,
    check: 0,
    idle: 1,
    error: 0,
  });
  assert.deepEqual(sessions.items.map((item) => [item.state, item.label, item.title]), [
    ['work', '运行 1', '会话一'],
    ['work', '运行 2', '会话二'],
    ['idle', '空闲 1', '旧会话'],
  ]);
});

test('builds a compact UTF-8 session line for firmware', () => {
  const display = buildDisplayPayload({
    nowMs: Date.parse('2026-06-10T12:00:00+08:00'),
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1781074024 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1781144543 },
    },
    status: { state: 'working', label: '工作中' },
    sessions: summarizeThreadSessions([
      {
        id: '019eaf35-73cd-7463-9dff-81b744c29a40',
        title: '我有个微雪开发版，已经连接上电脑了，资料在这https://docs.waveshare.net/ESP32-S3-Touch-LCD-1.85',
        cwd: '/Users/example/Documents/weixue',
        status: { type: 'active', activeFlags: [] },
        updatedAt: Date.parse('2026-06-10T12:00:00+08:00'),
      },
    ], 5, Date.parse('2026-06-10T12:00:00+08:00')),
  });

  const line = buildSessionLine(display.sessions);

  assert.equal(line, 'SESS|1,0,0,0|work,运行 1,查阅微雪开发板资料,weixue (019ea),刚刚');
  assert.ok(Buffer.byteLength(line) < 320);
});

test('bridge keeps Codex API failures separate from serial transport status', () => {
  const bridgeSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-usage-bridge.js'),
    'utf8',
  );

  assert.doesNotMatch(bridgeSource, /transport\.state = 'error';\s*transport\.detail = String\(error\.message/s);
  assert.match(bridgeSource, /if \(transport\.state === 'error'\) {\s*transport\.detail = String\(error\.message/s);
});

  test('bridge listens to richer Codex app-server events and sends detail pages', () => {
  const bridgeSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-usage-bridge.js'),
    'utf8',
  );

  assert.match(bridgeSource, /turn\/plan\/updated/);
  assert.match(bridgeSource, /item\/started/);
  assert.match(bridgeSource, /item\/completed/);
  assert.match(bridgeSource, /command\/exec\/outputDelta/);
  assert.match(bridgeSource, /process\/exited/);
  assert.match(bridgeSource, /thread\/tokenUsage\/updated/);
  assert.match(bridgeSource, /thread\/goal\/updated/);
  assert.match(bridgeSource, /account\/usage\/read/);
  assert.match(bridgeSource, /account\/usage\/read',\s*\{\}/);
  assert.match(bridgeSource, /account\/read/);
  assert.match(bridgeSource, /account\/read',\s*\{\}/);
  assert.match(bridgeSource, /model\/list/);
  assert.match(bridgeSource, /model\/list',\s*\{\}/);
  assert.match(bridgeSource, /buildDetailPageLines\(payload\.enhancements\)/);
  assert.match(bridgeSource, /for \(const detailLine of detailLines\)/);
  assert.match(bridgeSource, /summarizeSchedule/);
  assert.match(bridgeSource, /LARK_CALENDAR_SCOPE = 'calendar:calendar\.event:read'/);
  assert.match(bridgeSource, /readLarkAuthSummary/);
  assert.match(bridgeSource, /auth',\s*'check'/);
  assert.match(bridgeSource, /--scope',\s*LARK_CALENDAR_SCOPE/);
  assert.match(bridgeSource, /larkAuth,/);
  assert.match(bridgeSource, /lark-cli/);
  assert.match(bridgeSource, /calendar/);
  assert.match(bridgeSource, /\+agenda/);
  assert.match(bridgeSource, /--as',\s*'user'/);
  assert.match(bridgeSource, /resolve\(stdout \|\| stderr \|\| ''\)/);
  assert.doesNotMatch(bridgeSource, /resolve\(error \? '' : stdout\)/);
  assert.match(bridgeSource, /parsed\.ok === false/);
  assert.match(bridgeSource, /throw new Error\(parsed\.error\?\.message/);
});

test('menu app exposes schedule summary for debugging', () => {
  const menuSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-status-menu.swift'),
    'utf8',
  );

  assert.match(menuSource, /let schedule: EnhancementSummary\?/);
  assert.match(menuSource, /let larkAuth: EnhancementSummary\?/);
  assert.match(menuSource, /private let scheduleItem = NSMenuItem\(title: "日程：--"/);
  assert.match(menuSource, /private let larkAuthItem = NSMenuItem\(title: "飞书授权：--"/);
  assert.match(menuSource, /private let reauthorizeLarkItem = NSMenuItem\(title: "重新授权飞书日历"/);
  assert.match(menuSource, /scheduleItem\.title = "日程：\\\(snapshot\.enhancements\?\.schedule\?\.summary \?\? "--"\)"/);
  assert.match(menuSource, /larkAuthItem\.title = "飞书授权：\\\(snapshot\.enhancements\?\.larkAuth\?\.summary \?\? "--"\)"/);
  assert.match(menuSource, /@objc private func reauthorizeLarkCalendar/);
  assert.match(menuSource, /auth",\s*"login",\s*"--scope",\s*larkCalendarScope,\s*"--no-wait",\s*"--json"/);
  assert.match(menuSource, /auth",\s*"login",\s*"--device-code"/);
  assert.match(menuSource, /auth",\s*"qrcode"/);
});

test('bridge serial open has timeout diagnostics instead of hanging silently', () => {
  const bridgeSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-usage-bridge.js'),
    'utf8',
  );

  assert.match(bridgeSource, /function openSerialPortWithTimeout\(port,\s*timeoutMs = 8000\)/);
  assert.match(bridgeSource, /串口打开超时/);
  assert.ok(bridgeSource.includes('console.error(`[serial] opening ${options.port}`)'));
  assert.match(bridgeSource, /await openSerialPortWithTimeout\(port\)/);
  assert.ok(bridgeSource.includes("console.error('[serial] connected')"));
});

test('bridge resolves bundled usage format from its own runtime first', () => {
  const bridgeSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-usage-bridge.js'),
    'utf8',
  );

  assert.ok(
    bridgeSource.indexOf("path.resolve(scriptDir, 'src/usage-format')") <
      bridgeSource.indexOf("path.resolve(scriptDir, '../src/usage-format')"),
  );
});

test('menu app launches bridge outside the app resource directory', () => {
  const menuSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-status-menu.swift'),
    'utf8',
  );

  assert.match(menuSource, /let bridgeWorkDirectory = URL\(fileURLWithPath: options\.stateFilePath\)/);
  assert.match(menuSource, /process\.currentDirectoryURL = bridgeWorkDirectory/);
  assert.match(menuSource, /let runtimeBridgeScriptURL = bridgeWorkDirectory\.appendingPathComponent\("runtime\/codex-usage-bridge\.js"\)/);
  assert.match(menuSource, /let bridgeScriptPath = FileManager\.default\.fileExists\(atPath: runtimeBridgeScriptURL\.path\)/);
  assert.match(menuSource, /let runtimeNodeModules = bridgeWorkDirectory\.appendingPathComponent\("runtime\/node_modules"\)\.path/);
  assert.match(menuSource, /arguments = \[\s*bridgeScriptPath,/s);
  assert.doesNotMatch(menuSource, /process\.currentDirectoryURL = resourceURL/);
});

test('package script stages bridge runtime outside the app bundle', () => {
  const packageScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'package-menubar-app.sh'),
    'utf8',
  );

  assert.match(packageScript, /RUNTIME_DIR="\$HOME\/Library\/Application Support\/weixue-codex-bridge\/runtime"/);
  assert.match(packageScript, /cp "\$\{SCRIPT_DIR\}\/codex-usage-bridge\.js" "\$\{RUNTIME_DIR\}\/codex-usage-bridge\.js"/);
  assert.match(packageScript, /cp "\$\{ROOT_DIR\}\/src\/usage-format\.js" "\$\{RUNTIME_DIR\}\/src\/usage-format\.js"/);
  assert.match(packageScript, /NODE_MODULES_RUNTIME="\$\{RUNTIME_DIR\}\/node_modules"/);
});
