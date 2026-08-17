(() => {
  const grid = () => {
    if (!state?.view) return;
    const s = state.view.scale, x = state.view.x, y = state.view.y;
    viewport.style.backgroundSize = `${16*s}px ${16*s}px, ${80*s}px ${80*s}px, ${80*s}px ${80*s}px`;
    viewport.style.backgroundPosition = `${x}px ${y}px, ${x}px ${y}px, ${x}px ${y}px`;
  };
  let previous = '';
  setInterval(() => { const next = `${state.view.x}:${state.view.y}:${state.view.scale}`; if (next !== previous) { previous = next; grid(); } }, 40);
  byId('context-menu').addEventListener('pointerdown', (event) => event.stopPropagation());
  byId('node-menu').addEventListener('pointerdown', (event) => event.stopPropagation());
  byId('new-workspace').onclick = async () => {
    const result = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: `工作区 ${state.workspaces.length + 1}` }) });
    saveCanvas(); await load(result.workspace.id);
  };
  byId('rename-workspace').onclick = async () => {
    const name = byId('workspace-name').value.trim(); if (!name) return;
    await api(`/api/workspaces/${state.workspaceId}`, { method: 'POST', body: JSON.stringify({ name }) });
    await load(state.workspaceId);
  };
  const bridgeDialog = byId('bridge-dialog');
  byId('bridge-connect').onclick = () => { byId('bridge-key').value = state.key || ''; bridgeDialog.hidden = false; };
  byId('bridge-close').onclick = () => { bridgeDialog.hidden = true; };
  byId('bridge-copy-key').onclick = async () => {
    const key = byId('bridge-key'); key.select(); key.setSelectionRange(0, key.value.length);
    try { await navigator.clipboard.writeText(key.value); byId('bridge-copy-key').textContent = '已复制'; }
    catch { document.execCommand('copy'); byId('bridge-copy-key').textContent = '已复制'; }
    setTimeout(() => { byId('bridge-copy-key').textContent = '复制密钥'; }, 1200);
  };
  const originalRender = renderWorkspaces;
  uploadFiles = async function (files, position) {
    let offset = 0;
    for (const file of [...files]) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) continue;
      const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
      const result = await api('/api/assets', { method: 'POST', body: JSON.stringify({ workspaceId: state.workspaceId, name: file.name.replace(/\.[^.]+$/, ''), description: '', mime: file.type, dataUrl }) });
      state.assets.push(result.asset); state.canvas.images[result.asset.id] = { x: position.x + offset, y: position.y + offset }; offset += 28;
    }
    if (pendingDraftId && state.assets.length) {
      const draft = state.canvas.drafts.find((item) => item.id === pendingDraftId), asset = state.assets.at(-1);
      if (draft) { state.canvas.images[asset.id] = { x: draft.x, y: draft.y }; state.canvas.drafts = state.canvas.drafts.filter((item) => item.id !== pendingDraftId); }
      pendingDraftId = null;
    }
    saveCanvas(); render();
  };
  document.addEventListener('pointermove', (event) => {
    if (!drag || !state.canvas) return;
    const next = { x: drag.origin.x + (event.clientX - drag.startX) / state.view.scale, y: drag.origin.y + (event.clientY - drag.startY) / state.view.scale };
    const video = state.canvas.videos.find((item) => item.id === drag.id), text = state.canvas.texts.find((item) => item.id === drag.id), draft = state.canvas.drafts.find((item) => item.id === drag.id);
    if (video) { video.x = next.x; video.y = next.y; } else if (text) { text.x = next.x; text.y = next.y; } else if (draft) { draft.x = next.x; draft.y = next.y; } else if (state.assets.some((item) => item.id === drag.id)) state.canvas.images[drag.id] = next; else return;
    position(layer.querySelector(`[data-node-id="${drag.id}"]`), next); renderEdges(); event.stopPropagation();
  }, true);
  const applyVideoAspect = () => layer.querySelectorAll('.video-node').forEach((node) => {
    const video = state.canvas?.videos?.find((item) => item.id === node.dataset.nodeId);
    if (video) { node.dataset.aspect = video.aspect || '自动'; node.classList.toggle('selected', state.canvas.activeVideoId === video.id); }
  });
  document.addEventListener('change', (event) => {
    if (event.target?.dataset?.field !== 'aspect') return;
    const video = state.canvas.videos.find((item) => item.id === event.target.closest('.video-node')?.dataset.nodeId);
    if (!video) return;
    video.aspect = event.target.value; saveCanvas(); render();
  }, true);
  setInterval(() => { applyVideoAspect(); layer.querySelectorAll('select[data-field="aspect"]').forEach((select) => ['4:3','3:4'].forEach((ratio) => { if (![...select.options].some((option) => option.value === ratio)) select.add(new Option(ratio, ratio)); })); }, 80);
  document.addEventListener('click', (event) => {
    const node = event.target.closest?.('.video-node');
    if (node) { state.canvas.activeVideoId = node.dataset.nodeId; applyVideoAspect(); saveCanvas(); return; }
    if (!event.target.closest?.('.drawer, .context-menu, .topbar, .video-popover')) { state.canvas.activeVideoId = null; applyVideoAspect(); saveCanvas(); }
  }, true);
  const popover = byId('video-popover');
  const videoGeometry = (video) => { const dimensions = { '9:16':[278,494], '1:1':[350,350], '4:3':[390,293], '3:4':[310,413], '21:9':[520,223], '16:9':[470,264], '自动':[470,264] }; return dimensions[video.aspect || '自动'] || dimensions['16:9']; };
  point = function (id, side) {
    const video = state.canvas.videos.find((item) => item.id === id);
    if (video) { const [, height] = videoGeometry(video); return { x: video.x + (side === 'in' ? 0 : videoGeometry(video)[0]), y: video.y + (height + 20) / 2 }; }
    const text = state.canvas.texts.find((item) => item.id === id);
    if (text) return { x: text.x + (side === 'out' ? 560 : 0), y: text.y + 140 };
    const asset = state.assets.find((item) => item.id === id), draft = state.canvas.drafts.find((item) => item.id === id), p = asset ? imagePos(asset.id, state.assets.indexOf(asset)) : draft;
    return { x: p.x + (side === 'out' ? 368 : 0), y: p.y + 136 };
  };
  renderEdges = function () { let html = ''; state.canvas.videos.forEach((video) => { const to = point(video.id, 'in'); [...video.assetIds, video.textNodeId].filter(Boolean).forEach((id) => { const from = point(id, 'out'), bend = Math.max(75, (to.x - from.x) * .45); html += `<path d="M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}"></path>`; }); }); if (connection) { const from = point(connection.assetId, 'out'), end = connection.end, bend = Math.max(75, (end.x - from.x) * .45); html += `<path d="M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}"></path>`; } edges.innerHTML = html; };
  let panelSignature = '';
  // 记住触发 @ 时的光标：点击候选列表会丢失原 selection，不能再把标签追加到末尾。
  const mentionRanges = new WeakMap();
  const rememberMentionRange = (editor) => {
    const selection = window.getSelection(); if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0); if (!editor.contains(range.startContainer)) return false;
    mentionRanges.set(editor, range.cloneRange()); return true;
  };
  const isMentionTrigger = (editor) => {
    const range = mentionRanges.get(editor); return !!range && range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE && range.startContainer.textContent[range.startOffset - 1] === '@';
  };
  const insertMentionAtTrigger = (editor, chip) => {
    const range = mentionRanges.get(editor) || document.createRange();
    if (!mentionRanges.has(editor)) { range.selectNodeContents(editor); range.collapse(false); }
    if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0 && range.startContainer.textContent[range.startOffset - 1] === '@') {
      range.setStart(range.startContainer, range.startOffset - 1); range.deleteContents();
    }
    range.insertNode(chip); const space = document.createTextNode(' '); range.setStartAfter(chip); range.insertNode(space); range.setStartAfter(space); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); mentionRanges.delete(editor);
  };
  const makeMention = (asset, label) => { const chip = document.createElement('span'); chip.className = 'mention'; chip.contentEditable = 'false'; chip.dataset.assetName = asset.name; chip.textContent = label; const image = document.createElement('img'); image.src = asset.url; image.alt = asset.name; chip.append(image); return chip; };
  const serializeEditable = (editor) => {
    const read = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.dataset?.assetName) return `@${node.dataset.assetName}`;
      if (node.tagName === 'BR') return '\n';
      const content = Array.from(node.childNodes).map(read).join('');
      return /^(DIV|P|LI)$/i.test(node.tagName) ? `${content}\n` : content;
    };
    return Array.from(editor.childNodes).map(read).join('').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  };
  editorText = serializeEditable;
  document.addEventListener('paste', (event) => {
    const editor = event.target.closest?.('[contenteditable="true"]'); if (!editor || !editor.matches('.popover-prompt, .text-editor, .prompt-editor')) return;
    event.preventDefault(); const text = (event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n'); document.execCommand('insertText', false, text);
  }, true);
  const drawPopover = () => {
    const video = state.canvas?.videos?.find((item) => item.id === state.canvas.activeVideoId);
    if (!video) { popover.hidden = true; panelSignature = ''; return; }
    const [width, height] = videoGeometry(video), textSource = state.canvas.texts.find((item) => item.id === video.textNodeId), duration = Math.min(10, Math.max(4, Number.parseInt(String(video.sourceDuration || '10').replace(/\D/g, ''), 10) || 10)), signature = `${video.id}:${video.assetIds.join(',')}:${video.textNodeId || ''}:${video.aspect || '自动'}:${duration}`;
    // 用实际节点高度定位：标题、版本缩略图条都会改变节点高度，不能只按视频画幅估算。
    const nodeHeight = layer.querySelector(`[data-node-id="${video.id}"]`)?.offsetHeight || height;
    popover.hidden = false; popover.style.left = `${video.x - 92}px`; popover.style.top = `${video.y + nodeHeight + 34}px`;
    if (signature === panelSignature) return; panelSignature = signature;
    const references = selectedAssets(video).map((asset) => `<span class="popover-reference"><img src="${asset.url}" title="${esc(asset.name)}"></span>`).join('') || '<span class="popover-reference add">＋</span>';
    const prompt = textSource ? textSource.prompt || '' : video.prompt || '';
    popover.innerHTML = `<div class="popover-tabs"><span class="active">全能参考</span><span>视频编辑</span><span>视频延长</span><span>首尾帧</span><span>多图参考</span><span>动作模仿</span></div><div class="popover-references">${references}<span class="popover-reference add">＋</span></div><div class="popover-mention-list" hidden></div><div class="popover-prompt" contenteditable="${textSource ? 'false' : 'true'}"></div><p class="popover-help">最多连接 15 个参考素材；输入 @ 可选择已连接的图片，悬浮 @图号 查看缩略图。</p><div class="popover-footer"><span class="popover-chip">Seedance 2.0 Fast</span><select class="popover-aspect"><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option></select><label class="popover-duration"><span>时长 <b>${duration}s</b></span><input type="range" min="4" max="10" step="1" value="${duration}"></label><button class="popover-submit" title="提交生成">↑</button></div>`;
    const editor = popover.querySelector('.popover-prompt'), list = popover.querySelector('.popover-mention-list'); const select = popover.querySelector('.popover-aspect'), durationRange = popover.querySelector('.popover-duration input'), durationLabel = popover.querySelector('.popover-duration b'); select.value = video.aspect === '自动' ? '16:9' : video.aspect;
    const serialize = () => serializeEditable(editor);
    const fill = () => { const directAssets = selectedAssets(video), libraryAssets = textSource ? state.library.filter((item) => item.mime.startsWith('image/') && prompt.includes(`@${item.name}`)) : [], assets = [...directAssets, ...libraryAssets.filter((item) => !directAssets.some((direct) => direct.name === item.name))], names = assets.map((item) => item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length), parts = names.length ? prompt.split(new RegExp(`(@(?:${names.join('|')}))`, 'g')) : [prompt]; parts.forEach((part) => { const asset = assets.find((item) => `@${item.name}` === part); if (!asset) { editor.append(document.createTextNode(part)); return; } const index = directAssets.findIndex((item) => item.name === asset.name); editor.append(makeMention(asset, index >= 0 ? `@图${index + 1}` : `@${asset.name}`)); }); };
    fill();
    const showMentions = () => { const assets = selectedAssets(video); if (!isMentionTrigger(editor)) return; list.textContent = ''; list.hidden = false; if (!assets.length) { list.innerHTML = '<button disabled>请先连接图片节点</button>'; return; } assets.forEach((asset, index) => { const button = document.createElement('button'); button.textContent = `@图${index + 1} · ${asset.name}`; button.onclick = () => { insertMentionAtTrigger(editor, makeMention(asset, `@图${index + 1}`)); video.prompt = serialize(); list.hidden = true; saveCanvas(); editor.focus(); }; list.append(button); }); };
    editor.oninput = () => { if (!textSource) { video.prompt = serialize(); saveCanvas(); } };
    editor.onkeydown = (event) => { if (!textSource && event.key === '@') setTimeout(() => { rememberMentionRange(editor); showMentions(); }, 0); if (event.key === 'Escape') list.hidden = true; };
    select.onchange = () => { const node = layer.querySelector(`[data-node-id="${video.id}"]`); node?.classList.add('aspect-anim'); video.aspect = select.value; saveCanvas(); applyVideoAspect(); panelSignature = ''; drawPopover(); renderEdges(); setTimeout(() => node?.classList.remove('aspect-anim'), 300); };
    durationRange.oninput = () => { video.sourceDuration = `${durationRange.value}s`; durationLabel.textContent = video.sourceDuration; saveCanvas(); };
    popover.querySelector('.popover-submit').onclick = () => queueJob(video);
  };
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('.port, button, input, select, [contenteditable], .video-popover')) return;
    const node = event.target.closest?.('.graph-node'); if (!node || !state.canvas) return;
    const id = node.dataset.nodeId, video = state.canvas.videos.find((item) => item.id === id), text = state.canvas.texts.find((item) => item.id === id), asset = state.assets.find((item) => item.id === id), draft = state.canvas.drafts.find((item) => item.id === id), p = video || text || (asset && imagePos(asset.id, state.assets.indexOf(asset))) || draft;
    if (!p) return; drag = { id, startX:event.clientX, startY:event.clientY, origin:{x:p.x,y:p.y} }; event.stopPropagation();
  }, true);
  setInterval(drawPopover, 80);
  document.addEventListener('dragstart', (event) => { if (event.target.closest?.('.graph-node')) event.preventDefault(); }, true);
  document.addEventListener('pointerdown', (event) => {
    const node = event.target.closest?.('.graph-node');
    if (node && !event.target.closest?.('.port, button, input, select, [contenteditable]')) { state.canvas.activeNodeId = node.dataset.nodeId; layer.querySelectorAll('.graph-node').forEach((item) => item.classList.toggle('selected-node', item.dataset.nodeId === state.canvas.activeNodeId)); saveCanvas(); }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.target.matches?.('input,textarea,[contenteditable]')) return;
    const id = state.canvas?.activeNodeId; if (!id) return;
    if (state.canvas.videos.some((item) => item.id === id)) { state.canvas.videos = state.canvas.videos.filter((item) => item.id !== id); if (state.canvas.activeVideoId === id) state.canvas.activeVideoId = null; }
    else if (state.canvas.texts.some((item) => item.id === id)) { state.canvas.texts = state.canvas.texts.filter((item) => item.id !== id); state.canvas.videos.forEach((item) => { if (item.textNodeId === id) item.textNodeId = null; }); }
    else if (state.canvas.drafts.some((item) => item.id === id)) state.canvas.drafts = state.canvas.drafts.filter((item) => item.id !== id);
    else if (state.assets.some((item) => item.id === id)) { state.canvas.hiddenAssets ||= []; state.canvas.hiddenAssets.push(id); state.canvas.videos.forEach((item) => { item.assetIds = item.assetIds.filter((assetId) => assetId !== id); }); }
    else return;
    state.canvas.activeNodeId = null; saveCanvas(); render(); event.preventDefault();
  });
  const originalGraph = renderGraph;
  const wireTextEditors = () => layer.querySelectorAll('.text-editor').forEach((editor) => { editor.onkeydown = (event) => { if (event.key === 'Escape') closeTextPicker(); }; });
  renderGraph = function () { const hidden = new Set(state.canvas.hiddenAssets || []), original = state.assets; if (!hidden.size) { originalGraph(); wireTextEditors(); return; } state.assets = original.filter((asset) => !hidden.has(asset.id)); try { originalGraph(); wireTextEditors(); } finally { state.assets = original; } };
  const topActions = byId('toggle-assets').parentElement;
  document.body.append(topActions);
  Object.assign(topActions.style, { position:'fixed', left:'50%', bottom:'18px', top:'auto', right:'auto', transform:'translateX(-50%)', width:'max-content', display:'flex', flexWrap:'nowrap', zIndex:'9999' });
  const fullLoad = load;
  const originalJobInfo = jobInfo;
  const videoVersions = (video) => state.jobs.filter((job) => job.nodeId === video.id && job.status === 'succeeded' && job.result?.localUrl);
  jobInfo = function (video) {
    const info = originalJobInfo(video), versions = videoVersions(video);
    const chosen = versions.find((job) => job.id === video.selectedVersionJobId) || versions[0];
    return chosen ? { ...info, url:chosen.result.localUrl, selectedVersionId:chosen.id, versionCount:versions.length } : info;
  };
  const baseVideoNode = videoNode;
  videoNode = function (video) {
    const node = baseVideoNode(video), versions = videoVersions(video);
    if (versions.length < 2) return node;
    const activeIndex = Math.max(0, versions.findIndex((job) => job.id === video.selectedVersionJobId));
    const currentIndex = activeIndex < 0 ? 0 : activeIndex;
    const history = document.createElement('div'); history.className = 'video-version-history';
    history.innerHTML = `<button class="version-arrow" data-version-step="-1" title="上一版">‹</button><div class="version-strip"></div><button class="version-arrow" data-version-step="1" title="下一版">›</button>`;
    const strip = history.querySelector('.version-strip');
    versions.forEach((job, index) => {
      const button = document.createElement('button'); button.className = `version-thumb${index === currentIndex ? ' active' : ''}`; button.title = `第 ${versions.length - index} 次生成`;
      const poster = job.result?.poster ? ` poster="${esc(job.result.poster)}"` : '';
      button.innerHTML = `<video src="${esc(job.result.localUrl)}"${poster} muted preload="metadata" playsinline></video><span>${versions.length - index}</span>`;
      button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); video.selectedVersionJobId = job.id; saveCanvas(); render(); };
      strip.append(button);
    });
    history.querySelectorAll('[data-version-step]').forEach((button) => button.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      const next = (currentIndex + Number(button.dataset.versionStep) + versions.length) % versions.length;
      video.selectedVersionJobId = versions[next].id; saveCanvas(); render();
    });
    // 版本切换属于成片预览的头部控件；放在预览上方，避免被下方的参数面板遮挡。
    node.querySelector('.video-media')?.before(history);
    return node;
  };
  let lastVideoVersionSignature = '';
  const videoVersionSignature = () => (state.canvas?.videos || []).map((video) => `${video.id}:${videoVersions(video).map((job) => `${job.id}:${job.result?.localUrl || ''}`).join(',')}`).join('|');
  const syncVideoJobStates = () => layer.querySelectorAll('.video-node').forEach((node) => {
    const video = state.canvas?.videos?.find((item) => item.id === node.dataset.nodeId); if (!video) return;
    const info = jobInfo(video), title = node.querySelector('.node-titlebar small'), media = node.querySelector('.video-media');
    if (title) title.textContent = info.label;
    if (!media) return;
    media.classList.toggle('generating', info.cls === 'generating'); media.classList.toggle('failed', info.cls === 'failed'); media.classList.toggle('succeeded', info.cls === 'succeeded');
    const currentVideo = media.querySelector('video');
    if (info.url) {
      // 状态轮询每 4 秒执行一次；如果重建 video 元素，浏览器会把播放进度和缓冲都清零。
      if (!currentVideo || currentVideo.getAttribute('src') !== info.url) media.innerHTML = `<video src="${info.url}" controls preload="auto" playsinline></video>`;
    } else if (currentVideo || media.textContent !== info.media) media.innerHTML = `<span class="media-label">${info.media}</span>`;
  });
  load = async function (workspaceId = state.workspaceId) {
    if (!state.canvas || workspaceId !== state.workspaceId) return fullLoad(workspaceId);
    const [data, library] = await Promise.all([fetch(`/api/state?workspaceId=${encodeURIComponent(state.workspaceId)}`).then((response) => response.json()), fetch('/api/library').then((response) => response.json())]);
    state.jobs = data.jobs; state.workspaces = data.workspaces; state.assets = data.assets; state.accounts = data.accounts || []; state.library = library.items || []; state.libraryRoot = library.root || '';
    const signature = videoVersionSignature();
    renderJobs(); renderLibrary(); renderWorkspaces(); renderAccounts();
    if (signature !== lastVideoVersionSignature) { lastVideoVersionSignature = signature; renderGraph(); renderEdges(); applyView(); }
    else syncVideoJobStates();
  };
  const saveDialog = byId('library-save-dialog');
  byId('node-menu').onclick = (event) => {
    const category = event.target.dataset.libraryCategory, asset = state.assets.find((item) => item.id === librarySourceId);
    if (!category || !asset) return;
    byId('library-save-category').value = category; byId('library-save-name').value = asset.name; byId('library-save-folder').value = '';
    byId('node-menu').hidden = true; saveDialog.hidden = false;
  };
  byId('library-save-cancel').onclick = () => { saveDialog.hidden = true; };
  byId('library-save-confirm').onclick = async () => {
    const asset = state.assets.find((item) => item.id === librarySourceId); if (!asset) return;
    const blob = await fetch(asset.url).then((response) => response.blob()); const dataUrl = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
    await api('/api/library', { method:'POST', body:JSON.stringify({ category:byId('library-save-category').value, name:byId('library-save-name').value.trim() || asset.name, folder:byId('library-save-folder').value.trim(), mime:asset.mime, dataUrl }) });
    saveDialog.hidden = true; const library = await fetch('/api/library').then((response) => response.json()); state.library = library.items || []; state.libraryRoot = library.root || ''; renderLibrary();
  };
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.target.matches?.('input,textarea,[contenteditable]')) return;
    const id = state.canvas?.activeNodeId; const asset = state.assets.find((item) => item.id === id); if (!asset) return;
    api(`/api/assets/${asset.id}`, { method:'DELETE' }).then(() => { state.assets = state.assets.filter((item) => item.id !== asset.id); state.canvas.hiddenAssets = (state.canvas.hiddenAssets || []).filter((item) => item !== asset.id); state.canvas.images[asset.id] = undefined; state.canvas.activeNodeId = null; saveCanvas(); render(); }).catch((error) => alert(error.message));
  });
  const textMentionPicker = byId('text-mention-picker');
  const textNodeForEditor = (editor) => state.canvas.texts.find((item) => item.id === editor.closest('.text-node')?.dataset.nodeId);
  const closeTextPicker = () => { textMentionPicker.hidden = true; textMentionPicker.textContent = ''; };
  document.addEventListener('input', (event) => {
    const editor = event.target; if (!editor.matches?.('.text-editor')) return; rememberMentionRange(editor); if (!isMentionTrigger(editor)) return;
    const textNode = textNodeForEditor(editor); if (!textNode) return;
    const images = state.library.filter((item) => item.mime.startsWith('image/')); const rect = editor.getBoundingClientRect();
    textMentionPicker.textContent = ''; textMentionPicker.style.left = `${rect.left}px`; textMentionPicker.style.top = `${Math.min(window.innerHeight - 270, rect.bottom + 5)}px`; textMentionPicker.hidden = false;
    if (!images.length) { textMentionPicker.innerHTML = '<button disabled>用户素材库中没有图片</button>'; return; }
    images.forEach((asset) => { const button = document.createElement('button'); button.textContent = `@${asset.name} · ${asset.folder ? `${asset.category}/${asset.folder}` : asset.category}`; button.onclick = () => { insertMentionAtTrigger(editor, makeMention(asset, `@${asset.name}`)); textNode.prompt = editorText(editor); saveCanvas(); closeTextPicker(); editor.focus(); }; textMentionPicker.append(button); });
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTextPicker(); });
  renderWorkspaces = function () {
    originalRender();
    const workspace = state.workspaces.find((item) => item.id === state.workspaceId);
    byId('workspace-name').value = workspace?.name || '';
  };
  byId('clear-jobs').onclick = async () => {
    if (!state.jobs.length) return;
    if (!window.confirm('清空当前工作区的全部本地任务记录？\n不会取消豆包网页已提交的生成，也不会删除已保存的视频文件。')) return;
    try {
      const result = await api(`/api/jobs?workspaceId=${encodeURIComponent(state.workspaceId)}`, { method:'DELETE' });
      state.jobs = [];
      render();
      byId('bridge-state').textContent = `已清空 ${result.removed || 0} 条任务；可以重新测试`;
    } catch (error) { alert(error.message || String(error)); }
  };
  const accountDrawer = byId('account-drawer');
  const accountList = byId('account-list');
  const accountStatusClass = (status) => /未连接|等待|启动/.test(status || '') ? 'waiting' : /失败|错误/.test(status || '') ? 'error' : '';
  function renderAccounts() {
    if (!accountList) return;
    const accounts = state.accounts || [];
    accountList.textContent = '';
    if (!accounts.length) { accountList.innerHTML = '<p class="empty">还没有账号容器。添加后会自动打开一个独立 Chrome 窗口。</p>'; return; }
    accounts.forEach((account) => {
      const card = document.createElement('article'); card.className = 'account-card';
      const status = account.status || '未连接';
      const reserved = Number(account.reservedToday) || 0;
      card.innerHTML = `<header><b>${esc(account.name || '未命名账号')}</b><span class="account-status ${accountStatusClass(status)}">${esc(status)}</span></header><p>${esc(account.lastDetail || '等待账号窗口中的桥接扩展建立连接。')}</p><footer><span>今日成片 ${Number(account.usedToday) || 0} / ${Number(account.dailyLimit) || 3}${reserved ? ` · 暂占 ${reserved}` : ''} · 最多 ${Number(account.maxWorkers) || 3} 条并行</span><button type="button">打开窗口</button></footer>`;
      card.querySelector('button').onclick = async () => {
        try { await api(`/api/accounts/${encodeURIComponent(account.id)}/launch`, { method:'POST', body:'{}' }); await load(); }
        catch (error) { alert(error.message || String(error)); }
      };
      accountList.append(card);
    });
  }
  byId('toggle-accounts').onclick = () => { accountDrawer.hidden = !accountDrawer.hidden; if (!accountDrawer.hidden) renderAccounts(); };
  byId('add-account').onclick = async () => {
    // Codex 内嵌浏览器可能拦截 prompt；首次创建直接使用可识别的默认名，
    // 关键动作（打开独立 Chrome 登录窗口）不依赖任何弹窗。
    const name = `豆包账号 ${(state.accounts || []).length + 1}`;
    try {
      const result = await api('/api/accounts', { method:'POST', body:JSON.stringify({ name }) });
      state.accounts = [...(state.accounts || []), result.account]; renderAccounts();
      byId('bridge-state').textContent = `已打开「${name}」的独立登录窗口；请在该窗口登录豆包`;
    } catch (error) { alert(error.message || String(error)); }
  };
})();
