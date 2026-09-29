import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(srcDir, '..');
const dataDir = path.join(projectRoot, 'data');
const tokenFile = path.join(dataDir, 'tokens.json');
const historyFile = path.join(dataDir, 'history.json');
const settingsFile = path.join(dataDir, 'settings.json');
const plannerFile = path.join(dataDir, 'planner.json');
const templateFile = path.join(dataDir, 'templates.json');
const plannerLockFile = path.join(dataDir, '.planner.lock');

function ensureDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode = 0o600) {
  ensureDir();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Windows can ignore POSIX permission bits.
  }
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withPlannerLock(callback, fallback) {
  ensureDir();
  let fd = null;
  try {
    for (let attempt = 0; attempt < 25 && fd === null; attempt += 1) {
      try {
        fd = fs.openSync(plannerLockFile, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(plannerLockFile);
          if (Date.now() - stat.mtimeMs > 60_000) {
            fs.unlinkSync(plannerLockFile);
            continue;
          }
        } catch {
          // Another process may have released the lock between stat/unlink.
        }
        if (attempt < 24) sleepSync(10);
      }
    }
    if (fd === null) return fallback;
    return callback();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(plannerLockFile); } catch {}
    }
  }
}

export function getTokens() {
  return readJson(tokenFile, {});
}

export function savePlatformToken(platform, value) {
  const current = getTokens();
  current[platform] = value;
  writeJson(tokenFile, current);
  return current[platform];
}

export function clearPlatformToken(platform) {
  const current = getTokens();
  delete current[platform];
  writeJson(tokenFile, current);
}

export function getHistory(limit = 100) {
  const history = readJson(historyFile, []);
  return history.slice(0, Math.max(1, Math.min(Number(limit) || 100, 100)));
}

export function addHistory(entry) {
  const history = getHistory(100);
  history.unshift(entry);
  writeJson(historyFile, history.slice(0, 100), 0o600);
}

export function getAppSettings() {
  return readJson(settingsFile, {});
}

export function saveAppSettings(settings) {
  writeJson(settingsFile, settings, 0o600);
  return settings;
}

export function getPlannerItems(limit = 500) {
  const items = readJson(plannerFile, []);
  const max = Math.max(1, Math.min(Number(limit) || 500, 1000));
  return [...items]
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, max);
}

export function getPlannerItem(id) {
  return getPlannerItems(1000).find((item) => item.id === id) || null;
}

export function savePlannerItem(entry) {
  return withPlannerLock(() => {
    const items = readJson(plannerFile, []);
    const index = items.findIndex((item) => item.id === entry.id);
    if (index >= 0) items[index] = entry;
    else items.unshift(entry);
    writeJson(plannerFile, items.slice(0, 1000), 0o600);
    return entry;
  }, null);
}

export function deletePlannerItem(id) {
  return withPlannerLock(() => {
    const items = readJson(plannerFile, []);
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = items.splice(index, 1);
    writeJson(plannerFile, items, 0o600);
    return removed;
  }, null);
}


export function claimPlannerItem(id, allowedStatuses = ['draft', 'scheduled']) {
  return withPlannerLock(() => {
    const items = readJson(plannerFile, []);
    const item = items.find((candidate) => candidate.id === id);
    if (!item || !allowedStatuses.includes(item.status)) return null;
    const claimedAt = new Date().toISOString();
    item.status = 'processing';
    item.processingStartedAt = claimedAt;
    item.updatedAt = claimedAt;
    item.lastError = null;
    writeJson(plannerFile, items, 0o600);
    return structuredClone(item);
  }, null);
}

export function claimDuePlannerItems(now = new Date(), limit = 3) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return [];
  return withPlannerLock(() => {
    const items = readJson(plannerFile, []);
    const due = items
      .filter((item) => item.status === 'scheduled' && item.scheduledAt && new Date(item.scheduledAt).getTime() <= nowMs)
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
      .slice(0, Math.max(1, Math.min(Number(limit) || 3, 10)));
    if (!due.length) return [];
    const claimedAt = new Date(nowMs).toISOString();
    const ids = new Set(due.map((item) => item.id));
    for (const item of items) {
      if (!ids.has(item.id)) continue;
      item.status = 'processing';
      item.processingStartedAt = claimedAt;
      item.updatedAt = claimedAt;
      item.lastError = null;
    }
    writeJson(plannerFile, items, 0o600);
    return items.filter((item) => ids.has(item.id)).map((item) => structuredClone(item));
  }, []);
}

export function recoverInterruptedPlannerItems(maxProcessingAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  return withPlannerLock(() => {
    const items = readJson(plannerFile, []);
    let changed = 0;
    for (const item of items) {
      if (item.status !== 'processing') continue;
      const started = new Date(item.processingStartedAt || item.updatedAt || item.createdAt || 0).getTime();
      if (Number.isFinite(started) && now - started < maxProcessingAgeMs) continue;
      item.status = 'needs_review';
      item.updatedAt = new Date(now).toISOString();
      item.lastError = 'O servidor foi interrompido durante a publicação. Revise o item antes de tentar novamente para evitar duplicidade.';
      item.processingStartedAt = null;
      changed += 1;
    }
    if (changed) writeJson(plannerFile, items, 0o600);
    return changed;
  }, 0);
}


export function getTemplates(limit = 200) {
  const templates = readJson(templateFile, []);
  const max = Math.max(1, Math.min(Number(limit) || 200, 500));
  return [...templates]
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, max);
}

export function getTemplate(id) {
  return getTemplates(500).find((item) => item.id === id) || null;
}

export function saveTemplate(entry) {
  const templates = readJson(templateFile, []);
  const index = templates.findIndex((item) => item.id === entry.id);
  if (index >= 0) templates[index] = entry;
  else templates.unshift(entry);
  writeJson(templateFile, templates.slice(0, 500), 0o600);
  return entry;
}

export function deleteTemplate(id) {
  const templates = readJson(templateFile, []);
  const index = templates.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [removed] = templates.splice(index, 1);
  writeJson(templateFile, templates, 0o600);
  return removed;
}
