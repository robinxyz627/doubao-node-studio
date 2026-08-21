const DOUBAO_NODE_STUDIO_BUILD = '0.7.9';
const DOUBAO_NODE_STUDIO_PAGE_STATUS = 'DOUBAO_NODE_STUDIO_PAGE_STATUS';
if (window.__doubaoNodeStudioBridgeInjected === DOUBAO_NODE_STUDIO_BUILD) {
  const duplicateWorker = sessionStorage.getItem('doubao-node-studio-managed-worker') === '1' || /[?&](?:dnst|dnsw)=/.test(location.search);
  chrome.storage.local.get(['accountId'], (value) => chrome.runtime.sendMessage({ type:DOUBAO_NODE_STUDIO_PAGE_STATUS, status:{ state:'已连接豆包页面', detail:'既有桥接脚本已恢复心跳', accountId:value.accountId || null, managedWorker:duplicateWorker, build:DOUBAO_NODE_STUDIO_BUILD, lastPoll:new Date().toISOString() } }).catch(() => {}));
} else {
window.__doubaoNodeStudioBridgeInjected = DOUBAO_NODE_STUDIO_BUILD;
(() => {
  const DEFAULT_ORIGIN = 'http://127.0.0.1:4318';
  const FETCH_MESSAGE = 'DOUBAO_NODE_STUDIO_LOCAL_FETCH';
  const PAGE_STATUS_MESSAGE = DOUBAO_NODE_STUDIO_PAGE_STATUS;
  const TRUSTED_CLICK_MESSAGE = 'DOUBAO_NODE_STUDIO_TRUSTED_CLICK';
  const MEDIA_FETCH_MESSAGE = 'DOUBAO_NODE_STUDIO_MEDIA_FETCH';
  const MEDIA_FETCH_REQUEST = 'DOUBAO_NODE_STUDIO_MEDIA_FETCH_REQUEST';
  const MEDIA_FETCH_RESULT = 'DOUBAO_NODE_STUDIO_MEDIA_FETCH_RESULT';
  const MEDIA_STATUS_REQUEST = 'DOUBAO_NODE_STUDIO_MEDIA_STATUS_REQUEST';
  const MEDIA_STATUS_RESULT = 'DOUBAO_NODE_STUDIO_MEDIA_STATUS_RESULT';
  const DOWNLOAD_MEDIA_MESSAGE = 'DOUBAO_NODE_STUDIO_DOWNLOAD_MEDIA';
  const MEDIA_CANDIDATE = 'DOUBAO_NODE_STUDIO_MEDIA_CANDIDATE';
  const ENSURE_EXTRACTOR_MESSAGE = 'DOUBAO_NODE_STUDIO_ENSURE_EXTRACTOR';
  const SPAWN_WORKER_MESSAGE = 'DOUBAO_NODE_STUDIO_SPAWN_WORKER';
  const FOCUS_WORKER_MESSAGE = 'DOUBAO_NODE_STUDIO_FOCUS_WORKER';
  const PROMOTE_BOOTSTRAP_WINDOW_MESSAGE = 'DOUBAO_NODE_STUDIO_PROMOTE_BOOTSTRAP_WINDOW';
  const TRUSTED_KEY_MESSAGE = 'DOUBAO_NODE_STUDIO_TRUSTED_KEY';
  const TRUSTED_DURATION_MESSAGE = 'DOUBAO_NODE_STUDIO_TRUSTED_DURATION';
  let activeJob = null; let monitor = null; let polling = false; let lastRecovery = 0; let accountId = ''; let workerId = sessionStorage.getItem('doubao-node-studio-worker-id') || crypto.randomUUID(); sessionStorage.setItem('doubao-node-studio-worker-id', workerId);
  let managedWorker = sessionStorage.getItem('doubao-node-studio-managed-worker') === '1' || /[?&](?:dnst|dnsw)=/.test(location.search);
  if (managedWorker) sessionStorage.setItem('doubao-node-studio-managed-worker', '1');
  function reportStatus(status) {
    const payload = { ...status, accountId:accountId || null, workerId, managedWorker, build:DOUBAO_NODE_STUDIO_BUILD, lastPoll: new Date().toISOString() };
    chrome.runtime.sendMessage({ type: PAGE_STATUS_MESSAGE, status: payload }).catch(() => {});
    if (accountId && managedWorker) setTimeout(() => local(`/api/bridge/accounts/${encodeURIComponent(accountId)}/heartbeat`, { method:'POST', body:JSON.stringify({ state:payload.state, detail:payload.detail || '' }) }).catch(() => {}), 0);
  }
  function showBridgeBadge(text) {
    let badge = document.getElementById('doubao-node-studio-bridge-badge');
    if (!badge) { badge = document.createElement('div'); badge.id = 'doubao-node-studio-bridge-badge'; Object.assign(badge.style, { position:'fixed', right:'18px', bottom:'18px', zIndex:'2147483646', padding:'7px 10px', border:'1px solid #4d8f7d', borderRadius:'999px', background:'#15241feF', color:'#9cf0cb', font:'600 12px/1.2 Inter,"Microsoft YaHei",sans-serif', boxShadow:'0 8px 24px #0007', pointerEvents:'none' }); document.documentElement.append(badge); }
    badge.textContent = text;
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  chrome.runtime.sendMessage({ type:ENSURE_EXTRACTOR_MESSAGE }, (response) => { if (!response?.ok) reportStatus({ state:'主提取器未就绪', detail:response?.error || '无法注入豆包页面提取器', activeJob:null }); });
  window.addEventListener('message', (event) => { if (event.source !== window || event.data?.type !== MEDIA_FETCH_REQUEST) return; chrome.runtime.sendMessage({ type:MEDIA_FETCH_MESSAGE, url:event.data.url }, (response) => window.postMessage({ type:MEDIA_FETCH_RESULT, requestId:event.data.requestId, response }, location.origin)); });
  function installMediaInspector() {
    if (document.getElementById('doubao-node-studio-media-inspector')) return;
    const panel=document.createElement('aside'); panel.id='doubao-node-studio-media-inspector'; Object.assign(panel.style,{position:'fixed',right:'18px',top:'50%',transform:'translateY(-50%)',zIndex:'2147483646',width:'300px',maxHeight:'74vh',boxSizing:'border-box',padding:'12px',border:'1px solid #39435a',borderRadius:'12px',background:'#111722f2',boxShadow:'0 16px 45px #0008',color:'#edf1f8',font:'12px/1.45 Inter,"Microsoft YaHei",sans-serif',backdropFilter:'blur(12px)'});
    const heading=document.createElement('strong'); heading.textContent='无水印媒体'; heading.style.display='block'; heading.style.fontSize='13px';
    const detail=document.createElement('p'); detail.textContent='扫描当前豆包页面中的原始成片数据。'; Object.assign(detail.style,{margin:'7px 0 10px',color:'#aab5c8',minHeight:'18px'});
    const list=document.createElement('div'); Object.assign(list.style,{display:'grid',gap:'8px',maxHeight:'46vh',overflowY:'auto',paddingRight:'2px'});
    const scan=document.createElement('button'), close=document.createElement('button'); scan.textContent='扫描当前页'; close.textContent='×';
    Object.assign(close.style,{position:'absolute',right:'8px',top:'5px',border:'0',background:'transparent',color:'#aab5c8',fontSize:'18px'}); Object.assign(scan.style,{border:'1px solid #45536d',borderRadius:'7px',padding:'7px 9px',background:'#202a3b',color:'#eef2f8',fontWeight:'700'}); panel.append(heading,detail,list,scan,close); document.documentElement.append(panel);
    let pendingRequest='', candidates=[]; const setDetail=(value,color)=>{detail.textContent=value;detail.style.color=color||'#aab5c8'};
    const downloadCandidate=(candidate,index,button)=>{button.disabled=true;setDetail(`正在下载无水印成片 ${index + 1}…`,'#ffd077');chrome.runtime.sendMessage({type:DOWNLOAD_MEDIA_MESSAGE,url:candidate.url,fileName:`doubao_unwatermarked_${Date.now()}_${index + 1}.mp4`},(response)=>{if(response?.ok)setDetail(`已开始下载无水印成片 ${index + 1}。`,'#72dfa8');else{button.disabled=false;setDetail(`下载失败：${response?.error||'未知错误'}`,'#ff9a93')}});};
    const renderCandidates=()=>{list.textContent=''; candidates.forEach((candidate,index)=>{const card=document.createElement('article');Object.assign(card.style,{display:'grid',gridTemplateColumns:'84px 1fr',gap:'9px',padding:'8px',border:'1px solid #303b51',borderRadius:'9px',background:'#171e2b'});const preview=candidate.poster?document.createElement('img'):document.createElement('div');if(candidate.poster){preview.src=candidate.poster;preview.alt=`无水印成片 ${index+1} 预览`;preview.referrerPolicy='no-referrer';}else preview.textContent='视频';Object.assign(preview.style,{width:'84px',height:'54px',objectFit:'cover',borderRadius:'6px',background:'#0d1320',color:'#8390a8',display:'grid',placeItems:'center'});const meta=document.createElement('div');const title=document.createElement('b');title.textContent=`无水印成片 ${index+1}${index===0?' · 最新':''}`;const spec=document.createElement('small');spec.textContent=[candidate.width&&candidate.height?`${candidate.width}×${candidate.height}`:'规格未提供',candidate.duration?`${Math.round(candidate.duration)}s`:'',candidate.definition].filter(Boolean).join(' · ');Object.assign(spec.style,{display:'block',color:'#9ca9bd',margin:'3px 0 6px'});const button=document.createElement('button');button.textContent='下载此成片';Object.assign(button.style,{border:'1px solid #54bfa7',borderRadius:'6px',padding:'5px 7px',background:'#71d8bf',color:'#10201c',fontWeight:'700'});button.onclick=()=>downloadCandidate(candidate,index,button);meta.append(title,spec,button);card.append(preview,meta);list.append(card);});};
    close.onclick=()=>panel.remove(); scan.onclick=()=>{pendingRequest=crypto.randomUUID();scan.disabled=true;candidates=[];list.textContent='';setDetail('正在扫描页面与无水印媒体接口…','#ffd077');window.postMessage({type:MEDIA_STATUS_REQUEST,requestId:pendingRequest},location.origin);};
    let autoRetries=0; window.addEventListener('message',(event)=>{if(event.source!==window||event.data?.type!==MEDIA_STATUS_RESULT||event.data.requestId!==pendingRequest)return;scan.disabled=false;candidates=Array.isArray(event.data.candidates)?event.data.candidates:[];const ready=document.documentElement.dataset.doubaoNodeStudioExtractor||'未注入',responses=document.documentElement.dataset.doubaoNodeStudioResponseCount||'0';if(candidates.length){renderCandidates();setDetail(`已解析 ${candidates.length} 条无水印成片；按最新生成优先排列。`,'#72dfa8');}else {setDetail(event.data.diagnostic||event.data.error||`未找到：提取器 ${ready}，已观察 ${responses} 条相关响应。`,'#ff9a93');if(autoRetries<2){autoRetries+=1;setTimeout(()=>scan.click(),1800);}}}); window.addEventListener('message',(event)=>{if(event.source===window&&event.data?.type===MEDIA_CANDIDATE&&!candidates.length&&!scan.disabled)scan.click();}); setTimeout(()=>scan.click(),450);
  }
  setTimeout(installMediaInspector,900);
  const nativePointClick = (x, y) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type:TRUSTED_CLICK_MESSAGE, x, y }, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!response?.ok) { reject(new Error(response?.error || 'Chrome 原生点击失败')); return; }
      resolve();
    });
  });
  const nativeClick = (element) => new Promise((resolve, reject) => {
    const rect = element?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) { reject(new Error('待点击的豆包控件不可见')); return; }
    nativePointClick(rect.left + rect.width / 2, rect.top + rect.height / 2).then(resolve, reject);
  });
  const nativeKey = (key, code = key) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ type:TRUSTED_KEY_MESSAGE, key, code }, (response) => { if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; } if (!response?.ok) { reject(new Error(response?.error || 'Chrome 原生按键失败')); return; } resolve(); }));
  const nativeDuration = (steps) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ type:TRUSTED_DURATION_MESSAGE, steps }, (response) => { if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; } if (!response?.ok) { reject(new Error(response?.error || 'Chrome 原生时长设置失败')); return; } resolve(); }));
  const promoteBootstrapWindow = () => new Promise((resolve) => chrome.runtime.sendMessage({ type:PROMOTE_BOOTSTRAP_WINDOW_MESSAGE }, (response) => resolve(response || { ok:false })));
  function setDurationFallback(slider, value, minimum = 4) {
    // 旧后台扩展仍在运行时，保底走输入控件自身的标准 value + input/change 通道。
    // 正常情况下不会执行；执行后也会由下方 settled 校验拒绝错误的时长。
    slider.focus?.({ preventScroll:true });
    if (slider instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(slider, String(value));
      slider.dispatchEvent(new Event('input', { bubbles:true }));
      slider.dispatchEvent(new Event('change', { bubbles:true }));
      return;
    }
    slider.dispatchEvent(new KeyboardEvent('keydown', { key:'Home', code:'Home', bubbles:true, cancelable:true }));
    for (let index = 0; index < value - minimum; index += 1) slider.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', code:'ArrowRight', bubbles:true, cancelable:true }));
  }
  function secondsFromText(value) {
    const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(?:s|秒)/i);
    return match ? Number(match[1]) : NaN;
  }
  function durationScale(panel, slider) {
    const rawMin = Number(slider.getAttribute('aria-valuemin') ?? slider.min ?? 0);
    const rawMax = Number(slider.getAttribute('aria-valuemax') ?? slider.max ?? 0);
    // 豆包当前滑条内部是 0–11，界面显示 4s–15s。取页面两端的可见标签，
    // 不能把 aria-valuenow=0 直接解释为 0 秒。
    const labels = [...panel.querySelectorAll('*')]
      .filter((element) => element.children.length === 0)
      .map((element) => secondsFromText(element.textContent))
      .filter(Number.isFinite);
    const visibleMin = labels.length ? Math.min(...labels) : Number.isFinite(rawMin) ? rawMin : 4;
    const visibleMax = labels.length ? Math.max(...labels) : Number.isFinite(rawMax) ? rawMax : 10;
    return { rawMin, rawMax, visibleMin, visibleMax };
  }
  function sliderSeconds(slider, scale) {
    const ariaText = secondsFromText(slider.getAttribute('aria-valuetext'));
    if (Number.isFinite(ariaText)) return ariaText;
    const raw = Number(slider.getAttribute('aria-valuenow') ?? slider.value);
    if (!Number.isFinite(raw) || !Number.isFinite(scale.rawMax) || scale.rawMax === scale.rawMin) return NaN;
    return scale.visibleMin + (raw - scale.rawMin) * (scale.visibleMax - scale.visibleMin) / (scale.rawMax - scale.rawMin);
  }
  const settings = () => new Promise((resolve) => chrome.storage.local.get(['bridgeOrigin', 'bridgeKey', 'accountId', 'bootstrapToken'], (value) => resolve({ origin: value.bridgeOrigin || DEFAULT_ORIGIN, key: value.bridgeKey || '', accountId:value.accountId || '', bootstrapToken:value.bootstrapToken || '' })));
  const localFetch = (url, options, responseType = 'json') => new Promise((resolve) => chrome.runtime.sendMessage({ type: FETCH_MESSAGE, url, options, responseType }, resolve));
  async function local(path, options = {}) {
    const config = await settings(); if (!config.key) throw new Error('扩展尚未配置本地工作台密钥');
    const requestPath = path.startsWith('/api/bridge/') && accountId ? `${path}${path.includes('?') ? '&' : '?'}accountId=${encodeURIComponent(accountId)}&workerId=${encodeURIComponent(workerId)}` : path;
    const response = await localFetch(`${config.origin}${requestPath}`, { ...options, headers: { 'Content-Type':'application/json', 'X-Doubao-Studio-Key':config.key, ...(options.headers || {}) } });
    if (!response?.ok) throw new Error(`本机桥接请求失败：${response?.data?.error || response?.error || '无法连接本机工作台'}`);
    return { data: response.data, config };
  }
  async function bootstrapAccount() {
    const config = await settings(); accountId = String(config.accountId || '');
    // 豆包登录会发生页面跳转，可能删掉 URL 中的 dnst 参数；先写入该账号容器自己的
    // 扩展存储，后续任何豆包聊天页都会在 15 分钟有效期内自动重试配对。
    const urlToken = new URL(location.href).searchParams.get('dnst');
    if (urlToken) await new Promise((resolve) => chrome.storage.local.set({ bootstrapToken:urlToken }, resolve));
    const token = urlToken || config.bootstrapToken;
    if (!token) return;
    const response = await localFetch(`${DEFAULT_ORIGIN}/api/bridge/bootstrap`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ token }) });
    if (!response?.ok) throw new Error(response?.data?.error || response?.error || '账号窗口初始化失败');
    accountId = response.data.accountId;
    await new Promise((resolve) => chrome.storage.local.set({ bridgeOrigin:response.data.origin, bridgeKey:response.data.key, accountId, bootstrapToken:'' }, resolve));
    const clean = new URL(location.href); clean.searchParams.delete('dnst'); history.replaceState({}, '', `${clean.pathname}${clean.search}${clean.hash}`);
    showBridgeBadge(`豆包工作台已连接 · ${response.data.accountName || '账号容器'}`);
  }
  async function localAsset(url) {
    const response = await localFetch(url, { method:'GET' }, 'base64');
    if (!response?.ok) throw new Error(`本机素材读取失败：${response?.error || '无法读取本地素材'}`);
    const bytes = Uint8Array.from(atob(response.base64), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: response.mime });
  }
  const draftText = () => {
    const prose = document.querySelector('[contenteditable="true"][role="textbox"].tiptap, [contenteditable="true"].ProseMirror');
    const textarea = [...document.querySelectorAll('textarea')].find((item) => item.offsetParent !== null && !item.getAttribute('aria-hidden'));
    return (prose?.innerText || textarea?.value || '').trim();
  };
  const draftHasFiles = () => [...document.querySelectorAll('input[type="file"]')].some((input) => input.files?.length);
  const draftIsDirty = () => !!draftText() || draftHasFiles();
  async function createFreshConversation() {
    const label = [...document.querySelectorAll('span')].find((item) => item.textContent.trim() === '新对话');
    const trigger = label?.closest('[class*="sidebar_nav_item"]') || label?.closest('.cursor-pointer');
    if (!trigger) throw new Error('未找到豆包侧栏的「新对话」入口');
    await nativeClick(trigger); await wait(750);
  }
  async function ensureCleanConversation() {
    // 每一个任务都建立一条独立豆包会话，避免任何历史内容参与本次生成。
    await createFreshConversation();
    await wait(520);
    if (draftIsDirty()) throw new Error('新对话创建后输入栏或图片引用仍未清空，已停止提交以避免串用上下文');
  }
  async function event(job, status, detail, result, stage, userAction) { await local(`/api/bridge/jobs/${job.id}/event`, { method:'POST', body:JSON.stringify({ status, detail, result, stage, userAction }) }); }
  const pageText = () => document.body?.innerText || '';
  class UserActionRequired extends Error { constructor(message) { super(message); this.name = 'UserActionRequired'; } }
  function blockingOverlay() {
    const overlays = [...document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="popup" i], [class*="mask" i]')].filter(isVisible);
    const words = overlays.map((item) => item.innerText || item.textContent || '').join('\n').replace(/\s+/g, ' ').trim();
    if (!words) return null;
    if (/真人(?:认证|识别)|人脸(?:验证|认证)|安全验证|人机验证|验证码|完成验证/.test(words)) return { kind:'verification', title:'豆包要求真人/安全验证', resumeStep:'restart', instructions:'请在置顶的豆包窗口完成真人或安全验证；完成后回到工作台点击「我已处理，继续」。' };
    if (/(?:下载|安装|打开).{0,12}(?:豆包|Windows|客户端|桌面版)|推荐.{0,12}(?:客户端|桌面版)/.test(words)) return { kind:'client_prompt', title:'豆包客户端推荐弹窗遮挡页面', resumeStep:'restart', instructions:'请在豆包窗口关闭或跳过客户端推荐弹窗；不要改变已选模型、比例和图片，然后点击「我已处理，继续」。' };
    return null;
  }
  async function pauseForUser(job, stage, action) {
    const detail = action.instructions || '豆包页面需要人工处理后才能继续。';
    await event(job, 'awaiting_user', detail, null, stage, action);
    reportStatus({ state:'等待人工处理', detail:`${stage}：${action.title}`, activeJob:null, lastError:null });
    throw new UserActionRequired(detail);
  }
  async function requireClearPage(job, stage) { const action = blockingOverlay(); if (action) await pauseForUser(job, stage, action); }
  async function reportStage(job, stage, detail) { await event(job, 'dispatching', detail, null, stage); reportStatus({ state:'正在处理任务', detail:`${stage}：${detail}`, activeJob:job.id, lastError:null }); }
  const buttons = () => [...document.querySelectorAll('button')];
  const isVisible = (element) => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
  const normalizedText = (value) => String(value || '').replace(/\s/g, '');
  const buttonByText = (text, scope = document) => [...scope.querySelectorAll('button,[role="menuitem"],[role="button"]')].find((button) => normalizedText(button.textContent) === normalizedText(text));
  const visibleButtonByText = (text) => [...document.querySelectorAll('button,[role="menuitem"],[role="button"]')].find((button) => isVisible(button) && normalizedText(button.textContent) === normalizedText(text));
  const visibleControl = (selector) => [...document.querySelectorAll(selector)].find(isVisible);
  const requestWorkerFocus = () => new Promise((resolve) => chrome.runtime.sendMessage({ type:FOCUS_WORKER_MESSAGE }, (response) => resolve(Boolean(response?.ok))));
  async function bringTaskWindowToFront() {
    // 必须先激活“收到本任务的这个 tab”，再提升其所属账号窗口。服务端会
    // 连续执行三次 Windows 置顶，覆盖 Chrome 接管焦点与页面刚恢复渲染的时点。
    await requestWorkerFocus();
    if (accountId && managedWorker) await local(`/api/bridge/accounts/${encodeURIComponent(accountId)}/foreground`, { method:'POST', body:'{}' }).catch(() => {});
    await wait(480);
    await requestWorkerFocus();
  }
  async function waitForVideoControl(job) {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await requireClearPage(job, '切换视频生成');
      const model = visibleControl('button[data-input-engine-actionbar-control-key="video-model"]');
      if (model) return model;
      const mode = visibleButtonByText('视频生成');
      if (mode) await nativeClick(mode).catch(() => {});
      if (attempt === 10) { reportStatus({ state:'正在处理任务', detail:'后台豆包页面仍在加载视频控件，正在自动激活后重试', activeJob:activeJob?.job?.id || null }); await requestWorkerFocus(); }
      await wait(300);
    }
    return null;
  }
  async function openParams(params) {
    for (let round = 0; round < 3; round += 1) {
      if (params.getAttribute('aria-expanded') !== 'true') await nativeClick(params);
      for (let attempt = 0; attempt < 25; attempt += 1) {
        // 豆包存在两套参数 UI：一套为 role=menu 的“比例/时长”面板，另一套
        // 是底部上拉栏。两者都必须同时识别到画幅与时长线索才算已展开。
        const panel = [...document.querySelectorAll('[role="menu"], [role="dialog"], [class*="popover" i], [class*="panel" i], [class*="sheet" i]')].find((item) => isVisible(item) && /比例|16:9|9:16|1:1/.test(item.textContent) && /时长|\d+\s*(?:s|秒)/i.test(item.textContent));
        if (panel) return panel;
        await wait(80);
      }
      // 页面切换动画中 click 可能被吞掉：下一轮先收起，再重新展开。
      if (params.getAttribute('aria-expanded') === 'true') { await nativeClick(params); await wait(120); }
    }
    return null;
  }
  async function setAspect(job, params, aspect) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await requireClearPage(job, '设置画幅比例');
      await requestWorkerFocus(); await wait(260);
      const panel = await openParams(params);
      const option = panel && [...panel.querySelectorAll('button,[role="button"],[role="radio"],[role="option"],label,div')].find((button) => isVisible(button) && normalizedText(button.textContent) === normalizedText(aspect));
      if (!option) await pauseForUser(job, '设置画幅比例', { kind:'missing_aspect', resumeStep:'upload_assets', title:`未找到可选比例 ${aspect}`, instructions:`豆包当前页面没有识别到 ${aspect}。请检查是否有参数上拉栏、是否被弹窗遮挡；手动选好 ${aspect} 后点击「我已处理，继续」。` });
      await nativeClick(option); await wait(420);
      // 展开的参数面板本身也会含有全部比例文字，不能在展开态检查文本。
      // 先明确收起，再读取豆包底部的已选摘要，例如“16:9 · 10s”。
      if (params.getAttribute('aria-expanded') === 'true') { await nativeClick(params); await wait(260); }
      const summary = normalizedText(params.textContent);
      if (summary.includes(normalizedText(aspect)) && (aspect !== '自动' || !/[0-9]+:[0-9]+/.test(summary))) return;
      await requestWorkerFocus(); await wait(260);
    }
    await pauseForUser(job, '校验画幅比例', { kind:'aspect_unconfirmed', resumeStep:'upload_assets', title:`豆包未确认 ${aspect}`, instructions:`请在豆包窗口手动确认比例已为 ${aspect}，再点击「我已处理，继续」。页面摘要：${params.textContent.trim() || '未识别'}` });
  }
  async function activateVideoGeneration(job) {
    await reportStage(job, '切换视频生成', '正在确认豆包视频生成模式');
    const model = await waitForVideoControl(job); if (!model) await pauseForUser(job, '切换视频生成', { kind:'missing_video_mode', resumeStep:'upload_assets', title:'未找到视频生成控件', instructions:'请打开豆包窗口，手动进入「视频生成」模式并关闭遮挡弹窗，然后点击「我已处理，继续」。' });
    if (!/Seedance\s*2\.0\s*Fast/i.test(model.textContent)) { await nativeClick(model); await wait(120); const fast = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, div')].find((item) => isVisible(item) && /Seedance\s*2\.0\s*Fast/i.test(item.textContent)); if (!fast) await pauseForUser(job, '选择视频模型', { kind:'missing_model', resumeStep:'upload_assets', title:'未识别到 Seedance 2.0 Fast', instructions:'请在豆包窗口手动选择 Seedance 2.0 Fast，并确认仍处于视频生成模式后点击「我已处理，继续」。' }); await nativeClick(fast); await wait(160); }
    const params = visibleControl('button[data-creation-params-panel-id]') || buttons().find((button) => isVisible(button) && /(?:自动|\d+:\d+).*(?:\d+\s*(?:s|秒)|时长)|(?:时长|比例).*(?:自动|\d+:\d+)/i.test(button.textContent || '')); const aspect = job.aspect || '自动';
    if (!params) await pauseForUser(job, '设置视频参数', { kind:'missing_params', resumeStep:'upload_assets', title:'未找到比例/时长入口', instructions:'豆包可能使用了另一版参数栏。请手动选择正确的比例和时长，确认页面无遮挡后点击「我已处理，继续」。' });
    await reportStage(job, '设置画幅比例', `正在选择 ${aspect}`); await setAspect(job, params, aspect);
    const requestedDuration = Math.min(10, Math.max(4, Number.parseInt(String(job.sourceDuration || '10').replace(/\D/g, ''), 10) || 10));
    // 豆包默认即为 10 秒：默认任务不触碰滑条，避免无意义的额外页面操作。
    if (requestedDuration !== 10) {
      await reportStage(job, '设置视频时长', `正在选择 ${requestedDuration}s`); await requireClearPage(job, '设置视频时长'); const durationPanel = await openParams(params);
      const slider = durationPanel?.querySelector('input[type="range"]') || durationPanel?.querySelector('[role="slider"]');
      if (!slider) await pauseForUser(job, '设置视频时长', { kind:'missing_duration', resumeStep:'upload_assets', title:'未找到时长滑条', instructions:`请在豆包窗口的参数面板中手动选择 ${requestedDuration}s，确认后点击「我已处理，继续」。` });
      const scale = durationScale(durationPanel, slider);
      if (requestedDuration < scale.visibleMin || requestedDuration > scale.visibleMax) throw new Error(`当前豆包时长滑条显示范围为 ${scale.visibleMin}–${scale.visibleMax}s，无法设置 ${requestedDuration}s`);
      const rawTarget = scale.rawMin + (requestedDuration - scale.visibleMin) * (scale.rawMax - scale.rawMin) / (scale.visibleMax - scale.visibleMin);
      // [role=slider] 的可见矩形只是滑块拇指，不是整条轨道；点击它不会改变
      // 默认的 10 秒。先聚焦拇指，再在同一次 debugger 会话内 Home + 4 次右键，
      // 其中内部 0 对应页面的 4 秒，因此 8 秒恰好是第 4 格。
      await nativeClick(slider);
      try { await nativeDuration(Math.round(rawTarget - scale.rawMin)); }
      catch (error) {
        reportStatus({ state:'时长设置降级处理', detail:`原生时长通道不可用，改用页面控件：${error.message}`, activeJob:activeJob?.id || null });
        setDurationFallback(slider, rawTarget, scale.rawMin);
      }
      await wait(360);
      const settled = sliderSeconds(slider, scale);
      if (Number.isFinite(settled) && Math.abs(settled - requestedDuration) > .6) await pauseForUser(job, '校验视频时长', { kind:'duration_unconfirmed', resumeStep:'upload_assets', title:`豆包未确认 ${requestedDuration}s`, instructions:`请手动确认时长为 ${requestedDuration}s 后点击「我已处理，继续」。页面当前识别为 ${settled}s。` });
    }
    if (params.getAttribute('aria-expanded') === 'true') await nativeClick(params); await wait(100);
  }
  async function verifyGenerationSettings(job) {
    await requireClearPage(job, '提交前复核');
    const expectedAspect = job.aspect || '自动';
    const expectedDuration = Math.min(10, Math.max(4, Number.parseInt(String(job.sourceDuration || '10').replace(/\D/g, ''), 10) || 10));
    const model = visibleControl('button[data-input-engine-actionbar-control-key="video-model"]') || buttons().find((button) => isVisible(button) && /Seedance\s*2\.0/i.test(button.textContent || ''));
    const params = visibleControl('button[data-creation-params-panel-id]') || buttons().find((button) => isVisible(button) && /(?:自动|\d+:\d+).*(?:\d+\s*(?:s|秒)|时长)|(?:时长|比例).*(?:自动|\d+:\d+)/i.test(button.textContent || ''));
    if (params?.getAttribute('aria-expanded') === 'true') { await nativeClick(params); await wait(220); }
    const modelSummary = normalizedText(model?.textContent || '');
    const parameterSummary = normalizedText(params?.textContent || '');
    const modelOk = /Seedance2\.0Fast/i.test(modelSummary);
    const aspectOk = expectedAspect === '自动' ? parameterSummary.includes('自动') && !/[0-9]+:[0-9]+/.test(parameterSummary) : parameterSummary.includes(normalizedText(expectedAspect));
    const durationOk = new RegExp(`${expectedDuration}(?:s|秒)`, 'i').test(parameterSummary);
    if (modelOk && aspectOk && durationOk) {
      await reportStage(job, '提交前复核通过', `已确认 Seedance 2.0 Fast · ${expectedAspect} · ${expectedDuration}s`);
      return;
    }
    const detected = `模型「${model?.textContent?.trim() || '未识别'}」，参数「${params?.textContent?.trim() || '未识别'}」`;
    await pauseForUser(job, '提交前复核', { kind:'settings_unconfirmed', resumeStep:'ready_to_submit', title:'豆包页面参数未通过提交前复核', instructions:`期望：Seedance 2.0 Fast · ${expectedAspect} · ${expectedDuration}s。当前检测到：${detected}。请在豆包窗口手动修正并收起参数面板，再点击「我已处理，继续」。` });
  }
  function setPrompt(value) {
    const editor = document.querySelector('[contenteditable="true"][role="textbox"].tiptap, [contenteditable="true"].ProseMirror');
    if (editor) { editor.focus(); document.execCommand('selectAll', false); document.execCommand('insertText', false, value); editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value })); return; }
    const textarea = document.querySelector('textarea'); if (!textarea) throw new Error('未找到豆包视频提示词输入框'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(textarea,value); textarea.dispatchEvent(new Event('input',{bubbles:true})); textarea.dispatchEvent(new Event('change',{bubbles:true}));
  }
  async function setFiles(job) {
    const input=document.querySelector('input[type="file"][accept*=".jpg"],input[type="file"]'); if(!input) await pauseForUser(job, '上传参考图片', { kind:'missing_upload', resumeStep:'restart', title:'未找到图片上传入口', instructions:'请在豆包窗口关闭弹窗并手动展开图片上传入口；无需上传图片，完成后回到工作台点击「我已处理，继续」。' });
    for(const asset of job.assets){ try { await requestWorkerFocus(); await wait(260); const blob=await localAsset(`${job.bridgeOrigin}${asset.url}`); const transfer=new DataTransfer(); transfer.items.add(new File([blob],`${asset.name}.${asset.mime.split('/')[1].replace('jpeg','jpg')}`,{type:asset.mime})); input.files=transfer.files; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); await wait(320); } catch (error) { throw new Error(`读取参考图「${asset.name}」失败：${error.message || error}`); } }
    await wait(360);
  }
  function findSendButton() { return document.querySelector('#flow-end-msg-send:not([disabled]):not([aria-disabled="true"])') || buttons().find((button) => button.type === 'submit' && !button.disabled && button.getAttribute('aria-hidden') !== 'true' && !button.closest('#doubao-assistant-root')); }
  function latestMedia() { const candidates=[...document.querySelectorAll('video,video source,a[href*=".mp4"],a[href*="video"]')];for(const element of candidates.reverse()){const value=element.currentSrc||element.src||element.href;if(value&&/^https?:/.test(value))return value;}return null; }
  function originalMediaUrl() { const requestId=crypto.randomUUID();return new Promise((resolve)=>{const listener=(event)=>{if(event.source!==window||event.data?.type!=='DOUBAO_NODE_STUDIO_MEDIA_RESULT'||event.data.requestId!==requestId)return;clearTimeout(timeout);window.removeEventListener('message',listener);resolve(event.data.media|| (event.data.url?{url:event.data.url}:null));};const timeout=setTimeout(()=>{window.removeEventListener('message',listener);resolve(null);},12000);window.addEventListener('message',listener);window.postMessage({type:'DOUBAO_NODE_STUDIO_EXTRACT_MEDIA',requestId},location.origin);}); }
  async function downloadIfAvailable(job) { const media=await originalMediaUrl(); if(!media?.url) return null; const result=await local(`/api/bridge/jobs/${job.id}/download`,{method:'POST',body:JSON.stringify({url:media.url,poster:media.poster||null,fileName:`${job.id}.mp4`})}); return result.data; }
  function textSinceSubmit(context) { const current=pageText(); return current.startsWith(context.baseline) ? current.slice(context.baseline.length) : current; }
  async function finish(context,status,detail,result) { clearInterval(monitor); monitor=null; try { await event(context.job,status,detail,result); } finally { activeJob=null; reportStatus({ state:'已连接豆包页面', detail:`任务 ${status}：${detail}`, activeJob:null }); } }
  async function monitorJob(context) { const delta=textSinceSubmit(context); if(/肖像保护|不支持上传真实人脸|人脸未通过|人脸检测未通过|人脸素材限制/.test(delta)){await finish(context,'face_rejected','豆包返回肖像保护或人脸素材限制');return;} if(/内容(?:可能)?存在违规|内容违规|疑似包含[\s\S]{0,30}违规|侵权\s*\/\s*违规|无法返回该内容|违反(?:内容|平台|社区)规范|安全审核(?:未通过|不通过)|不符合(?:平台|社区)规范/.test(delta)){await finish(context,'content_rejected','豆包内容安全审核未通过；本次生成额度未扣除');return;} if(/免费次数用完|额度已用完|暂时无法使用专业版/.test(delta)){await finish(context,'quota_exhausted','豆包页面提示当日免费次数已用完');return;} if(/你的视频生成好了|视频(?:已经|已)生成(?:好|完成)|生成完成(?:，|。|！|!)/.test(delta)){const downloaded=await downloadIfAvailable(context.job).catch(()=>null);await finish(context,'succeeded',downloaded?.savedAs?`生成成功，已保存至 ${downloaded.savedAs}`:'生成成功；未解析到豆包原始无水印地址，因此未下载预览流',downloaded?.result);return;} if(/生成失败|生成异常|请重试|暂时无法生成/.test(delta))await finish(context,'failed','豆包页面提示生成失败'); }
  function startMonitoring(context) { activeJob=context; clearInterval(monitor); monitor=setInterval(()=>monitorJob(context).catch((error)=>reportStatus({ state:'正在生成', detail:'等待豆包结果', lastError:error?.message || String(error), activeJob:context.job.id })),2500); }
  async function resumeSubmittedJob() { const response=await local('/api/bridge/active'); if(!response.data.job || activeJob)return false; const context={job:response.data.job,baseline:pageText()}; startMonitoring(context); reportStatus({ state:'正在生成', detail:`已恢复 ${context.job.id} 的结果监听`, activeJob:context.job.id, lastError:null }); return true; }
  async function recoverPendingDownload() { if(Date.now()-lastRecovery<30000)return false; const response=await local('/api/bridge/download-pending'); const job=response.data.job; if(!job)return false; lastRecovery=Date.now(); reportStatus({ state:'正在保存无水印成片', detail:`正在补充解析 ${job.id} 的原始成片地址`, activeJob:job.id, lastError:null }); const downloaded=await downloadIfAvailable(job).catch(()=>null); if(downloaded?.savedAs){await event(job,'succeeded',`生成成功，已保存至 ${downloaded.savedAs}`,downloaded.result);reportStatus({state:'已连接豆包页面',detail:`已补充保存 ${job.id} 的无水印成片`,activeJob:null,lastError:null});return true;} reportStatus({state:'已连接豆包页面',detail:'未解析到原始成片地址；将在页面数据更新后自动重试',activeJob:null,lastError:null});return false; }
  async function dispatch(job) { try { reportStatus({ state:'正在处理任务', detail:`正在激活豆包任务页并处理 ${job.id}`, activeJob:job.id, lastError:null }); await bringTaskWindowToFront(); await ensureCleanConversation(); await bringTaskWindowToFront(); await activateVideoGeneration(job); await bringTaskWindowToFront(); await setFiles(job); await bringTaskWindowToFront(); setPrompt(job.expandedPrompt); await wait(320); await event(job,'prepared',`已新建独立对话，切换视频生成、设置 ${job.aspect || '自动'}、逐张上传图片并填入提示词`); const send=findSendButton(); if(!send){await event(job,'prepared','已填入视频生成面板；未找到发送箭头，请在豆包网页检查后手动发送'); reportStatus({ state:'已连接豆包页面', detail:'任务已填入，等待网页端手动发送', activeJob:null });return;} const baseline=pageText(); const baselineUrl=location.href; await bringTaskWindowToFront(); await nativeClick(send); let confirmed=false; for(let attempt=0;attempt<16;attempt+=1){await wait(250);const delta=textSinceSubmit({baseline});if(/视频生成已提交|正在为您生成|预计等待\s*\d+\s*分钟/.test(delta) || location.href!==baselineUrl && /\/chat\/\d+/.test(location.pathname)){confirmed=true;break;}} if(!confirmed){await event(job,'prepared','发送箭头已触发，但豆包未返回“视频生成已提交”回执；任务仍等待网页确认'); reportStatus({ state:'已连接豆包页面', detail:'发送未获豆包回执，未标记为已提交', activeJob:null }); return;} const context={job,baseline}; await event(job,'submitted','豆包已确认视频生成提交，节点进入生成中'); if(accountId) chrome.runtime.sendMessage({ type:SPAWN_WORKER_MESSAGE, accountId }, () => {}); startMonitoring(context); reportStatus({ state:'正在生成', detail:`豆包已确认 ${job.id}，等待结果`, activeJob:job.id }); } catch(error) { await event(job,'failed',error.message||String(error)); activeJob=null; reportStatus({ state:'豆包页面已连接，但任务失败', detail:error.message||String(error), lastError:error.message||String(error), activeJob:null }); } }
  async function poll() { if(!managedWorker || polling || activeJob)return;polling=true;try{if(await resumeSubmittedJob())return;if(await recoverPendingDownload())return;const response=await local('/api/bridge/next'); reportStatus({ state:'已连接豆包页面', detail:'正在等待本机任务', activeJob:null, lastError:null }); if(response.data.job)await dispatch(response.data.job);}catch(error){reportStatus({ state:'豆包页面已连接，但本机轮询失败', detail:error?.message || String(error), lastError:error?.message || String(error), activeJob:null });}finally{polling=false;} }
  async function dispatchStaged(job) {
    try {
      const resumeStep = String(job.resumeStep || 'restart'); delete job.resumeStep;
      await reportStage(job, '唤醒账号窗口', '正在激活本次任务的豆包标签页');
      await bringTaskWindowToFront(); await requireClearPage(job, '唤醒账号窗口');
      const resumeAtSubmit = resumeStep === 'ready_to_submit';
      if (!resumeAtSubmit && resumeStep !== 'upload_assets') {
        await reportStage(job, '创建独立对话', '正在清空历史上下文');
        try { await ensureCleanConversation(); } catch (_) { await pauseForUser(job, '创建独立对话', { kind:'conversation_not_clean', resumeStep:'restart', title:'新对话未清空', instructions:'请在豆包窗口新建并确认空白对话，关闭提示弹窗后点击「我已处理，继续」。' }); }
        await bringTaskWindowToFront(); await requireClearPage(job, '切换视频生成');
        await activateVideoGeneration(job);
      } else if (!resumeAtSubmit) {
        await reportStage(job, '沿用人工确认的参数', '保留当前页面的模型、比例与时长设置');
        await requireClearPage(job, '沿用人工确认的参数');
      }
      if (!resumeAtSubmit) {
        await bringTaskWindowToFront(); await reportStage(job, '上传参考图片', `正在逐张上传 ${job.assets.length} 张参考图`); await requireClearPage(job, '上传参考图片'); await setFiles(job);
        await bringTaskWindowToFront(); await reportStage(job, '填入提示词', '正在写入已展开的图号提示词'); await requireClearPage(job, '填入提示词'); setPrompt(job.expandedPrompt); await wait(320);
      } else await reportStage(job, '沿用已填内容', '保留人工修正后的模型、参数、图片与提示词');
      await reportStage(job, '提交前复核', '正在核对模型、比例与时长'); await verifyGenerationSettings(job); await requireClearPage(job, '校验并发送');
      const send = findSendButton();
      if (!send) await pauseForUser(job, '等待发送', { kind:'missing_send', resumeStep:'restart', canConfirmSent:true, title:'未找到豆包发送箭头', instructions:'请检查图片、提示词、比例和时长。若你已手动点击豆包发送箭头，点「我已在网页发送」；否则处理页面提示后点「我已处理，继续」。' });
      const baseline = pageText(); const baselineUrl = location.href;
      await bringTaskWindowToFront(); await nativeClick(send);
      let confirmed = false;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await wait(250); await requireClearPage(job, '等待提交回执');
        const delta = textSinceSubmit({ baseline });
        if (/视频生成已提交|正在为您生成|预计等待\s*\d+\s*分钟/.test(delta) || location.href !== baselineUrl && /\/chat\/\d+/.test(location.pathname)) { confirmed = true; break; }
      }
      if (!confirmed) await pauseForUser(job, '等待提交回执', { kind:'submit_unconfirmed', resumeStep:'restart', canConfirmSent:true, title:'发送动作未获得豆包回执', instructions:'请在豆包窗口确认是否已经开始生成：已开始则点「我已在网页发送」恢复监听；未开始则处理页面提示后点「我已处理，继续」。' });
      const context = { job, baseline };
      await event(job, 'submitted', '豆包已确认视频生成提交，节点进入生成中', null, '等待生成结果');
      if (accountId) chrome.runtime.sendMessage({ type:SPAWN_WORKER_MESSAGE, accountId }, () => {});
      startMonitoring(context); reportStatus({ state:'正在生成', detail:`豆包已确认 ${job.id}，等待结果`, activeJob:job.id });
    } catch (error) {
      if (error instanceof UserActionRequired) { activeJob = null; return; }
      await event(job, 'failed', error.message || String(error), null, '自动化异常'); activeJob = null;
      reportStatus({ state:'豆包页面已连接，但任务失败', detail:error.message || String(error), lastError:error.message || String(error), activeJob:null });
    }
  }
  // 新版流程从这里进入；旧 dispatch 保留在文件中仅用于兼容已注入的旧页面。
  dispatch = dispatchStaged;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => { if (message?.type !== 'DOUBAO_NODE_STUDIO_WAKE') return undefined; reportStatus({ state:'已连接豆包页面', detail:activeJob ? '收到后台唤醒，正在检查本任务结果' : '收到后台唤醒，正在检查任务', activeJob:activeJob?.job?.id || null }); const work = activeJob ? monitorJob(activeJob) : poll(); work.catch((error) => reportStatus({ state:'桥接检查失败', detail:error?.message || String(error), activeJob:activeJob?.job?.id || null })).finally(() => sendResponse({ ok:true })); return true; });
  bootstrapAccount().then(() => {
    reportStatus({ state:'已连接豆包页面', detail:accountId ? (managedWorker ? '账号容器 Worker 已就绪，正在等待本机任务' : '历史豆包页已连接，不参与任务调度') : '桥接脚本已注入，正在等待本机任务', activeJob:null, lastError:null });
    setInterval(poll,1800); poll();
  }).catch((error) => reportStatus({ state:'账号窗口初始化失败', detail:error?.message || String(error), activeJob:null, lastError:error?.message || String(error) }));
})();
}
