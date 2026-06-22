#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const includeLocalState = process.env.CODEX_FONT_INCLUDE_LOCAL_STATE === '1';
const sqliteDb = path.join(os.homedir(), '.codex/state_5.sqlite');
const bridgeStatePath = path.join(
  os.homedir(),
  'Library/Application Support/weixue-codex-bridge/state/codex-status-menu-state.json',
);
const fontCandidates = [
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/eb257c12d1a51c8c661b89f30eec56cacf9b8987.asset/AssetData/STHEITI.ttf',
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/3419f2a427639ad8c8e139149a287865a90fa17e.asset/AssetData/PingFang.ttc',
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/62032b9b64a0e3a9121c50aeb2ed794e3e2c201f.asset/AssetData/Hei.ttf',
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/f7f6b250e97c182e68ac53a2b359ec44548878b9.asset/AssetData/Lantinghei.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
];
const fontPath = fontCandidates.find((candidate) => fs.existsSync(candidate));
const converter = path.join(repoRoot, 'node_modules/.bin/lv_font_conv');
const outputDir = path.join(repoRoot, 'Firmware/CodexStatusDisplay');
const scanDirs = [
  path.join(repoRoot, 'Firmware/CodexStatusDisplay'),
  path.join(repoRoot, 'src'),
  path.join(repoRoot, 'scripts'),
];
const scanExts = new Set(['.cpp', '.h', '.js', '.ts', '.swift']);
const ignoreDirs = new Set(['.git', 'node_modules', 'build', '.build', 'dist', 'tmp', 'tmp-arduino']);

const fixedText = [
  'Codex用量监控',
  '运行待检空闲异常离线',
  '五小时窗口本周剩余重置',
  '会话点按返回查看',
  '当前工作等待检查已完成',
  '刚刚分钟小时秒天月日',
  '暂无会话桥接异常串口数据异常',
  '项目标题状态',
].join('');

function readCodexText() {
  if (!fs.existsSync(sqliteDb)) return '';
  const query = [
    'select title, preview, first_user_message',
    'from threads',
    'where archived=0',
    'order by coalesce(updated_at_ms, updated_at * 1000, 0) desc',
    'limit 300;',
  ].join(' ');
  try {
    return execFileSync('/usr/bin/sqlite3', ['-json', sqliteDb, query], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function readBridgeStateText() {
  if (!fs.existsSync(bridgeStatePath)) return '';
  try {
    return fs.readFileSync(bridgeStatePath, 'utf8');
  } catch {
    return '';
  }
}

function addCodepoints(set, text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (shouldIncludeCodepoint(code)) set.add(code);
  }
}

function shouldIncludeCodepoint(code) {
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0x3000 && code <= 0x303f) return true;
  if (code >= 0x3400 && code <= 0x9fff) return true;
  if (code >= 0xff00 && code <= 0xffef) return true;
  if ([0x00b7, 0x2014, 0x201c, 0x201d, 0x2026, 0x2192].includes(code)) return true;
  return false;
}

function compactRanges(codes) {
  const sorted = [...codes].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (const code of sorted.slice(1)) {
    if (code === prev + 1) {
      prev = code;
      continue;
    }
    ranges.push(start === prev ? `0x${start.toString(16)}` : `0x${start.toString(16)}-0x${prev.toString(16)}`);
    start = code;
    prev = code;
  }
  ranges.push(start === prev ? `0x${start.toString(16)}` : `0x${start.toString(16)}-0x${prev.toString(16)}`);
  return ranges.join(',');
}

function addTextFromFile(set, filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  addCodepoints(set, text);
}

function collectFromFiles(set) {
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, file.name);
      if (ignoreDirs.has(file.name)) continue;
      if (file.isDirectory()) {
        collectFromFilesFromDir(fullPath, set);
      } else if (scanExts.has(path.extname(file.name))) {
        addTextFromFile(set, fullPath);
      }
    }
  }
}

function collectFromFilesFromDir(directory, set) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, file.name);
    if (ignoreDirs.has(file.name)) continue;
    if (file.isDirectory()) {
      collectFromFilesFromDir(fullPath, set);
      continue;
    }
    if (scanExts.has(path.extname(file.name))) {
      addTextFromFile(set, fullPath);
    }
  }
}

function collectCodepoints() {
  const set = new Set();
  for (let code = 0x20; code <= 0x7e; code += 1) set.add(code);
  addCodepoints(set, fixedText);
  collectFromFiles(set);

  if (includeLocalState) {
    const raw = readCodexText();
    if (raw) {
      for (const row of JSON.parse(raw)) {
        addCodepoints(set, `${row.title || ''}${row.preview || ''}${row.first_user_message || ''}`);
      }
    }
    addCodepoints(set, readBridgeStateText());
  }

  return set;
}

function buildFont(size) {
  const codes = collectCodepoints();
  const ranges = compactRanges(codes);
  const name = `lv_font_codex_cjk_${size}`;
  const output = path.join(outputDir, `${name}.c`);
  const outputArg = path.relative(repoRoot, output);

  execFileSync(converter, [
    '--size', String(size),
    '--bpp', '2',
    '--format', 'lvgl',
    '--font', fontPath,
    '-r', ranges,
    '--lv-font-name', name,
    '--lv-include', 'lvgl.h',
    '--force-fast-kern-format',
    '--no-compress',
    '--no-prefilter',
    '-o', outputArg,
  ], { stdio: 'inherit', cwd: repoRoot });

  console.log(`${name}: ${codes.size} glyphs -> ${output}`);
}

if (!fontPath) {
  throw new Error(`No usable Chinese font found. Checked: ${fontCandidates.join(', ')}`);
}
if (!fs.existsSync(converter)) {
  throw new Error('lv_font_conv is not installed. Run npm install first.');
}

buildFont(16);
buildFont(24);
