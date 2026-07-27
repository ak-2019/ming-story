const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');
const JSZip = require('jszip');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const STAGING_DIST_DIR = path.join(__dirname, '.portable-dist-staging');
const PREVIOUS_DIST_DIR = path.join(PROJECT_DIR, '.portable-dist-previous');
const BUILD_LOCK_FILE = path.join(PROJECT_DIR, '.portable-build.lock');
const APP_DIR = path.join(STAGING_DIST_DIR, 'file-manager');
const NODE_DIR = path.join(APP_DIR, 'runtime');
const NODE_VERSION = 'v20.18.1';
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;
const CACHE_DIR = path.join(__dirname, '.cache');
const NODE_ZIP_PATH = path.join(CACHE_DIR, NODE_ZIP);
const BUILD_REPORT = path.join(STAGING_DIST_DIR, '打包检查报告.txt');
const FAILURE_REPORT = path.join(__dirname, '打包失败报告.txt');
const SOURCE_FILES = [
  'server.js', 'launcher.js', 'stop.js', 'process-identity.js', 'index.html', 'package.json', 'package-lock.json',
  '启动文件管理系统.vbs', '停止文件管理系统.vbs',
  path.join('test', 'file-safety.test.js'), path.join('test', 'lifecycle.test.js'), path.join('test', 'package-validation.test.js'), path.join('test', 'process-identity.test.js'), path.join('test', 'workflows.test.js'),
  path.join('test-support', 'helpers.js'),
  path.join('libs', 'jszip.min.js'), path.join('libs', 'docx-preview.min.js')
];
const PORTABLE_FILES = [
  'server.js', 'launcher.js', 'stop.js', 'process-identity.js', 'index.html', 'package.json', 'package-lock.json',
  '启动文件管理系统.vbs', '停止文件管理系统.vbs', 'start-silent.vbs', 'start.bat', '使用说明.txt',
  path.join('runtime', 'node.exe'), path.join('runtime', 'npm.cmd'),
  path.join('node_modules', 'express', 'package.json'), path.join('node_modules', 'jszip', 'package.json'),
  path.join('node_modules', 'mammoth', 'package.json'), path.join('node_modules', 'xlsx', 'package.json'),
  path.join('libs', 'jszip.min.js'), path.join('libs', 'docx-preview.min.js')
];
const checkResults = [];
let buildLock = null;

function log(msg) { console.log(msg); }

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dest) {
  mkdirp(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isRecordedProcessRunning(record, actualStartedAt = undefined) {
  return require('../process-identity').isRecordedProcessRunning(record, actualStartedAt);
}

function processStartMatchesRecord(recordedAt, actualStartedAt) {
  return require('../process-identity').processStartMatchesRecord(recordedAt, actualStartedAt);
}

function acquireBuildLock(lockFile = BUILD_LOCK_FILE) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd = null;
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
      return { fd, lockFile };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (ignored) {}
      }
      if (error.code !== 'EEXIST') throw error;

      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (ignored) {}
      const age = existing && existing.startedAt ? Date.now() - new Date(existing.startedAt).getTime() : Infinity;
      if (existing && isRecordedProcessRunning(existing) && age < 6 * 60 * 60 * 1000) {
        throw new Error(`另一个打包任务正在运行（PID ${existing.pid}），请等待完成后再试`);
      }
      try {
        fs.unlinkSync(lockFile);
      } catch (removeError) {
        throw new Error(`无法清理过期打包锁：${removeError.message}`);
      }
    }
  }
  throw new Error('无法取得打包锁');
}

function releaseBuildLock(lock = buildLock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch (ignored) {}
  try {
    const current = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    if (current.pid === process.pid) fs.unlinkSync(lock.lockFile);
  } catch (ignored) {}
  if (lock === buildLock) buildLock = null;
}

function runCheck(name, fn) {
  log(`  [检查] ${name}...`);
  try {
    fn();
    checkResults.push({ name, success: true });
    log('         通过');
  } catch (error) {
    checkResults.push({ name, success: false, error: error.message });
    throw new Error(`${name}失败：${error.message}`);
  }
}

