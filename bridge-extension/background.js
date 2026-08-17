const FETCH_MESSAGE = 'DOUBAO_NODE_STUDIO_LOCAL_FETCH';
const PAGE_STATUS_MESSAGE = 'DOUBAO_NODE_STUDIO_PAGE_STATUS';
const STATUS_MESSAGE = 'DOUBAO_NODE_STUDIO_STATUS';
const TRUSTED_CLICK_MESSAGE = 'DOUBAO_NODE_STUDIO_TRUSTED_CLICK';
const MEDIA_FETCH_MESSAGE = 'DOUBAO_NODE_STUDIO_MEDIA_FETCH';
const DOWNLOAD_MEDIA_MESSAGE = 'DOUBAO_NODE_STUDIO_DOWNLOAD_MEDIA';
const ENSURE_EXTRACTOR_MESSAGE = 'DOUBAO_NODE_STUDIO_ENSURE_EXTRACTOR';
const WAKE_MESSAGE = 'DOUBAO_NODE_STUDIO_WAKE';
const SPAWN_WORKER_MESSAGE = 'DOUBAO_NODE_STUDIO_SPAWN_WORKER';
const FOCUS_WORKER_MESSAGE = 'DOUBAO_NODE_STUDIO_FOCUS_WORKER';
const PROMOTE_BOOTSTRAP_WINDOW_MESSAGE = 'DOUBAO_NODE_STUDIO_PROMOTE_BOOTSTRAP_WINDOW';
const TRUSTED_KEY_MESSAGE = 'DOUBAO_NODE_STUDIO_TRUSTED_KEY';
const TRUSTED_DURATION_MESSAGE = 'DOUBAO_NODE_STUDIO_TRUSTED_DURATION';
const HEARTBEAT_ALARM = 'doubao-node-studio-heartbeat';
const pageStatus = { state: '未检测到豆包页面', detail: '请打开 https://www.doubao.com/chat/ 页面', lastSeen: null, lastPoll: null, lastError: null, activeJob: null };
const accountTabs = new Map();

function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer); let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

// 豆包“新对话”使用 /chat?channel=…；已有会话才通常是 /chat/<id>。
const isDoubaoChat = (url) => /^https:\/\/([\w-]+\.)?doubao\.com\/chat(?:[\/?#]|$)/.test(url || '');
function isAllowedMediaRequest(url) {
  try { const parsed = new URL(url), host = parsed.hostname.toLowerCase(); return parsed.protocol === 'https:' && ['doubao.com', 'douyin.com', 'snssdk.com', 'byteimg.com', 'bytedance.com', 'bytecdn.cn', 'bytecdn.com', 'ibytedtos.com'].some((domain) => host === domain || host.endsWith(`.${domain}`)); } catch { return false; }
}
// 原开源下载器使用 @connect *。fallback_api 的签名域名会随豆包灰度线路变化，
// 因此这里不再写死媒体域名；但只允许提取器构造的无水印 GET 接口参数。
function isAllowedFallbackRequest(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.searchParams.get('channel') === 'no'
      && parsed.searchParams.get('codec_type') === '8'
      && parsed.searchParams.get('logo_type') === 'unwatermarked';
  } catch { return false; }
}
async function injectBridge(tabId, url) {
  if (!isDoubaoChat(url)) return;
  try {
    pageStatus.state = '正在连接豆包页面'; pageStatus.detail = '正在注入桥接脚本';
    await chrome.scripting.executeScript({ target:{ tabId }, files:['extractor.js'], world:'MAIN', injectImmediately:true });
    await chrome.scripting.executeScript({ target:{ tabId }, files:['content.js'], world:'ISOLATED', injectImmediately:true });
  } catch (error) { pageStatus.state = '豆包页面未连接'; pageStatus.detail = error?.message || '桥接脚本注入失败'; pageStatus.lastError = pageStatus.detail; }
}
async function injectOpenChats() { const tabs = await chrome.tabs.query({ url:['https://www.doubao.com/chat*', 'https://*.doubao.com/chat*'] }); await Promise.all(tabs.map((tab) => injectBridge(tab.id, tab.url))); }
async function wakeOpenChats() {
  const tabs = await chrome.tabs.query({ url:['https://www.doubao.com/chat*', 'https://*.doubao.com/chat*'] });
  for (const tab of tabs) {
    if (tab.discarded) { pageStatus.state = '豆包页面被 Chrome 休眠'; pageStatus.detail = '切回豆包标签页后会自动恢复桥接'; continue; }
    try { await chrome.tabs.sendMessage(tab.id, { type:WAKE_MESSAGE }); }
    catch { await injectBridge(tab.id, tab.url); await chrome.tabs.sendMessage(tab.id, { type:WAKE_MESSAGE }).catch(() => {}); }
  }
}
function startHeartbeat() { chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }); }
async function trustedClick(tabId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('原生点击坐标无效');
  const target = { tabId }; await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none', buttons:0 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', buttons:1, clickCount:1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', buttons:0, clickCount:1 });
  } finally { await chrome.debugger.detach(target).catch(() => {}); }
}
async function trustedKey(tabId, key, code) {
  const target = { tabId }; await chrome.debugger.attach(target, '1.3');
  try {
    await dispatchTrustedKey(target, key, code);
  } finally { await chrome.debugger.detach(target).catch(() => {}); }
}
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function virtualKeyCode(key) { return key === 'Home' ? 36 : key === 'ArrowRight' ? 39 : 0; }
async function dispatchTrustedKey(target, key, code) {
  const keyCode = virtualKeyCode(key);
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type:'keyDown', key, code, windowsVirtualKeyCode:keyCode, nativeVirtualKeyCode:keyCode });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type:'keyUp', key, code, windowsVirtualKeyCode:keyCode, nativeVirtualKeyCode:keyCode });
}
// 时长滑条必须保持同一个 debugger 会话：逐个 attach/detach 会让 React 丢失部分
// ArrowRight，导致请求 8 秒却停在 6 秒。
async function trustedDuration(tabId, steps) {
  const target = { tabId }; await chrome.debugger.attach(target, '1.3');
  try {
    await dispatchTrustedKey(target, 'Home', 'Home');
    await pause(150);
    for (let index = 0; index < steps; index += 1) {
      await dispatchTrustedKey(target, 'ArrowRight', 'ArrowRight');
      await pause(150);
    }
  } finally { await chrome.debugger.detach(target).catch(() => {}); }
}

