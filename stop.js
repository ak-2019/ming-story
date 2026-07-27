const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const APP_DIR = __dirname;
const STATE_FILE = path.join(APP_DIR, '.file-manager-state.json');
const ERROR_LOG = path.join(APP_DIR, '停止错误.log');

function isRecordedProcessRunning(record) {
  return require('./process-identity').isRecordedProcessRunning(record);
}

function shouldPreserveUnresponsiveState(record, portListening) {
  return require('./process-identity').shouldPreserveUnresponsiveState(record, portListening);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
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

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      timeout: 1500,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
    }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(content) }); }
        catch (e) { reject(new Error('服务返回了无效响应')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const state = readState();
  if (!state) return;

  let health;
  try {
    health = await request(state.port, 'GET', '/api/health');
  } catch (e) {
    const portListening = await isPortListening(state.port);
    if (shouldPreserveUnresponsiveState(state, portListening)) {
      throw new Error('服务进程仍在运行，但暂时没有响应，可能正在处理大文件。请等待任务完成后再停止。');
    }
    removeState();
    return;
  }

  const sameProject = health.status === 200 && health.data.success
    && typeof health.data.projectDir === 'string'
    && path.resolve(health.data.projectDir).toLowerCase() === path.resolve(APP_DIR).toLowerCase();
  if (!sameProject) {
    removeState();
    return;
  }
  if (!state.shutdownToken) {
    throw new Error('状态文件缺少安全停止信息，已拒绝停止');
  }

  const result = await request(state.port, 'POST', '/api/shutdown', { token: state.shutdownToken });
  if (result.status !== 200 || !result.data.success) throw new Error(result.data.error || '服务拒绝停止');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const currentHealth = await request(state.port, 'GET', '/api/health');
      const sameInstance = currentHealth.status === 200 && currentHealth.data.success
        && currentHealth.data.pid === state.pid
        && typeof currentHealth.data.projectDir === 'string'
        && path.resolve(currentHealth.data.projectDir).toLowerCase() === path.resolve(APP_DIR).toLowerCase();
      if (!sameInstance) {
        removeState();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    } catch (e) {
      const portListening = await isPortListening(state.port);
      if (!shouldPreserveUnresponsiveState(state, portListening)) {
        removeState();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  const portListening = await isPortListening(state.port);
  if (!shouldPreserveUnresponsiveState(state, portListening)) {
    removeState();
    return;
  }
  throw new Error('服务未在预期时间内停止');
}

if (require.main === module) {
  main().catch(error => {
    try {
      fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${error.stack || error.message || error}\n`, 'utf8');
    } catch (e) {}
    process.stderr.write(`停止失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { isPortListening };
