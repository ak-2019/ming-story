const fs = require('fs');
const path = require('path');
const http = require('http');

const APP_DIR = __dirname;
const STATE_FILE = path.join(APP_DIR, '.file-manager-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

function removeState() {
  try { fs.unlinkSync(STATE_FILE); } catch (e) {}
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
    removeState();
    return;
  }

  const sameProject = health.status === 200 && health.data.success
    && health.data.pid === state.pid
    && typeof health.data.projectDir === 'string'
    && path.resolve(health.data.projectDir).toLowerCase() === path.resolve(APP_DIR).toLowerCase();
  if (!sameProject || !state.shutdownToken) {
    throw new Error('状态文件与正在运行的服务不匹配，已拒绝停止');
  }

  const result = await request(state.port, 'POST', '/api/shutdown', { token: state.shutdownToken });
  if (result.status !== 200 || !result.data.success) throw new Error(result.data.error || '服务拒绝停止');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await request(state.port, 'GET', '/api/health');
      await new Promise(resolve => setTimeout(resolve, 150));
    } catch (e) {
      removeState();
      return;
    }
  }
  throw new Error('服务未在预期时间内停止');
}

main().catch(error => {
  process.stderr.write(`停止失败：${error.message}\n`);
  process.exitCode = 1;
});
