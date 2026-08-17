const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4318);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const PROFILE_DIR = path.join(DATA_DIR, 'account-profiles');
const LIBRARY_DIR = path.join(ROOT, '用户素材库');
const LIBRARY_CATEGORIES = ['人物', '环境', '物品', '风格', '提示词文本'];
const DB_FILE = path.join(DATA_DIR, 'studio.json');
const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function blankCanvas() {
  return { images:{}, drafts:[], texts:[], videos:[], view:{ x:140, y:110, scale:.8 } };
}

function publicCanvas(value) {
  const canvas = value && typeof value === 'object' && !Array.isArray(value) ? value : blankCanvas();
  return {
    images: canvas.images && typeof canvas.images === 'object' && !Array.isArray(canvas.images) ? canvas.images : {},
    drafts: Array.isArray(canvas.drafts) ? canvas.drafts : [],
    texts: Array.isArray(canvas.texts) ? canvas.texts : [],
    videos: Array.isArray(canvas.videos) ? canvas.videos : [],
    view: canvas.view && typeof canvas.view === 'object' ? canvas.view : blankCanvas().view,
  };
}

function initialDb() {
  return {
    version: 1,
    bridgeKey: crypto.randomBytes(24).toString('hex'),
    workspaces: [{ id: 'workspace_default', name: '未命名工作区', createdAt: now() }],
    canvases: {},
    assets: [],
    jobs: [],
    accounts: [],
  };
}

async function setupDb() {
  await Promise.all([fsp.mkdir(ASSET_DIR, { recursive: true }), fsp.mkdir(VIDEO_DIR, { recursive: true }), fsp.mkdir(PROFILE_DIR, { recursive: true }), ...LIBRARY_CATEGORIES.map((category) => fsp.mkdir(path.join(LIBRARY_DIR, category), { recursive: true }))]);
  try {
    const loaded = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    let changed = false;
    if (!Array.isArray(loaded.workspaces) || !loaded.workspaces.length) {
      loaded.workspaces = [{ id: 'workspace_default', name: '未命名工作区', createdAt: now() }];
      for (const asset of loaded.assets || []) asset.workspaceId ||= 'workspace_default';
      for (const job of loaded.jobs || []) job.workspaceId ||= 'workspace_default';
      changed = true;
    }
    if (!loaded.canvases || typeof loaded.canvases !== 'object' || Array.isArray(loaded.canvases)) { loaded.canvases = {}; changed = true; }
    if (changed) await saveDb(loaded);
    return loaded;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const db = initialDb();
    await saveDb(db);
    return db;
  }
}

