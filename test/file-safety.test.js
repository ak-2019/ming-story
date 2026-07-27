const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { replaceFileSafely } = require('../server');
const { createDocxBuffer, makeTempDir } = require('../test-support/helpers');

test('Word 新文件安装失败且无法回滚时保留临时原文件并返回可恢复错误', async t => {
  const root = makeTempDir();
  const file = path.join(root, '故事.docx');
  const token = 'rollback-test';
  const tempPath = `${file}.ming-story-${token}.tmp`;
  const rollbackPath = `${file}.ming-story-${token}.original`;
  const original = await createDocxBuffer(['原内容']);
  const replacement = await createDocxBuffer(['新内容']);
  fs.writeFileSync(file, original);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const originalRenameSync = fs.renameSync;
  fs.renameSync = function(source, destination) {
    if (source === tempPath && destination === file) {
      const error = new Error('模拟新文件安装失败');
      error.code = 'EACCES';
      throw error;
    }
    if (source === rollbackPath && destination === file) {
      const error = new Error('模拟原文件回滚失败');
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSync.apply(this, arguments);
  };

  try {
    await assert.rejects(
      replaceFileSafely(file, replacement, token, original),
      error => error.code === 'ROLLBACK_FAILED' && error.recoveryPath === rollbackPath
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.readFileSync(rollbackPath).equals(original), true);
});

test('临时原文件意外丢失时仍返回可恢复错误', async t => {
  const root = makeTempDir();
  const file = path.join(root, '故事.docx');
  const token = 'missing-rollback-test';
  const tempPath = `${file}.ming-story-${token}.tmp`;
  const rollbackPath = `${file}.ming-story-${token}.original`;
  const original = await createDocxBuffer(['原内容']);
  const replacement = await createDocxBuffer(['新内容']);
  fs.writeFileSync(file, original);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const originalRenameSync = fs.renameSync;
  fs.renameSync = function(source, destination) {
    if (source === tempPath && destination === file) {
      fs.unlinkSync(rollbackPath);
      const error = new Error('模拟新文件安装失败');
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSync.apply(this, arguments);
  };

  try {
    await assert.rejects(
      replaceFileSafely(file, replacement, token, original),
      error => error.code === 'ROLLBACK_FAILED' && error.recoveryPath === undefined
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.existsSync(rollbackPath), false);
});