async function runCheckAsync(name, fn) {
  log(`  [检查] ${name}...`);
  try {
    await fn();
    checkResults.push({ name, success: true });
    log('         通过');
  } catch (error) {
    checkResults.push({ name, success: false, error: error.message });
    throw new Error(`${name}失败：${error.message}`);
  }
}

function assertFiles(baseDir, files) {
  const missing = files.filter(file => !fs.existsSync(path.join(baseDir, file)));
  if (missing.length > 0) throw new Error(`缺少文件：${missing.join('、')}`);
}

function validateSource() {
  runCheck('源码必需文件', () => assertFiles(PROJECT_DIR, SOURCE_FILES));
  runCheck('源码脚本语法', () => {
    ['server.js', 'launcher.js', 'stop.js', 'process-identity.js', path.join('build', 'build-portable.js')].forEach(file => {
      execFileSync(process.execPath, ['--check', path.join(PROJECT_DIR, file)], { stdio: 'pipe' });
    });
  });
  runCheck('核心回归测试', () => {
    execFileSync(process.execPath, ['--test', '--test-concurrency=1'], { cwd: PROJECT_DIR, stdio: 'pipe' });
  });
  runCheck('源码 VBS 编译', () => {
    execFileSync('cscript.exe', ['//nologo', path.join(PROJECT_DIR, '启动文件管理系统.vbs'), '/check'], { stdio: 'pipe' });
    execFileSync('cscript.exe', ['//nologo', path.join(PROJECT_DIR, '停止文件管理系统.vbs'), '/check'], { stdio: 'pipe' });
  });
  runCheck('依赖清单', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
    ['express', 'jszip', 'mammoth', 'xlsx'].forEach(name => {
      if (!pkg.dependencies || !pkg.dependencies[name]) throw new Error(`package.json 缺少 ${name}`);
    });
  });
}

