const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { once } = require('events');
const { spawn } = require('child_process');
const launcherIdentity = require('../launcher');
const stopIdentity = require('../stop');
const buildIdentity = require('../build/build-portable');
const processIdentity = require('../process-identity');

function runScript(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`测试脚本运行超时：${scriptPath}`));
    }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function closeNetServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function createUnresponsiveStopFixture(pid, startedAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-story-stop-state-'));
  fs.copyFileSync(path.join(__dirname, '..', 'stop.js'), path.join(root, 'stop.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'process-identity.js'), path.join(root, 'process-identity.js'));
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stateFile = path.join(root, '.file-manager-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    pid,
    port: server.address().port,
    shutdownToken: 'test',
    startedAt
  }), 'utf8');
  return {
    root,
    stateFile,
    async close() {
      sockets.forEach(socket => socket.destroy());
      await closeNetServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

for (const [label, identity] of [['启动器', launcherIdentity], ['停止器', stopIdentity]]) {
  test(`${label}通过监听端口判断服务是否仍占用`, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    assert.equal(await identity.isPortListening(port), true);
    server.close();
    await once(server, 'close');
    assert.equal(await identity.isPortListening(port), false);
  });
}

test('打包器能够区分原进程和复用后的 PID', () => {
  const recordedAt = '2026-07-26T08:00:10.000Z';
  assert.equal(buildIdentity.processStartMatchesRecord(recordedAt, Date.parse('2026-07-26T08:00:00.000Z')), true);
  assert.equal(buildIdentity.processStartMatchesRecord(recordedAt, Date.parse('2026-07-26T08:00:20.000Z')), false);
  assert.equal(buildIdentity.processStartMatchesRecord('', null), true);
});

test('打包器在 PID 已被复用时不再认定旧任务仍运行', () => {
  const record = { pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z' };
  assert.equal(buildIdentity.isRecordedProcessRunning(record, Date.now()), false);
});

test('无响应端口只有在仍属于原进程时才保留状态', () => {
  const recordedAt = Date.now();
  const record = { pid: process.pid, startedAt: new Date(recordedAt).toISOString() };
  assert.equal(processIdentity.shouldPreserveUnresponsiveState(record, true, recordedAt - 1000), true);
  assert.equal(processIdentity.shouldPreserveUnresponsiveState(record, true, recordedAt + 5000), false);
  assert.equal(processIdentity.shouldPreserveUnresponsiveState(record, false, recordedAt - 1000), false);
});

test('启动器在启动锁 PID 已被复用时自动清理旧锁', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-story-start-lock-'));
  const lockFile = path.join(root, '.file-manager-start.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z' }), 'utf8');
  try {
    const lock = launcherIdentity.acquireStartLock(lockFile, Date.now());
    assert.ok(lock);
    launcherIdentity.releaseStartLock(lock);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('启动器保留仍属于原启动进程的有效锁', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ming-story-start-lock-active-'));
  const lockFile = path.join(root, '.file-manager-start.lock');
  const recordedAt = Date.now();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date(recordedAt).toISOString() }), 'utf8');
  try {
    assert.equal(launcherIdentity.acquireStartLock(lockFile, recordedAt - 1000), null);
    assert.equal(fs.existsSync(lockFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('停止器在旧端口被其他程序占用且原 PID 已不存在时自动清理状态', async t => {
  const fixture = await createUnresponsiveStopFixture(2147483647, '2020-01-01T00:00:00.000Z');
  t.after(() => fixture.close());
  const result = await runScript(path.join(fixture.root, 'stop.js'), fixture.root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.stateFile), false);
});