chrome.runtime.onInstalled.addListener(() => { startHeartbeat(); injectOpenChats().then(wakeOpenChats).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { startHeartbeat(); injectOpenChats().then(wakeOpenChats).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.status === 'complete') injectBridge(tabId, tab.url).catch(() => {}); });
chrome.tabs.onRemoved.addListener((tabId) => { for (const tabs of accountTabs.values()) tabs.delete(tabId); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === HEARTBEAT_ALARM) wakeOpenChats().catch(() => {}); });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === ENSURE_EXTRACTOR_MESSAGE) {
    const tabId = _sender?.tab?.id, tabUrl = _sender?.tab?.url;
    if (!tabId || !isDoubaoChat(tabUrl)) { sendResponse({ ok:false, error:'主提取器只能注入豆包聊天页' }); return undefined; }
    chrome.scripting.executeScript({ target:{ tabId }, files:['extractor.js'], world:'MAIN', injectImmediately:true }).then(() => sendResponse({ ok:true })).catch((error) => sendResponse({ ok:false, error:error?.message || '主提取器注入失败' }));
    return true;
  }
  if (message?.type === TRUSTED_CLICK_MESSAGE) {
    const tabId = _sender?.tab?.id;
    if (!tabId || !_sender.tab?.url || !isDoubaoChat(_sender.tab.url)) { sendResponse({ ok:false, error:'原生点击只能在豆包聊天页执行' }); return undefined; }
    trustedClick(tabId, Number(message.x), Number(message.y)).then(() => sendResponse({ ok:true })).catch((error) => sendResponse({ ok:false, error:error?.message || 'Chrome 原生点击失败' }));
    return true;
  }
  if (message?.type === TRUSTED_KEY_MESSAGE) {
    const tabId = _sender?.tab?.id;
    if (!tabId || !_sender.tab?.url || !isDoubaoChat(_sender.tab.url)) { sendResponse({ ok:false, error:'原生按键只能在豆包聊天页执行' }); return undefined; }
    trustedKey(tabId, String(message.key || ''), String(message.code || '')).then(() => sendResponse({ ok:true })).catch((error) => sendResponse({ ok:false, error:error?.message || 'Chrome 原生按键失败' }));
    return true;
  }
  if (message?.type === TRUSTED_DURATION_MESSAGE) {
    const tabId = _sender?.tab?.id, steps = Math.max(0, Math.min(12, Number.parseInt(message.steps, 10) || 0));
    if (!tabId || !_sender.tab?.url || !isDoubaoChat(_sender.tab.url)) { sendResponse({ ok:false, error:'原生时长设置只能在豆包聊天页执行' }); return undefined; }
    trustedDuration(tabId, steps).then(() => sendResponse({ ok:true })).catch((error) => sendResponse({ ok:false, error:error?.message || 'Chrome 原生时长设置失败' }));
    return true;
  }
  if (message?.type === PAGE_STATUS_MESSAGE) {
    const status = message.status || {}, accountId = String(status.accountId || '');
    Object.assign(pageStatus, status, { lastSeen: new Date().toISOString() });
    if (accountId && status.managedWorker && _sender?.tab?.id) { if (!accountTabs.has(accountId)) accountTabs.set(accountId, new Set()); accountTabs.get(accountId).add(_sender.tab.id); }
    sendResponse({ ok:true }); return undefined;
  }
  if (message?.type === SPAWN_WORKER_MESSAGE) {
    const accountId = String(message.accountId || ''), source = _sender?.tab;
    if (!accountId || !source || !isDoubaoChat(source.url)) { sendResponse({ ok:false, error:'只能从已连接的豆包账号窗口创建 Worker' }); return undefined; }
    const workers = accountTabs.get(accountId) || new Set();
    if (workers.size >= 3) { sendResponse({ ok:true, spawned:false, workers:workers.size }); return undefined; }
    // 豆包的视频控件在后台页会被 Chrome 降频；新 Worker 必须成为前台活动页，
    // 后续任务开始时也会再次置顶该页。
    chrome.tabs.create({ windowId:source.windowId, active:true, url:'https://www.doubao.com/chat?channel=baidu_pz&dnsw=1' }).then(async (tab) => { workers.add(tab.id); accountTabs.set(accountId, workers); if (source.windowId) await chrome.windows.update(source.windowId, { focused:true }); sendResponse({ ok:true, spawned:true, workers:workers.size }); }).catch((error) => sendResponse({ ok:false, error:error?.message || '创建 Worker 标签页失败' }));
    return true;
  }
  if (message?.type === FOCUS_WORKER_MESSAGE) {
    const source = _sender?.tab;
    if (!source?.id) { sendResponse({ ok:false, error:'未找到需要激活的豆包标签页' }); return undefined; }
    chrome.tabs.update(source.id, { active:true }).then(async () => { if (source.windowId) await chrome.windows.update(source.windowId, { focused:true }); sendResponse({ ok:true }); }).catch((error) => sendResponse({ ok:false, error:error?.message || '无法激活豆包标签页' }));
    return true;
  }
  if (message?.type === PROMOTE_BOOTSTRAP_WINDOW_MESSAGE) {
    const source = _sender?.tab;
    if (!source?.id || !isDoubaoChat(source.url)) { sendResponse({ ok:false, error:'未找到可提升的豆包账号窗口' }); return undefined; }
    // The first page of an account container becomes a separate Chrome popup.
    // This keeps it independent from the user's ordinary tab strip and gives
    // Chrome a real foreground window to render before task interaction starts.
    chrome.windows.get(source.windowId).then(async (current) => {
      if (current.type === 'popup') {
        await chrome.tabs.update(source.id, { active:true });
        await chrome.windows.update(source.windowId, { focused:true });
        sendResponse({ ok:true, reused:true, windowId:source.windowId });
        return;
      }
      const worker = await chrome.windows.create({ tabId:source.id, type:'popup', focused:true, width:900, height:680 });
      sendResponse({ ok:true, moved:true, windowId:worker.id });
    }).catch((error) => sendResponse({ ok:false, error:error?.message || '无法创建独立豆包 Worker 窗口' }));
    return true;
  }
  if (message?.type === STATUS_MESSAGE) { wakeOpenChats().catch(() => {}); sendResponse({ ok:true, status:pageStatus }); return undefined; }
  if (message?.type === MEDIA_FETCH_MESSAGE) {
    if (!isAllowedFallbackRequest(message.url)) { sendResponse({ ok:false, error:'无水印接口参数校验失败' }); return undefined; }
    fetch(message.url, { credentials:'include', headers:{ accept:'application/json,text/plain,*/*' } }).then(async (response) => {
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
      sendResponse({ ok:response.ok && !!data, status:response.status, data, error:response.ok ? (data ? null : `媒体接口返回的不是 JSON（${response.status}）`) : `媒体接口请求失败：${response.status}` });
    }).catch((error) => sendResponse({ ok:false, error:error?.message || '媒体接口请求失败' }));
    return true;
  }
  if (message?.type === DOWNLOAD_MEDIA_MESSAGE) {
    if (!isAllowedMediaRequest(message.url)) { sendResponse({ ok:false, error:'未获得可信的豆包原始成片地址' }); return undefined; }
    chrome.downloads.download({ url:message.url, filename:`DoubaoNodeStudio/${message.fileName || `doubao_unwatermarked_${Date.now()}.mp4`}`, saveAs:false, conflictAction:'uniquify' }).then((downloadId) => sendResponse({ ok:true, downloadId })).catch((error) => sendResponse({ ok:false, error:error?.message || '浏览器下载失败' }));
    return true;
  }
  if (message?.type !== FETCH_MESSAGE) return undefined;
  fetch(message.url, message.options || {}).then(async (response) => {
    if (message.responseType === 'base64') { sendResponse({ ok: response.ok, status: response.status, mime: response.headers.get('content-type') || 'application/octet-stream', base64: encodeBase64(await response.arrayBuffer()) }); return; }
    const text = await response.text(); let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || '本机服务返回了无效响应' }; }
    sendResponse({ ok: response.ok, status: response.status, data });
  }).catch((error) => sendResponse({ ok: false, status: 0, error: error?.message || '无法连接本机工作台' }));
  return true;
});
