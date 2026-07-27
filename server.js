const express = require('express');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const crypto = require('crypto');

const app = express();
const HOST = process.env.HOST || '127.0.0.1';
const parsedStartPort = Number.parseInt(process.env.PORT || '3000', 10);
const START_PORT = Number.isInteger(parsedStartPort) && parsedStartPort > 0 && parsedStartPort < 65536 ? parsedStartPort : 3000;
const defaultMaxPort = Math.min(65535, START_PORT + 10);
const parsedMaxPort = Number.parseInt(process.env.MAX_PORT || String(defaultMaxPort), 10);
const MAX_PORT = Number.isInteger(parsedMaxPort) && parsedMaxPort >= START_PORT && parsedMaxPort < 65536 ? parsedMaxPort : defaultMaxPort;
const STATE_FILE = process.env.FILE_MANAGER_STATE_FILE || path.join(__dirname, '.file-manager-state.json');
const ERROR_LOG = process.env.FILE_MANAGER_ERROR_LOG || path.join(__dirname, '启动错误.log');
const SHUTDOWN_TOKEN = crypto.randomBytes(24).toString('hex');

// 默认根目录：当前文件夹的上级目录
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const AUDIO_MIME_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wma': 'audio/x-ms-wma'
});
const AUDIO_FORMAT_DETAILS = Object.freeze({
  '.wav': {
    introduction: 'WAV 通常保存未压缩的 PCM 音频，保留完整波形，适合录音、剪辑和归档。',
    comparison: '相比 MP3、AAC、M4A，WAV 通常更大，但没有有损压缩；相比 FLAC，同为无损时 WAV 通常更大，但编辑兼容性更直接。'
  }
});
const AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_TYPES));
const WORD_EXTENSIONS = new Set(['.doc', '.docx']);
const EPISODE_NAME_PATTERN = /第\s*\d+\s*集/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '撤回文件夹', '备份文件夹', '操作日志']);
const DASHBOARD_SKIPPED_DIRECTORIES = new Set(['node_modules', '操作日志']);
const PREVIEW_LIMITS = {
  word: 50 * 1024 * 1024,
  excel: 25 * 1024 * 1024,
  text: 5 * 1024 * 1024,
  image: 20 * 1024 * 1024
};
const EXCEL_PREVIEW_LIMITS = {
  sheets: 50,
  rowsPerSheet: 10000,
  columnsPerSheet: 500,
  cellsTotal: 200000
};
const TREE_PAGE_SIZE = 500;
const TREE_ENTRY_LIMIT = 20000;
const TREE_CACHE_TTL_MS = 30000;
const TREE_CACHE_MAX_DIRECTORIES = 20;
const LOG_VIEW_LIMIT = PREVIEW_LIMITS.text;
const LOG_VIEW_MAX_LINES = 10000;
const OFFICE_ZIP_LIMITS = {
  entries: 5000,
  totalUncompressed: 200 * 1024 * 1024,
  singleEntry: 100 * 1024 * 1024
};
const directoryEntryCache = new Map();
const activeTaskLocks = new Set();
let activeMutationCount = 0;
let shutdownPending = false;

class FileChangedError extends Error {
  constructor(message = '文件在处理期间发生变化，请重新扫描') {
    super(message);
    this.name = 'FileChangedError';
    this.code = 'FILE_CHANGED';
  }
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (shutdownPending && ['/api/move-revoked', '/api/remove-content', '/api/restore-task'].includes(req.path)) {
    return res.status(503).json({ success: false, code: 'SERVER_STOPPING', error: '服务正在停止，未开始新的文件操作' });
  }
  next();
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/libs', express.static(path.join(__dirname, 'libs'), { dotfiles: 'deny' }));

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

function resolveRoot(inputRoot) {
  const requested = path.resolve(inputRoot || DEFAULT_ROOT);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    throw new Error('管理目录不存在或不是文件夹');
  }
  return fs.realpathSync(requested);
}

function assertWithinRoot(rootDir, targetPath, options = {}) {
  const { mustExist = true, type } = options;
  const realRoot = fs.realpathSync(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const targetExists = fs.existsSync(resolvedTarget);
  if (mustExist && !targetExists) throw new Error('目标路径不存在');

  let checkedTarget;
  if (targetExists) {
    checkedTarget = fs.realpathSync(resolvedTarget);
  } else {
    const missingParts = [];
    let existingAncestor = resolvedTarget;
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error('无法解析目标路径');
      missingParts.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
    checkedTarget = path.join(fs.realpathSync(existingAncestor), ...missingParts);
  }
  const relative = path.relative(realRoot, checkedTarget);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('目标路径超出当前管理目录');
  }

  if (mustExist && type) {
    const stats = fs.statSync(checkedTarget);
    if (type === 'file' && !stats.isFile()) throw new Error('目标不是文件');
    if (type === 'directory' && !stats.isDirectory()) throw new Error('目标不是文件夹');
  }

  return checkedTarget;
}

function createTaskId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeTaskId(taskId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId || '')) throw new Error('任务编号无效');
  return taskId;
}

function taskLockKey(rootDir, taskId) {
  const rootKey = process.platform === 'win32' ? rootDir.toLowerCase() : rootDir;
  return `${rootKey}\n${normalizeTaskId(taskId)}`;
}

function acquireTaskLock(rootDir, taskId) {
  const key = taskLockKey(rootDir, taskId);
  if (activeTaskLocks.has(key)) {
    const error = new Error('该任务正在处理中，请等待当前操作完成后再重试');
    error.code = 'TASK_BUSY';
    throw error;
  }
  activeTaskLocks.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTaskLocks.delete(key);
  };
}

function isTaskLocked(rootDir, taskId) {
  return activeTaskLocks.has(taskLockKey(rootDir, taskId));
}

function beginMutation() {
  activeMutationCount++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeMutationCount = Math.max(0, activeMutationCount - 1);
  };
}

function fileVersion(stats) {
  return { size: stats.size, mtime: stats.mtime, mtimeMs: Math.trunc(stats.mtimeMs) };
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hasValidSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function hashFileSha256(filePath, isCancelled) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => {
      if (isCancelled && isCancelled()) {
        const error = new Error('扫描已取消');
        error.code = 'SCAN_CANCELLED';
        stream.destroy(error);
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function loadOfficeZip(buffer, label) {
  const zip = await JSZip.loadAsync(buffer);
  let entryCount = 0;
  let totalUncompressed = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    entryCount++;
    if (entryCount > OFFICE_ZIP_LIMITS.entries) {
      throw new Error(`${label} 内部文件过多，已停止处理以保护程序`);
    }
    const size = Number(entry._data && entry._data.uncompressedSize);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`${label} 内部结构异常，无法确认解压后大小`);
    }
    if (size > OFFICE_ZIP_LIMITS.singleEntry) {
      throw new Error(`${label} 单个内部文件解压后过大，已停止处理以保护程序`);
    }
    totalUncompressed += size;
    if (totalUncompressed > OFFICE_ZIP_LIMITS.totalUncompressed) {
      throw new Error(`${label} 解压后内容超过 200 MB，已停止处理以保护程序`);
    }
  }
  return zip;
}

function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPreviewKind(ext) {
  if (ext === '.docx') return 'word';
  if (ext === '.xlsx' || ext === '.xls') return 'excel';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (['.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.css', '.js'].includes(ext)) return 'text';
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) return 'image';
  return null;
}

function previewLimitMessage(kind, size, limit) {
  const labels = { word: 'Word', excel: 'Excel', text: '文本', image: '图片' };
  return `${labels[kind] || '文件'}过大（${Math.ceil(size / 1024 / 1024)} MB），浏览器预览上限为 ${Math.floor(limit / 1024 / 1024)} MB，请使用本地软件打开。`;
}

function parseAudioRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match || (!match[1] && !match[2]) || fileSize <= 0) return undefined;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : fileSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return undefined;
    end = Math.min(end, fileSize - 1);
  }
  if (start >= fileSize) return undefined;
  return { start, end };
}

function excelColumnLabel(columnIndex) {
  let label = '';
  let index = columnIndex;
  while (index >= 0) {
    label = String.fromCharCode(65 + (index % 26)) + label;
    index = Math.floor(index / 26) - 1;
  }
  return label;
}

function excelCellValue(cell) {
  if (!cell) return '';
  if (cell.t === 'd' && cell.v instanceof Date) {
    const date = cell.v;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  if (cell.t === 'n' && cell.v != null && XLSX.SSF) {
    const format = String(cell.z || '').toLowerCase();
    if (format && ['y', 'm', 'd', '日', '年'].some(token => format.includes(token))) {
      try {
        const date = XLSX.SSF.parse_date_code(cell.v);
        if (date && date.y > 1899) {
          return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
        }
      } catch (e) {}
    }
    return cell.w || String(cell.v);
  }
  return cell.w || (cell.v != null ? String(cell.v) : '');
}

function excelColor(color, fallback = '') {
  const rgb = color && typeof color.rgb === 'string' ? color.rgb.slice(-6) : '';
  return /^[a-f0-9]{6}$/i.test(rgb) ? `#${rgb}` : fallback;
}

function excelCellStyle(cell) {
  if (!cell || !cell.s) return '';
  const style = cell.s;
  const parts = [];
  if (style.alignment) {
    if (['center', 'right', 'left'].includes(style.alignment.horizontal)) {
      parts.push(`text-align:${style.alignment.horizontal}`);
    }
    const vertical = { center: 'middle', top: 'top', bottom: 'bottom' }[style.alignment.vertical];
    if (vertical) parts.push(`vertical-align:${vertical}`);
    if (style.alignment.wrapText) parts.push('white-space:normal', 'word-wrap:break-word');
  }
  if (style.font) {
    if (style.font.bold) parts.push('font-weight:bold');
    if (style.font.italic) parts.push('font-style:italic');
    if (style.font.underline) parts.push('text-decoration:underline');
    const fontSize = Number(style.font.sz);
    if (Number.isFinite(fontSize) && fontSize >= 6 && fontSize <= 72) parts.push(`font-size:${fontSize}pt`);
    const fontColor = excelColor(style.font.color);
    if (fontColor) parts.push(`color:${fontColor}`);
  }
  const fillColor = excelColor(style.fill && style.fill.fgColor);
  if (fillColor) parts.push(`background-color:${fillColor}`);
  if (style.border) {
    const borderStyle = border => {
      if (!border || !border.style) return '';
      const width = border.style === 'medium' ? '2px' : border.style === 'thick' ? '3px' : '1px';
      return `${width} solid ${excelColor(border.color, '#000000')}`;
    };
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const value = borderStyle(style.border[side]);
      if (value) parts.push(`border-${side}:${value}`);
    }
  }
  return parts.join(';');
}

