const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4318);
const SERVER_BUILD = '0.7.9';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const LOCAL_VIDEO_DIR = path.join(DATA_DIR, 'local-videos');
const PROFILE_DIR = path.join(DATA_DIR, 'account-profiles');
const LIBRARY_DIR = path.join(ROOT, '用户素材库');
const LIBRARY_CATEGORIES = ['人物', '环境', '物品', '风格', '提示词文本'];
const DB_FILE = path.join(DATA_DIR, 'studio.json');
const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
const MAX_PROJECT_BYTES = 900 * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function blankCanvas() {
  return { images:{}, drafts:[], texts:[], videos:[], localVideos:[], view:{ x:140, y:110, scale:.8 } };
}

function publicCanvas(value) {
  const canvas = value && typeof value === 'object' && !Array.isArray(value) ? value : blankCanvas();
  return {
    images: canvas.images && typeof canvas.images === 'object' && !Array.isArray(canvas.images) ? canvas.images : {},
    drafts: Array.isArray(canvas.drafts) ? canvas.drafts : [],
    texts: Array.isArray(canvas.texts) ? canvas.texts : [],
    videos: Array.isArray(canvas.videos) ? canvas.videos : [],
    localVideos: Array.isArray(canvas.localVideos) ? canvas.localVideos : [],
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
    localVideos: [],
    jobs: [],
    accounts: [],
  };
}

async function setupDb() {
  await Promise.all([fsp.mkdir(ASSET_DIR, { recursive: true }), fsp.mkdir(VIDEO_DIR, { recursive: true }), fsp.mkdir(LOCAL_VIDEO_DIR, { recursive: true }), fsp.mkdir(PROFILE_DIR, { recursive: true }), ...LIBRARY_CATEGORIES.map((category) => fsp.mkdir(path.join(LIBRARY_DIR, category), { recursive: true }))]);
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
    if (!Array.isArray(loaded.localVideos)) { loaded.localVideos = []; changed = true; }
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
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
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

async function readBody(request, maxBytes) {
  const chunks = []; let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[index] = value >>> 0; }
  return table;
})();
function crc32(value) { let result = 0xffffffff; for (const byte of value) result = CRC32_TABLE[(result ^ byte) & 0xff] ^ (result >>> 8); return (result ^ 0xffffffff) >>> 0; }
function zipBuffer(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8'), raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.compress === false ? 0 : 8, compressed = method ? zlib.deflateRawSync(raw) : raw, checksum = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const centralData = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}
function unzipBuffer(buffer) {
  const minimum = Math.max(0, buffer.length - 0x10016); let eocd = -1;
  for (let index = buffer.length - 22; index >= minimum; index -= 1) if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  if (eocd < 0) throw new Error('不是有效的 ZIP 项目包');
  const count = buffer.readUInt16LE(eocd + 10), centralOffset = buffer.readUInt32LE(eocd + 16), files = new Map(); let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10), compressedSize = buffer.readUInt32LE(cursor + 20), uncompressedSize = buffer.readUInt32LE(cursor + 24), nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32), localOffset = buffer.readUInt32LE(cursor + 42), name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('项目包包含不安全路径');
    if (flags & 1) throw new Error('不支持加密 ZIP 项目包');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28), start = localOffset + 30 + localNameLength + localExtraLength, compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : (() => { throw new Error(`不支持的 ZIP 压缩方式 ${method}`); })();
    if (data.length !== uncompressedSize || data.length > MAX_PROJECT_BYTES) throw new Error(`项目文件「${name}」大小校验失败`);
    files.set(name, data);
  }
  return files;
}
function xmlEscape(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function columnName(index) { let output = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) output = String.fromCharCode(65 + (value - 1) % 26) + output; return output; }
function promptWorkbookBuffer(rows) {
  const columns = ['序号', '视频节点', '比例', '时长', '主用窗口', '尾段策略', '引用图片', '提示词'];
  const matrix = [columns, ...rows];
  const cells = matrix.map((row, rowIndex) => `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="25" customHeight="1"' : ''}>${row.map((value, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`).join('')}</row>`).join('');
  const widths = [8, 18, 10, 10, 14, 18, 28, 110].map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
  return zipBuffer([
    { name:'[Content_Types].xml', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name:'_rels/.rels', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name:'xl/workbook.xml', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="视频提示词" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name:'xl/_rels/workbook.xml.rels', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name:'xl/styles.xml', data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4B5A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>' },
    { name:'xl/worksheets/sheet1.xml', data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${cells}</sheetData><autoFilter ref="A1:H${Math.max(1, matrix.length)}"/></worksheet>` },
  ]);
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

