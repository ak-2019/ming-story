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
const parsedMaxPort = Number.parseInt(process.env.MAX_PORT || String(START_PORT + 10), 10);
const MAX_PORT = Number.isInteger(parsedMaxPort) && parsedMaxPort >= START_PORT && parsedMaxPort < 65536 ? parsedMaxPort : START_PORT + 10;
const STATE_FILE = process.env.FILE_MANAGER_STATE_FILE || path.join(__dirname, '.file-manager-state.json');
const SHUTDOWN_TOKEN = crypto.randomBytes(24).toString('hex');

// 默认根目录：当前文件夹的上级目录
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '撤回文件夹', '备份文件夹', '操作日志']);

app.use(express.json({ limit: '1mb' }));
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
  const checkedTarget = targetExists ? fs.realpathSync(resolvedTarget) : resolvedTarget;
  const relative = path.relative(realRoot, checkedTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
  res.json({ success: true });
  setImmediate(shutdown);
});

// ========== 操作日志 ==========
function writeLog(rootDir, action, details) {
  const logDir = path.join(rootDir, '操作日志');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  const logFile = path.join(logDir, `${dateStr}.log`);
  const line = `[${timeStr}] [${action}] ${details}\n`;
  fs.appendFileSync(logFile, line, 'utf8');
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
    const content = fs.readFileSync(logFile, 'utf8');
    res.json({ success: true, content, filename: req.params.filename });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== API 1: 递归获取目录树 ==========
function buildTree(dirPath, rootPath) {
  const stats = fs.lstatSync(dirPath);
  if (stats.isSymbolicLink()) return null;
  const name = path.basename(dirPath);
  const relativePath = path.relative(rootPath, dirPath).replace(/\\/g, '/');

  if (stats.isFile()) {
    return {
      name,
      type: 'file',
      path: relativePath,
      fullPath: dirPath.replace(/\\/g, '/'),
      size: stats.size,
      ext: path.extname(name).toLowerCase(),
      mtime: stats.mtime
    };
  }

  let children = [];
  try {
    const entries = fs.readdirSync(dirPath);
    children = entries
      .filter(entry => {
        // 跳过隐藏文件、临时文件
        if (entry.startsWith('.') || entry.startsWith('~$')) return false;
        if (entry === 'node_modules') return false;
        // 跳过项目自身所在目录
        const fullPath = path.join(dirPath, entry);
        try {
          if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
        } catch (e) {
          return false;
        }
        if (path.resolve(fullPath) === path.resolve(__dirname)) return false;
        return true;
      })
      .map(entry => {
        try {
          return buildTree(path.join(dirPath, entry), rootPath);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => {
        // 文件夹在前，文件在后
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  } catch (e) {
    // 无权限访问
  }

  return {
    name,
    type: 'directory',
    path: relativePath,
    fullPath: dirPath.replace(/\\/g, '/'),
    children
  };
}

app.get('/api/tree', (req, res) => {
  try {
    const rootDir = resolveRoot(req.query.root);
    const tree = buildTree(rootDir, rootDir);
    res.json({ success: true, data: tree, root: toPosix(rootDir) });
  } catch (e) {
    res.json({ success: false, error: e.message });
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
    const metadata = { size: fileStats.size, mtime: fileStats.mtime };
    if (ext === '.xlsx' || ext === '.xls') {
      const buf = fs.readFileSync(filePath);
      const workbook = XLSX.read(buf, { type: 'buffer', cellStyles: true, cellNF: true, cellDates: true });
      const sheets = {};
      const styledSheets = {};

      // Column letter helper (A, B, ..., Z, AA, AB, ...)
      function colLabel(c) {
        let s = '';
        let n = c;
        while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
        return s;
      }

      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
        const merges = sheet['!merges'] || [];

        // Build merge lookup
        const skipMap = {};
        const mergeMap = {};
        merges.forEach(m => {
          const rs = m.e.r - m.s.r + 1;
          const cs = m.e.c - m.s.c + 1;
          mergeMap[m.s.r + '_' + m.s.c] = { rowspan: rs, colspan: cs };
          for (let r = m.s.r; r <= m.e.r; r++) {
            for (let c = m.s.c; c <= m.e.c; c++) {
              if (r !== m.s.r || c !== m.s.c) {
                if (!skipMap[r]) skipMap[r] = {};
                skipMap[r][c] = true;
              }
            }
          }
        });

        // Column widths
        const colWidths = {};
        if (sheet['!cols']) {
          sheet['!cols'].forEach((col, i) => {
            if (col && col.wpx) colWidths[i] = col.wpx;
            else if (col && col.wch) colWidths[i] = Math.round(col.wch * 7.5);
          });
        }

        // Helper: extract cell value
        function getCellVal(cell) {
          if (!cell) return '';
          if (cell.t === 'd' && cell.v instanceof Date) {
            const d = cell.v;
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          } else if (cell.t === 'n' && cell.v != null && XLSX.SSF) {
            const fmt = (cell.z || '').toLowerCase();
            if (fmt && (fmt.includes('y') || fmt.includes('m') || fmt.includes('d') || fmt.includes('日') || fmt.includes('年'))) {
              try {
                const dateObj = XLSX.SSF.parse_date_code(cell.v);
                if (dateObj && dateObj.y > 1899) {
                  return dateObj.y + '-' + String(dateObj.m).padStart(2,'0') + '-' + String(dateObj.d).padStart(2,'0');
                }
              } catch(e) {}
            }
            return cell.w || String(cell.v);
          }
          return cell.w || (cell.v != null ? String(cell.v) : '');
        }

        // Helper: build inline style from cell.s
        function buildCellStyle(cell) {
          if (!cell || !cell.s) return '';
          const s = cell.s;
          const parts = [];
          // Alignment
          if (s.alignment) {
            const h = s.alignment.horizontal;
            if (h === 'center') parts.push('text-align:center');
            else if (h === 'right') parts.push('text-align:right');
            else if (h === 'left') parts.push('text-align:left');
            const v = s.alignment.vertical;
            if (v === 'center') parts.push('vertical-align:middle');
            else if (v === 'top') parts.push('vertical-align:top');
            else if (v === 'bottom') parts.push('vertical-align:bottom');
            if (s.alignment.wrapText) parts.push('white-space:normal;word-wrap:break-word');
          }
          // Font
          if (s.font) {
            if (s.font.bold) parts.push('font-weight:bold');
            if (s.font.italic) parts.push('font-style:italic');
            if (s.font.underline) parts.push('text-decoration:underline');
            if (s.font.sz) parts.push('font-size:' + s.font.sz + 'pt');
            if (s.font.name) parts.push("font-family:'" + s.font.name + "'");
            if (s.font.color) {
              if (s.font.color.rgb) parts.push('color:#' + s.font.color.rgb.slice(-6));
              else if (s.font.color.theme != null) { /* theme colors are complex, skip */ }
            }
          }
          // Fill / background
          if (s.fill) {
            const fg = s.fill.fgColor;
            if (fg) {
              if (fg.rgb) parts.push('background-color:#' + fg.rgb.slice(-6));
            }
          }
          // Border
          if (s.border) {
            const bSide = (b) => {
              if (!b || !b.style) return '';
              const c = (b.color && b.color.rgb) ? '#' + b.color.rgb.slice(-6) : '#000';
              const w = b.style === 'thin' ? '1px' : b.style === 'medium' ? '2px' : b.style === 'thick' ? '3px' : '1px';
              return w + ' solid ' + c;
            };
            if (s.border.top) parts.push('border-top:' + bSide(s.border.top));
            if (s.border.bottom) parts.push('border-bottom:' + bSide(s.border.bottom));
            if (s.border.left) parts.push('border-left:' + bSide(s.border.left));
            if (s.border.right) parts.push('border-right:' + bSide(s.border.right));
          }
          return parts.join(';');
        }

        // === Reading view (plain) ===
        let readHtml = '<table><tbody>';
        for (let r = range.s.r; r <= range.e.r; r++) {
          readHtml += `<tr data-row="${r}">`;
          for (let c = range.s.c; c <= range.e.c; c++) {
            if (skipMap[r] && skipMap[r][c]) continue;
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = sheet[addr];
            const val = getCellVal(cell).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const mk = mergeMap[r + '_' + c];
            let attrs = '';
            if (mk) {
              if (mk.rowspan > 1) attrs += ` rowspan="${mk.rowspan}"`;
              if (mk.colspan > 1) attrs += ` colspan="${mk.colspan}"`;
            }
            readHtml += `<td${attrs}>${val}</td>`;
          }
          readHtml += '</tr>';
        }
        readHtml += '</tbody></table>';
        sheets[sheetName] = readHtml;

        // === Original view (styled with col/row headers) ===
        let styleHtml = '<table><thead><tr><th></th>';
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cw = colWidths[c];
          const wStyle = cw ? ` style="width:${cw}px;min-width:${cw}px"` : '';
          styleHtml += `<th${wStyle}>${colLabel(c)}</th>`;
        }
        styleHtml += '</tr></thead><tbody>';

        for (let r = range.s.r; r <= range.e.r; r++) {
          const rowH = (sheet['!rows'] && sheet['!rows'][r] && sheet['!rows'][r].hpx) ? sheet['!rows'][r].hpx : null;
          const trStyle = rowH ? ` style="height:${rowH}px"` : '';
          styleHtml += `<tr${trStyle}><th>${r + 1}</th>`;
          for (let c = range.s.c; c <= range.e.c; c++) {
            if (skipMap[r] && skipMap[r][c]) continue;
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = sheet[addr];
            const val = getCellVal(cell).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const mk = mergeMap[r + '_' + c];
            let attrs = '';
            if (mk) {
              if (mk.rowspan > 1) attrs += ` rowspan="${mk.rowspan}"`;
              if (mk.colspan > 1) attrs += ` colspan="${mk.colspan}"`;
            }
            let cellStyle = buildCellStyle(cell);
            cellStyle += (cellStyle ? ';' : '') + 'border:1px solid #d0d0d0;padding:3px 6px';
            attrs += ` style="${cellStyle}"`;
            styleHtml += `<td${attrs}>${val}</td>`;
          }
          styleHtml += '</tr>';
        }
        styleHtml += '</tbody></table>';
        styledSheets[sheetName] = styleHtml;
      });

      res.json({ success: true, type: 'excel', data: sheets, styled: styledSheets, fileName: path.basename(filePath), ...metadata });
    } else if (ext === '.docx' || ext === '.doc') {
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString('base64');
      const mammothResult = await mammoth.convertToHtml({ path: filePath }, {
        convertImage: mammoth.images.inline(function(element) {
          return element.read("base64").then(function(imageBuffer) {
            return { src: "data:" + element.contentType + ";base64," + imageBuffer };
          });
        })
      });
      // Extract headings from docx XML for TOC
      const headings = [];
      try {
        const JSZipWord = require('jszip');
        const zip = await JSZipWord.loadAsync(buf);
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
    } else {
      res.json({ success: false, error: `不支持预览此文件类型: ${ext}` });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

function collectMatchingFiles(dirPath, matcher, skipped = []) {
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (path.resolve(fullPath) === path.resolve(__dirname)) continue;
        results.push(...collectMatchingFiles(fullPath, matcher, skipped));
      } else if (entry.isFile() && matcher(fullPath, entry.name)) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    skipped.push({ path: toPosix(dirPath), error: e.message });
  }
  return results;
}

function findRevokedAudioFiles(rootDir) {
  const skipped = [];
  const files = collectMatchingFiles(rootDir, (fullPath, name) => {
    return name.includes('撤回') && AUDIO_EXTENSIONS.has(path.extname(fullPath).toLowerCase());
  }, skipped);
  return { files, skipped };
}

app.post('/api/scan-revoked-audio', (req, res) => {
  try {
    const rootDir = resolveRoot(req.body.root);
    const { files, skipped } = findRevokedAudioFiles(rootDir);
    const data = files.map(file => {
      const stats = fs.statSync(file);
      return {
        file: toPosix(file),
        relativePath: toPosix(path.relative(rootDir, file)),
        size: stats.size,
        mtime: stats.mtime
      };
    });
    res.json({ success: true, data, totalScanned: data.length, skipped });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/move-revoked', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    const rootDir = resolveRoot(req.body.root);
    const requestedFiles = Array.isArray(req.body.files) ? req.body.files : [];
    if (requestedFiles.length === 0) throw new Error('没有选择需要移动的音频文件');

    const targetDir = assertWithinRoot(rootDir, path.join(rootDir, '撤回文件夹'), { mustExist: false });
    fs.mkdirSync(targetDir, { recursive: true });

    const files = [...new Set(requestedFiles.map(file => assertWithinRoot(rootDir, file, { type: 'file' })))]
      .filter(file => path.basename(file).includes('撤回') && AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .filter(file => !toPosix(path.relative(rootDir, file)).startsWith('撤回文件夹/'));

    const moved = [];
    const errors = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = path.basename(file);
      res.write(`data: ${JSON.stringify({ type: 'progress', current: i + 1, total: files.length, file: fileName })}\n\n`);

      let destPath = path.join(targetDir, fileName);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        destPath = path.join(targetDir, `${base}_${counter}${ext}`);
        counter++;
      }

      try {
        fs.renameSync(file, destPath);
        moved.push({ from: toPosix(file), to: toPosix(destPath) });
      } catch (e) {
        errors.push({ file: toPosix(file), error: e.message });
      }
    }

    if (moved.length > 0) {
      writeLog(rootDir, '移动撤回音频', `移动 ${moved.length} 个音频到撤回文件夹` + moved.map(item => `\n  ${item.from} → ${item.to}`).join(''));
    }
    if (errors.length > 0) {
      writeLog(rootDir, '移动撤回音频-失败', errors.map(item => `${item.file}: ${item.error}`).join('; '));
    }

    res.write(`data: ${JSON.stringify({ type: 'done', success: true, moved, errors, targetDir: toPosix(targetDir) })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: e.message })}\n\n`);
  }
  res.end();
});

function findWordFiles(rootDir) {
  const skipped = [];
  const files = collectMatchingFiles(rootDir, (fullPath, name) => {
    return path.extname(name).toLowerCase() === '.docx';
  }, skipped);
  return { files, skipped };
}

async function checkWordForKeywords(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const lines = result.value.split('\n');
  const matchedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('返场故事') && line.includes('撤回')) {
      matchedLines.push({ lineNumber: i + 1, content: line.trim() });
    }
  }
  return matchedLines.length > 0 ? { file: filePath, matchedLines } : null;
}

app.post('/api/find-keywords', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    const rootDir = resolveRoot(req.body.root);
    const { files: wordFiles, skipped } = findWordFiles(rootDir);
    const results = [];
    const errors = [];

    for (let i = 0; i < wordFiles.length; i++) {
      const file = wordFiles[i];
      res.write(`data: ${JSON.stringify({ type: 'progress', current: i + 1, total: wordFiles.length, file: path.basename(file) })}\n\n`);
      try {
        const match = await checkWordForKeywords(file);
        if (match) {
          match.file = toPosix(match.file);
          match.relativePath = toPosix(path.relative(rootDir, file));
          results.push(match);
        }
      } catch (e) {
        errors.push({ file: toPosix(file), error: e.message });
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', success: true, data: results, totalScanned: wordFiles.length, skipped, errors })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: e.message })}\n\n`);
  }
  res.end();
});

async function validateDocxBuffer(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file('word/document.xml')) throw new Error('Word 文档缺少 document.xml');
  await mammoth.extractRawText({ buffer });
}

async function replaceFileSafely(filePath, newData, token) {
  const tempPath = `${filePath}.ming-story-${token}.tmp`;
  const rollbackPath = `${filePath}.ming-story-${token}.original`;
  fs.writeFileSync(tempPath, newData);

  try {
    await validateDocxBuffer(fs.readFileSync(tempPath));
    if (fs.existsSync(filePath)) fs.renameSync(filePath, rollbackPath);
    try {
      fs.renameSync(tempPath, filePath);
      if (fs.existsSync(rollbackPath)) fs.unlinkSync(rollbackPath);
    } catch (e) {
      if (fs.existsSync(rollbackPath) && !fs.existsSync(filePath)) fs.renameSync(rollbackPath, filePath);
      throw e;
    }
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (fs.existsSync(rollbackPath) && fs.existsSync(filePath)) fs.unlinkSync(rollbackPath);
  }
}

function writeTaskManifest(rootDir, taskId, type, items) {
  const taskDir = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', taskId), { mustExist: false });
  fs.mkdirSync(taskDir, { recursive: true });
  const manifest = { version: 1, taskId, type, createdAt: new Date().toISOString(), items };
  fs.writeFileSync(path.join(taskDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function removeContentFromLine(filePath, rootDir, taskId) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
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

  const relativePath = path.relative(rootDir, filePath);
  const backupPath = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', taskId, 'files', relativePath), { mustExist: false });
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);

  await replaceFileSafely(filePath, newData, taskId);
  return {
    modified: true,
    removedParagraphs: paragraphs.length - targetIdx,
    backupPath: toPosix(backupPath),
    manifestItem: {
      originalRelativePath: toPosix(relativePath),
      backupRelativePath: toPosix(path.relative(rootDir, backupPath)),
      removedParagraphs: paragraphs.length - targetIdx
    }
  };
}

app.post('/api/remove-content', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    const rootDir = resolveRoot(req.body.root);
    const requestedFiles = Array.isArray(req.body.files) ? req.body.files : [];
    if (requestedFiles.length === 0) throw new Error('没有选择需要处理的 Word 文档');

    const targetFiles = [...new Set(requestedFiles.map(file => assertWithinRoot(rootDir, file, { type: 'file' })))]
      .filter(file => path.extname(file).toLowerCase() === '.docx');
    const taskId = createTaskId('word-remove');
    const results = [];
    const manifestItems = [];

    for (let i = 0; i < targetFiles.length; i++) {
      const file = targetFiles[i];
      res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'process', current: i + 1, total: targetFiles.length, file: path.basename(file) })}\n\n`);
      try {
        const result = await removeContentFromLine(file, rootDir, taskId);
        if (result.manifestItem) manifestItems.push(result.manifestItem);
        delete result.manifestItem;
        results.push({ file: toPosix(file), ...result });
      } catch (e) {
        results.push({ file: toPosix(file), modified: false, error: e.message });
      }
    }

    const modified = results.filter(item => item.modified);
    const failed = results.filter(item => !item.modified && item.error);
    if (manifestItems.length > 0) writeTaskManifest(rootDir, taskId, 'remove-content', manifestItems);
    if (modified.length > 0) {
      writeLog(rootDir, '删除返场故事内容', `任务 ${taskId}，处理 ${modified.length} 个文件` + modified.map(item => `\n  ${item.file} - 删除${item.removedParagraphs}段, 备份:${item.backupPath}`).join(''));
    }
    if (failed.length > 0) {
      writeLog(rootDir, '删除返场故事内容-失败', failed.map(item => `${item.file}: ${item.error}`).join('; '));
    }

    res.write(`data: ${JSON.stringify({ type: 'done', success: true, data: results, taskId, restorable: modified.length > 0 })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: e.message })}\n\n`);
  }
  res.end();
});

app.post('/api/restore-task', async (req, res) => {
  try {
    const rootDir = resolveRoot(req.body.root);
    const taskId = normalizeTaskId(req.body.taskId);
    const manifestPath = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', taskId, 'manifest.json'), { type: 'file' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.type !== 'remove-content' || !Array.isArray(manifest.items)) throw new Error('该备份任务不能恢复');

    const restoreTaskId = createTaskId('before-restore');
    const restoreItems = [];
    const results = [];
    for (const item of manifest.items) {
      try {
        const originalPath = assertWithinRoot(rootDir, path.join(rootDir, item.originalRelativePath), { mustExist: false });
        const backupPath = assertWithinRoot(rootDir, path.join(rootDir, item.backupRelativePath), { type: 'file' });
        const backupData = fs.readFileSync(backupPath);
        await validateDocxBuffer(backupData);

        if (fs.existsSync(originalPath)) {
          const currentBackup = assertWithinRoot(rootDir, path.join(rootDir, '备份文件夹', restoreTaskId, 'files', item.originalRelativePath), { mustExist: false });
          fs.mkdirSync(path.dirname(currentBackup), { recursive: true });
          fs.copyFileSync(originalPath, currentBackup);
          restoreItems.push({
            originalRelativePath: item.originalRelativePath,
            backupRelativePath: toPosix(path.relative(rootDir, currentBackup))
          });
        } else {
          fs.mkdirSync(path.dirname(originalPath), { recursive: true });
        }

        await replaceFileSafely(originalPath, backupData, restoreTaskId);
        results.push({ file: toPosix(originalPath), restored: true });
      } catch (e) {
        results.push({ file: item.originalRelativePath, restored: false, error: e.message });
      }
    }

    if (restoreItems.length > 0) writeTaskManifest(rootDir, restoreTaskId, 'before-restore', restoreItems);
    const restoredCount = results.filter(item => item.restored).length;
    writeLog(rootDir, '恢复文档备份', `恢复任务 ${taskId}，成功 ${restoredCount}/${results.length}，恢复前版本备份任务 ${restoreTaskId}`);
    res.json({ success: true, data: results, restoredCount, restoreTaskId });
  } catch (e) {
    res.json({ success: false, error: e.message });
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
          return manifest.type === 'remove-content' ? { taskId: manifest.taskId, createdAt: manifest.createdAt, count: manifest.items.length } : null;
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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
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

function listenOnAvailablePort(port = START_PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('listening', () => {
      serverInstance = server;
      writeServerState(port);
      console.log(`文件管理系统已启动: http://${HOST}:${port}`);
      console.log(`管理目录: ${DEFAULT_ROOT}`);
      resolve({ server, port });
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
  cleanupServerState();
  if (!serverInstance) return process.exit(0);
  serverInstance.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanupServerState);

if (require.main === module) {
  listenOnAvailablePort().catch(error => {
    cleanupServerState();
    console.error(`服务启动失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { app, listenOnAvailablePort, resolveRoot, assertWithinRoot };
