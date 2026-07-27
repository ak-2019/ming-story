const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
const SERVER_PATH = path.join(APP_DIR, 'server.js');
const STATE_FILE = path.join(APP_DIR, '.file-manager-state.json');
const START_LOCK_FILE = path.join(APP_DIR, '.file-manager-start.lock');
const ERROR_LOG = path.join(APP_DIR, '启动错误.log');
const DIAGNOSTIC_FILE = path.join(APP_DIR, '诊断信息.txt');
const REQUIRED_FILES = [
  'server.js',
  'process-identity.js',
  'index.html',
  'package.json',
  path.join('libs', 'jszip.min.js'),
  path.join('libs', 'docx-preview.min.js')
];
const REQUIRED_DEPENDENCIES = ['express', 'jszip', 'mammoth', 'xlsx'];

function isRecordedProcessRunning(record, actualStartedAt = undefined) {
  return require('./process-identity').isRecordedProcessRunning(record, actualStartedAt);
}

function shouldPreserveUnresponsiveState(record, portListening) {
  return require('./process-identity').shouldPreserveUnresponsiveState(record, portListening);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function removeState() {
  try { fs.unlinkSync(STATE_FILE); } catch (e) {}
}

function isPortListening(port, timeoutMs = 1000) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = listening => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function acquireStartLock(lockFile = START_LOCK_FILE, actualStartedAt = undefined) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd = null;
    try {
      const record = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token: crypto.randomBytes(12).toString('hex')
      };
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
      return { fd, lockFile, token: record.token };
    } catch (e) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (ignored) {}
        try { fs.unlinkSync(lockFile); } catch (ignored) {}
      }
      if (e.code !== 'EEXIST') throw e;
      let lock = null;
      try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (ignored) {}
      const age = lock && lock.startedAt ? Date.now() - new Date(lock.startedAt).getTime() : Infinity;
      if (lock && isRecordedProcessRunning(lock, actualStartedAt) && age < 60000) return null;
      try { fs.unlinkSync(lockFile); } catch (ignored) { return null; }
    }
  }
  return null;
}

function releaseStartLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch (e) {}
  try {
    const current = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    if (current.pid === process.pid && current.token === lock.token) fs.unlinkSync(lock.lockFile);
  } catch (e) {}
}

function waitForHealth(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const check = () => {
      const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              const data = JSON.parse(body);
              if (data.success) return resolve(data);
            } catch (e) {}
          }
          retry();
        });
      });
      request.on('error', retry);
      request.on('timeout', () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) return resolve(null);
      setTimeout(check, 250);
    };
    check();
  });
}

function isDirectoryWritable() {
  const testFile = path.join(APP_DIR, `文件管理写入测试-${process.pid}.tmp`);
  try {
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    return true;
  } catch (e) {
    try { fs.unlinkSync(testFile); } catch (ignored) {}
    return false;
  }
}

function resolveNodePath() {
  const runtimeDir = path.join(APP_DIR, 'runtime');
  const runtimeNode = path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(runtimeDir) && !fs.existsSync(runtimeNode)) {
    throw new Error('内置运行环境不完整，缺少 runtime/node.exe，请重新解压完整程序。');
  }
  return fs.existsSync(runtimeNode) ? runtimeNode : process.execPath;
}

function runPreflight() {
  const missingFiles = REQUIRED_FILES.filter(file => !fs.existsSync(path.join(APP_DIR, file)));
  if (missingFiles.length > 0) {
    throw new Error(`程序文件不完整，缺少：${missingFiles.join('、')}。请重新解压完整程序。`);
  }
  const missingDependencies = REQUIRED_DEPENDENCIES.filter(name => {
    try {
      require.resolve(name, { paths: [APP_DIR] });
      return false;
    } catch (e) {
      return true;
    }
  });
  if (missingDependencies.length > 0) {
    throw new Error(`离线依赖不完整，缺少：${missingDependencies.join('、')}。请重新解压完整程序。`);
  }
  if (process.env.FILE_MANAGER_SKIP_WRITE_CHECK !== '1' && !isDirectoryWritable()) {
    throw new Error('当前程序目录不可写，请将程序移动到有写入权限的文件夹后重试。');
  }
  return resolveNodePath();
}

