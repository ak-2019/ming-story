const express = require('express');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;

// 默认根目录：当前文件夹的上级目录
const DEFAULT_ROOT = path.resolve(__dirname, '..');

app.use(express.json());
app.use(express.static(__dirname));

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
  const rootDir = req.query.root || DEFAULT_ROOT;
  const logDir = path.join(rootDir, '操作日志');
  try {
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
  const rootDir = req.query.root || DEFAULT_ROOT;
  const logDir = path.join(rootDir, '操作日志');
  const logFile = path.join(logDir, req.params.filename);
  try {
    if (!logFile.startsWith(logDir) || !fs.existsSync(logFile)) {
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
  const stats = fs.statSync(dirPath);
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
  const rootDir = req.query.root || DEFAULT_ROOT;
  try {
    const tree = buildTree(rootDir, rootDir);
    res.json({ success: true, data: tree, root: rootDir.replace(/\\/g, '/') });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== API 2: 预览文件内容 ==========
app.get('/api/preview', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.json({ success: false, error: '文件不存在' });
  }

  const ext = path.extname(filePath).toLowerCase();

  try {
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

      res.json({ success: true, type: 'excel', data: sheets, styled: styledSheets, fileName: path.basename(filePath) });
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
      res.json({ success: true, type: 'word', data: base64, html: mammothResult.value, headings, fileName: path.basename(filePath) });
    } else if (['.txt', '.md', '.json', '.csv', '.log', '.xml', '.html', '.css', '.js'].includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.json({ success: true, type: 'text', data: content, fileName: path.basename(filePath) });
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      const base64 = fs.readFileSync(filePath).toString('base64');
      const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`;
      res.json({ success: true, type: 'image', data: `data:${mime};base64,${base64}`, fileName: path.basename(filePath) });
    } else {
      res.json({ success: false, error: `不支持预览此文件类型: ${ext}` });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== API 3: 移动"撤回"文件 ==========
function findFilesWithKeyword(dirPath, keyword) {
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '撤回文件夹') continue;
        if (path.resolve(fullPath) === path.resolve(__dirname)) continue;
        results.push(...findFilesWithKeyword(fullPath, keyword));
      } else if (entry.isFile() && entry.name.includes(keyword) && !entry.name.startsWith('~$')) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    // 跳过无权限目录
  }
  return results;
}

app.post('/api/move-revoked', (req, res) => {
  const rootDir = req.body.root || DEFAULT_ROOT;
  const targetDir = path.join(rootDir, '撤回文件夹');

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const files = findFilesWithKeyword(rootDir, '撤回');
    const moved = [];
    const errors = [];
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = path.basename(file);
      res.write(`data: ${JSON.stringify({ type: 'progress', current: i + 1, total, file: fileName })}\n\n`);

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
        moved.push({ from: file.replace(/\\/g, '/'), to: destPath.replace(/\\/g, '/') });
      } catch (e) {
        errors.push({ file: file.replace(/\\/g, '/'), error: e.message });
      }
    }

    if (moved.length > 0) {
      writeLog(rootDir, '移动撤回文件', `移动 ${moved.length} 个文件到撤回文件夹` + moved.map(m => `\n  ${m.from} → ${m.to}`).join(''));
    }
    if (errors.length > 0) {
      writeLog(rootDir, '移动撤回文件-失败', errors.map(e => `${e.file}: ${e.error}`).join('; '));
    }

    res.write(`data: ${JSON.stringify({ type: 'done', success: true, moved, errors, targetDir: targetDir.replace(/\\/g, '/') })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: e.message })}\n\n`);
  }
  res.end();
});

// ========== API 4: 查找包含"返场故事"和"撤回"在同一行的Word文件 ==========
function findWordFiles(dirPath) {
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '撤回文件夹' || entry.name === '备份文件夹') continue;
        if (path.resolve(fullPath) === path.resolve(__dirname)) continue;
        results.push(...findWordFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.docx') || entry.name.endsWith('.doc')) && !entry.name.startsWith('~$')) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    // 跳过
  }
  return results;
}

async function checkWordForKeywords(filePath) {
  try {
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
  } catch (e) {
    return null;
  }
}

app.post('/api/find-keywords', async (req, res) => {
  const rootDir = req.body.root || DEFAULT_ROOT;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    const wordFiles = findWordFiles(rootDir);
    const results = [];
    const total = wordFiles.length;

    for (let i = 0; i < wordFiles.length; i++) {
      const file = wordFiles[i];
      res.write(`data: ${JSON.stringify({ type: 'progress', current: i + 1, total, file: path.basename(file) })}\n\n`);
      const match = await checkWordForKeywords(file);
      if (match) {
        match.file = match.file.replace(/\\/g, '/');
        results.push(match);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', success: true, data: results, totalScanned: total })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: e.message })}\n\n`);
  }
  res.end();
});