let dbPromise = setupDb();
async function db() { return dbPromise; }
let saveQueue = Promise.resolve();
async function saveDb(nextDb) {
  // 路由请求可并行抵达；把每次调用当下的快照排队写入，避免多个请求抢同一个 .tmp 文件。
  const snapshot = JSON.stringify(nextDb, null, 2);
  const write = saveQueue.then(async () => {
    const temporary = `${DB_FILE}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, snapshot, 'utf8');
    await fsp.rename(temporary, DB_FILE);
  });
  saveQueue = write.catch(() => {});
  return write;
}

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Doubao-Studio-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  response.end(JSON.stringify(value));
}

function error(response, status, message) {
  json(response, status, { error: message });
}

function mimeFor(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
  }[extension] || 'application/octet-stream';
}

function isSafeFileName(value) {
  return /^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff._-]*$/.test(value || '');
}

function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && [
      'doubao.com', 'douyin.com', 'snssdk.com', 'byteimg.com', 'bytedance.com',
      'bytecdn.cn', 'bytecdn.com', 'ibytedtos.com', 'douyinvod.com', 'bytevod.com'
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_JSON_BYTES) throw new Error('请求超过 100MB 限制');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function requireBridgeKey(request, currentDb, response) {
  if (request.headers['x-doubao-studio-key'] !== currentDb.bridgeKey) {
    error(response, 401, '本地桥接密钥不匹配');
    return false;
  }
  return true;
}

function publicAsset(asset) {
  return {
    id: asset.id, name: asset.name, description: asset.description, mime: asset.mime,
    workspaceId: asset.workspaceId, createdAt: asset.createdAt, url: `/assets/${asset.fileName}`,
  };
}

function libraryMime(fileName) {
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' }[path.extname(fileName).toLowerCase()] || null;
}

async function listLibrary() {
  const groups = await Promise.all(LIBRARY_CATEGORIES.map(async (category) => {
    const directory = path.join(LIBRARY_DIR, category);
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && isSafeFileName(entry.name)) files.push({ fileName: entry.name, folder: '' });
      if (entry.isDirectory() && isSafeFileName(entry.name)) {
        const nested = await fsp.readdir(path.join(directory, entry.name), { withFileTypes: true }).catch(() => []);
        nested.filter((item) => item.isFile() && isSafeFileName(item.name)).forEach((item) => files.push({ fileName: item.name, folder: entry.name }));
      }
    }
    return files.map(({ fileName, folder }) => {
      const mime = libraryMime(fileName); if (!mime) return null;
      const relativePath = folder ? `${folder}/${fileName}` : fileName;
      return { id: `library:${category}:${relativePath}`, category, folder, fileName, name: path.basename(fileName, path.extname(fileName)), mime, url: `/library/${encodeURIComponent(category)}/${relativePath.split('/').map(encodeURIComponent).join('/')}` };
    });
  }));
  return groups.flat().flat().filter(Boolean);
}

function publicJob(job) {
  return {
    ...job,
    assets: [...job.assetIds.map((id) => dbCache.assets.find((asset) => asset.id === id)).filter(Boolean).map(publicAsset), ...(job.libraryAssets || [])],
  };
}
function releaseStaleDispatches(currentDb) {
  const cutoff = Date.now() - 90 * 1000;
  let changed = false;
  for (const job of currentDb.jobs) {
    if (job.status !== 'dispatching' || !job.updatedAt || Date.parse(job.updatedAt) >= cutoff) continue;
    job.status = 'queued'; job.statusDetail = '此前领取任务的历史页面未继续执行，已回到 Worker 队列'; job.updatedAt = now();
    delete job.accountId; delete job.accountName; delete job.workerId;
    job.events.push({ at:now(), type:'queued', detail:job.statusDetail }); changed = true;
  }
  return changed;
}

function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }
function normalizeAccount(account) {
  const date = today();
  if (account.usageDate !== date) { account.usageDate = date; account.usedToday = 0; }
  account.dailyLimit = Math.max(1, Math.min(20, Number(account.dailyLimit) || 3));
  account.usedToday = Math.max(0, Number(account.usedToday) || 0);
  account.maxWorkers = Math.max(1, Math.min(3, Number(account.maxWorkers) || 3));
  return account;
}
function publicAccount(account, currentDb = dbCache) {
  normalizeAccount(account);
  const reservedToday = (currentDb?.jobs || []).filter((job) => job.accountId === account.id && ['dispatching', 'prepared', 'submitted', 'generating'].includes(job.status)).length;
  return { id:account.id, name:account.name, status:account.status || '未连接', usedToday:account.usedToday, reservedToday, dailyLimit:account.dailyLimit, maxWorkers:account.maxWorkers, lastSeen:account.lastSeen || null, lastDetail:account.lastDetail || '', createdAt:account.createdAt };
}
function shanghaiDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' }); }
function reconcileDailyQuota(currentDb) {
  let changed = false;
  for (const account of currentDb.accounts) {
    normalizeAccount(account);
    // 额度只以真正产出成片为准。旧版在 submitted 时扣过额度，这里同时完成
    // 一次兼容修复，使人脸卡审/生成失败不会遗留虚假的已用次数。
    const successful = currentDb.jobs.filter((job) => job.accountId === account.id && job.status === 'succeeded' && shanghaiDate(job.updatedAt) === account.usageDate).length;
    if (account.usedToday !== successful) { account.usedToday = successful; changed = true; }
  }
  return changed;
}
function chromeExecutable() {
  // 正式版 Google Chrome 137+ 会忽略 --load-extension。工作台携带的
  // Chrome for Testing 是隔离的自动化运行时，仍可安全地预装本机桥接扩展。
  const candidates = [path.join(ROOT, 'runtime', 'chrome-win64', 'chrome.exe'), process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'), process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}
function foregroundAccountWindow(profileDir, processId) {
  // chrome.windows.update 只能在 Chrome 自己的窗口内切标签；Windows 仍可能拒绝
  // 后台进程抢焦点，导致豆包页面不绘制也不响应控件。这里按独立 Profile 找到
  // 对应顶层窗口，使用 Windows 前台 API 恢复并激活它。
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(ROOT, 'scripts', 'foreground-account-window.ps1');
  if (!fs.existsSync(powershell) || !fs.existsSync(script)) return;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProfilePath', profileDir, '-LogPath', path.join(DATA_DIR, 'window-focus.log')];
  if (processId) args.push('-ChromeProcessId', String(processId));
  const child = spawn(powershell, args, { detached:true, stdio:'ignore', windowsHide:true });
  child.unref();
}
function launchAccountWindow(account, token) {
  const chrome = chromeExecutable();
  if (!chrome) throw new Error('未找到 Google Chrome；请安装 Chrome 后重试');
  const extensionDir = path.join(ROOT, 'bridge-extension');
  const loginUrl = `https://www.doubao.com/chat?channel=baidu_pz&dnst=${encodeURIComponent(token)}`;
  const child = spawn(chrome, [`--user-data-dir=${account.profileDir}`, '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--new-window', loginUrl], { detached:true, stdio:'ignore', windowsHide:false });
  child.unref();
  // 进程刚启动时还没有可枚举的顶层窗口；稍后多次尝试，覆盖“已有 Chrome
  // 进程接收新窗口请求”和“全新 Profile 冷启动”两种情况。
  setTimeout(() => foregroundAccountWindow(account.profileDir, child.pid), 450);
  setTimeout(() => foregroundAccountWindow(account.profileDir, child.pid), 1450);
}
function accountHeartbeatFresh(account) {
  const seen = Date.parse(account.lastSeen || '');
  return Number.isFinite(seen) && Date.now() - seen < 45 * 1000;
}
function wakeAvailableAccount(currentDb, { forceWorker = false } = {}) {
  const candidates = currentDb.accounts.map(normalizeAccount).filter((account) => account.usedToday < account.dailyLimit);
  if (!candidates.length || (!forceWorker && candidates.some(accountHeartbeatFresh))) return null;
  const account = candidates.sort((a, b) => (Number(a.usedToday) - Number(b.usedToday)) || ((Date.parse(a.lastSeen || '') || 0) - (Date.parse(b.lastSeen || '') || 0)))[0];
  const requestedAt = Date.parse(account.launchRequestedAt || '');
  if (Number.isFinite(requestedAt) && Date.now() - requestedAt < (forceWorker ? 12 : 30) * 1000) return null;
  account.bootstrapToken = crypto.randomBytes(24).toString('hex'); account.bootstrapExpiresAt = Date.now() + 15 * 60 * 1000;
  account.launchRequestedAt = now(); account.status = '正在自动打开账号窗口'; account.lastDetail = forceWorker ? '新任务已入队，正在拉起前台 Worker 页面' : '检测到有待处理视频任务，正在恢复账号容器';
  launchAccountWindow(account, account.bootstrapToken);
  return account;
}

let dbCache;
async function refreshCache() { dbCache = await db(); return dbCache; }

function expandPrompt(job, currentDb) {
  const assets = [...job.assetIds.map((id) => currentDb.assets.find((asset) => asset.id === id)).filter(Boolean), ...(job.libraryAssets || [])];
  let prompt = job.prompt;
  for (const [index, asset] of assets.entries()) {
    const escaped = asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    prompt = prompt.replace(new RegExp(`@${escaped}`, 'g'), `图${index + 1}`);
  }
  // 图号的视觉锚定说明完全由用户提示词控制；绝不把无意义的文件名擅自写入豆包。
  return prompt.trim();
}

async function serveFile(request, response, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return error(response, 404, '文件不存在');
    // 成片文件名由任务 ID 与时间戳组成，写入后不会再变；允许浏览器缓存，
    // 结合 Range 请求可避免播放时反复从磁盘重新读取。
    const cacheControl = filePath.startsWith(VIDEO_DIR) ? 'public, max-age=86400, immutable' : 'no-store';
    const range = request.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startText, endText] = range.slice(6).split('-');
      const start = startText ? Number(startText) : Math.max(0, stat.size - Number(endText || 0));
      const end = endText ? Math.min(Number(endText), stat.size - 1) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
      response.writeHead(206, { 'Content-Type': mimeFor(filePath), 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl });
      fs.createReadStream(filePath, { start, end }).pipe(response); return;
    }
    response.writeHead(200, { 'Content-Type': mimeFor(filePath), 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl });
    fs.createReadStream(filePath).pipe(response);
  } catch {
    error(response, 404, '文件不存在');
  }
}