function renderExcelWorkbook(buffer) {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellStyles: true,
    cellNF: true,
    cellDates: true
  });
  if (workbook.SheetNames.length > EXCEL_PREVIEW_LIMITS.sheets) {
    throw new Error(`Excel 工作表超过 ${EXCEL_PREVIEW_LIMITS.sheets} 个，请使用本地表格软件打开。`);
  }

  const sheets = Object.create(null);
  const styledSheets = Object.create(null);
  let totalCells = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    let range;
    try {
      range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    } catch (e) {
      throw new Error(`工作表“${sheetName}”范围异常，无法安全预览。`);
    }
    const validRange = Number.isInteger(range.s.r) && Number.isInteger(range.s.c)
      && Number.isInteger(range.e.r) && Number.isInteger(range.e.c)
      && range.s.r >= 0 && range.s.c >= 0 && range.e.r >= range.s.r && range.e.c >= range.s.c;
    if (!validRange) throw new Error(`工作表“${sheetName}”范围异常，无法安全预览。`);
    const rowCount = range.e.r - range.s.r + 1;
    const columnCount = range.e.c - range.s.c + 1;
    const cellCount = rowCount * columnCount;
    totalCells += cellCount;
    if (!Number.isSafeInteger(cellCount) || rowCount > EXCEL_PREVIEW_LIMITS.rowsPerSheet
      || columnCount > EXCEL_PREVIEW_LIMITS.columnsPerSheet || totalCells > EXCEL_PREVIEW_LIMITS.cellsTotal) {
      throw new Error(`工作表“${sheetName}”内容过大，浏览器最多预览 ${EXCEL_PREVIEW_LIMITS.cellsTotal} 个单元格，请使用本地表格软件打开。`);
    }

    const skipCells = new Set();
    const mergedCells = new Map();
    for (const merge of sheet['!merges'] || []) {
      const validMerge = merge && Number.isInteger(merge.s && merge.s.r) && Number.isInteger(merge.s && merge.s.c)
        && Number.isInteger(merge.e && merge.e.r) && Number.isInteger(merge.e && merge.e.c)
        && merge.s.r >= range.s.r && merge.s.c >= range.s.c && merge.e.r <= range.e.r && merge.e.c <= range.e.c
        && merge.e.r >= merge.s.r && merge.e.c >= merge.s.c;
      if (!validMerge) throw new Error(`工作表“${sheetName}”包含异常合并区域，无法安全预览。`);
      mergedCells.set(`${merge.s.r}_${merge.s.c}`, {
        rowspan: merge.e.r - merge.s.r + 1,
        colspan: merge.e.c - merge.s.c + 1
      });
      for (let row = merge.s.r; row <= merge.e.r; row++) {
        for (let column = merge.s.c; column <= merge.e.c; column++) {
          if (row !== merge.s.r || column !== merge.s.c) skipCells.add(`${row}_${column}`);
        }
      }
    }

    const columnWidths = new Map();
    (sheet['!cols'] || []).forEach((column, index) => {
      const width = Number(column && (column.wpx || (column.wch && column.wch * 7.5)));
      if (Number.isFinite(width) && width > 0) columnWidths.set(index, Math.min(800, Math.round(width)));
    });

    let readingHtml = '<table><tbody>';
    let styledHtml = '<table><thead><tr><th></th>';
    for (let column = range.s.c; column <= range.e.c; column++) {
      const width = columnWidths.get(column);
      const widthStyle = width ? ` style="width:${width}px;min-width:${width}px"` : '';
      styledHtml += `<th${widthStyle}>${excelColumnLabel(column)}</th>`;
    }
    styledHtml += '</tr></thead><tbody>';

    for (let row = range.s.r; row <= range.e.r; row++) {
      readingHtml += `<tr data-row="${row}">`;
      const rowHeight = Number(sheet['!rows'] && sheet['!rows'][row] && sheet['!rows'][row].hpx);
      const rowStyle = Number.isFinite(rowHeight) && rowHeight > 0 ? ` style="height:${Math.min(500, rowHeight)}px"` : '';
      styledHtml += `<tr${rowStyle}><th>${row + 1}</th>`;
      for (let column = range.s.c; column <= range.e.c; column++) {
        const cellKey = `${row}_${column}`;
        if (skipCells.has(cellKey)) continue;
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address];
        const value = escapeHtmlText(excelCellValue(cell));
        const merge = mergedCells.get(cellKey);
        let attributes = '';
        if (merge) {
          if (merge.rowspan > 1) attributes += ` rowspan="${merge.rowspan}"`;
          if (merge.colspan > 1) attributes += ` colspan="${merge.colspan}"`;
        }
        readingHtml += `<td${attributes}>${value}</td>`;
        const style = [excelCellStyle(cell), 'border:1px solid #d0d0d0', 'padding:3px 6px'].filter(Boolean).join(';');
        styledHtml += `<td${attributes} style="${style}">${value}</td>`;
      }
      readingHtml += '</tr>';
      styledHtml += '</tr>';
    }
    readingHtml += '</tbody></table>';
    styledHtml += '</tbody></table>';
    sheets[sheetName] = readingHtml;
    styledSheets[sheetName] = styledHtml;
  }
  return { sheets, styledSheets };
}

app.get('/api/health', (req, res) => {
  const address = req.socket.localPort;
  res.json({
    success: true,
    version: require('./package.json').version,
    host: HOST,
    port: address,
    defaultRoot: toPosix(DEFAULT_ROOT),
    projectDir: toPosix(__dirname),
    pid: process.pid,
    uptime: Math.round(process.uptime())
  });
});

app.post('/api/shutdown', (req, res) => {
  const remoteAddress = req.socket.remoteAddress || '';
  const isLocal = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (!isLocal || req.body.token !== SHUTDOWN_TOKEN) {
    return res.status(403).json({ success: false, error: '无权停止服务' });
  }
  if (activeMutationCount > 0) {
    return res.status(409).json({
      success: false,
      code: 'TASKS_RUNNING',
      error: `当前有 ${activeMutationCount} 个文件任务正在处理，请等待完成后再停止`
    });
  }
  shutdownPending = true;
  res.json({ success: true });
  setImmediate(shutdown);
});

// ========== 操作日志 ==========
function writeLog(rootDir, action, details) {
  const logDir = assertWithinRoot(rootDir, path.join(rootDir, '操作日志'), { mustExist: false });
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  const logFile = assertWithinRoot(rootDir, path.join(logDir, `${dateStr}.log`), { mustExist: false });
  const line = `[${timeStr}] [${action}] ${details}\n`;
  fs.appendFileSync(logFile, line, 'utf8');
}

function tryWriteLog(rootDir, action, details) {
  try {
    writeLog(rootDir, action, details);
    return '';
  } catch (e) {
    return `操作已完成，但日志写入失败：${e.message}`;
  }
}

function readUtf8Tail(filePath, maxBytes, maxLines) {
  const stats = fs.statSync(filePath);
  let content;
  let truncatedBySize = false;
  if (stats.size <= maxBytes) {
    content = fs.readFileSync(filePath, 'utf8');
  } else {
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    content = buffer.subarray(0, bytesRead).toString('utf8');
    const firstLineBreak = content.indexOf('\n');
    if (firstLineBreak >= 0) content = content.slice(firstLineBreak + 1);
    truncatedBySize = true;
  }

  let truncatedByLines = false;
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    content = lines.slice(-maxLines).join('\n');
    truncatedByLines = true;
  }
  return {
    content,
    truncated: truncatedBySize || truncatedByLines,
    truncatedBySize,
    truncatedByLines,
    totalSize: stats.size,
    loadedSize: Buffer.byteLength(content, 'utf8'),
    lineLimit: maxLines
  };
}

