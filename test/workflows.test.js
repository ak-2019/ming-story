const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { app } = require('../server');
const {
  closeServer,
  createDocxBuffer,
  jsonRequest,
  makeTempDir,
  serverPort,
  ssePost,
  startAppServer
} = require('../test-support/helpers');

test('音频扫描、整理和一键撤回保持完整', async t => {
  const root = makeTempDir();
  const file = path.join(root, '第一集撤回.mp3');
  fs.writeFileSync(file, Buffer.from('test-audio'));
  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const scan = await ssePost(serverPort(server), '/api/scan-revoked-audio', { root });
  assert.equal(scan.success, true);
  assert.equal(scan.data.length, 1);
  assert.match(scan.data[0].sha256, /^[a-f0-9]{64}$/);

  const move = await ssePost(serverPort(server), '/api/move-revoked', { root, items: scan.data });
  assert.deepEqual(move.summary, { success: 1, skipped: 0, failed: 0 });
  assert.equal(fs.existsSync(file), false);
  assert.equal(move.restorable, true);

  const restore = await jsonRequest(serverPort(server), 'POST', '/api/restore-task', { root, taskId: move.taskId });
  assert.equal(restore.data.success, true);
  assert.deepEqual(restore.data.summary, { success: 1, skipped: 0, failed: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'test-audio');
});

test('同大小同时间但内容变化的音频不会使用过期扫描结果移动', async t => {
  const root = makeTempDir();
  const file = path.join(root, '第二集撤回.mp3');
  fs.writeFileSync(file, 'AAAA');
  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const scan = await ssePost(serverPort(server), '/api/scan-revoked-audio', { root });
  const candidate = scan.data[0];
  fs.writeFileSync(file, 'BBBB');
  fs.utimesSync(file, new Date(candidate.mtimeMs), new Date(candidate.mtimeMs));

  const move = await ssePost(serverPort(server), '/api/move-revoked', { root, items: [candidate] });
  assert.deepEqual(move.summary, { success: 0, skipped: 1, failed: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'BBBB');
});

test('Word 修改前备份并可恢复原内容', async t => {
  const root = makeTempDir();
  const file = path.join(root, '故事.docx');
  const original = await createDocxBuffer(['开场', '返场故事 撤回', '不应保留']);
  fs.writeFileSync(file, original);
  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const scan = await ssePost(serverPort(server), '/api/find-keywords', { root });
  assert.equal(scan.success, true);
  assert.equal(scan.data.length, 1);

  const remove = await ssePost(serverPort(server), '/api/remove-content', { root, items: scan.data });
  assert.deepEqual(remove.summary, { success: 1, skipped: 0, failed: 0 });
  assert.equal(remove.restorable, true);
  const changedText = await mammoth.extractRawText({ buffer: fs.readFileSync(file) });
  assert.equal(changedText.value.includes('返场故事'), false);
  assert.equal(changedText.value.includes('不应保留'), false);

  const restore = await jsonRequest(serverPort(server), 'POST', '/api/restore-task', { root, taskId: remove.taskId });
  assert.equal(restore.data.success, true);
  assert.equal(fs.readFileSync(file).equals(original), true);
});

test('Word 安装失败且临时原文件丢失时仍保留任务并可恢复', async t => {
  const root = makeTempDir();
  const file = path.join(root, '异常故事.docx');
  const original = await createDocxBuffer(['开场', '返场故事 撤回', '不应保留']);
  fs.writeFileSync(file, original);
  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const scan = await ssePost(serverPort(server), '/api/find-keywords', { root });
  assert.equal(scan.success, true);
  assert.equal(scan.data.length, 1);

  const originalRenameSync = fs.renameSync;
  let remove;
  fs.renameSync = function(source, destination) {
    const sourceText = String(source);
    if (destination === file && sourceText.startsWith(`${file}.ming-story-word-remove-`) && sourceText.endsWith('.tmp')) {
      const rollbackPath = `${sourceText.slice(0, -4)}.original`;
      fs.unlinkSync(rollbackPath);
      const error = new Error('模拟新文件安装失败');
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSync.apply(this, arguments);
  };
  try {
    remove = await ssePost(serverPort(server), '/api/remove-content', { root, items: scan.data });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(remove.summary, { success: 0, skipped: 0, failed: 1 });
  assert.equal(remove.restorable, true);
  assert.equal(fs.existsSync(file), false);
  const manifestPath = path.join(root, '备份文件夹', remove.taskId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.items[0].status, 'recovery-required');

  const restore = await jsonRequest(serverPort(server), 'POST', '/api/restore-task', { root, taskId: remove.taskId });
  assert.equal(restore.data.success, true);
  assert.deepEqual(restore.data.summary, { success: 1, skipped: 0, failed: 0 });
  assert.equal(fs.readFileSync(file).equals(original), true);
});

test('恢复中断的 Word 修改后清理临时原文件', async t => {
  const root = makeTempDir();
  const taskId = 'word-remove-recovery-test';
  const relativeFile = '故事.docx';
  const file = path.join(root, relativeFile);
  const backupRelativePath = path.join('备份文件夹', taskId, 'files', relativeFile);
  const backupPath = path.join(root, backupRelativePath);
  const recoveryPath = `${file}.ming-story-${taskId}.original`;
  const manifestPath = path.join(root, '备份文件夹', taskId, 'manifest.json');
  const original = await createDocxBuffer(['原内容']);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, original);
  fs.writeFileSync(recoveryPath, original);
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    taskId,
    type: 'remove-content',
    createdAt: new Date().toISOString(),
    items: [{
      originalRelativePath: relativeFile,
      backupRelativePath: backupRelativePath.replace(/\\/g, '/'),
      recoveryRelativePath: path.relative(root, recoveryPath).replace(/\\/g, '/'),
      status: 'recovery-required'
    }]
  }, null, 2), 'utf8');

  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const restore = await jsonRequest(serverPort(server), 'POST', '/api/restore-task', { root, taskId });
  assert.equal(restore.data.success, true);
  assert.deepEqual(restore.data.summary, { success: 1, skipped: 0, failed: 0 });
  assert.equal(fs.readFileSync(file).equals(original), true);
  assert.equal(fs.existsSync(recoveryPath), false);

  const savedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(savedManifest.items[0].status, 'restored');
  assert.equal(savedManifest.items[0].recoveryRelativePath, undefined);
});

