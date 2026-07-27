const assert = require('assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const { indexZipEntries } = require('../build/build-portable');

test('ZIP 检查拒绝斜杠形式不同但目标相同的重复路径', () => {
  const zip = new JSZip();
  zip.file('file-manager\\launcher.js', 'old');
  zip.file('file-manager/launcher.js', 'new');
  assert.throws(() => indexZipEntries(zip), /ZIP 包含重复路径.*launcher\.js/);
});

test('ZIP 检查接受唯一的标准化路径', () => {
  const zip = new JSZip();
  zip.file('file-manager\\launcher.js', 'content');
  const entries = indexZipEntries(zip);
  assert.equal(entries.has('file-manager/launcher.js'), true);
});
