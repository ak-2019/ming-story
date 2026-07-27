const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const test = require('node:test');
const { once } = require('events');
const { spawn } = require('child_process');
const { acquireBuildLock, releaseBuildLock } = require('../build/build-portable');
const { jsonRequest, makeTempDir } = require('../test-support/helpers');

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForState(stateFile, child, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${child.exitCode}`);
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('测试服务未生成状态文件');
}

test('打包锁拒绝第二个并发打包并可在释放后重新取得', () => {
  const root = makeTempDir();
  const lockFile = path.join(root, '.portable-build.lock');
  const first = acquireBuildLock(lockFile);
  try {
    assert.throws(() => acquireBuildLock(lockFile), /另一个打包任务正在运行/);
  } finally {
    releaseBuildLock(first);
  }
  const second = acquireBuildLock(lockFile);
  releaseBuildLock(second);
  assert.equal(fs.existsSync(lockFile), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('服务真正退出前保留状态文件，避免重复双击启动第二个实例', async t => {
  const root = makeTempDir();
  const scanRoot = path.join(root, 'scan');
  const stateFile = path.join(root, 'state.json');
  const errorLog = path.join(root, 'error.log');
  fs.mkdirSync(scanRoot);
  for (let i = 0; i < 96; i++) {
    const file = path.join(scanRoot, `撤回-${String(i).padStart(3, '0')}.mp3`);
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, 2 * 1024 * 1024);
    fs.closeSync(fd);
  }
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      MAX_PORT: String(port),
      FILE_MANAGER_STATE_FILE: stateFile,
      FILE_MANAGER_ERROR_LOG: errorLog,
      OPEN_BROWSER: '0'
    }
  });
  let scanResponse = null;
  t.after(() => {
    if (scanResponse) scanResponse.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  });

  const state = await waitForState(stateFile, child);
  const fingerprintStarted = new Promise((resolve, reject) => {
    const payload = JSON.stringify({ root: scanRoot });
    const request = http.request({
      hostname: '127.0.0.1',
      port: state.port,
      method: 'POST',
      path: '/api/scan-revoked-audio',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, response => {
      scanResponse = response;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (chunk.includes('"phase":"fingerprint"')) resolve();
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });

  await fingerprintStarted;
  const shutdown = await jsonRequest(state.port, 'POST', '/api/shutdown', { token: state.shutdownToken });
  assert.equal(shutdown.data.success, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
  assert.equal(fs.existsSync(stateFile), true);

  scanResponse.destroy();
  await once(child, 'exit');
  assert.equal(fs.existsSync(stateFile), false);
});