// ========== API 5: 删除"返场故事"行及后续内容 ==========
// 使用 python-docx 风格：通过 mammoth 读取，通过直接操作 docx XML 来删除内容
const JSZip = require('jszip');

async function removeContentFromLine(filePath, rootDir) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const documentXml = await zip.file('word/document.xml').async('string');

  // 解析段落，找到同时包含"返场故事"和"撤回"的段落
  const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  const paragraphs = [];
  let match;
  while ((match = paragraphRegex.exec(documentXml)) !== null) {
    paragraphs.push({ text: match[0], index: match.index, length: match[0].length });
  }

  // 从段落中提取文本
  function extractText(pXml) {
    const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let text = '';
    let m;
    while ((m = textRegex.exec(pXml)) !== null) {
      text += m[1];
    }
    return text;
  }

  // 找到第一个同时包含"返场故事"和"撤回"的段落索引
  let targetIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const text = extractText(paragraphs[i].text);
    if (text.includes('返场故事') && text.includes('撤回')) {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx === -1) {
    return { modified: false, reason: '未找到同时包含"返场故事"和"撤回"的段落' };
  }

  // 删除从 targetIdx 开始的所有段落
  // 找到第一个要删除的段落的开始位置和最后一个段落的结束位置
  const startPos = paragraphs[targetIdx].index;
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const endPos = lastParagraph.index + lastParagraph.length;

  const newDocumentXml = documentXml.substring(0, startPos) + documentXml.substring(endPos);

  zip.file('word/document.xml', newDocumentXml);
  const newData = await zip.generateAsync({ type: 'nodebuffer' });

  // 备份原文件到备份文件夹
  const backupDir = path.join(rootDir, '备份文件夹');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const relPath = path.relative(rootDir, filePath);
  const backupPath = path.join(backupDir, relPath);
  const backupSubDir = path.dirname(backupPath);
  if (!fs.existsSync(backupSubDir)) fs.mkdirSync(backupSubDir, { recursive: true });
  fs.copyFileSync(filePath, backupPath);

  // 写入修改后的文件
  fs.writeFileSync(filePath, newData);

  return {
    modified: true,
    removedParagraphs: paragraphs.length - targetIdx,
    backupPath: backupPath.replace(/\\/g, '/')
  };
}

app.post('/api/remove-content', async (req, res) => {
  const rootDir = req.body.root || DEFAULT_ROOT;
  const specificFiles = req.body.files;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  try {
    let targetFiles = [];

    if (specificFiles && specificFiles.length > 0) {
      targetFiles = specificFiles;
    } else {
      const wordFiles = findWordFiles(rootDir);
      for (let i = 0; i < wordFiles.length; i++) {
        res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'scan', current: i + 1, total: wordFiles.length, file: path.basename(wordFiles[i]) })}\n\n`);
        const match = await checkWordForKeywords(wordFiles[i]);
        if (match) {
          targetFiles.push(wordFiles[i]);
        }
      }
    }

    const results = [];
    const total = targetFiles.length;
    for (let i = 0; i < targetFiles.length; i++) {
      const file = targetFiles[i];
      res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'process', current: i + 1, total, file: path.basename(file) })}\n\n`);
      try {
        const result = await removeContentFromLine(file, rootDir);
        results.push({ file: file.replace(/\\/g, '/'), ...result });
      } catch (e) {
        results.push({ file: file.replace(/\\/g, '/'), modified: false, error: e.message });
      }
    }

    const modified = results.filter(r => r.modified);
    const failed = results.filter(r => !r.modified && r.error);
    if (modified.length > 0) {
      writeLog(rootDir, '删除返场故事内容', `处理 ${modified.length} 个文件` + modified.map(m => `\n  ${m.file} - 删除${m.removedParagraphs}段, 备份:${m.backupPath}`).join(''));
    }
    if (failed.length > 0) {
      writeLog(rootDir, '删除返场故事内容-失败', failed.map(f => `${f.file}: ${f.error}`).join('; '));
    }

    res.write(`data: ${JSON.stringify({ type: 'done', success: true, data: results })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: e.message })}\n\n`);
  }
  res.end();
});

// ========== 启动服务器 ==========
const { exec } = require('child_process');
const net = require('net');

function checkPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port);
  });
}

checkPort(PORT).then((inUse) => {
  if (inUse) {
    console.log(`端口 ${PORT} 已被占用，服务可能已在运行`);
    console.log(`正在打开浏览器: http://localhost:${PORT}`);
    exec(`start http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 1000);
    return;
  }
  app.listen(PORT, () => {
    console.log(`文件管理系统已启动: http://localhost:${PORT}`);
    console.log(`管理目录: ${DEFAULT_ROOT}`);
    exec(`start http://localhost:${PORT}`);
  });
});