async function route(request, response) {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const currentDb = await refreshCache();
  if (reconcileDailyQuota(currentDb)) await saveDb(currentDb);
  if (request.method === 'OPTIONS') return json(response, 204, {});

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const workspaceId = url.searchParams.get('workspaceId') || currentDb.workspaces[0].id;
    return json(response, 200, {
      bridgeKey: currentDb.bridgeKey,
      workspaces: currentDb.workspaces,
      activeWorkspaceId: workspaceId,
      canvas: currentDb.canvases[workspaceId] ? publicCanvas(currentDb.canvases[workspaceId]) : null,
      assets: currentDb.assets.filter((asset) => asset.workspaceId === workspaceId).map(publicAsset),
      jobs: currentDb.jobs.filter((job) => job.workspaceId === workspaceId).slice().reverse().map(publicJob),
      accounts: currentDb.accounts.map(publicAccount),
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/library') {
    return json(response, 200, { root: LIBRARY_DIR, categories: LIBRARY_CATEGORIES, items: await listLibrary() });
  }

  if (request.method === 'POST' && url.pathname === '/api/accounts') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request);
    const account = normalizeAccount({ id:uid('account'), name:String(body.name || `豆包账号 ${currentDb.accounts.length + 1}`).trim().slice(0, 40) || `豆包账号 ${currentDb.accounts.length + 1}`, profileDir:'', status:'等待登录', usageDate:today(), usedToday:0, dailyLimit:3, maxWorkers:3, createdAt:now(), lastSeen:null, lastDetail:'' });
    account.profileDir = path.join(PROFILE_DIR, account.id);
    await fsp.mkdir(account.profileDir, { recursive:true });
    account.bootstrapToken = crypto.randomBytes(24).toString('hex'); account.bootstrapExpiresAt = Date.now() + 15 * 60 * 1000; account.launchRequestedAt = now();
    currentDb.accounts.push(account); await saveDb(currentDb);
    try { launchAccountWindow(account, account.bootstrapToken); }
    catch (cause) { account.status = '启动失败'; account.lastDetail = cause.message || String(cause); await saveDb(currentDb); return error(response, 500, account.lastDetail); }
    return json(response, 201, { account:publicAccount(account) });
  }

  const accountLaunch = url.pathname.match(/^\/api\/accounts\/(account_[\w-]+)\/launch$/);
  if (request.method === 'POST' && accountLaunch) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const account = currentDb.accounts.find((item) => item.id === accountLaunch[1]); if (!account) return error(response, 404, '账号容器不存在');
    account.bootstrapToken = crypto.randomBytes(24).toString('hex'); account.bootstrapExpiresAt = Date.now() + 15 * 60 * 1000; account.launchRequestedAt = now(); account.status = '正在启动'; await saveDb(currentDb);
    try { launchAccountWindow(account, account.bootstrapToken); }
    catch (cause) { account.status = '启动失败'; account.lastDetail = cause.message || String(cause); await saveDb(currentDb); return error(response, 500, account.lastDetail); }
    return json(response, 200, { account:publicAccount(account) });
  }

  if (request.method === 'POST' && url.pathname === '/api/bridge/bootstrap') {
    const body = await readJson(request);
    const token = String(body.token || '');
    const account = currentDb.accounts.find((item) => item.bootstrapToken === token && Number(item.bootstrapExpiresAt) > Date.now());
    if (!account) return error(response, 401, '账号窗口初始化链接已失效，请在工作台重新打开账号窗口');
    delete account.bootstrapToken; delete account.bootstrapExpiresAt; account.status = '已登录，等待桥接'; account.lastSeen = now(); await saveDb(currentDb);
    return json(response, 200, { origin:`http://${HOST}:${PORT}`, key:currentDb.bridgeKey, accountId:account.id, accountName:account.name });
  }

  const accountHeartbeat = url.pathname.match(/^\/api\/bridge\/accounts\/(account_[\w-]+)\/heartbeat$/);
  if (request.method === 'POST' && accountHeartbeat) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const account = currentDb.accounts.find((item) => item.id === accountHeartbeat[1]); if (!account) return error(response, 404, '账号容器不存在');
    const body = await readJson(request); normalizeAccount(account); account.status = String(body.state || '已连接').slice(0, 40); account.lastDetail = String(body.detail || '').slice(0, 160); account.lastSeen = now(); await saveDb(currentDb);
    return json(response, 200, { account:publicAccount(account) });
  }

  if (request.method === 'POST' && url.pathname === '/api/library') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request); const category = String(body.category || '');
    if (!LIBRARY_CATEGORIES.includes(category)) return error(response, 400, '素材库分类无效');
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'text/plain']);
    if (!allowed.has(body.mime) || typeof body.dataUrl !== 'string') return error(response, 400, '素材库仅支持图片或文本文件');
    const match = body.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match || match[1] !== body.mime) return error(response, 400, '素材库文件格式无效');
    const extension = body.mime === 'image/png' ? '.png' : body.mime === 'image/webp' ? '.webp' : body.mime === 'text/plain' ? '.txt' : '.jpg';
    const baseName = String(body.name || '素材').replace(/[^\w\-\u4e00-\u9fff]/g, '_').slice(0, 80) || '素材';
    const folder = String(body.folder || '').replace(/[^\w\-\u4e00-\u9fff]/g, '_').slice(0, 60);
    const fileName = `${baseName}_${Date.now()}${extension}`;
    const targetDir = folder ? path.join(LIBRARY_DIR, category, folder) : path.join(LIBRARY_DIR, category);
    await fsp.mkdir(targetDir, { recursive: true }); await fsp.writeFile(path.join(targetDir, fileName), Buffer.from(match[2], 'base64'));
    const item = (await listLibrary()).find((candidate) => candidate.category === category && candidate.fileName === fileName && candidate.folder === folder);
    return json(response, 201, { item });
  }

  if (request.method === 'POST' && url.pathname === '/api/workspaces') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request);
    const workspace = { id: uid('workspace'), name: String(body.name || '未命名工作区').slice(0, 60), createdAt: now() };
    currentDb.workspaces.push(workspace); await saveDb(currentDb);
    return json(response, 201, { workspace });
  }

  const workspaceUpdate = url.pathname.match(/^\/api\/workspaces\/(workspace_[\w-]+)$/);
  if (request.method === 'POST' && workspaceUpdate) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request); const workspace = currentDb.workspaces.find((item) => item.id === workspaceUpdate[1]);
    if (!workspace) return error(response, 404, '工作区不存在');
    workspace.name = String(body.name || '').trim().slice(0, 60) || workspace.name;
    await saveDb(currentDb); return json(response, 200, { workspace });
  }

  const workspaceCanvas = url.pathname.match(/^\/api\/workspaces\/(workspace_[\w-]+)\/canvas$/);
  if (workspaceCanvas && request.method === 'POST') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const workspaceId = workspaceCanvas[1];
    if (!currentDb.workspaces.some((item) => item.id === workspaceId)) return error(response, 404, '工作区不存在');
    const body = await readJson(request);
    if (!body.canvas || typeof body.canvas !== 'object' || Array.isArray(body.canvas)) return error(response, 400, '画布数据格式无效');
    const serialized = JSON.stringify(body.canvas);
    if (Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024) return error(response, 413, '画布数据过大');
    currentDb.canvases[workspaceId] = publicCanvas(body.canvas);
    await saveDb(currentDb);
    return json(response, 200, { canvas: currentDb.canvases[workspaceId] });
  }

  if (request.method === 'POST' && url.pathname === '/api/assets') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request);
    const workspaceId = String(body.workspaceId || '');
    if (!currentDb.workspaces.some((workspace) => workspace.id === workspaceId)) return error(response, 400, '工作区不存在');
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowed.has(body.mime) || typeof body.dataUrl !== 'string') return error(response, 400, '仅支持 PNG、JPEG、WebP 图片');
    const match = body.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match || match[1] !== body.mime) return error(response, 400, '图片数据格式无效');
    const extension = body.mime === 'image/png' ? '.png' : body.mime === 'image/webp' ? '.webp' : '.jpg';
    const asset = {
      id: uid('asset'), workspaceId, name: String(body.name || `素材${currentDb.assets.length + 1}`).slice(0, 80),
      description: String(body.description || '').slice(0, 240), mime: body.mime,
      fileName: `${crypto.randomUUID()}${extension}`, createdAt: now(),
    };
    await fsp.writeFile(path.join(ASSET_DIR, asset.fileName), Buffer.from(match[2], 'base64'));
    currentDb.assets.push(asset); await saveDb(currentDb);
    return json(response, 201, { asset: publicAsset(asset) });
  }

  const assetDelete = url.pathname.match(/^\/api\/assets\/(asset_[\w-]+)$/);
  if (request.method === 'DELETE' && assetDelete) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const index = currentDb.assets.findIndex((asset) => asset.id === assetDelete[1]);
    if (index < 0) return error(response, 404, '素材不存在');
    const [asset] = currentDb.assets.splice(index, 1);
    currentDb.jobs.forEach((job) => { job.assetIds = job.assetIds.filter((id) => id !== asset.id); });
    await fsp.unlink(path.join(ASSET_DIR, asset.fileName)).catch(() => {});
    await saveDb(currentDb); return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request);
    const workspaceId = String(body.workspaceId || '');
    if (!currentDb.workspaces.some((workspace) => workspace.id === workspaceId)) return error(response, 400, '工作区不存在');
    const assetIds = Array.isArray(body.assetIds) ? body.assetIds.filter((id) => currentDb.assets.some((asset) => asset.id === id && asset.workspaceId === workspaceId)) : [];
    if (!String(body.prompt || '').trim()) return error(response, 400, '请填写视频提示词');
    const availableLibrary = await listLibrary();
    const requestedLibraryIds = Array.isArray(body.libraryAssetIds) ? body.libraryAssetIds : [];
    const libraryAssets = requestedLibraryIds.map((id) => availableLibrary.find((item) => item.id === id && item.mime.startsWith('image/'))).filter(Boolean);
    const requestedDuration = Number.parseInt(String(body.sourceDuration || '10').replace(/\D/g, ''), 10);
    const sourceDuration = `${Math.min(10, Math.max(4, Number.isFinite(requestedDuration) ? requestedDuration : 10))}s`;
    const job = {
      id: uid('job'), workspaceId, nodeId: String(body.nodeId || '').slice(0, 100), prompt: String(body.prompt).slice(0, 16000), assetIds, libraryAssets,
      model: String(body.model || 'Seedance 2.0 Fast'), aspect: String(body.aspect || '自动'),
      sourceDuration, mainWindow: String(body.mainWindow || '0–10s'), tailPlan: String(body.tailPlan || '完整保留'),
      status: 'queued', statusDetail: '等待已连接的 Chrome 扩展处理', events: [{ at: now(), type: 'queued', detail: '本地工作台已入队' }],
      createdAt: now(), updatedAt: now(), result: null,
    };
    currentDb.jobs.push(job);
    let awakened = null;
    try { awakened = wakeAvailableAccount(currentDb, { forceWorker:true }); }
    catch (cause) { const account = currentDb.accounts.find((item) => item.status === '正在自动打开账号窗口'); if (account) { account.status = '启动失败'; account.lastDetail = cause.message || String(cause); } }
    await saveDb(currentDb);
    return json(response, 201, { job: publicJob(job), awakenedAccount:awakened ? publicAccount(awakened) : null });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/jobs') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const workspaceId = String(url.searchParams.get('workspaceId') || '');
    if (!currentDb.workspaces.some((workspace) => workspace.id === workspaceId)) return error(response, 400, '工作区不存在');
    const before = currentDb.jobs.length;
    currentDb.jobs = currentDb.jobs.filter((job) => job.workspaceId !== workspaceId);
    await saveDb(currentDb);
    return json(response, 200, { ok: true, removed: before - currentDb.jobs.length });
  }

  const jobDelete = url.pathname.match(/^\/api\/jobs\/(job_[\w-]+)$/);
  if (request.method === 'DELETE' && jobDelete) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const index = currentDb.jobs.findIndex((job) => job.id === jobDelete[1]);
    if (index < 0) return error(response, 404, '任务不存在');
    currentDb.jobs.splice(index, 1); await saveDb(currentDb);
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/bridge/next') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const releasedStale = releaseStaleDispatches(currentDb);
    const accountId = String(url.searchParams.get('accountId') || '');
    if (!accountId && currentDb.accounts.length) return json(response, 200, { job:null, reason:'managed_accounts_active' });
    const account = accountId ? currentDb.accounts.find((item) => item.id === accountId) : null;
    if (accountId && !account) return error(response, 404, '账号容器不存在');
    if (account) {
      normalizeAccount(account);
      const reservations = currentDb.jobs.filter((item) => item.accountId === account.id && ['dispatching', 'prepared', 'submitted', 'generating'].includes(item.status)).length;
      if (account.usedToday + reservations >= account.dailyLimit) return json(response, 200, { job:null, reason:'quota_exhausted', account:publicAccount(account) });
    }
    const job = currentDb.jobs.find((item) => item.status === 'queued');
    if (!job) { if (releasedStale) await saveDb(currentDb); return json(response, 200, { job: null, account:account ? publicAccount(account) : null }); }
    if (account) { job.accountId = account.id; job.accountName = account.name; job.workerId = String(url.searchParams.get('workerId') || '').slice(0, 80) || null; }
    job.status = 'dispatching'; job.statusDetail = 'Chrome 扩展正在准备图片与提示词'; job.updatedAt = now();
    job.events.push({ at: now(), type: 'dispatching', detail: job.statusDetail });
    await saveDb(currentDb);
    return json(response, 200, { job: { ...publicJob(job), expandedPrompt: expandPrompt(job, currentDb), bridgeOrigin: `http://${HOST}:${PORT}` }, account:account ? publicAccount(account) : null });
  }

  if (request.method === 'GET' && url.pathname === '/api/bridge/active') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const accountId = String(url.searchParams.get('accountId') || ''); const workerId = String(url.searchParams.get('workerId') || '');
    const job = currentDb.jobs.find((item) => ['submitted', 'generating'].includes(item.status) && (!accountId || item.accountId === accountId) && (!workerId || item.workerId === workerId));
    if (!job) return json(response, 200, { job: null });
    return json(response, 200, { job: { ...publicJob(job), expandedPrompt: expandPrompt(job, currentDb), bridgeOrigin: `http://${HOST}:${PORT}` } });
  }

  if (request.method === 'GET' && url.pathname === '/api/bridge/download-pending') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const accountId = String(url.searchParams.get('accountId') || ''); const workerId = String(url.searchParams.get('workerId') || '');
    const jobs = currentDb.jobs.filter((item) => item.status === 'succeeded' && !item.result?.localUrl && (!accountId || item.accountId === accountId) && (!workerId || item.workerId === workerId)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return json(response, 200, { job: jobs[0] ? publicJob(jobs[0]) : null });
  }

  const bridgeEvent = url.pathname.match(/^\/api\/bridge\/jobs\/(job_[\w-]+)\/event$/);
  if (request.method === 'POST' && bridgeEvent) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request); const job = currentDb.jobs.find((item) => item.id === bridgeEvent[1]);
    if (!job) return error(response, 404, '任务不存在');
    const allowedStatuses = new Set(['prepared', 'submitted', 'generating', 'succeeded', 'face_rejected', 'content_rejected', 'failed', 'quota_exhausted']);
    const status = allowedStatuses.has(body.status) ? body.status : 'failed';
    job.status = status; job.statusDetail = String(body.detail || '').slice(0, 500); job.updatedAt = now();
    job.events.push({ at: now(), type: status, detail: job.statusDetail });
    const account = job.accountId ? currentDb.accounts.find((item) => item.id === job.accountId) : null;
    if (account) {
      normalizeAccount(account);
      if (status === 'submitted' || status === 'generating') job.quotaReserved = true;
      if (status === 'succeeded' && !job.quotaConsumed) { account.usedToday += 1; job.quotaConsumed = true; job.quotaReserved = false; }
      if (['face_rejected', 'content_rejected', 'failed', 'quota_exhausted'].includes(status)) { job.quotaReserved = false; if (job.quotaConsumed) { account.usedToday = Math.max(0, account.usedToday - 1); job.quotaConsumed = false; } }
      if (status === 'quota_exhausted') account.usedToday = account.dailyLimit;
    }
    if (body.result && typeof body.result === 'object') job.result = { poster: body.result.poster || null, officialDownloadUrl: body.result.officialDownloadUrl || null, savedAs: body.result.savedAs || null, localUrl: body.result.localUrl || null };
    await saveDb(currentDb); return json(response, 200, { ok: true });
  }

  const bridgeDownload = url.pathname.match(/^\/api\/bridge\/jobs\/(job_[\w-]+)\/download$/);
  if (request.method === 'POST' && bridgeDownload) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request); const job = currentDb.jobs.find((item) => item.id === bridgeDownload[1]);
    if (!job) return error(response, 404, '任务不存在');
    if (!isAllowedMediaUrl(body.url)) return error(response, 400, '仅允许保存豆包/字节媒体域名下的 HTTPS 成品链接');
    const remote = await fetch(body.url, { redirect: 'follow' });
    if (!remote.ok || !remote.body) return error(response, 502, `媒体下载失败：${remote.status}`);
    const advertisedLength = Number(remote.headers.get('content-length') || 0);
    if (advertisedLength > MAX_VIDEO_BYTES) return error(response, 413, '视频文件超过 800MB 限制');
    const bytes = Buffer.from(await remote.arrayBuffer());
    if (bytes.length > MAX_VIDEO_BYTES) return error(response, 413, '视频文件超过 800MB 限制');
    const fileName = `${job.id}_${Date.now()}.mp4`;
    await fsp.writeFile(path.join(VIDEO_DIR, fileName), bytes);
    const result = { poster: typeof body.poster === 'string' && body.poster.startsWith('http') ? body.poster : null, officialDownloadUrl: body.url, savedAs: `data/videos/${fileName}`, localUrl: `/videos/${fileName}` };
    job.result = result; job.updatedAt = now(); job.events.push({ at: now(), type: 'downloaded', detail: result.savedAs });
    await saveDb(currentDb); return json(response, 201, { savedAs: result.savedAs, result });
  }

  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const fileName = decodeURIComponent(url.pathname.slice('/assets/'.length));
    if (!isSafeFileName(fileName)) return error(response, 400, '无效文件名');
    return serveFile(request, response, path.join(ASSET_DIR, fileName));
  }

  const libraryFile = url.pathname.match(/^\/library\/([^/]+)\/(.+)$/);
  if (request.method === 'GET' && libraryFile) {
    const category = decodeURIComponent(libraryFile[1]); const relative = libraryFile[2].split('/').map(decodeURIComponent);
    if (!LIBRARY_CATEGORIES.includes(category) || !relative.length || !relative.every(isSafeFileName)) return error(response, 400, '无效素材库路径');
    return serveFile(request, response, path.join(LIBRARY_DIR, category, ...relative));
  }

  if (request.method === 'GET' && url.pathname.startsWith('/videos/')) {
    const fileName = decodeURIComponent(url.pathname.slice('/videos/'.length));
    if (!isSafeFileName(fileName)) return error(response, 400, '无效文件名');
    return serveFile(request, response, path.join(VIDEO_DIR, fileName));
  }

  if (request.method === 'GET') {
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.resolve(PUBLIC_DIR, requested);
    if (filePath.startsWith(PUBLIC_DIR)) return serveFile(request, response, filePath);
  }
  return error(response, 404, '未找到资源');
}

const server = http.createServer((request, response) => route(request, response).catch((cause) => {
  console.error(cause); error(response, 500, cause.message || '服务异常');
}));

server.listen(PORT, HOST, () => console.log(`Doubao Node Studio: http://${HOST}:${PORT}`));