// ========== API: 获取操作日志列表 ==========
app.get('/api/logs', (req, res) => {
  try {
    const rootDir = resolveRoot(req.query.root);
    const logDir = assertWithinRoot(rootDir, path.join(rootDir, '操作日志'), { mustExist: false });
    if (!fs.existsSync(logDir)) {
      return res.json({ success: true, files: [] });
    }
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse();
    res.json({ success: true, files });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== API: 读取指定日志文件 ==========
app.get('/api/logs/:filename', (req, res) => {
  try {
    const rootDir = resolveRoot(req.query.root);
    const filename = req.params.filename;
    if (path.basename(filename) !== filename || !filename.endsWith('.log')) {
      return res.json({ success: false, error: '日志文件名无效' });
    }
    const logDir = assertWithinRoot(rootDir, path.join(rootDir, '操作日志'), { mustExist: false });
    const logFile = assertWithinRoot(rootDir, path.join(logDir, filename), { mustExist: false });
    if (!fs.existsSync(logFile)) {
      return res.json({ success: false, error: '日志文件不存在' });
    }
    const result = readUtf8Tail(logFile, LOG_VIEW_LIMIT, LOG_VIEW_MAX_LINES);
    res.json({ success: true, ...result, filename: req.params.filename, limit: LOG_VIEW_LIMIT });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== API 1: 按需获取一层目录 ==========
function directoryCacheKey(dirPath) {
  return process.platform === 'win32' ? dirPath.toLowerCase() : dirPath;
}

async function readDirectoryEntries(dirPath) {
  const beforeStats = await fs.promises.stat(dirPath);
  const directoryMtimeMs = Math.trunc(beforeStats.mtimeMs);
  const cacheKey = directoryCacheKey(dirPath);
  const cached = directoryEntryCache.get(cacheKey);
  if (cached && cached.directoryMtimeMs === directoryMtimeMs && Date.now() - cached.cachedAt <= TREE_CACHE_TTL_MS) {
    return { entries: cached.entries, directoryMtimeMs };
  }

  const entries = [];
  let inspected = 0;
  const directory = await fs.promises.opendir(dirPath);
  for await (const entry of directory) {
    inspected++;
    if (inspected > TREE_ENTRY_LIMIT) {
      const error = new Error(`该文件夹包含超过 ${TREE_ENTRY_LIMIT} 个项目。为避免程序卡死，请先用系统文件管理器拆分文件夹。`);
      error.code = 'DIRECTORY_TOO_LARGE';
      throw error;
    }
    if (inspected % 500 === 0) await new Promise(resolve => setImmediate(resolve));
    if (entry.name.startsWith('.') || entry.name.startsWith('~$') || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
    if (path.resolve(dirPath, entry.name) === path.resolve(__dirname)) continue;
    entries.push(entry);
  }

  const afterStats = await fs.promises.stat(dirPath);
  const afterMtimeMs = Math.trunc(afterStats.mtimeMs);
  if (Math.abs(afterMtimeMs - directoryMtimeMs) > 1) {
    const error = new Error('目录内容已发生变化，请刷新目录后重试。');
    error.code = 'DIRECTORY_CHANGED';
    throw error;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  directoryEntryCache.delete(cacheKey);
  directoryEntryCache.set(cacheKey, { entries, directoryMtimeMs, cachedAt: Date.now() });
  while (directoryEntryCache.size > TREE_CACHE_MAX_DIRECTORIES) {
    directoryEntryCache.delete(directoryEntryCache.keys().next().value);
  }
  return { entries, directoryMtimeMs };
}

async function buildDirectoryLevel(dirPath, rootPath, offset = 0) {
  const skipped = [];
  const children = [];
  const { entries, directoryMtimeMs } = await readDirectoryEntries(dirPath);
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const pageEntries = entries.slice(safeOffset, safeOffset + TREE_PAGE_SIZE);

  for (const entry of pageEntries) {
    const fullPath = path.join(dirPath, entry.name);

    try {
      const stats = await fs.promises.lstat(fullPath);
      if (stats.isSymbolicLink()) continue;
      const common = {
        name: entry.name,
        path: toPosix(path.relative(rootPath, fullPath)),
        fullPath: toPosix(fullPath)
      };
      if (stats.isDirectory()) {
        children.push({ ...common, type: 'directory', children: null });
      } else if (stats.isFile()) {
        children.push({ ...common, type: 'file', ext: path.extname(entry.name).toLowerCase(), ...fileVersion(stats) });
      }
    } catch (e) {
      skipped.push({ path: toPosix(fullPath), error: e.message });
    }
  }

  return {
    node: {
      name: path.basename(dirPath),
      type: 'directory',
      path: toPosix(path.relative(rootPath, dirPath)),
      fullPath: toPosix(dirPath),
      children,
      pagination: {
        offset: safeOffset,
        limit: TREE_PAGE_SIZE,
        total: entries.length,
        hasMore: safeOffset + pageEntries.length < entries.length,
        nextOffset: safeOffset + pageEntries.length,
        directoryMtimeMs
      }
    },
    skipped
  };
}

app.get('/api/tree', async (req, res) => {
  try {
    const rootDir = resolveRoot(req.query.root);
    const requestedOffset = Number.parseInt(req.query.offset || '0', 10);
    const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    const requestedVersion = Number.parseInt(req.query.version || '', 10);
    const dirPath = req.query.path
      ? assertWithinRoot(rootDir, req.query.path, { type: 'directory' })
      : rootDir;
    if (offset > 0 && Number.isInteger(requestedVersion)) {
      const currentVersion = Math.trunc((await fs.promises.stat(dirPath)).mtimeMs);
      if (Math.abs(currentVersion - requestedVersion) > 1) {
        return res.json({ success: false, code: 'DIRECTORY_CHANGED', error: '目录内容已发生变化，请刷新目录后重试。' });
      }
    }
    const { node, skipped } = await buildDirectoryLevel(dirPath, rootDir, offset);
    if (offset > 0 && Number.isInteger(requestedVersion)
      && Math.abs(node.pagination.directoryMtimeMs - requestedVersion) > 1) {
      return res.json({ success: false, code: 'DIRECTORY_CHANGED', error: '目录内容已发生变化，请刷新目录后重试。' });
    }
    res.json({ success: true, data: node, root: toPosix(rootDir), skipped });
  } catch (e) {
    const code = ['DIRECTORY_CHANGED', 'DIRECTORY_TOO_LARGE'].includes(e.code) ? e.code : undefined;
    res.json({ success: false, code, error: e.message });
  }
});

// ========== API: 音频分段读取 ==========
app.get('/api/media', (req, res) => {
  let fileSize = 0;
  try {
    const rootDir = resolveRoot(req.query.root);
    if (!req.query.path) return res.status(400).end();
    const filePath = assertWithinRoot(rootDir, req.query.path, { type: 'file' });
    const ext = path.extname(filePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return res.status(415).end();

    const stats = fs.statSync(filePath);
    fileSize = stats.size;
    const range = parseAudioRange(req.headers.range, fileSize);
    if (req.headers.range && !range) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, fileSize - 1);
    const contentLength = fileSize === 0 ? 0 : end - start + 1;
    res.set({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': AUDIO_MIME_TYPES[ext],
      'Content-Length': String(contentLength),
      'X-Content-Type-Options': 'nosniff'
    });
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    }
    if (fileSize === 0) return res.end();

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', error => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy(error);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(400).end();
    else res.destroy(e);
  }
});

// ========== API 2: 预览文件内容 ==========
app.get('/api/preview', async (req, res) => {
  try {
    const rootDir = resolveRoot(req.query.root);
    if (!req.query.path) return res.json({ success: false, error: '文件不存在' });
    const filePath = assertWithinRoot(rootDir, req.query.path, { type: 'file' });
    const ext = path.extname(filePath).toLowerCase();
    const fileStats = fs.statSync(filePath);
    const metadata = fileVersion(fileStats);
    const previewKind = getPreviewKind(ext);
    if (ext === '.doc') {
      return res.json({ success: false, error: '暂不支持预览旧版 .doc 文件，请先用 Word 另存为 .docx。', fileName: path.basename(filePath), ...metadata });
    }
    if (!previewKind) return res.json({ success: false, error: `不支持预览此文件类型: ${ext}` });
    const previewLimit = PREVIEW_LIMITS[previewKind];
    if (Number.isFinite(previewLimit) && fileStats.size > previewLimit) {
      return res.json({
        success: false,
        code: 'FILE_TOO_LARGE',
        error: previewLimitMessage(previewKind, fileStats.size, previewLimit),
        type: previewKind,
        fileName: path.basename(filePath),
        limit: previewLimit,
        ...metadata
      });
    }
    if (AUDIO_EXTENSIONS.has(ext)) {
      res.json({
        success: true,
        type: 'audio',
        mimeType: AUDIO_MIME_TYPES[ext],
        format: ext.slice(1).toUpperCase(),
        ...(AUDIO_FORMAT_DETAILS[ext] ? { formatDetails: AUDIO_FORMAT_DETAILS[ext] } : {}),
        fileName: path.basename(filePath),
        ...metadata
      });
    } else if (ext === '.xlsx' || ext === '.xls') {
      const buffer = fs.readFileSync(filePath);
      const { sheets, styledSheets } = renderExcelWorkbook(buffer);
      res.json({
        success: true,
        type: 'excel',
        data: sheets,
        styled: styledSheets,
        fileName: path.basename(filePath),
        ...metadata
      });
    } else if (ext === '.docx') {
      const buf = fs.readFileSync(filePath);
      const zip = await loadOfficeZip(buf, 'Word 文档');
      const base64 = buf.toString('base64');
      const mammothResult = await mammoth.convertToHtml({ buffer: buf }, {
        convertImage: mammoth.images.inline(function(element) {
          return element.read("base64").then(function(imageBuffer) {
            return { src: "data:" + element.contentType + ";base64," + imageBuffer };
          });
        })
      });
      // Extract headings from docx XML for TOC
      const headings = [];
      try {
        const stylesFile = zip.file('word/styles.xml');
        // Build map: styleId -> heading level
        const headingStyles = {};
        if (stylesFile) {
          const stylesXml = await stylesFile.async('string');
          const styleRegex = /<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
          let sm;
          while ((sm = styleRegex.exec(stylesXml)) !== null) {
            const sid = sm[1];
            const content = sm[2];
            // Check outlineLvl
            const olvl = content.match(/<w:outlineLvl\s+w:val="(\d+)"/);
            if (olvl) {
              headingStyles[sid] = parseInt(olvl[1]) + 1; // outlineLvl 0 = Heading 1
            }
            // Also match by name
            const nameMatch = content.match(/<w:name\s+w:val="([^"]+)"/);
            if (nameMatch) {
              const n = nameMatch[1].toLowerCase();
              const hMatch = n.match(/heading\s*(\d)/);
              if (hMatch) headingStyles[sid] = parseInt(hMatch[1]);
              if (n === '标题 1' || n === '标题1') headingStyles[sid] = 1;
              if (n === '标题 2' || n === '标题2') headingStyles[sid] = 2;
              if (n === '标题 3' || n === '标题3') headingStyles[sid] = 3;
              if (n === '标题 4' || n === '标题4') headingStyles[sid] = 4;
            }
          }
        }
        const docXmlFile = zip.file('word/document.xml');
        if (docXmlFile) {
          const docXml = await docXmlFile.async('string');
          const pRegex = /<w:p\b[^/]*?>([\s\S]*?)<\/w:p>/g;
          let pm;
          while ((pm = pRegex.exec(docXml)) !== null) {
            const content = pm[1];
            const pPr = content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
            if (!pPr) continue;
            const pStyle = pPr[1].match(/<w:pStyle\s+w:val="([^"]+)"/);
            if (!pStyle) continue;
            const level = headingStyles[pStyle[1]];
            if (!level || level > 6) continue;
            // Extract text
            let text = '';
            const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
            let tm;
            while ((tm = tRegex.exec(content)) !== null) text += tm[1];
            text = text.trim();
            if (text) headings.push({ level, text });
          }
        }
      } catch(e) { /* ignore heading extraction errors */ }
      res.json({ success: true, type: 'word', data: base64, html: mammothResult.value, headings, fileName: path.basename(filePath), ...metadata });
    } else if (['.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.css', '.js'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.json({ success: true, type: 'text', data: content, fileName: path.basename(filePath), ...metadata });
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      const base64 = fs.readFileSync(filePath).toString('base64');
      const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`;
      res.json({ success: true, type: 'image', data: `data:${mime};base64,${base64}`, fileName: path.basename(filePath), ...metadata });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

function writeSse(res, data) {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

async function collectMatchingFiles(dirPath, matcher, options = {}) {
  const { skipped = [], stats = { scannedFiles: 0, scannedDirectories: 0 }, onProgress, isCancelled } = options;
  const results = [];
  if (isCancelled && isCancelled()) return { files: results, skipped, stats, cancelled: true };

  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    stats.scannedDirectories++;
  } catch (e) {
    skipped.push({ path: toPosix(dirPath), error: e.message });
    return { files: results, skipped, stats, cancelled: false };
  }

  for (const entry of entries) {
    if (isCancelled && isCancelled()) return { files: results, skipped, stats, cancelled: true };
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (path.resolve(fullPath) === path.resolve(__dirname)) continue;
      const nested = await collectMatchingFiles(fullPath, matcher, { skipped, stats, onProgress, isCancelled });
      for (const nestedFile of nested.files) results.push(nestedFile);
      if (nested.cancelled) return { files: results, skipped, stats, cancelled: true };
    } else if (entry.isFile()) {
      stats.scannedFiles++;
      if (onProgress && (stats.scannedFiles === 1 || stats.scannedFiles % 25 === 0)) {
        onProgress({ current: stats.scannedFiles, total: 0, file: entry.name, phase: 'discover' });
      }
      if (matcher(fullPath, entry.name)) results.push(fullPath);
      if (stats.scannedFiles % 50 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }

  return { files: results, skipped, stats, cancelled: false };
}

async function findRevokedAudioFiles(rootDir, options = {}) {
  return collectMatchingFiles(rootDir, (fullPath, name) => {
    return name.includes('撤回') && AUDIO_EXTENSIONS.has(path.extname(fullPath).toLowerCase());
  }, options);
}

function createCancellationState(res) {
  const state = { cancelled: false };
  res.on('close', () => {
    if (!res.writableEnded) state.cancelled = true;
  });
  return state;
}

function createDashboardModuleSummary() {
  return { files: 0, directories: 0, bytes: 0 };
}

function createDashboardModuleBreakdown() {
  return { total: 0, normal: 0, backup: 0, revoked: 0 };
}

function createDashboardAudioSummary() {
  return { total: 0, bytes: 0, body: 0, normalEncore: 0, revokedEncore: 0 };
}

function dashboardModuleForPath(baseModule, name) {
  if (name === '备份文件夹') return 'backup';
  if (name === '撤回文件夹') return 'revoked';
  return baseModule;
}

function dashboardRootModule(rootDir) {
  return path.resolve(rootDir).split(path.sep).reduce((moduleName, segment) => {
    return dashboardModuleForPath(moduleName, segment);
  }, 'normal');
}

function classifyDashboardAudio(name) {
  if (EPISODE_NAME_PATTERN.test(name)) return 'body';
  if (name.includes('撤回')) return 'revokedEncore';
  return 'normalEncore';
}

async function collectDashboardStats(rootDir, options = {}) {
  const { onProgress, isCancelled } = options;
  const modules = {
    normal: createDashboardModuleSummary(),
    backup: createDashboardModuleSummary(),
    revoked: createDashboardModuleSummary()
  };
  const episodes = {
    folders: createDashboardModuleBreakdown(),
    wordDocuments: createDashboardModuleBreakdown()
  };
  const audio = {
    ...createDashboardAudioSummary(),
    modules: {
      normal: createDashboardAudioSummary(),
      backup: createDashboardAudioSummary(),
      revoked: createDashboardAudioSummary()
    }
  };
  const skipped = [];
  const stats = { scannedFiles: 0, scannedDirectories: 0, excludedDirectories: 0 };
  const projectDir = path.resolve(__dirname);
  const samePath = (left, right) => {
    const normalizedLeft = path.resolve(left);
    const normalizedRight = path.resolve(right);
    return process.platform === 'win32'
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  };
  const pending = [{ dirPath: rootDir, moduleName: dashboardRootModule(rootDir) }];

  while (pending.length > 0) {
    if (isCancelled && isCancelled()) return { cancelled: true, modules, episodes, audio, skipped, stats };
    const current = pending.pop();
    let safeDirectory;
    let entries;
    try {
      safeDirectory = assertWithinRoot(rootDir, current.dirPath, { type: 'directory' });
      if (!samePath(safeDirectory, rootDir) && samePath(safeDirectory, projectDir)) {
        stats.excludedDirectories++;
        continue;
      }
      entries = await fs.promises.readdir(safeDirectory, { withFileTypes: true });
      stats.scannedDirectories++;
    } catch (e) {
      skipped.push({ path: toPosix(current.dirPath), error: e.message });
      continue;
    }

    for (const entry of entries) {
      if (isCancelled && isCancelled()) return { cancelled: true, modules, episodes, audio, skipped, stats };
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const fullPath = path.join(safeDirectory, entry.name);

      if (entry.isSymbolicLink()) {
        stats.excludedDirectories++;
        continue;
      }
      if (entry.isDirectory() && (DASHBOARD_SKIPPED_DIRECTORIES.has(entry.name) || samePath(fullPath, projectDir))) {
        stats.excludedDirectories++;
        continue;
      }

      let entryStats;
      try {
        entryStats = await fs.promises.lstat(fullPath);
      } catch (e) {
        skipped.push({ path: toPosix(fullPath), error: e.message });
        continue;
      }
      if (entryStats.isSymbolicLink()) {
        stats.excludedDirectories++;
        continue;
      }

      if (entryStats.isDirectory()) {
        const moduleName = dashboardModuleForPath(current.moduleName, entry.name);
        modules[moduleName].directories++;
        if (EPISODE_NAME_PATTERN.test(entry.name)) {
          episodes.folders.total++;
          episodes.folders[moduleName]++;
        }
        pending.push({ dirPath: fullPath, moduleName });
        continue;
      }
      if (!entryStats.isFile()) continue;

      stats.scannedFiles++;
      modules[current.moduleName].files++;
      modules[current.moduleName].bytes += entryStats.size;
      const ext = path.extname(entry.name).toLowerCase();

      if (WORD_EXTENSIONS.has(ext) && EPISODE_NAME_PATTERN.test(entry.name)) {
        episodes.wordDocuments.total++;
        episodes.wordDocuments[current.moduleName]++;
      }
      if (AUDIO_EXTENSIONS.has(ext)) {
        const category = classifyDashboardAudio(entry.name);
        const moduleAudio = audio.modules[current.moduleName];
        audio.total++;
        audio.bytes += entryStats.size;
        audio[category]++;
        moduleAudio.total++;
        moduleAudio.bytes += entryStats.size;
        moduleAudio[category]++;
      }

      if (onProgress && (stats.scannedFiles === 1 || stats.scannedFiles % 25 === 0)) {
        onProgress({
          current: stats.scannedFiles,
          total: 0,
          file: toPosix(path.relative(rootDir, fullPath)),
          phase: 'discover'
        });
      }
      if (stats.scannedFiles % 50 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }

  return { cancelled: false, modules, episodes, audio, skipped, stats };
}

app.post('/api/dashboard-stats', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const cancellation = createCancellationState(res);

  try {
    const rootDir = resolveRoot(req.body.root);
    const result = await collectDashboardStats(rootDir, {
      isCancelled: () => cancellation.cancelled,
      onProgress: progress => writeSse(res, { type: 'progress', ...progress })
    });
    if (result.cancelled || cancellation.cancelled) return res.end();
    writeSse(res, {
      type: 'done',
      success: true,
      generatedAt: new Date().toISOString(),
      scannedFiles: result.stats.scannedFiles,
      scannedDirectories: result.stats.scannedDirectories,
      excludedDirectories: result.stats.excludedDirectories,
      skipped: result.skipped,
      modules: result.modules,
      episodes: result.episodes,
      audio: result.audio
    });
  } catch (e) {
    writeSse(res, { type: 'done', success: false, error: e.message });
  }
  res.end();
});

app.post('/api/scan-revoked-audio', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const cancellation = createCancellationState(res);

  try {
    const rootDir = resolveRoot(req.body.root);
    const scan = await findRevokedAudioFiles(rootDir, {
      isCancelled: () => cancellation.cancelled,
      onProgress: progress => writeSse(res, { type: 'progress', ...progress })
    });
    if (scan.cancelled || cancellation.cancelled) return res.end();

    const data = [];
    const errors = [];
    for (let i = 0; i < scan.files.length; i++) {
      if (cancellation.cancelled) return res.end();
      const file = scan.files[i];
      writeSse(res, { type: 'progress', phase: 'fingerprint', current: i + 1, total: scan.files.length, file: path.basename(file) });
      try {
        const stats = await fs.promises.stat(file);
        const sha256 = await hashFileSha256(file, () => cancellation.cancelled);
        const latestStats = await fs.promises.stat(file);
        if (latestStats.size !== stats.size
          || Math.abs(Math.trunc(latestStats.mtimeMs) - Math.trunc(stats.mtimeMs)) > 1) {
          errors.push({ file: toPosix(file), error: '文件在扫描期间发生变化，请重新扫描' });
          continue;
        }
        data.push({
          file: toPosix(file),
          relativePath: toPosix(path.relative(rootDir, file)),
          ...fileVersion(latestStats),
          sha256
        });
      } catch (e) {
        if (e.code === 'SCAN_CANCELLED' || cancellation.cancelled) return res.end();
        errors.push({ file: toPosix(file), error: e.message });
      }
      if ((i + 1) % 10 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    writeSse(res, {
      type: 'done',
      success: true,
      data,
      totalScanned: scan.stats.scannedFiles,
      scannedDirectories: scan.stats.scannedDirectories,
      skipped: scan.skipped,
      errors
    });
  } catch (e) {
    writeSse(res, { type: 'done', success: false, error: e.message });
  }
  res.end();
});

function normalizeRequestedItems(body) {
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.files)) return body.files.map(file => ({ file }));
  return [];
}

async function checkCandidateVersion(filePath, candidate, options = {}) {
  const stats = options.stats || await fs.promises.stat(filePath);
  const hasExpectedSize = Number.isFinite(candidate.size);
  const hasExpectedMtime = Number.isFinite(candidate.mtimeMs);
  const hasExpectedHash = hasValidSha256(candidate.sha256);
  if (!hasExpectedSize || !hasExpectedMtime || !hasExpectedHash) {
    return { stats, hasSnapshot: false, changed: false };
  }
  const metadataChanged = (hasExpectedSize && stats.size !== candidate.size)
    || (hasExpectedMtime && Math.abs(Math.trunc(stats.mtimeMs) - Math.trunc(candidate.mtimeMs)) > 1);
  if (metadataChanged || options.metadataOnly) {
    return { stats, hasSnapshot: true, changed: metadataChanged };
  }

  const actualHash = Buffer.isBuffer(options.data)
    ? sha256Buffer(options.data)
    : await hashFileSha256(filePath, options.isCancelled);
  const latestStats = await fs.promises.stat(filePath);
  const changed = actualHash.toLowerCase() !== candidate.sha256.toLowerCase()
    || latestStats.size !== stats.size
    || Math.abs(Math.trunc(latestStats.mtimeMs) - Math.trunc(stats.mtimeMs)) > 1;
  return { stats: latestStats, hasSnapshot: true, changed };
}

app.post('/api/move-revoked', async (req, res) => {
  const finishMutation = beginMutation();
  let releaseTaskLock = null;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    const rootDir = resolveRoot(req.body.root);
    const requestedItems = normalizeRequestedItems(req.body);
    if (requestedItems.length === 0) throw new Error('没有选择需要移动的音频文件');

    const targetDir = assertWithinRoot(rootDir, path.join(rootDir, '撤回文件夹'), { mustExist: false });
    fs.mkdirSync(targetDir, { recursive: true });
    const taskId = createTaskId('audio-move');
    releaseTaskLock = acquireTaskLock(rootDir, taskId);
    const manifest = createTaskManifest(rootDir, taskId, 'move-audio');
    const moved = [];
    const skipped = [];
    const errors = [];
    const warnings = [];
    const seen = new Set();

    for (let i = 0; i < requestedItems.length; i++) {
      const candidate = requestedItems[i] || {};
      const candidateName = typeof candidate.file === 'string' ? candidate.file : '(未知文件)';
      writeSse(res, { type: 'progress', current: i + 1, total: requestedItems.length, file: path.basename(candidateName) });

      let file;
      try {
        file = assertWithinRoot(rootDir, candidate.file, { type: 'file' });
      } catch (e) {
        errors.push({ file: candidateName, error: e.message });
        continue;
      }

      const dedupeKey = process.platform === 'win32' ? file.toLowerCase() : file;
      if (seen.has(dedupeKey)) {
        skipped.push({ file: toPosix(file), reason: '重复选择，已跳过' });
        continue;
      }
      seen.add(dedupeKey);

      const relativePath = toPosix(path.relative(rootDir, file));
      if (!path.basename(file).includes('撤回') || !AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        skipped.push({ file: toPosix(file), reason: '文件不符合撤回音频规则' });
        continue;
      }
      if (relativePath === '撤回文件夹' || relativePath.startsWith('撤回文件夹/')) {
        skipped.push({ file: toPosix(file), reason: '文件已经位于撤回文件夹' });
        continue;
      }

      try {
        const version = await checkCandidateVersion(file, candidate);
        if (!version.hasSnapshot) {
          skipped.push({ file: toPosix(file), reason: '缺少扫描信息，请重新扫描' });
          continue;
        }
        if (version.changed) {
          skipped.push({ file: toPosix(file), reason: '文件在扫描后已发生变化，请重新扫描' });
          continue;
        }
      } catch (e) {
        errors.push({ file: toPosix(file), error: e.message });
        continue;
      }

      const fileName = path.basename(file);
      let destPath = path.join(targetDir, fileName);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        destPath = path.join(targetDir, `${base}_${counter}${ext}`);
        counter++;
      }

      const manifestItem = {
        originalRelativePath: relativePath,
        movedRelativePath: toPosix(path.relative(rootDir, destPath)),
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        sha256: candidate.sha256,
        status: 'moving'
      };
      manifest.items.push(manifestItem);
      try {
        saveTaskManifest(rootDir, manifest);
      } catch (e) {
        manifest.items.pop();
        errors.push({ file: toPosix(file), error: `无法创建撤回记录，未移动文件：${e.message}` });
        continue;
      }

      try {
        const latestVersion = await checkCandidateVersion(file, candidate, { metadataOnly: true });
        if (latestVersion.changed) {
          manifestItem.status = 'changed';
          manifestItem.resolvedAt = new Date().toISOString();
          try { saveTaskManifest(rootDir, manifest); } catch (ignored) {}
          skipped.push({ file: toPosix(file), reason: '文件在等待移动期间发生变化，请重新扫描' });
          continue;
        }
      } catch (e) {
        manifestItem.status = 'failed';
        manifestItem.error = e.message;
        try { saveTaskManifest(rootDir, manifest); } catch (ignored) {}
        errors.push({ file: toPosix(file), error: e.message });
        continue;
      }

      try {
        fs.renameSync(file, destPath);
      } catch (e) {
        manifestItem.status = 'failed';
        manifestItem.error = e.message;
        try { saveTaskManifest(rootDir, manifest); } catch (ignored) {}
        errors.push({ file: toPosix(file), error: e.message });
        continue;
      }

      manifestItem.status = 'moved';
      manifestItem.movedAt = new Date().toISOString();
      moved.push({ from: toPosix(file), to: toPosix(destPath) });
      try {
        saveTaskManifest(rootDir, manifest);
      } catch (e) {
        warnings.push({ file: toPosix(destPath), reason: `文件已移动，撤回记录状态更新失败；系统仍会按实际位置尝试撤回：${e.message}` });
      }
    }

    if (moved.length > 0) {
      const logWarning = tryWriteLog(rootDir, '移动撤回音频', `任务 ${taskId}，移动 ${moved.length} 个音频到撤回文件夹` + moved.map(item => `\n  ${item.from} → ${item.to}`).join(''));
      if (logWarning) warnings.push({ file: '操作日志', reason: logWarning });
    } else {
      removeTaskDirectory(rootDir, taskId);
    }
    if (skipped.length > 0) {
      const logWarning = tryWriteLog(rootDir, '移动撤回音频-跳过', skipped.map(item => `${item.file}: ${item.reason}`).join('; '));
      if (logWarning && !warnings.some(item => item.reason === logWarning)) warnings.push({ file: '操作日志', reason: logWarning });
    }
    if (errors.length > 0) {
      const logWarning = tryWriteLog(rootDir, '移动撤回音频-失败', errors.map(item => `${item.file}: ${item.error}`).join('; '));
      if (logWarning && !warnings.some(item => item.reason === logWarning)) warnings.push({ file: '操作日志', reason: logWarning });
    }
    if (warnings.length > 0) {
      tryWriteLog(rootDir, '移动撤回音频-警告', warnings.map(item => `${item.file}: ${item.reason}`).join('; '));
    }

    writeSse(res, {
      type: 'done',
      success: true,
      moved,
      skipped,
      errors,
      warnings,
      taskId,
      restorable: moved.length > 0,
      targetDir: toPosix(targetDir),
      summary: { success: moved.length, skipped: skipped.length, failed: errors.length }
    });
  } catch (e) {
    writeSse(res, { type: 'done', success: false, error: e.message });
  } finally {
    if (releaseTaskLock) releaseTaskLock();
    finishMutation();
    res.end();
  }
});

async function findWordFiles(rootDir, options = {}) {
  return collectMatchingFiles(rootDir, (fullPath, name) => {
    return path.extname(name).toLowerCase() === '.docx';
  }, options);
}

async function checkWordForKeywords(filePath, options = {}) {
  const stats = await fs.promises.stat(filePath);
  if (stats.size > PREVIEW_LIMITS.word) {
    throw new Error(previewLimitMessage('word', stats.size, PREVIEW_LIMITS.word));
  }
  const data = await fs.promises.readFile(filePath);
  if (options.isCancelled && options.isCancelled()) {
    const error = new Error('扫描已取消');
    error.code = 'SCAN_CANCELLED';
    throw error;
  }
  const latestStats = await fs.promises.stat(filePath);
  if (latestStats.size !== stats.size
    || Math.abs(Math.trunc(latestStats.mtimeMs) - Math.trunc(stats.mtimeMs)) > 1) {
    throw new FileChangedError('文件在扫描期间发生变化，请重新扫描');
  }
  await loadOfficeZip(data, 'Word 文档');
  const result = await mammoth.extractRawText({ buffer: data });
  const lines = result.value.split('\n');
  const matchedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('返场故事') && line.includes('撤回')) {
      matchedLines.push({ lineNumber: i + 1, content: line.trim() });
    }
  }
  return matchedLines.length > 0
    ? { file: filePath, matchedLines, ...fileVersion(latestStats), sha256: sha256Buffer(data) }
    : null;
}

app.post('/api/find-keywords', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const cancellation = createCancellationState(res);

  try {
    const rootDir = resolveRoot(req.body.root);
    const scan = await findWordFiles(rootDir, {
      isCancelled: () => cancellation.cancelled,
      onProgress: progress => writeSse(res, { type: 'progress', ...progress })
    });
    if (scan.cancelled || cancellation.cancelled) return res.end();
    const wordFiles = scan.files;
    const results = [];
    const errors = [];

    for (let i = 0; i < wordFiles.length; i++) {
      if (cancellation.cancelled) return res.end();
      const file = wordFiles[i];
      writeSse(res, { type: 'progress', phase: 'inspect', current: i + 1, total: wordFiles.length, file: path.basename(file) });
      try {
        const match = await checkWordForKeywords(file, { isCancelled: () => cancellation.cancelled });
        if (match) {
          match.file = toPosix(match.file);
          match.relativePath = toPosix(path.relative(rootDir, file));
          results.push(match);
        }
      } catch (e) {
        if (e.code === 'SCAN_CANCELLED' || cancellation.cancelled) return res.end();
        errors.push({ file: toPosix(file), error: e.message });
      }
    }

    writeSse(res, {
      type: 'done',
      success: true,
      data: results,
      totalScanned: wordFiles.length,
      totalFilesVisited: scan.stats.scannedFiles,
      scannedDirectories: scan.stats.scannedDirectories,
      skipped: scan.skipped,
      errors
    });
  } catch (e) {
    writeSse(res, { type: 'done', success: false, error: e.message });
  }
  res.end();
});

async function validateDocxBuffer(buffer) {
  const zip = await loadOfficeZip(buffer, 'Word 文档');
  if (!zip.file('word/document.xml')) throw new Error('Word 文档缺少 document.xml');
  await mammoth.extractRawText({ buffer });
}

async function replaceFileSafely(filePath, newData, token, expectedData = undefined) {
  const tempPath = `${filePath}.ming-story-${token}.tmp`;
  const rollbackPath = `${filePath}.ming-story-${token}.original`;
  let originalMoved = false;
  let replacementInstalled = false;
  let cleanupWarning = '';
  let operationError = null;
  let rollbackError = null;
  fs.writeFileSync(tempPath, newData);

  try {
    await validateDocxBuffer(fs.readFileSync(tempPath));
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, rollbackPath);
      originalMoved = true;
      if (expectedData === null || (Buffer.isBuffer(expectedData) && !fs.readFileSync(rollbackPath).equals(expectedData))) {
        operationError = new FileChangedError();
        try {
          fs.renameSync(rollbackPath, filePath);
          originalMoved = false;
        } catch (e) {}
        throw operationError;
      }
    } else if (Buffer.isBuffer(expectedData)) {
      throw new FileChangedError('文件在处理期间被移动或删除，请重新扫描');
    }
    fs.renameSync(tempPath, filePath);
    replacementInstalled = true;

    if (originalMoved && fs.existsSync(rollbackPath)) {
      try {
        fs.unlinkSync(rollbackPath);
        originalMoved = false;
      } catch (e) {
        cleanupWarning = `临时原文件未能自动删除：${rollbackPath}（${e.message}）`;
      }
    }
  } catch (e) {
    if (!operationError) operationError = e;
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
    if (!replacementInstalled && originalMoved) {
      if (!fs.existsSync(rollbackPath)) {
        rollbackError = new Error('临时原文件已不存在，无法自动回滚');
      } else if (fs.existsSync(filePath)) {
        rollbackError = new Error('原位置出现了其他文件，系统未覆盖该文件');
      } else {
        try {
          fs.renameSync(rollbackPath, filePath);
          originalMoved = false;
        } catch (e) {
          rollbackError = e;
        }
      }
    }
  }

  if (rollbackError) {
    const rollbackAvailable = fs.existsSync(rollbackPath);
    const rollbackDescription = rollbackAvailable
      ? `临时原文件：${rollbackPath}`
      : `临时原文件已不存在：${rollbackPath}`;
    const recoveryError = new Error(`新文件安装失败，原文件也未能自动放回。备份任务已保留，请使用“恢复本次修改”。${rollbackDescription}（${rollbackError.message}）`);
    recoveryError.code = 'ROLLBACK_FAILED';
    if (rollbackAvailable) recoveryError.recoveryPath = rollbackPath;
    throw recoveryError;
  }
  if (operationError) throw operationError;
  return { cleanupWarning };
}

function saveTaskManifest(rootDir, manifest) {
  const taskId = normalizeTaskId(manifest.taskId);
  const taskDir = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', taskId), { mustExist: false });
  fs.mkdirSync(taskDir, { recursive: true });
  const manifestPath = assertWithinRoot(rootDir, path.join(taskDir, 'manifest.json'), { mustExist: false });
  const tempPath = assertWithinRoot(rootDir, path.join(taskDir, `.manifest-${process.pid}-${crypto.randomBytes(3).toString('hex')}.tmp`), { mustExist: false });
  try {
    fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tempPath, manifestPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  return manifest;
}

function createTaskManifest(rootDir, taskId, type, items = []) {
  return saveTaskManifest(rootDir, {
    version: 2,
    taskId,
    type,
    createdAt: new Date().toISOString(),
    items
  });
}

function removeTaskDirectory(rootDir, taskId) {
  try {
    const taskDir = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', normalizeTaskId(taskId)), { type: 'directory' });
    fs.rmSync(taskDir, { recursive: true, force: true });
  } catch (e) {}
}

async function removeContentFromLine(filePath, rootDir, taskId, candidate, onBackupReady) {
  const stats = fs.statSync(filePath);
  if (stats.size > PREVIEW_LIMITS.word) {
    throw new Error(previewLimitMessage('word', stats.size, PREVIEW_LIMITS.word));
  }
  const data = fs.readFileSync(filePath);
  const scannedVersion = await checkCandidateVersion(filePath, candidate, { stats, data });
  if (!scannedVersion.hasSnapshot) {
    return { modified: false, skipped: true, reason: '缺少完整扫描信息，请重新扫描' };
  }
  if (scannedVersion.changed) {
    return { modified: false, skipped: true, reason: '文件在扫描后已发生变化，请重新扫描' };
  }
  const zip = await loadOfficeZip(data, 'Word 文档');
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('Word 文档结构不完整');
  const documentXml = await documentFile.async('string');

  const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const paragraphs = [];
  let match;
  while ((match = paragraphRegex.exec(documentXml)) !== null) {
    paragraphs.push({ text: match[0], index: match.index, length: match[0].length });
  }

  function extractText(pXml) {
    const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let text = '';
    let textMatch;
    while ((textMatch = textRegex.exec(pXml)) !== null) text += textMatch[1];
    return text;
  }

  const targetIdx = paragraphs.findIndex(paragraph => {
    const text = extractText(paragraph.text);
    return text.includes('返场故事') && text.includes('撤回');
  });
  if (targetIdx === -1) return { modified: false, reason: '文件内容已变化，未找到匹配段落' };

  const startPos = paragraphs[targetIdx].index;
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const endPos = lastParagraph.index + lastParagraph.length;
  zip.file('word/document.xml', documentXml.substring(0, startPos) + documentXml.substring(endPos));
  const newData = await zip.generateAsync({ type: 'nodebuffer' });

  if (!fs.readFileSync(filePath).equals(data)) {
    return { modified: false, skipped: true, reason: '文件在处理期间发生变化，请重新扫描' };
  }

  const relativePath = path.relative(rootDir, filePath);
  const backupPath = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', taskId, 'files', relativePath), { mustExist: false });
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, data);

  const manifestItem = {
    originalRelativePath: toPosix(relativePath),
    backupRelativePath: toPosix(path.relative(rootDir, backupPath)),
    removedParagraphs: paragraphs.length - targetIdx,
    status: 'backup-ready'
  };
  if (onBackupReady) onBackupReady(manifestItem);

  const replacement = await replaceFileSafely(filePath, newData, taskId, data);
  return {
    modified: true,
    removedParagraphs: paragraphs.length - targetIdx,
    backupPath: toPosix(backupPath),
    manifestItem,
    warning: replacement.cleanupWarning
  };
}

app.post('/api/remove-content', async (req, res) => {
  const finishMutation = beginMutation();
  let releaseTaskLock = null;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    const rootDir = resolveRoot(req.body.root);
    const requestedItems = normalizeRequestedItems(req.body);
    if (requestedItems.length === 0) throw new Error('没有选择需要处理的 Word 文档');

    const taskId = createTaskId('word-remove');
    const results = [];
    const warnings = [];
    const targetFiles = [];
    const seen = new Set();

    for (const candidate of requestedItems) {
      const candidateName = candidate && typeof candidate.file === 'string' ? candidate.file : '(未知文件)';
      let file;
      try {
        file = assertWithinRoot(rootDir, candidate.file, { type: 'file' });
      } catch (e) {
        results.push({ file: candidateName, modified: false, error: e.message });
        continue;
      }

      const dedupeKey = process.platform === 'win32' ? file.toLowerCase() : file;
      if (seen.has(dedupeKey)) {
        results.push({ file: toPosix(file), modified: false, skipped: true, reason: '重复选择，已跳过' });
        continue;
      }
      seen.add(dedupeKey);

      if (path.extname(file).toLowerCase() !== '.docx') {
        results.push({ file: toPosix(file), modified: false, skipped: true, reason: '仅支持处理 .docx 文档' });
        continue;
      }

      try {
        const version = await checkCandidateVersion(file, candidate, { metadataOnly: true });
        if (!version.hasSnapshot) {
          results.push({ file: toPosix(file), modified: false, skipped: true, reason: '缺少扫描信息，请重新扫描' });
          continue;
        }
        if (version.changed) {
          results.push({ file: toPosix(file), modified: false, skipped: true, reason: '文件在扫描后已发生变化，请重新扫描' });
          continue;
        }
      } catch (e) {
        results.push({ file: toPosix(file), modified: false, error: e.message });
        continue;
      }
      targetFiles.push({ file, candidate });
    }

    if (targetFiles.length > 0) releaseTaskLock = acquireTaskLock(rootDir, taskId);
    const manifest = targetFiles.length > 0 ? createTaskManifest(rootDir, taskId, 'remove-content') : null;
    for (let i = 0; i < targetFiles.length; i++) {
      const { file, candidate } = targetFiles[i];
      let recordedManifestItem = null;
      writeSse(res, { type: 'progress', phase: 'process', current: i + 1, total: targetFiles.length, file: path.basename(file) });
      try {
        const latestVersion = await checkCandidateVersion(file, candidate, { metadataOnly: true });
        if (latestVersion.changed) {
          results.push({ file: toPosix(file), modified: false, skipped: true, reason: '文件在等待处理期间已发生变化，请重新扫描' });
          continue;
        }
        const result = await removeContentFromLine(file, rootDir, taskId, candidate, manifestItem => {
          recordedManifestItem = manifestItem;
          manifest.items.push(manifestItem);
          try {
            saveTaskManifest(rootDir, manifest);
          } catch (e) {
            manifest.items.pop();
            throw e;
          }
        });
        let warning = result.warning || '';
        if (result.manifestItem) {
          result.manifestItem.status = 'modified';
          result.manifestItem.modifiedAt = new Date().toISOString();
          try {
            saveTaskManifest(rootDir, manifest);
          } catch (e) {
            warning = `文档已修改且备份可用，但任务状态更新失败：${e.message}`;
          }
        }
        delete result.manifestItem;
        results.push({ file: toPosix(file), ...result, warning });
      } catch (e) {
        if (recordedManifestItem && manifest.items.includes(recordedManifestItem)) {
          recordedManifestItem.status = e.code === 'FILE_CHANGED'
            ? 'changed'
            : e.code === 'ROLLBACK_FAILED' ? 'recovery-required' : 'failed';
          recordedManifestItem.error = e.message;
          if (e.recoveryPath) {
            recordedManifestItem.recoveryRelativePath = toPosix(path.relative(rootDir, e.recoveryPath));
          }
          try { saveTaskManifest(rootDir, manifest); } catch (ignored) {}
        }
        if (e.code === 'FILE_CHANGED') {
          results.push({ file: toPosix(file), modified: false, skipped: true, reason: e.message });
        } else {
          results.push({ file: toPosix(file), modified: false, error: e.message });
        }
      }
    }

    const modified = results.filter(item => item.modified);
    const skipped = results.filter(item => !item.modified && (item.skipped || item.reason) && !item.error);
    const failed = results.filter(item => !item.modified && item.error);
    const recoveryRequired = manifest ? manifest.items.filter(item => item.status === 'recovery-required') : [];
    if (manifest && manifest.items.every(item => ['failed', 'changed'].includes(item.status))) removeTaskDirectory(rootDir, taskId);
    if (modified.length > 0) {
      const logWarning = tryWriteLog(rootDir, '删除返场故事内容', `任务 ${taskId}，处理 ${modified.length} 个文件` + modified.map(item => `\n  ${item.file} - 删除${item.removedParagraphs}段, 备份:${item.backupPath}`).join(''));
      if (logWarning) warnings.push(logWarning);
    }
    if (failed.length > 0) {
      const logWarning = tryWriteLog(rootDir, '删除返场故事内容-失败', failed.map(item => `${item.file}: ${item.error}`).join('; '));
      if (logWarning && !warnings.includes(logWarning)) warnings.push(logWarning);
    }
    if (skipped.length > 0) {
      const logWarning = tryWriteLog(rootDir, '删除返场故事内容-跳过', skipped.map(item => `${item.file}: ${item.reason}`).join('; '));
      if (logWarning && !warnings.includes(logWarning)) warnings.push(logWarning);
    }

    writeSse(res, {
      type: 'done',
      success: true,
      data: results,
      warnings,
      taskId,
      restorable: modified.length > 0 || recoveryRequired.length > 0,
      summary: { success: modified.length, skipped: skipped.length, failed: failed.length }
    });
  } catch (e) {
    writeSse(res, { type: 'done', success: false, error: e.message });
  } finally {
    if (releaseTaskLock) releaseTaskLock();
    finishMutation();
    res.end();
  }
});

async function restoreWordTask(rootDir, taskId, manifest) {
  const restoreTaskId = createTaskId('before-restore');
  const releaseRestoreTaskLock = acquireTaskLock(rootDir, restoreTaskId);
  let restoreManifest = null;
  const results = [];

  try {

  for (const item of manifest.items) {
    if (['failed', 'changed'].includes(item.status)) continue;
    if (item.restoredAt) {
      results.push({ file: item.originalRelativePath, restored: false, skipped: true, reason: '该文件已经恢复过' });
      continue;
    }
    let restoreItem = null;
    try {
      const originalPath = assertWithinRoot(rootDir, path.join(rootDir, item.originalRelativePath), { mustExist: false });
      const wasRecoveryRequired = item.status === 'recovery-required';
      const backupPath = assertWithinRoot(rootDir, path.join(rootDir, item.backupRelativePath), { type: 'file' });
      const backupData = fs.readFileSync(backupPath);
      await validateDocxBuffer(backupData);

      let currentData = null;
      if (fs.existsSync(originalPath)) {
        currentData = fs.readFileSync(originalPath);
        if (!restoreManifest) restoreManifest = createTaskManifest(rootDir, restoreTaskId, 'before-restore');
        const currentBackup = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', restoreTaskId, 'files', item.originalRelativePath), { mustExist: false });
        fs.mkdirSync(path.dirname(currentBackup), { recursive: true });
        fs.writeFileSync(currentBackup, currentData);
        restoreItem = {
          originalRelativePath: item.originalRelativePath,
          backupRelativePath: toPosix(path.relative(rootDir, currentBackup)),
          status: 'modified'
        };
        restoreManifest.items.push(restoreItem);
        try {
          saveTaskManifest(rootDir, restoreManifest);
        } catch (e) {
          restoreManifest.items.pop();
          throw new Error(`无法记录恢复前版本，未覆盖当前文件：${e.message}`);
        }
      } else {
        fs.mkdirSync(path.dirname(originalPath), { recursive: true });
      }

      const replacement = await replaceFileSafely(originalPath, backupData, restoreTaskId, currentData);
      let warning = replacement.cleanupWarning || '';
      if (wasRecoveryRequired) {
        const recoveryPath = assertWithinRoot(rootDir, `${originalPath}.ming-story-${taskId}.original`, { mustExist: false });
        try {
          if (fs.existsSync(recoveryPath)) fs.unlinkSync(recoveryPath);
          delete item.recoveryRelativePath;
        } catch (e) {
          const cleanupMessage = `文件已恢复，但临时原文件未能删除：${recoveryPath}（${e.message}）`;
          warning = warning ? `${warning}；${cleanupMessage}` : cleanupMessage;
        }
      }
      item.restoredAt = new Date().toISOString();
      item.status = 'restored';
      try {
        saveTaskManifest(rootDir, manifest);
      } catch (e) {
        const manifestMessage = `文件已恢复，但任务状态更新失败：${e.message}`;
        warning = warning ? `${warning}；${manifestMessage}` : manifestMessage;
      }
      results.push({ file: toPosix(originalPath), restored: true, warning });
    } catch (e) {
      if (e.code === 'FILE_CHANGED') {
        if (restoreItem && restoreManifest) {
          restoreItem.status = 'changed';
          restoreItem.error = e.message;
          try { saveTaskManifest(rootDir, restoreManifest); } catch (ignored) {}
        }
        results.push({ file: item.originalRelativePath, restored: false, skipped: true, reason: e.message });
      } else {
        results.push({ file: item.originalRelativePath, restored: false, error: e.message });
      }
    }
  }

  if (restoreManifest && restoreManifest.items.every(item => ['failed', 'changed'].includes(item.status))) {
    removeTaskDirectory(rootDir, restoreTaskId);
    restoreManifest = null;
  }
  manifest.lastRestoreAt = new Date().toISOString();
  try { saveTaskManifest(rootDir, manifest); } catch (e) {}
  const restoredCount = results.filter(item => item.restored).length;
  const skippedCount = results.filter(item => item.skipped).length;
  const failedCount = results.filter(item => !item.restored && !item.skipped).length;
  const logWarning = tryWriteLog(rootDir, '恢复文档备份', `恢复任务 ${taskId}，成功 ${restoredCount}，跳过 ${skippedCount}，失败 ${failedCount}${restoreManifest ? `，恢复前版本备份任务 ${restoreTaskId}` : ''}`);
  return {
    data: results,
    restoredCount,
    restoreTaskId: restoreManifest ? restoreTaskId : null,
    taskType: manifest.type,
    warning: logWarning,
    summary: { success: restoredCount, skipped: skippedCount, failed: failedCount }
  };
  } finally {
    releaseRestoreTaskLock();
  }
}

async function restoreAudioTask(rootDir, taskId, manifest) {
  const results = [];
  for (const item of manifest.items) {
    if (item.restoredAt) continue;
    if (['failed', 'not-moved', 'missing', 'changed'].includes(item.status)) continue;
    const originalLabel = item.originalRelativePath || '(未知原路径)';
    try {
      const originalPath = assertWithinRoot(rootDir, path.join(rootDir, item.originalRelativePath), { mustExist: false });
      const movedPath = assertWithinRoot(rootDir, path.join(rootDir, item.movedRelativePath), { mustExist: false });
      if (!fs.existsSync(movedPath)) {
        item.status = fs.existsSync(originalPath) ? 'not-moved' : 'missing';
        item.resolvedAt = new Date().toISOString();
        results.push({ file: toPosix(movedPath), restored: false, skipped: true, reason: fs.existsSync(originalPath) ? '文件已在原位置，无需重复撤回' : '撤回文件不存在，可能已被移动或删除' });
        continue;
      }
      const version = await checkCandidateVersion(movedPath, item);
      if (version.hasSnapshot && version.changed) {
        item.status = 'changed';
        item.resolvedAt = new Date().toISOString();
        results.push({ file: toPosix(movedPath), restored: false, skipped: true, reason: '整理后的文件已发生变化，为避免移动错误文件，请手动确认' });
        continue;
      }
      if (fs.existsSync(originalPath)) {
        results.push({ file: toPosix(originalPath), restored: false, skipped: true, reason: '原位置已有同名文件，未覆盖' });
        continue;
      }
      fs.mkdirSync(path.dirname(originalPath), { recursive: true });
      fs.renameSync(movedPath, originalPath);
      item.restoredAt = new Date().toISOString();
      item.status = 'restored';
      let warning = '';
      try {
        saveTaskManifest(rootDir, manifest);
      } catch (e) {
        warning = `文件已撤回，但任务状态更新失败：${e.message}`;
      }
      results.push({ file: toPosix(originalPath), restored: true, from: toPosix(movedPath), warning });
    } catch (e) {
      results.push({ file: originalLabel, restored: false, error: e.message });
    }
  }

  manifest.lastRestoreAt = new Date().toISOString();
  let manifestWarning = '';
  try {
    saveTaskManifest(rootDir, manifest);
  } catch (e) {
    manifestWarning = `部分任务状态未能更新：${e.message}`;
  }
  const restoredCount = results.filter(item => item.restored).length;
  const skippedCount = results.filter(item => item.skipped).length;
  const failedCount = results.filter(item => !item.restored && !item.skipped).length;
  const logWarning = tryWriteLog(rootDir, '撤回音频整理', `恢复任务 ${taskId}，成功 ${restoredCount}，跳过 ${skippedCount}，失败 ${failedCount}`);
  return {
    data: results,
    restoredCount,
    taskType: 'move-audio',
    warning: [manifestWarning, logWarning].filter(Boolean).join('；'),
    summary: { success: restoredCount, skipped: skippedCount, failed: failedCount }
  };
}

app.post('/api/restore-task', async (req, res) => {
  const finishMutation = beginMutation();
  let releaseTaskLock = null;
  try {
    const rootDir = resolveRoot(req.body.root);
    const taskId = normalizeTaskId(req.body.taskId);
    releaseTaskLock = acquireTaskLock(rootDir, taskId);
    const manifestPath = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', taskId, 'manifest.json'), { type: 'file' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.items)) throw new Error('恢复任务记录不完整');
    if (manifest.taskId !== taskId) throw new Error('恢复任务编号不匹配');

    let result;
    if (manifest.type === 'remove-content' || manifest.type === 'before-restore') {
      result = await restoreWordTask(rootDir, taskId, manifest);
    } else if (manifest.type === 'move-audio') {
      result = await restoreAudioTask(rootDir, taskId, manifest);
    } else {
      throw new Error('该任务不能恢复');
    }
    res.json({ success: true, ...result });
  } catch (e) {
    res.json({ success: false, code: e.code, error: e.message });
  } finally {
    if (releaseTaskLock) releaseTaskLock();
    finishMutation();
  }
});

app.get('/api/backups', (req, res) => {
  try {
    const rootDir = resolveRoot(req.query.root);
    const backupDir = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹'), { mustExist: false });
    if (!fs.existsSync(backupDir)) return res.json({ success: true, data: [] });
    const data = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, entry.name, 'manifest.json'), 'utf8'));
          if (!Array.isArray(manifest.items)) return null;
          const taskId = normalizeTaskId(manifest.taskId);
          if (taskId !== entry.name || typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) return null;
          if (isTaskLocked(rootDir, taskId)) return null;
          if (manifest.type === 'remove-content' || manifest.type === 'before-restore') {
            const pendingCount = manifest.items.filter(item => !item.restoredAt && !['failed', 'changed'].includes(item.status)).length;
            return pendingCount > 0
              ? { taskId, type: manifest.type, createdAt: manifest.createdAt, count: pendingCount }
              : null;
          }
          if (manifest.type === 'move-audio') {
            const pendingCount = manifest.items.filter(item => !item.restoredAt && !['failed', 'not-moved', 'missing', 'changed'].includes(item.status)).length;
            return pendingCount > 0
              ? { taskId, type: manifest.type, createdAt: manifest.createdAt, count: pendingCount }
              : null;
          }
          return null;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

let serverInstance = null;
let shutdownStarted = false;

function writeServerState(port) {
  const state = {
    pid: process.pid,
    port,
    host: HOST,
    nodePath: process.execPath,
    serverPath: __filename,
    projectDir: __dirname,
    shutdownToken: SHUTDOWN_TOKEN,
    startedAt: new Date().toISOString()
  };
  const tempPath = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, STATE_FILE);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
  }
}

function cleanupServerState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.pid === process.pid) fs.unlinkSync(STATE_FILE);
  } catch (e) {
    // State cleanup must not prevent shutdown.
  }
}

function writeStartupError(error) {
  try {
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] 服务错误：${error.stack || error.message || error}\n`, 'utf8');
  } catch (e) {}
}

function listenOnAvailablePort(port = START_PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('listening', () => {
      try {
        writeServerState(port);
        serverInstance = server;
        console.log(`文件管理系统已启动: http://${HOST}:${port}`);
        console.log(`管理目录: ${DEFAULT_ROOT}`);
        resolve({ server, port });
      } catch (error) {
        server.close(() => reject(error));
      }
    });
    server.once('error', error => {
      if (error.code === 'EADDRINUSE' && port < MAX_PORT) {
        resolve(listenOnAvailablePort(port + 1));
      } else {
        reject(error);
      }
    });
  });
}

function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (!serverInstance) return process.exit(0);
  serverInstance.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanupServerState);

if (require.main === module) {
  listenOnAvailablePort().catch(error => {
    cleanupServerState();
    writeStartupError(error);
    console.error(`服务启动失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { app, listenOnAvailablePort, resolveRoot, assertWithinRoot, replaceFileSafely };