function diagnosticReport(error, nodePath) {
  let version = '未知';
  try { version = require('./package.json').version || version; } catch (e) {}
  const lines = [
    '大明帝国文件管理 - 启动诊断',
    `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `程序版本: ${version}`,
    `系统: ${os.type()} ${os.release()} ${os.arch()}`,
    `程序目录: ${APP_DIR}`,
    `Node.js: ${nodePath || process.execPath}`,
    `目录可写: ${process.env.FILE_MANAGER_SKIP_WRITE_CHECK === '1' ? '由打包器检查' : (isDirectoryWritable() ? '是' : '否')}`,
    `状态文件: ${fs.existsSync(STATE_FILE) ? '存在' : '不存在'}`,
    '',
    '关键文件:'
  ];
  REQUIRED_FILES.forEach(file => lines.push(`- ${file}: ${fs.existsSync(path.join(APP_DIR, file)) ? '正常' : '缺失'}`));
  lines.push('', '离线依赖:');
  REQUIRED_DEPENDENCIES.forEach(name => {
    let available = false;
    try { require.resolve(name, { paths: [APP_DIR] }); available = true; } catch (e) {}
    lines.push(`- ${name}: ${available ? '正常' : '缺失'}`);
  });
  if (error) lines.push('', `错误: ${error.message || error}`);
  return lines.join('\r\n') + '\r\n';
}

function writeDiagnostic(error, nodePath) {
  try { fs.writeFileSync(DIAGNOSTIC_FILE, diagnosticReport(error, nodePath), 'utf8'); } catch (e) {}
}

function showError(message, error, nodePath) {
  const detail = `[${new Date().toISOString()}] ${message}${error ? `\n${error.stack || error.message || error}` : ''}\n`;
  try { fs.appendFileSync(ERROR_LOG, detail, 'utf8'); } catch (e) {}
  writeDiagnostic(error || new Error(message), nodePath);
  try {
    const quotedMessage = `'${String(message).replace(/'/g, "''")}'`;
    const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${quotedMessage}, '文件管理系统') | Out-Null`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore'
    }).unref();
  } catch (e) {}
}

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '', url], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
}

async function main() {
  if (process.argv.includes('--diagnose')) {
    try {
      const nodePath = runPreflight();
      writeDiagnostic(null, nodePath);
      process.stdout.write(`诊断通过：${DIAGNOSTIC_FILE}\n`);
    } catch (error) {
      writeDiagnostic(error);
      process.stderr.write(`诊断失败：${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  let startLock;
  try {
    startLock = acquireStartLock();
  } catch (error) {
    showError('无法创建启动状态，请确认程序目录具有写入权限。', error);
    process.exitCode = 1;
    return;
  }
  if (startLock === null) return;
  try {

    const current = readState();
    if (current) {
      const health = await waitForHealth(current.port, 3000);
      const sameProject = health && typeof health.projectDir === 'string'
        && path.resolve(health.projectDir).toLowerCase() === path.resolve(APP_DIR).toLowerCase();
      if (sameProject) {
        if (process.env.FILE_MANAGER_NO_BROWSER !== '1') openBrowser(health.port);
        return;
      }
      const portListening = !health && await isPortListening(current.port);
      if (!health && shouldPreserveUnresponsiveState(current, portListening)) {
        showError(
          '文件管理服务仍在运行，但暂时没有响应。可能正在处理大文件，请稍后再双击启动；不要重复启动。',
          new Error(`运行中的服务暂时无响应（PID ${current.pid}，端口 ${current.port}）`)
        );
        process.exitCode = 1;
        return;
      }
    }
    if (current) removeState();

    let nodePath;
    try {
      nodePath = runPreflight();
    } catch (error) {
      showError(error.message, error);
      process.exitCode = 1;
      return;
    }

    try { fs.unlinkSync(DIAGNOSTIC_FILE); } catch (e) {}
    try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] 正在启动服务\n`, 'utf8'); } catch (e) {}
    const child = spawn(nodePath, [SERVER_PATH], {
      cwd: APP_DIR,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, FILE_MANAGER_STATE_FILE: STATE_FILE, FILE_MANAGER_ERROR_LOG: ERROR_LOG, OPEN_BROWSER: '0' }
    });
    child.unref();

    let state = null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 12000) {
      state = readState();
      if (state && state.pid === child.pid) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!state || state.pid !== child.pid) {
      showError('服务启动失败，请查看启动错误.log 和诊断信息.txt。', new Error('服务未生成有效的启动状态'), nodePath);
      process.exitCode = 1;
      return;
    }

    const health = await waitForHealth(state.port);
    if (!health) {
      showError('服务启动超时，请查看启动错误.log 和诊断信息.txt。', new Error('健康检查超时'), nodePath);
      process.exitCode = 1;
      return;
    }
    if (process.env.FILE_MANAGER_NO_BROWSER !== '1') openBrowser(health.port);
  } finally {
    releaseStartLock(startLock);
  }
}

if (require.main === module) {
  main().catch(error => {
    showError(`启动失败：${error.message}`, error);
    process.exitCode = 1;
  });
}

module.exports = { acquireStartLock, isPortListening, releaseStartLock };