function publicLocalVideo(video) {
  return { id:video.id, workspaceId:video.workspaceId, name:video.name, mime:video.mime, createdAt:video.createdAt, url:`/local-videos/${video.fileName}` };
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
  if (account.usageDate !== date) {
    account.usageDate = date; account.usedToday = 0;
    delete account.manualQuotaDate; delete account.manualQuotaAt;
  }
  account.dailyLimit = Math.max(1, Math.min(20, Number(account.dailyLimit) || 3));
  account.usedToday = Math.max(0, Number(account.usedToday) || 0);
  account.maxWorkers = Math.max(1, Math.min(3, Number(account.maxWorkers) || 3));
  return account;
}
function publicAccount(account, currentDb = dbCache) {
  normalizeAccount(account);
  const reservedToday = (currentDb?.jobs || []).filter((job) => job.accountId === account.id && ['dispatching', 'prepared', 'submitted', 'generating'].includes(job.status)).length;
  const remainingToday = Math.max(0, account.dailyLimit - account.usedToday - reservedToday);
  return { id:account.id, name:account.name, status:account.status || '未连接', usedToday:account.usedToday, reservedToday, remainingToday, dailyLimit:account.dailyLimit, manuallyCalibrated:account.manualQuotaDate === account.usageDate, maxWorkers:account.maxWorkers, lastSeen:account.lastSeen || null, lastDetail:account.lastDetail || '', bridgeBuild:account.bridgeBuild || null, createdAt:account.createdAt };
}
function shanghaiDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' }); }
function reconcileDailyQuota(currentDb) {
  let changed = false;
  for (const account of currentDb.accounts) {
    normalizeAccount(account);
    // 用户在当天手动核对过网页额度时，以手动校准为准；次日会自动恢复正常统计。
    if (account.manualQuotaDate === account.usageDate) continue;
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
function foregroundAccountWindow(profileDir, processId, mode = 'compact') {
  // chrome.windows.update 只能在 Chrome 自己的窗口内切标签；Windows 仍可能拒绝
  // 后台进程抢焦点，导致豆包页面不绘制也不响应控件。这里按独立 Profile 找到
  // 对应顶层窗口，使用 Windows 前台 API 恢复并激活它。
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(ROOT, 'scripts', 'foreground-account-window.ps1');
  if (!fs.existsSync(powershell) || !fs.existsSync(script)) return;
  const logPath = path.join(DATA_DIR, 'window-focus.log');
  // 先同步记录请求。若这里只有 request 而无后续结果，说明 PowerShell 没有
  // 在用户交互桌面会话中完成，不能再误判成“只是 Chrome 没激活标签”。
  fsp.appendFile(logPath, `${now()} focus-request profile=${profileDir} pid=${processId || 'auto'}\n`).catch(() => {});
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProfilePath', profileDir, '-Mode', mode === 'automation' ? 'automation' : 'compact', '-LogPath', logPath];
  if (processId) args.push('-ChromeProcessId', String(processId));
  const child = spawn(powershell, args, { detached:false, stdio:['ignore', 'pipe', 'pipe'], windowsHide:true });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += `stderr: ${chunk}`; });
  child.on('close', () => {
    const text = output.trim();
    if (text) fsp.appendFile(logPath, `${now()} ${text}\n`).catch(() => {});
  });
}
function launchAccountWindow(account, token) {
  const chrome = chromeExecutable();
  if (!chrome) throw new Error('未找到 Google Chrome；请安装 Chrome 后重试');
  const extensionDir = path.join(ROOT, 'bridge-extension');
  const loginUrl = `https://www.doubao.com/chat?channel=baidu_pz&dnst=${encodeURIComponent(token)}`;
  const child = spawn(chrome, [`--user-data-dir=${account.profileDir}`, '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--window-size=900,680', '--window-position=980,56', '--new-window', loginUrl], { detached:true, stdio:'ignore', windowsHide:false });
  // 多账号时不能依赖“唯一测试浏览器窗口”的回退；记录该 profile 的启动器 PID，
  // 后续每次任务只提升与该账号对应的 Chrome 窗口。
  account.chromeProcessId = child.pid;
  child.unref();
  // 进程刚启动时还没有可枚举的顶层窗口；稍后多次尝试，覆盖“已有 Chrome
  // 进程接收新窗口请求”和“全新 Profile 冷启动”两种情况。
  setTimeout(() => foregroundAccountWindow(account.profileDir, child.pid), 450);
  setTimeout(() => foregroundAccountWindow(account.profileDir, child.pid), 1450);
}
function accountHeartbeatFresh(account) {
  const seen = Date.parse(account.lastSeen || '');
  return Number.isFinite(seen) && Date.now() - seen < 15 * 1000;
}
function wakeAvailableAccount(currentDb) {
  const candidates = currentDb.accounts.map(normalizeAccount).filter((account) => account.usedToday < account.dailyLimit);
  if (!candidates.length) return null;
  const connected = candidates.filter(accountHeartbeatFresh).sort((a, b) => (Number(a.usedToday) - Number(b.usedToday)) || ((Date.parse(a.lastSeen || '') || 0) - (Date.parse(b.lastSeen || '') || 0)));
  if (connected.length) {
    const account = connected[0];
    account.lastDetail = '新任务已入队：复用现有账号窗口并激活任务标签页';
    // 视频模型和比例控件会在窄窗口进入响应式折叠；任务投放期间以可用
    // 工作区尺寸置顶，确保网页控件完整出现而不是靠猜测隐藏菜单。
    foregroundAccountWindow(account.profileDir, account.chromeProcessId, 'automation');
    setTimeout(() => foregroundAccountWindow(account.profileDir, account.chromeProcessId, 'automation'), 900);
    return account;
  }
  const account = candidates.sort((a, b) => (Number(a.usedToday) - Number(b.usedToday)) || ((Date.parse(a.lastSeen || '') || 0) - (Date.parse(b.lastSeen || '') || 0)))[0];
  const requestedAt = Date.parse(account.launchRequestedAt || '');
  if (Number.isFinite(requestedAt) && Date.now() - requestedAt < 12 * 1000) return null;
  account.bootstrapToken = crypto.randomBytes(24).toString('hex'); account.bootstrapExpiresAt = Date.now() + 15 * 60 * 1000;
  account.launchRequestedAt = now(); account.status = '正在自动打开账号窗口'; account.lastDetail = '账号窗口未连接，正在拉起一个新的前台账号窗口';
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
      serverBuild: SERVER_BUILD,
      canvas: currentDb.canvases[workspaceId] ? publicCanvas(currentDb.canvases[workspaceId]) : null,
      assets: currentDb.assets.filter((asset) => asset.workspaceId === workspaceId).map(publicAsset),
      localVideos: (currentDb.localVideos || []).filter((video) => video.workspaceId === workspaceId).map(publicLocalVideo),
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
    try { launchAccountWindow(account, account.bootstrapToken); await saveDb(currentDb); }
    catch (cause) { account.status = '启动失败'; account.lastDetail = cause.message || String(cause); await saveDb(currentDb); return error(response, 500, account.lastDetail); }
    return json(response, 201, { account:publicAccount(account) });
  }

  const accountLaunch = url.pathname.match(/^\/api\/accounts\/(account_[\w-]+)\/launch$/);
  if (request.method === 'POST' && accountLaunch) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const account = currentDb.accounts.find((item) => item.id === accountLaunch[1]); if (!account) return error(response, 404, '账号容器不存在');
    account.bootstrapToken = crypto.randomBytes(24).toString('hex'); account.bootstrapExpiresAt = Date.now() + 15 * 60 * 1000; account.launchRequestedAt = now(); account.status = '正在启动'; await saveDb(currentDb);
    try { launchAccountWindow(account, account.bootstrapToken); await saveDb(currentDb); }
    catch (cause) { account.status = '启动失败'; account.lastDetail = cause.message || String(cause); await saveDb(currentDb); return error(response, 500, account.lastDetail); }
    return json(response, 200, { account:publicAccount(account) });
  }

  const accountQuota = url.pathname.match(/^\/api\/accounts\/(account_[\w-]+)\/quota$/);
  if (request.method === 'POST' && accountQuota) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const account = currentDb.accounts.find((item) => item.id === accountQuota[1]);
    if (!account) return error(response, 404, '账号容器不存在');
    const body = await readJson(request); normalizeAccount(account);
    const requested = Number.parseInt(String(body.remaining ?? ''), 10);
    if (!Number.isFinite(requested)) return error(response, 400, '请输入 0 到今日可校准上限之间的整数');
    const reserved = currentDb.jobs.filter((job) => job.accountId === account.id && ['dispatching', 'prepared', 'submitted', 'generating'].includes(job.status)).length;
    const maximum = Math.max(0, account.dailyLimit - reserved);
    if (requested < 0 || requested > maximum) return error(response, 400, `当前有 ${reserved} 条任务暂占，剩余额度只能校准为 0–${maximum}`);
    // “剩余”以豆包网页实际显示为准，并包含正在生成任务的影响；因此反推出
    // 已使用数时要扣掉暂占，调度器随后仍使用 已用 + 暂占 的统一判断。
    account.usedToday = Math.max(0, account.dailyLimit - reserved - requested);
    account.manualQuotaDate = account.usageDate;
    account.manualQuotaAt = now();
    account.lastDetail = `今日 Fast 额度已手动校准：剩余 ${requested} 次${reserved ? `（另有 ${reserved} 条任务暂占）` : ''}`;
    await saveDb(currentDb);
    return json(response, 200, { account:publicAccount(account, currentDb) });
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
    const body = await readJson(request); normalizeAccount(account); account.status = String(body.state || '已连接').slice(0, 40); account.lastDetail = String(body.detail || '').slice(0, 160); account.bridgeBuild = String(body.build || account.bridgeBuild || '').slice(0, 30); account.lastSeen = now(); await saveDb(currentDb);
    return json(response, 200, { account:publicAccount(account) });
  }

  // 此接口由“已经拿到任务的实际标签页”调用。扩展先把这个 tab 激活，随后
  // 通过 Windows API 将该账号的 Chrome 窗口提高到最前层；绝不新开浏览器窗口。
  const accountForeground = url.pathname.match(/^\/api\/bridge\/accounts\/(account_[\w-]+)\/foreground$/);
  if (request.method === 'POST' && accountForeground) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const account = currentDb.accounts.find((item) => item.id === accountForeground[1]);
    if (!account) return error(response, 404, '账号容器不存在');
    // 这个接口只会由已领取任务的豆包标签调用；默认展开而不是小窗，避免
    // 比例、模型和时长面板因响应式布局被隐藏。
    const body = await readJson(request).catch(() => ({}));
    const mode = body.mode === 'compact' ? 'compact' : 'automation';
    foregroundAccountWindow(account.profileDir, account.chromeProcessId, mode);
    setTimeout(() => foregroundAccountWindow(account.profileDir, account.chromeProcessId, mode), 450);
    setTimeout(() => foregroundAccountWindow(account.profileDir, account.chromeProcessId, mode), 1150);
    return json(response, 200, { ok:true, serverBuild:SERVER_BUILD });
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
    const savedCanvas = publicCanvas(body.canvas);
    currentDb.canvases[workspaceId] = savedCanvas;
    // “提交前复核”是允许用户回到画布修正比例/时长的暂停点。画布保存后，
    // 同步更新同一节点的暂停任务快照，避免任务卡片仍展示旧的“自动”。
    currentDb.jobs.filter((job) => job.workspaceId === workspaceId && job.status === 'awaiting_user' && job.userAction?.kind === 'settings_unconfirmed').forEach((job) => {
      const video = savedCanvas.videos.find((item) => item.id === job.nodeId);
      if (!video) return;
      job.aspect = String(video.aspect || '自动');
      const duration = Number.parseInt(String(video.sourceDuration || '10').replace(/\D/g, ''), 10);
      job.sourceDuration = `${Math.min(10, Math.max(4, Number.isFinite(duration) ? duration : 10))}s`;
      const detail = `画布参数已同步：期望 Seedance 2.0 Fast · ${job.aspect} · ${job.sourceDuration}。豆包页面当前参数请保持一致并收起参数面板，再点击「我已处理，继续」。`;
      job.statusDetail = detail;
      job.userAction.instructions = detail;
    });
    await saveDb(currentDb);
    return json(response, 200, { canvas: currentDb.canvases[workspaceId] });
  }

  const workspaceExport = url.pathname.match(/^\/api\/workspaces\/(workspace_[\w-]+)\/export$/);
  if (workspaceExport && request.method === 'GET') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const workspace = currentDb.workspaces.find((item) => item.id === workspaceExport[1]);
    if (!workspace) return error(response, 404, '工作区不存在');
    const canvas = publicCanvas(currentDb.canvases[workspace.id]);
    const assets = currentDb.assets.filter((asset) => asset.workspaceId === workspace.id);
    const localVideos = (currentDb.localVideos || []).filter((video) => video.workspaceId === workspace.id);
    const entries = [];
    for (const asset of assets) entries.push({ name:`assets/${asset.fileName}`, data:await fsp.readFile(path.join(ASSET_DIR, asset.fileName)), compress:false });
    for (const video of localVideos) entries.push({ name:`source-videos/${video.fileName}`, data:await fsp.readFile(path.join(LOCAL_VIDEO_DIR, video.fileName)), compress:false });
    const projectCanvas = JSON.parse(JSON.stringify(canvas));
    projectCanvas.videos.forEach((video) => delete video.selectedVersionJobId);
    const manifest = {
      format:'doubao-node-studio-project', version:1, exportedAt:now(),
      workspace:{ name:workspace.name }, canvas:projectCanvas,
      assets:assets.map((asset) => ({ id:asset.id, name:asset.name, description:asset.description || '', mime:asset.mime, createdAt:asset.createdAt, packagePath:`assets/${asset.fileName}` })),
      localVideos:localVideos.map((video) => ({ id:video.id, name:video.name, mime:video.mime, createdAt:video.createdAt, packagePath:`source-videos/${video.fileName}` })),
      note:'仅包含工程画布、图片与导入的素材视频；已生成成片与任务记录不会导出。',
    };
    entries.unshift({ name:'project.json', data:Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
    const archive = zipBuffer(entries), downloadName = `${workspace.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '豆包工程'}_${today()}.doubao-project.zip`;
    response.writeHead(200, { 'Content-Type':'application/zip', 'Content-Length':archive.length, 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`, 'Cache-Control':'no-store' });
    response.end(archive); return;
  }

  const promptExport = url.pathname.match(/^\/api\/workspaces\/(workspace_[\w-]+)\/prompts\.xlsx$/);
  if (promptExport && request.method === 'POST') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const workspace = currentDb.workspaces.find((item) => item.id === promptExport[1]);
    if (!workspace) return error(response, 404, '工作区不存在');
    const body = await readJson(request), canvas = publicCanvas(currentDb.canvases[workspace.id]), requested = Array.isArray(body.nodeIds) ? body.nodeIds.map(String) : [];
    const source = requested.length ? requested.map((id) => canvas.videos.find((video) => video.id === id)).filter(Boolean) : [...canvas.videos].sort((a, b) => a.y - b.y || a.x - b.x);
    const assetsById = new Map(currentDb.assets.filter((asset) => asset.workspaceId === workspace.id).map((asset) => [asset.id, asset]));
    const rows = source.map((video, index) => [index + 1, `视频节点 ${index + 1}`, video.aspect || '自动', video.sourceDuration || '10s', video.mainWindow || '0–10s', video.tailPlan || '完整保留', (video.assetIds || []).map((id) => assetsById.get(id)?.name).filter(Boolean).join('\n'), video.prompt || '']);
    const workbook = promptWorkbookBuffer(rows), downloadName = `${workspace.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '豆包工程'}_视频提示词_${today()}.xlsx`;
    response.writeHead(200, { 'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length':workbook.length, 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`, 'Cache-Control':'no-store' });
    response.end(workbook); return;
  }

  if (request.method === 'POST' && url.pathname === '/api/projects/import') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const archive = await readBody(request, MAX_PROJECT_BYTES), files = unzipBuffer(archive), manifestBytes = files.get('project.json');
    if (!manifestBytes) return error(response, 400, '项目包缺少 project.json');
    let manifest; try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { return error(response, 400, 'project.json 不是有效 JSON'); }
    if (manifest?.format !== 'doubao-node-studio-project' || Number(manifest.version) !== 1) return error(response, 400, '不是受支持的豆包工程包');
    const sourceCanvas = publicCanvas(manifest.canvas), sourceAssets = Array.isArray(manifest.assets) ? manifest.assets : [], sourceVideos = Array.isArray(manifest.localVideos) ? manifest.localVideos : [];
    const workspace = { id:uid('workspace'), name:`${String(manifest.workspace?.name || '导入工程').slice(0, 52)}（导入）`.slice(0, 60), createdAt:now() }, assetIds = new Map(), importedAssets = [], importedVideos = [];
    for (const source of sourceAssets) {
      const packagePath = String(source.packagePath || ''); if (!packagePath.startsWith('assets/') || !files.has(packagePath)) return error(response, 400, `项目包缺少图片资源「${source.name || packagePath}」`);
      const extension = path.extname(packagePath).toLowerCase(); if (!['.png','.jpg','.jpeg','.webp'].includes(extension)) return error(response, 400, `不支持的图片格式：${extension || '未知'}`);
      const id = uid('asset'), fileName = `${crypto.randomUUID()}${extension}`; await fsp.writeFile(path.join(ASSET_DIR, fileName), files.get(packagePath));
      importedAssets.push({ id, workspaceId:workspace.id, name:String(source.name || '图片素材').slice(0, 100), description:String(source.description || '').slice(0, 400), mime:String(source.mime || mimeFor(fileName)), fileName, createdAt:now() }); assetIds.set(String(source.id), id);
    }
    const localVideoIds = new Map();
    for (const source of sourceVideos) {
      const packagePath = String(source.packagePath || ''); if (!packagePath.startsWith('source-videos/') || !files.has(packagePath)) return error(response, 400, `项目包缺少素材视频「${source.name || packagePath}」`);
      const extension = path.extname(packagePath).toLowerCase(); if (!['.mp4','.webm','.mov'].includes(extension)) return error(response, 400, `不支持的素材视频格式：${extension || '未知'}`);
      const id = uid('localvideo'), fileName = `${crypto.randomUUID()}${extension}`; await fsp.writeFile(path.join(LOCAL_VIDEO_DIR, fileName), files.get(packagePath));
      importedVideos.push({ id, workspaceId:workspace.id, name:String(source.name || '素材视频').slice(0, 100), mime:String(source.mime || mimeFor(fileName)), fileName, createdAt:now() }); localVideoIds.set(String(source.id), id);
    }
    const canvas = JSON.parse(JSON.stringify(sourceCanvas)); canvas.images = Object.fromEntries(Object.entries(canvas.images || {}).flatMap(([id, position]) => assetIds.has(id) ? [[assetIds.get(id), position]] : []));
    canvas.videos.forEach((video) => { video.assetIds = (video.assetIds || []).map((id) => assetIds.get(id)).filter(Boolean); delete video.selectedVersionJobId; });
    canvas.localVideos = (canvas.localVideos || []).map((video) => localVideoIds.has(video.id) ? { ...video, id:localVideoIds.get(video.id), workspaceId:workspace.id, url:undefined } : null).filter(Boolean);
    currentDb.workspaces.push(workspace); currentDb.assets.push(...importedAssets); currentDb.localVideos ||= []; currentDb.localVideos.push(...importedVideos); currentDb.canvases[workspace.id] = publicCanvas(canvas);
    await saveDb(currentDb); return json(response, 201, { workspace, assets:importedAssets.length, localVideos:importedVideos.length });
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

  if (request.method === 'POST' && url.pathname === '/api/local-videos') {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const workspaceId = String(request.headers['x-workspace-id'] || '');
    if (!currentDb.workspaces.some((workspace) => workspace.id === workspaceId)) return error(response, 400, '工作区不存在');
    const originalName = decodeURIComponent(String(request.headers['x-file-name'] || '素材视频')).replace(/[\\/:*?"<>|]/g, '_');
    const extension = path.extname(originalName).toLowerCase();
    const allowed = new Map([['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime']]);
    if (!allowed.has(extension)) return error(response, 400, '仅支持 MP4、WebM、MOV 视频文件');
    const bytes = await readBody(request, MAX_VIDEO_BYTES);
    if (!bytes.length) return error(response, 400, '视频文件为空');
    const fileName = `${crypto.randomUUID()}${extension}`;
    const video = { id:uid('localvideo'), workspaceId, name:path.basename(originalName, extension).slice(0, 100) || '素材视频', mime:allowed.get(extension), fileName, createdAt:now() };
    await fsp.writeFile(path.join(LOCAL_VIDEO_DIR, fileName), bytes);
    currentDb.localVideos ||= []; currentDb.localVideos.push(video); await saveDb(currentDb);
    return json(response, 201, { video:publicLocalVideo(video) });
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
    try { awakened = wakeAvailableAccount(currentDb); }
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
    // 人工处理过真人校验或页面弹窗后，必须回到原账号容器继续，不能被另一账号
    // Worker 抢走，否则用户刚完成的操作会落到错误的豆包窗口。
    const workerId = String(url.searchParams.get('workerId') || '');
    const job = currentDb.jobs.find((item) => item.status === 'queued' && (!item.resumeAccountId || item.resumeAccountId === accountId) && (!item.resumeWorkerId || item.resumeWorkerId === workerId));
    if (!job) { if (releasedStale) await saveDb(currentDb); return json(response, 200, { job: null, account:account ? publicAccount(account) : null }); }
    if (account) { job.accountId = account.id; job.accountName = account.name; job.workerId = workerId.slice(0, 80) || null; }
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
    const allowedStatuses = new Set(['dispatching', 'prepared', 'awaiting_user', 'submitted', 'generating', 'succeeded', 'face_rejected', 'content_rejected', 'failed', 'quota_exhausted']);
    const status = allowedStatuses.has(body.status) ? body.status : 'failed';
    job.status = status; job.statusDetail = String(body.detail || '').slice(0, 500); job.stage = String(body.stage || job.stage || '').slice(0, 80); job.updatedAt = now();
    if (status === 'awaiting_user') {
      const action = body.userAction && typeof body.userAction === 'object' ? body.userAction : {};
      job.userAction = { kind:String(action.kind || 'page_blocked').slice(0, 40), title:String(action.title || '需要在豆包页面处理').slice(0, 80), instructions:String(action.instructions || job.statusDetail).slice(0, 500), resumeStep:String(action.resumeStep || 'restart').slice(0, 40), canConfirmSent:Boolean(action.canConfirmSent) };
    } else if (status !== 'prepared') delete job.userAction;
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
    await saveDb(currentDb); return json(response, 200, { ok: true, job:publicJob(job) });
  }

  const jobContinue = url.pathname.match(/^\/api\/jobs\/(job_[\w-]+)\/continue$/);
  if (request.method === 'POST' && jobContinue) {
    if (!requireBridgeKey(request, currentDb, response)) return;
    const body = await readJson(request); const job = currentDb.jobs.find((item) => item.id === jobContinue[1]);
    if (!job) return error(response, 404, '任务不存在');
    if (job.status !== 'awaiting_user') return error(response, 409, '该任务当前不在等待人工处理状态');
    const action = String(body.action || 'retry');
    if (action === 'sent') {
      if (!job.userAction?.canConfirmSent) return error(response, 400, '当前步骤不能确认已发送');
      job.status = 'submitted'; job.statusDetail = '用户已在豆包网页手动发送；扩展将恢复结果监听'; job.stage = '等待生成结果';
    } else {
      // 用户在提交前复核阶段改过画布参数后，继续原任务时必须以节点当前值
      // 覆盖旧任务快照；否则任务会继续带着最初的“自动”等过期参数。
      if (job.userAction?.kind === 'settings_unconfirmed') {
        const canvas = publicCanvas(currentDb.canvases[job.workspaceId]);
        const video = canvas.videos.find((item) => item.id === job.nodeId);
        if (video) {
          job.aspect = String(video.aspect || job.aspect || '自动');
          const duration = Number.parseInt(String(video.sourceDuration || job.sourceDuration || '10').replace(/\D/g, ''), 10);
          job.sourceDuration = `${Math.min(10, Math.max(4, Number.isFinite(duration) ? duration : 10))}s`;
        }
      }
      job.status = 'queued'; job.statusDetail = '用户已处理豆包页面提示，正在由原账号窗口继续'; job.stage = '等待重新投放'; job.resumeAccountId = job.accountId || null; job.resumeWorkerId = job.workerId || null; job.resumeStep = job.userAction?.resumeStep || 'restart';
    }
    delete job.userAction; job.updatedAt = now(); job.events.push({ at:now(), type:job.status, detail:job.statusDetail });
    await saveDb(currentDb); return json(response, 200, { job:publicJob(job) });
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

  if (request.method === 'GET' && url.pathname.startsWith('/local-videos/')) {
    const fileName = decodeURIComponent(url.pathname.slice('/local-videos/'.length));
    if (!isSafeFileName(fileName)) return error(response, 400, '无效文件名');
    return serveFile(request, response, path.join(LOCAL_VIDEO_DIR, fileName));
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