function writePortablePackage() {
  const packagePath = path.join(APP_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.scripts = {
    start: 'node launcher.js',
    'start:server': 'node server.js',
    stop: 'node stop.js',
    check: 'node --check server.js && node --check launcher.js && node --check stop.js && node --check process-identity.js && cscript //nologo "启动文件管理系统.vbs" /check && cscript //nologo "停止文件管理系统.vbs" /check'
  };
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

function validatePortableDirectory() {
  const runtimeNode = path.join(NODE_DIR, 'node.exe');
  runCheck('便携目录必需文件', () => assertFiles(APP_DIR, PORTABLE_FILES));
  runCheck('便携目录写入权限', () => {
    const testFile = path.join(APP_DIR, `.build-write-test-${process.pid}.tmp`);
    try {
      fs.writeFileSync(testFile, 'ok', 'utf8');
    } finally {
      try { fs.unlinkSync(testFile); } catch (e) {}
    }
  });
  runCheck('便携运行脚本语法', () => {
    ['server.js', 'launcher.js', 'stop.js', 'process-identity.js'].forEach(file => {
      execFileSync(runtimeNode, ['--check', path.join(APP_DIR, file)], { stdio: 'pipe' });
    });
  });
  runCheck('便携 VBS 编译', () => {
    execFileSync('cscript.exe', ['//nologo', path.join(APP_DIR, '启动文件管理系统.vbs'), '/check'], { stdio: 'pipe' });
    execFileSync('cscript.exe', ['//nologo', path.join(APP_DIR, '停止文件管理系统.vbs'), '/check'], { stdio: 'pipe' });
  });
  runCheck('便携启动诊断', () => {
    execFileSync(runtimeNode, [path.join(APP_DIR, 'launcher.js'), '--diagnose'], {
      cwd: APP_DIR,
      env: { ...process.env, FILE_MANAGER_NO_BROWSER: '1', FILE_MANAGER_SKIP_WRITE_CHECK: '1' },
      stdio: 'pipe'
    });
    try { fs.unlinkSync(path.join(APP_DIR, '诊断信息.txt')); } catch (e) {}
  });
}

function listFilesRecursively(baseDir, relativeDir = '') {
  const files = [];
  const currentDir = path.join(baseDir, relativeDir);
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(baseDir, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function indexZipEntries(zip) {
  const entries = new Map();
  const duplicates = new Set();
  for (const name of Object.keys(zip.files)) {
    const normalized = name.replace(/\\/g, '/');
    if (entries.has(normalized)) duplicates.add(normalized);
    entries.set(normalized, zip.files[name]);
  }
  if (duplicates.size > 0) {
    throw new Error(`ZIP 包含重复路径：${[...duplicates].join('、')}`);
  }
  return entries;
}

async function validateZip(zipPath) {
  await runCheckAsync('ZIP 内容', async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath), { checkCRC32: true });
    const entries = indexZipEntries(zip);
    const portableFiles = listFilesRecursively(APP_DIR);
    for (const file of portableFiles) {
      const normalizedFile = file.replace(/\\/g, '/');
      const entry = `file-manager/${normalizedFile}`;
      const zipEntry = entries.get(entry);
      if (!zipEntry) throw new Error(`ZIP 缺少 ${entry}`);
      const zippedData = await zipEntry.async('nodebuffer');
      const portableData = fs.readFileSync(path.join(APP_DIR, file));
      if (!zippedData.equals(portableData)) throw new Error(`ZIP 中的 ${entry} 与便携目录不一致`);
    }
    if (portableFiles.length < 10) throw new Error('便携目录内容数量异常');
  });
}

function writeBuildReport(reportPath, zipPath, error, displayZipPath = zipPath) {
  mkdirp(path.dirname(reportPath));
  let version = '未知';
  try { version = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8')).version; } catch (e) {}
  const lines = [
    '大明帝国文件管理 - 打包检查报告',
    `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `程序版本: ${version}`,
    `内置 Node.js: ${NODE_VERSION}`,
    `打包结果: ${error ? '失败' : '成功'}`,
    ''
  ];
  checkResults.forEach(item => lines.push(`${item.success ? '[通过]' : '[失败]'} ${item.name}${item.error ? `：${item.error}` : ''}`));
  if (zipPath && fs.existsSync(zipPath)) lines.push('', `ZIP: ${displayZipPath}`, `ZIP 大小: ${fs.statSync(zipPath).size} 字节`);
  if (error) lines.push('', `错误: ${error.message}`);
  fs.writeFileSync(reportPath, lines.join('\r\n') + '\r\n', 'utf8');
}

function recoverInterruptedPublish() {
  if (!fs.existsSync(DIST_DIR) && fs.existsSync(PREVIOUS_DIST_DIR)) {
    fs.renameSync(PREVIOUS_DIST_DIR, DIST_DIR);
  } else if (fs.existsSync(DIST_DIR) && fs.existsSync(PREVIOUS_DIST_DIR)) {
    rmrf(PREVIOUS_DIST_DIR);
  }
  rmrf(STAGING_DIST_DIR);
}

function publishStagingOutput() {
  if (!fs.existsSync(STAGING_DIST_DIR)) throw new Error('临时构建目录不存在');
  if (fs.existsSync(PREVIOUS_DIST_DIR)) rmrf(PREVIOUS_DIST_DIR);
  if (fs.existsSync(DIST_DIR)) fs.renameSync(DIST_DIR, PREVIOUS_DIST_DIR);
  try {
    fs.renameSync(STAGING_DIST_DIR, DIST_DIR);
  } catch (error) {
    if (!fs.existsSync(DIST_DIR) && fs.existsSync(PREVIOUS_DIST_DIR)) {
      try { fs.renameSync(PREVIOUS_DIST_DIR, DIST_DIR); } catch (restoreError) {
        error.message += `；恢复上一份构建也失败：${restoreError.message}`;
      }
    }
    throw error;
  }
  try { rmrf(PREVIOUS_DIST_DIR); } catch (error) {
    log(`  [提示] 新包已发布，但旧包临时目录未能删除：${error.message}`);
  }
}

function getDownloadResponse(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirectCount >= 5) return reject(new Error('下载重定向异常'));
        return resolve(getDownloadResponse(new URL(response.headers.location, url).toString(), redirectCount + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`下载服务器返回 ${response.statusCode}`));
      }
      resolve(response);
    }).on('error', reject);
  });
}

async function downloadFile(url, dest) {
  log(`       下载中: ${url}`);
  const partialPath = `${dest}.part`;
  try { fs.unlinkSync(partialPath); } catch (e) {}
  try {
    const response = await getDownloadResponse(url);
    const total = parseInt(response.headers['content-length'] || '0', 10);
    let downloaded = 0;
    let lastPercent = -1;
    response.on('data', chunk => {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.round(downloaded / total * 100);
        if (pct !== lastPercent) {
          lastPercent = pct;
          process.stdout.write(`\r       进度: ${pct}% (${Math.round(downloaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)  `);
        }
      }
    });
    await pipeline(response, fs.createWriteStream(partialPath, { flags: 'wx' }));
    if (total > 0 && downloaded !== total) throw new Error(`下载不完整：应为 ${total} 字节，实际 ${downloaded} 字节`);
    fs.renameSync(partialPath, dest);
    console.log('');
  } catch (e) {
    try { fs.unlinkSync(partialPath); } catch (ignored) {}
    throw e;
  }
}

async function validateNodeArchive(zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error('缓存文件不存在');
  const stats = fs.statSync(zipPath);
  if (stats.size < 10 * 1024 * 1024) throw new Error('缓存文件大小异常');
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath), { checkCRC32: true });
  const prefix = `node-${NODE_VERSION}-win-x64/`;
  for (const required of [`${prefix}node.exe`, `${prefix}npm.cmd`]) {
    if (!zip.file(required)) throw new Error(`缓存压缩包缺少 ${required}`);
  }
}

async function main() {
  log('============================================');
  log('  文件管理系统 - 便携版打包工具');
  log('============================================');
  log('');

  const checkSourceOnly = process.argv.includes('--check-source');
  if (!checkSourceOnly) {
    buildLock = acquireBuildLock();
    recoverInterruptedPublish();
  }
  validateSource();
  if (checkSourceOnly) {
    log('  源码打包前检查全部通过。');
    return;
  }

  // 先确认运行环境缓存可用，失败时保留上一份便携包。
  mkdirp(CACHE_DIR);

  // [1/5] 下载并校验 Node.js
  log(`[1/5] 检查便携版 Node.js ${NODE_VERSION}...`);
  log('       (约30MB，请耐心等待)');
  let cacheReady = false;
  if (fs.existsSync(NODE_ZIP_PATH)) {
    try {
      await validateNodeArchive(NODE_ZIP_PATH);
      cacheReady = true;
      log('       已有完整缓存，跳过下载');
    } catch (e) {
      log(`       旧缓存无效，将重新下载：${e.message}`);
      try { fs.unlinkSync(NODE_ZIP_PATH); } catch (ignored) {}
    }
  }
  if (!cacheReady) {
    try {
      await downloadFile(NODE_URL, NODE_ZIP_PATH);
      await validateNodeArchive(NODE_ZIP_PATH);
      log('       下载并校验完成！');
    } catch (e) {
      log(`[错误] 下载或校验失败: ${e.message}`);
      log(`       请手动下载: ${NODE_URL}`);
      log(`       放到 ${NODE_ZIP_PATH} 后重新运行`);
      throw e;
    }
  }

  // [2/5] 在临时目录构建，上一份 dist 保留到全部检查通过。
  log('[2/5] 创建临时构建目录...');
  rmrf(STAGING_DIST_DIR);
  mkdirp(APP_DIR);
  mkdirp(NODE_DIR);

  // [3/5] 解压 Node.js
  log('[3/5] 解压 Node.js...');
  const tempDir = path.join(STAGING_DIST_DIR, 'temp_node');
  mkdirp(tempDir);
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${NODE_ZIP_PATH}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'inherit' });
  const extractedDir = path.join(tempDir, `node-${NODE_VERSION}-win-x64`);
  copyDirSync(extractedDir, NODE_DIR);
  rmrf(tempDir);
  log('       解压完成！');

  // [4/5] 复制项目文件
  log('[4/5] 复制项目文件...');
  const filesToCopy = [
    'server.js',
    'launcher.js',
    'stop.js',
    'process-identity.js',
    'index.html',
    'package.json',
    'package-lock.json',
    '启动文件管理系统.vbs',
    '停止文件管理系统.vbs'
  ];
  for (const f of filesToCopy) {
    const src = path.join(PROJECT_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(APP_DIR, f));
    }
  }
  writePortablePackage();

  // 复制 libs 目录（前端离线依赖）
  const libsSrc = path.join(PROJECT_DIR, 'libs');
  if (fs.existsSync(libsSrc)) {
    copyDirSync(libsSrc, path.join(APP_DIR, 'libs'));
  }

  // 始终用打包自带的 npm 重新安装依赖（避免 pnpm 符号链接复制问题）
  log('       安装生产依赖（使用 npm ci）...');
  const npmCmd = path.join(NODE_DIR, 'npm.cmd');
  execSync(`"${npmCmd}" ci --omit=dev`, { cwd: APP_DIR, stdio: 'inherit' });
  log('       复制完成！');

  // [5/5] 创建启动脚本
  log('[5/5] 创建启动脚本...');

  // start.bat
  const startBat = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0launcher.js"\r\nif errorlevel 1 pause\r\n`;
  fs.writeFileSync(path.join(APP_DIR, 'start.bat'), startBat, 'utf8');

  // Keep an English alias for users of earlier portable packages.
  fs.copyFileSync(path.join(APP_DIR, '启动文件管理系统.vbs'), path.join(APP_DIR, 'start-silent.vbs'));

  // README
  const readme = `大明帝国文件管理 - 使用说明\r\n\r\n启动方法:\r\n  双击“启动文件管理系统.vbs”，浏览器会自动打开。\r\n\r\n停止方法:\r\n  双击“停止文件管理系统.vbs”，只会停止本程序的内置 Node.js 进程。\r\n\r\n注意事项:\r\n  - 无需安装 Node.js，无需联网，解压即用\r\n  - 默认管理本文件夹的上级目录\r\n  - 请不要删除 runtime、node_modules、server.js 等程序文件\r\n  - 批量操作会先显示文件清单，确认后才执行\r\n  - Word 修改和音频整理都支持从结果或日志页面恢复\r\n  - 启动失败时请查看“启动错误.log”和“诊断信息.txt”\r\n`;
  fs.writeFileSync(path.join(APP_DIR, '使用说明.txt'), readme, 'utf8');

  validatePortableDirectory();

  const zipPath = path.join(STAGING_DIST_DIR, '大明帝国文件管理.zip');
  log('');
  log('  正在生成便携版 ZIP...');
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${APP_DIR}' -DestinationPath '${zipPath}' -Force"`, { stdio: 'inherit' });
  await validateZip(zipPath);
  writeBuildReport(BUILD_REPORT, zipPath, null, path.join(DIST_DIR, path.basename(zipPath)));
  publishStagingOutput();
  try { fs.unlinkSync(FAILURE_REPORT); } catch (e) {}
  log('');
  log('============================================');
  log('  打包完成！');
  log('============================================');
  log(`  输出目录: ${path.join(DIST_DIR, 'file-manager')}`);
  log(`  ZIP 文件: ${path.join(DIST_DIR, path.basename(zipPath))}`);
  log(`  检查报告: ${path.join(DIST_DIR, path.basename(BUILD_REPORT))}`);
  log('  将 ZIP 发给用户，解压后双击“启动文件管理系统.vbs”即可使用。');
  log('============================================');
}

if (require.main === module) {
  main().catch(e => {
    try { writeBuildReport(FAILURE_REPORT, null, e); } catch (reportError) {}
    try { rmrf(STAGING_DIST_DIR); } catch (cleanupError) {}
    console.error('打包失败:', e.message);
    console.error(`失败报告: ${FAILURE_REPORT}`);
    process.exitCode = 1;
  }).finally(() => releaseBuildLock());
}

module.exports = { acquireBuildLock, indexZipEntries, isRecordedProcessRunning, processStartMatchesRecord, releaseBuildLock };