test('Excel 可在浏览器中预览并转义单元格内容', async t => {
  const root = makeTempDir();
  const file = path.join(root, '表格.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['姓名', '说明'],
    ['张三', '<script>alert("x")</script> & 测试']
  ]), '名单');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['第二页']]), '补充');
  XLSX.writeFile(workbook, file);
  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const route = `/api/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`;
  const result = await jsonRequest(serverPort(server), 'GET', route);
  assert.equal(result.data.success, true);
  assert.equal(result.data.type, 'excel');
  assert.deepEqual(Object.keys(result.data.data), ['名单', '补充']);
  assert.match(result.data.data['名单'], /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; 测试/);
  assert.equal(result.data.data['名单'].includes('<script>'), false);
  assert.match(result.data.styled['补充'], /第二页/);
});

test('Excel 超出行数上限时会停止预览', async t => {
  const root = makeTempDir();
  const file = path.join(root, '超出行数.xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['内容']]);
  sheet['!ref'] = 'A1:A10001';
  XLSX.utils.book_append_sheet(workbook, sheet, '超出行数');
  XLSX.writeFile(workbook, file);
  const server = await startAppServer(app);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const route = `/api/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(file)}`;
  const result = await jsonRequest(serverPort(server), 'GET', route);
  assert.equal(result.data.success, false);
  assert.match(result.data.error, /内容过大/);
});
