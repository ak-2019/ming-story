const { execFileSync } = require('child_process');

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processStartMatchesRecord(recordedAt, actualStartedAt) {
  const recordedTime = typeof recordedAt === 'number' ? recordedAt : Date.parse(recordedAt || '');
  const actualTime = typeof actualStartedAt === 'number' ? actualStartedAt : Date.parse(actualStartedAt || '');
  if (!Number.isFinite(recordedTime) || !Number.isFinite(actualTime)) return true;
  return actualTime <= recordedTime + 2000;
}

function readProcessStartTime(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const script = `$processInfo = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write(([DateTimeOffset]$processInfo.StartTime).ToUnixTimeMilliseconds())`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const startedAt = Number(String(output).trim());
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch (error) {
    return null;
  }
}

function isRecordedProcessRunning(record, actualStartedAt = undefined) {
  if (!record || !isProcessRunning(record.pid)) return false;
  const observedStartTime = actualStartedAt === undefined ? readProcessStartTime(record.pid) : actualStartedAt;
  return processStartMatchesRecord(record.startedAt, observedStartTime);
}

function shouldPreserveUnresponsiveState(record, portListening, actualStartedAt = undefined) {
  return Boolean(portListening && isRecordedProcessRunning(record, actualStartedAt));
}

module.exports = {
  isProcessRunning,
  isRecordedProcessRunning,
  processStartMatchesRecord,
  readProcessStartTime,
  shouldPreserveUnresponsiveState
};
