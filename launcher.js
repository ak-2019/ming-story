const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
const SERVER_PATH = path.join(APP_DIR, 'server.js');
const STATE_FILE = path.join(APP_DIR, '.file-manager-state.json');
const ERROR_LOG = path.join(APP_DIR, '启动错误.log');

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

function showError(message) {
  const detail = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(ERROR_LOG, detail, 'utf8'); } catch (e) {}
  try {
    const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(message)}, '文件管理系统') | Out-Null`;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
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
  const current = readState();
  if (current) {
    const health = await waitForHealth(current.port, 3000);
    const sameProject = health && health.pid === current.pid
      && typeof health.projectDir === 'string'
      && path.resolve(health.projectDir).toLowerCase() === path.resolve(APP_DIR).toLowerCase();
    if (sameProject) {
      if (process.env.FILE_MANAGER_NO_BROWSER !== '1') openBrowser(health.port);
      return;
    }
  }
  if (current) removeState();

  if (!fs.existsSync(SERVER_PATH)) {
    showError('缺少 server.js，请重新解压完整的程序文件夹。');
    process.exitCode = 1;
    return;
  }

  const runtimeNode = path.join(APP_DIR, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodePath = fs.existsSync(runtimeNode) ? runtimeNode : process.execPath;
  const child = spawn(nodePath, [SERVER_PATH], {
    cwd: APP_DIR,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, FILE_MANAGER_STATE_FILE: STATE_FILE, OPEN_BROWSER: '0' }
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
    showError('服务启动失败，请查看启动错误.log。');
    process.exitCode = 1;
    return;
  }

  const health = await waitForHealth(state.port);
  if (!health) {
    showError('服务启动超时，请查看启动错误.log。');
    return;
  }
  if (process.env.FILE_MANAGER_NO_BROWSER !== '1') openBrowser(health.port);
}

main().catch(error => {
  showError(`启动失败：${error.message}`);
  process.exitCode = 1;
});
