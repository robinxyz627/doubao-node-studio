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
  // 状态轮询会每隔几秒刷新工作区列表；输入框获得焦点后，绝不能用服务端旧值覆盖
  // 用户尚未提交的名称。只在未编辑状态下同步显示名称。
  let workspaceNameEditing = false;
  const workspaceNameInput = byId('workspace-name');
  // 画布级撤回：只记录会改变工程内容的字段，避免点选节点、平移视图也占用撤回次数。
  const cloneCanvas = (canvas) => JSON.parse(JSON.stringify(canvas));
  const comparableCanvas = (canvas) => {
    const snapshot = cloneCanvas(canvas || blankCanvas());
    delete snapshot.activeNodeId; delete snapshot.activeVideoId; delete snapshot.selectedNodeIds; delete snapshot.view;
    return snapshot;
  };
  let canvasUndoStack = [], canvasRedoStack = [], lastCanvasHistory = null, historyWorkspaceId = '';
  const historyJson = (canvas) => JSON.stringify(comparableCanvas(canvas));
  const resetCanvasHistory = (clear = false) => {
    if (!state.canvas) return;
    const snapshot = comparableCanvas(state.canvas);
    if (clear || historyWorkspaceId !== state.workspaceId) { canvasUndoStack = []; canvasRedoStack = []; historyWorkspaceId = state.workspaceId; }
    lastCanvasHistory = snapshot;
  };
  const recordCanvasChange = () => {
    if (!state.canvas) return;
    const current = comparableCanvas(state.canvas);
    if (!lastCanvasHistory || historyWorkspaceId !== state.workspaceId) { historyWorkspaceId = state.workspaceId; lastCanvasHistory = current; return; }
    if (historyJson(current) === historyJson(lastCanvasHistory)) return;
    canvasUndoStack.push(lastCanvasHistory); if (canvasUndoStack.length > 80) canvasUndoStack.shift();
    canvasRedoStack = []; lastCanvasHistory = current;
  };
  const baseSaveCanvasForHistory = saveCanvas;
  saveCanvas = function () { recordCanvasChange(); return baseSaveCanvasForHistory(); };
  const restoreCanvasHistory = async (direction) => {
    const source = direction === 'undo' ? canvasUndoStack : canvasRedoStack;
    if (!source.length || !state.canvas) return;
    const target = source.pop(), current = comparableCanvas(state.canvas);
    (direction === 'undo' ? canvasRedoStack : canvasUndoStack).push(current);
    state.canvas = cloneCanvas(target);
    state.canvas.images ||= {}; state.canvas.drafts ||= []; state.canvas.texts ||= []; state.canvas.videos ||= [];
    state.canvas.selectedNodeIds = []; state.canvas.activeNodeId = null; state.canvas.activeVideoId = null;
    state.canvas.view = state.view;
    lastCanvasHistory = comparableCanvas(state.canvas);
    await flushCanvas(); render();
  };
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target?.matches?.('input, textarea, [contenteditable]')) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault(); event.stopImmediatePropagation();
    restoreCanvasHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo').catch((error) => alert(error.message || String(error)));
  }, true);
  workspaceNameInput.addEventListener('focus', () => { workspaceNameEditing = true; });
  workspaceNameInput.addEventListener('input', () => { workspaceNameEditing = true; });
  workspaceNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); byId('rename-workspace').click(); }
  });
  byId('workspace-select').addEventListener('change', () => { workspaceNameEditing = false; }, true);
  // 图片节点删除必须是持久删除。此前先写入本地隐藏标记、再等防抖保存；
  // 用户立刻刷新时，旧画布会从服务端重新载入，看起来像节点“复活”。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.target?.matches?.('input, textarea, [contenteditable]')) return;
    const id = state.canvas?.activeNodeId;
    const asset = state.assets.find((item) => item.id === id);
    if (!asset) return;
    event.preventDefault(); event.stopImmediatePropagation();
    (async () => {
      try {
        await api(`/api/assets/${encodeURIComponent(asset.id)}`, { method:'DELETE' });
        state.assets = state.assets.filter((item) => item.id !== asset.id);
        delete state.canvas.images[asset.id];
        state.canvas.hiddenAssets = (state.canvas.hiddenAssets || []).filter((item) => item !== asset.id);
        state.canvas.selectedNodeIds = (state.canvas.selectedNodeIds || []).filter((item) => item !== asset.id);
        state.canvas.videos.forEach((item) => { item.assetIds = item.assetIds.filter((assetId) => assetId !== asset.id); });
        state.canvas.activeNodeId = null;
        await flushCanvas();
        // 实体文件已经删除，不能把它作为可恢复的普通画布历史版本。
        resetCanvasHistory(true);
        render();
      } catch (error) { alert(error.message || String(error)); }
    })();
  }, true);
  byId('rename-workspace').onclick = async () => {
    const name = byId('workspace-name').value.trim(); if (!name) return;
    await api(`/api/workspaces/${state.workspaceId}`, { method: 'POST', body: JSON.stringify({ name }) });
    workspaceNameEditing = false;
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
  // 普通设定图节点为了紧凑会裁切预览；截帧必须完整保留原视频画幅，不能沿用该规则。
  const baseImageNodeForFrame = imageNode;
  const isCapturedFrame = (asset) => /^(截帧|来自视频节点当前帧)/.test(String(asset.description || ''));
  imageNode = function (asset, index) {
    const node = baseImageNodeForFrame(asset, index);
    if (!isCapturedFrame(asset)) return node;
    const image = node.querySelector('.image-preview img');
    const applyNaturalRatio = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      node.classList.add('frame-image-node');
      node.style.setProperty('--frame-ratio', `${image.naturalWidth} / ${image.naturalHeight}`);
    };
    image.addEventListener('load', applyNaturalRatio, { once:true });
    if (image.complete) applyNaturalRatio();
    return node;
  };
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
  const uploadLocalVideos = async (files, position) => {
    state.canvas.localVideos ||= [];
    let offset = 0;
    for (const file of [...files]) {
      if (!/^video\/(mp4|webm|quicktime)$/i.test(file.type) && !/\.(mp4|webm|mov)$/i.test(file.name)) continue;
      if (file.size > 800 * 1024 * 1024) throw new Error(`“${file.name}”超过 800MB 上限`);
      const response = await fetch('/api/local-videos', { method:'POST', headers:{ 'X-Doubao-Studio-Key':state.key, 'X-Workspace-Id':state.workspaceId, 'X-File-Name':encodeURIComponent(file.name), 'Content-Type':file.type || 'application/octet-stream' }, body:file });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || '本地视频上传失败');
      state.canvas.localVideos.push({ ...body.video, x:position.x + offset, y:position.y + offset }); offset += 28;
    }
    saveCanvas(); render();
  };
  // 原始拖放处理只认识图片；含视频时由这里接管，支持图与视频混合拖入。
  viewport.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])], videos = files.filter((file) => /^video\//.test(file.type) || /\.(mp4|webm|mov)$/i.test(file.name));
    if (!videos.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const position = worldAt(event.clientX, event.clientY), images = files.filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type));
    Promise.all([images.length ? uploadFiles(images, position) : null, uploadLocalVideos(videos, { x:position.x + images.length * 28, y:position.y + images.length * 28 })]).catch((error) => alert(error.message || String(error)));
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!drag || !state.canvas) return;
    const next = { x: drag.origin.x + (event.clientX - drag.startX) / state.view.scale, y: drag.origin.y + (event.clientY - drag.startY) / state.view.scale };
    const video = state.canvas.videos.find((item) => item.id === drag.id), text = state.canvas.texts.find((item) => item.id === drag.id), draft = state.canvas.drafts.find((item) => item.id === drag.id), localVideo = state.canvas.localVideos?.find((item) => item.id === drag.id);
    if (video) { video.x = next.x; video.y = next.y; } else if (text) { text.x = next.x; text.y = next.y; } else if (draft) { draft.x = next.x; draft.y = next.y; } else if (localVideo) { localVideo.x = next.x; localVideo.y = next.y; } else if (state.assets.some((item) => item.id === drag.id)) state.canvas.images[drag.id] = next; else return;
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
    popover.innerHTML = `<div class="popover-tabs"><span class="active">全能参考</span><span>视频编辑</span><span>视频延长</span><span>首尾帧</span><span>多图参考</span><span>动作模仿</span></div><div class="popover-references">${references}<span class="popover-reference add">＋</span></div><div class="popover-mention-list" hidden></div><div class="popover-prompt" contenteditable="${textSource ? 'false' : 'true'}"></div><p class="popover-help">最多连接 15 个参考素材；输入 @ 可选择已连接的图片，悬浮 @图号 查看缩略图。</p><div class="popover-footer"><span class="popover-chip">Seedance 2.0 Fast</span><select class="popover-aspect"><option>自动</option><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option></select><label class="popover-duration"><span>时长 <b>${duration}s</b></span><input type="range" min="4" max="10" step="1" value="${duration}"></label><button class="popover-submit" title="提交生成">↑</button></div>`;
    const editor = popover.querySelector('.popover-prompt'), list = popover.querySelector('.popover-mention-list'); const select = popover.querySelector('.popover-aspect'), durationRange = popover.querySelector('.popover-duration input'), durationLabel = popover.querySelector('.popover-duration b'); select.value = video.aspect || '自动';
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
    const id = node.dataset.nodeId, video = state.canvas.videos.find((item) => item.id === id), text = state.canvas.texts.find((item) => item.id === id), asset = state.assets.find((item) => item.id === id), draft = state.canvas.drafts.find((item) => item.id === id), localVideo = state.canvas.localVideos?.find((item) => item.id === id), p = video || text || (asset && imagePos(asset.id, state.assets.indexOf(asset))) || draft || localVideo;
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
    else if (state.canvas.localVideos?.some((item) => item.id === id)) state.canvas.localVideos = state.canvas.localVideos.filter((item) => item.id !== id);
    else if (state.assets.some((item) => item.id === id)) { state.canvas.hiddenAssets ||= []; state.canvas.hiddenAssets.push(id); state.canvas.videos.forEach((item) => { item.assetIds = item.assetIds.filter((assetId) => assetId !== id); }); }
    else return;
    state.canvas.activeNodeId = null; saveCanvas(); render(); event.preventDefault();
  });
  const originalGraph = renderGraph;
  const wireTextEditors = () => layer.querySelectorAll('.text-editor').forEach((editor) => { editor.onkeydown = (event) => { if (event.key === 'Escape') closeTextPicker(); }; });
  const appendLocalVideoNodes = () => (state.canvas.localVideos || []).forEach((video) => layer.append(localVideoNode(video)));
  renderGraph = function () { const hidden = new Set(state.canvas.hiddenAssets || []), original = state.assets; if (!hidden.size) { originalGraph(); appendLocalVideoNodes(); wireTextEditors(); return; } state.assets = original.filter((asset) => !hidden.has(asset.id)); try { originalGraph(); appendLocalVideoNodes(); wireTextEditors(); } finally { state.assets = original; } };
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
  // 成片节点可把当前播放头所在的一帧保存为普通图片素材。这样截图既会出现在
  // 画布上，也与用户手动上传的图片完全等价，可以直接连到下一镜。
  const videoNodeWithHistory = videoNode;
  const captureVideoFrame = async (video, node, button) => {
    const player = node.querySelector('.video-media video');
    if (!player || !player.videoWidth || !player.videoHeight) throw new Error('请先等待视频画面加载完成，再截取当前帧');
    const canvas = document.createElement('canvas');
    canvas.width = player.videoWidth; canvas.height = player.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(player, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    const frameTime = Number.isFinite(player.currentTime) ? player.currentTime.toFixed(1) : '0.0';
    button.disabled = true; button.textContent = '保存中…';
    try {
      const result = await api('/api/assets', { method:'POST', body:JSON.stringify({
        workspaceId:state.workspaceId,
        name:`截帧_${frameTime}s_${new Date().toLocaleTimeString('zh-CN', { hour12:false }).replace(/:/g, '')}`,
        description:`截帧 · 来自视频节点当前帧（${frameTime}s）`, mime:'image/png', dataUrl,
      }) });
      const width = node.offsetWidth || videoGeometry(video)[0];
      state.assets.push(result.asset);
      state.canvas.images[result.asset.id] = { x:video.x + width + 58, y:video.y + 18 };
      saveCanvas(); render();
    } finally {
      button.disabled = false; button.textContent = '📷 截帧';
    }
  };
  videoNode = function (video) {
    const node = videoNodeWithHistory(video);
    const media = node.querySelector('.video-media');
    if (!media?.querySelector('video')) return node;
    const action = document.createElement('button');
    action.type = 'button'; action.className = 'video-snapshot-action';
    action.title = '将当前暂停画面截为图片节点'; action.setAttribute('aria-label', '截取当前帧');
    action.textContent = '📷 截帧';
    action.addEventListener('pointerdown', (event) => event.stopPropagation());
    action.onclick = async (event) => {
      event.preventDefault(); event.stopPropagation();
      try { await captureVideoFrame(video, node, action); }
      catch (error) { action.disabled = false; action.textContent = '📷 截帧'; alert(error.message || String(error)); }
    };
    node.append(action);
    return node;
  };
  // 普通素材视频节点：不含提示词、比例或提交按钮，只提供播放和截帧。
  const localVideoNode = (video) => {
    const body = `<div class="video-media local-video-media"><video src="${esc(video.url)}" controls preload="metadata" playsinline></video></div><p class="local-video-hint">本地素材视频 · 暂停在所需画面后可截帧，用于下一镜参考。</p>`;
    const node = titleNode(video.id, '▸', '素材视频', 'LOCAL', body, '', 'local-video-node');
    position(node, video);
    const action = document.createElement('button');
    action.type = 'button'; action.className = 'video-snapshot-action'; action.title = '将当前暂停画面截为图片节点'; action.setAttribute('aria-label', '截取当前帧'); action.textContent = '📷 截帧';
    action.addEventListener('pointerdown', (event) => event.stopPropagation());
    action.onclick = async (event) => {
      event.preventDefault(); event.stopPropagation();
      try { await captureVideoFrame(video, node, action); }
      catch (error) { action.disabled = false; action.textContent = '📷 截帧'; alert(error.message || String(error)); }
    };
    node.append(action); return node;
  };
  // 视频专属右键菜单与“悬挂副本”。副本在落点前只是 DOM 预览，绝不会污染
  // 工程；落点后才写入画布，因此可以自然地用 Esc 取消。
  const videoNodeMenu = byId('video-node-menu');
  let pendingVideoClone = null;
  const cancelVideoClone = () => {
    pendingVideoClone?.ghost?.remove(); pendingVideoClone = null;
  };
  const cloneVideoRecord = (source, type, point) => {
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = uid(type === 'generated' ? 'video' : 'localvideo-node'); copy.x = point.x; copy.y = point.y;
    if (type === 'generated') { copy.assetIds = [...(source.assetIds || [])]; copy.textNodeId = source.textNodeId || null; delete copy.selectedVersionJobId; }
    return copy;
  };
  const startVideoClone = (source, type, sourceNode, clientX, clientY) => {
    cancelVideoClone();
    const ghost = sourceNode.cloneNode(true);
    ghost.classList.add('video-clone-ghost'); ghost.removeAttribute('data-node-id'); ghost.querySelectorAll('[id]').forEach((item) => item.removeAttribute('id'));
    layer.append(ghost); pendingVideoClone = { source, type, ghost };
    position(ghost, worldAt(clientX, clientY));
    videoNodeMenu.hidden = true;
  };
  viewport.addEventListener('contextmenu', (event) => {
    const node = event.target.closest?.('.video-node, .local-video-node'); if (!node) return;
    const id = node.dataset.nodeId, generated = state.canvas.videos.find((item) => item.id === id), localVideo = state.canvas.localVideos?.find((item) => item.id === id), source = generated || localVideo;
    if (!source) return;
    event.preventDefault(); event.stopImmediatePropagation(); cancelVideoClone();
    byId('context-menu').hidden = true; byId('node-menu').hidden = true;
    videoNodeMenu.hidden = false; videoNodeMenu.style.left = `${event.clientX}px`; videoNodeMenu.style.top = `${event.clientY}px`;
    videoNodeMenu.dataset.nodeId = id; videoNodeMenu.dataset.nodeType = generated ? 'generated' : 'local';
  }, true);
  videoNodeMenu.addEventListener('pointerdown', (event) => event.stopPropagation());
  videoNodeMenu.onclick = async (event) => {
    const action = event.target.dataset.videoAction; if (!action) return;
    const id = videoNodeMenu.dataset.nodeId, type = videoNodeMenu.dataset.nodeType;
    const source = type === 'generated' ? state.canvas.videos.find((item) => item.id === id) : state.canvas.localVideos?.find((item) => item.id === id);
    const node = layer.querySelector(`[data-node-id="${id}"]`); if (!source || !node) { videoNodeMenu.hidden = true; return; }
    if (action === 'snapshot') {
      const button = event.target; videoNodeMenu.hidden = true;
      try { await captureVideoFrame(source, node, button); }
      catch (error) { alert(error.message || String(error)); }
      return;
    }
    if (action === 'duplicate') startVideoClone(source, type, node, Number.parseFloat(videoNodeMenu.style.left) || 0, Number.parseFloat(videoNodeMenu.style.top) || 0);
  };
  viewport.addEventListener('pointermove', (event) => {
    if (!pendingVideoClone) return;
    position(pendingVideoClone.ghost, worldAt(event.clientX, event.clientY));
  }, true);
  viewport.addEventListener('pointerdown', (event) => {
    if (!pendingVideoClone || event.button !== 0 || event.target.closest?.('.context-menu, .drawer, .topbar, .video-popover')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const point = worldAt(event.clientX, event.clientY), copy = cloneVideoRecord(pendingVideoClone.source, pendingVideoClone.type, point);
    if (pendingVideoClone.type === 'generated') state.canvas.videos.push(copy);
    else { state.canvas.localVideos ||= []; state.canvas.localVideos.push(copy); }
    // 副本一落到画布就立即落盘；不能只依赖 260ms 的防抖，
    // 否则紧接着刷新/热更新时会留下“看见了但未保存”的副本。
    cancelVideoClone(); saveCanvas(); render();
    flushCanvas().catch((error) => {
      console.error('副本节点保存失败', error);
      alert(`副本已创建，但工程保存失败：${error.message || error}`);
    });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingVideoClone) { event.preventDefault(); cancelVideoClone(); }
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest?.('#video-node-menu, .video-node, .local-video-node')) videoNodeMenu.hidden = true;
  }, true);
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
    if (!state.canvas || workspaceId !== state.workspaceId) {
      const result = await fullLoad(workspaceId); state.canvas.localVideos ||= []; resetCanvasHistory(true); return result;
    }
    const [data, library] = await Promise.all([fetch(`/api/state?workspaceId=${encodeURIComponent(state.workspaceId)}`).then((response) => response.json()), fetch('/api/library').then((response) => response.json())]);
    state.jobs = data.jobs; state.workspaces = data.workspaces; state.assets = data.assets; state.localVideos = data.localVideos || []; state.canvas.localVideos ||= []; state.accounts = data.accounts || []; state.library = library.items || []; state.libraryRoot = library.root || '';
    const signature = videoVersionSignature();
    renderJobs(); renderLibrary(); renderWorkspaces(); renderAccounts();
    if (signature !== lastVideoVersionSignature) { lastVideoVersionSignature = signature; renderGraph(); renderEdges(); applyView(); }
    else syncVideoJobStates();
    if (!lastCanvasHistory) resetCanvasHistory();
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
    // 轮询只更新下拉列表；编辑中的输入值由用户掌控，提交或切换工程后再同步。
    if (!workspaceNameEditing && document.activeElement !== workspaceNameInput) workspaceNameInput.value = workspace?.name || '';
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
      const dailyLimit = Number(account.dailyLimit) || 3;
      const remaining = Math.max(0, Number(account.remainingToday) || 0);
      const calibrationMaximum = Math.max(0, dailyLimit - reserved);
      card.innerHTML = `<header><b>${esc(account.name || '未命名账号')}</b><span class="account-status ${accountStatusClass(status)}">${esc(status)}</span></header><p>${esc(account.lastDetail || '等待账号窗口中的桥接扩展建立连接。')}</p><footer><span>今日成片 ${Number(account.usedToday) || 0} / ${dailyLimit}${reserved ? ` · 暂占 ${reserved}` : ''} · 最多 ${Number(account.maxWorkers) || 3} 条并行</span><button type="button">打开窗口</button></footer><div class="quota-calibration"><label>Fast 实际剩余 <input type="number" min="0" max="${calibrationMaximum}" step="1" value="${remaining}" inputmode="numeric"></label><button type="button" data-calibrate-quota>校准</button><small>${account.manuallyCalibrated ? '已按手动校准执行（次日自动重置）' : '以网页显示的实际剩余次数为准'}</small></div>`;
      card.querySelector('button').onclick = async () => {
        try { await api(`/api/accounts/${encodeURIComponent(account.id)}/launch`, { method:'POST', body:'{}' }); await load(); }
        catch (error) { alert(error.message || String(error)); }
      };
      card.querySelector('[data-calibrate-quota]').onclick = async () => {
        const input = card.querySelector('.quota-calibration input');
        try {
          const result = await api(`/api/accounts/${encodeURIComponent(account.id)}/quota`, { method:'POST', body:JSON.stringify({ remaining:input.value }) });
          state.accounts = (state.accounts || []).map((item) => item.id === account.id ? result.account : item);
          renderAccounts();
          byId('bridge-state').textContent = `已校准「${account.name}」：Fast 剩余 ${result.account.remainingToday} 次`;
        } catch (error) { alert(error.message || String(error)); }
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
  const projectDialog = byId('project-dialog');
  const promptOrderList = byId('prompt-order-list');
  let promptOrder = [];
  const promptHoverCard = document.createElement('aside');
  promptHoverCard.id = 'prompt-order-hover-card'; promptHoverCard.className = 'prompt-order-hover-card'; promptHoverCard.hidden = true;
  document.body.append(promptHoverCard);
  let promptHoverCloseTimer = null;
  const assetName = (id) => state.assets?.find((asset) => asset.id === id)?.name || id;
  const promptTooltip = (video, index) => {
    const references = (video.assetIds || []).map(assetName);
    const header = `镜头 ${index + 1} · ${video.aspect || '自动'} · ${video.sourceDuration || '10s'}`;
    const referenceText = references.length ? `引用素材：${references.join('、')}` : '引用素材：无';
    return `${header}\n${referenceText}\n\n完整提示词\n${String(video.prompt || '未填写提示词')}`;
  };
  const movePromptHoverCard = (event) => {
    const margin = 14, maxX = window.innerWidth - 440, maxY = window.innerHeight - 300;
    promptHoverCard.style.left = `${Math.max(8, Math.min(maxX, event.clientX + margin))}px`;
    promptHoverCard.style.top = `${Math.max(8, Math.min(maxY, event.clientY + margin))}px`;
  };
  const cancelPromptHoverClose = () => { clearTimeout(promptHoverCloseTimer); promptHoverCloseTimer = null; };
  const hidePromptHoverCard = (immediately = false) => {
    cancelPromptHoverClose();
    const close = () => { promptHoverCard.hidden = true; promptHoverCard.textContent = ''; };
    if (immediately) close(); else promptHoverCloseTimer = setTimeout(close, 180);
  };
  promptHoverCard.addEventListener('pointerenter', cancelPromptHoverClose);
  promptHoverCard.addEventListener('pointerleave', () => hidePromptHoverCard());
  const orderedProjectVideos = () => {
    const videos = [...(state.canvas?.videos || [])];
    const map = new Map(videos.map((video) => [video.id, video]));
    const known = promptOrder.map((id) => map.get(id)).filter(Boolean);
    const unknown = videos.filter((video) => !promptOrder.includes(video.id)).sort((a, b) => a.y - b.y || a.x - b.x);
    promptOrder = [...known, ...unknown].map((video) => video.id);
    return [...known, ...unknown];
  };
  const promptNodeLabel = (video, index) => {
    const firstLine = String(video.prompt || '').split(/\r?\n/).find((line) => line.trim())?.replace(/\s+/g, ' ').slice(0, 30) || '未填写提示词';
    return `镜头 ${index + 1} · ${firstLine}`;
  };
  const renderPromptOrder = () => {
    if (!promptOrderList) return;
    const videos = orderedProjectVideos(); promptOrderList.textContent = '';
    if (!videos.length) { promptOrderList.innerHTML = '<p class="empty">当前画布没有视频节点。</p>'; return; }
    videos.forEach((video, index) => {
      const row = document.createElement('div'); row.className = 'prompt-order-item';
      row.innerHTML = `<b>${index + 1}</b><span class="prompt-order-label" tabindex="0">${esc(promptNodeLabel(video, index))}</span><small>${esc(video.aspect || '自动')} · ${esc(video.sourceDuration || '10s')}</small><button type="button" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" title="下移" ${index === videos.length - 1 ? 'disabled' : ''}>↓</button>`;
      const label = row.querySelector('.prompt-order-label');
      const showTip = (event) => { cancelPromptHoverClose(); promptHoverCard.textContent = promptTooltip(video, index); promptHoverCard.hidden = false; movePromptHoverCard(event); };
      label.addEventListener('pointerenter', showTip); label.addEventListener('pointerleave', () => hidePromptHoverCard());
      label.addEventListener('focus', (event) => showTip({ clientX:event.target.getBoundingClientRect().right, clientY:event.target.getBoundingClientRect().bottom }));
      label.addEventListener('blur', hidePromptHoverCard);
      const buttons = row.querySelectorAll('button');
      buttons[0].onclick = () => { [promptOrder[index - 1], promptOrder[index]] = [promptOrder[index], promptOrder[index - 1]]; renderPromptOrder(); };
      buttons[1].onclick = () => { [promptOrder[index + 1], promptOrder[index]] = [promptOrder[index], promptOrder[index + 1]]; renderPromptOrder(); };
      promptOrderList.append(row);
    });
  };
  const saveDownload = async (url, options, fallbackName) => {
    const response = await fetch(url, { ...options, headers:{ 'X-Doubao-Studio-Key':state.key, ...(options?.headers || {}) } });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || '导出失败'); }
    const blob = await response.blob(), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = fallbackName; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 3000);
  };
  byId('toggle-project').onclick = () => { projectDialog.hidden = false; renderPromptOrder(); };
  byId('project-close').onclick = () => { projectDialog.hidden = true; hidePromptHoverCard(true); };
  projectDialog.addEventListener('pointerdown', (event) => { if (event.target === projectDialog) { projectDialog.hidden = true; hidePromptHoverCard(true); } });
  byId('project-export').onclick = async () => {
    try { await flushCanvas(); await saveDownload(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/export`, { method:'GET' }, 'doubao-project.zip'); byId('bridge-state').textContent = '工程包已导出：包含画布、图片与素材视频，不含已生成成片'; }
    catch (error) { alert(error.message || String(error)); }
  };
  byId('project-import-file').onchange = async (event) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    try {
      const response = await fetch('/api/projects/import', { method:'POST', headers:{ 'X-Doubao-Studio-Key':state.key, 'Content-Type':'application/zip' }, body:file });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '工程导入失败');
      projectDialog.hidden = true; await load(result.workspace.id); byId('bridge-state').textContent = `已导入工程：${result.assets} 张图片、${result.localVideos} 个素材视频`;
    } catch (error) { alert(error.message || String(error)); }
  };
  byId('prompt-export').onclick = async () => {
    try { await flushCanvas(); orderedProjectVideos(); await saveDownload(`/api/workspaces/${encodeURIComponent(state.workspaceId)}/prompts.xlsx`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ nodeIds:promptOrder }) }, '视频提示词.xlsx'); byId('bridge-state').textContent = `已按 ${promptOrder.length} 个视频节点的当前排序导出 Excel`; }
    catch (error) { alert(error.message || String(error)); }
  };
  // 可恢复的人工介入：浏览器最小化后，用户仍能在工作台明确看到卡在什么
  // 步骤，并决定“处理弹窗后重试”或“我已经手动发送”。
  const baseJobInfoForAttention = jobInfo;
  jobInfo = function (video) {
    const job = nodeJob(video);
    if (job?.status === 'awaiting_user') return { label:'等待你处理', detail:job.userAction?.instructions || job.statusDetail || '请在豆包页面处理后继续', media:'等待人工处理', cls:'failed' };
    return baseJobInfoForAttention(video);
  };
  async function continuePausedJob(id, action) {
    try {
      // “提交前复核”暂停时，先把用户刚在画布改好的比例/时长落盘，服务端会
      // 用这一份真实节点参数更新原任务，避免旧任务仍拿着之前的“自动”。
      const paused = state.jobs.find((job) => job.id === id);
      if (action === 'retry' && paused?.userAction?.kind === 'settings_unconfirmed') await flushCanvas();
      const result = await api(`/api/jobs/${encodeURIComponent(id)}/continue`, { method:'POST', body:JSON.stringify({ action }) });
      state.jobs = state.jobs.map((job) => job.id === id ? result.job : job); render();
      byId('bridge-state').textContent = action === 'sent' ? '已确认网页发送，扩展正在恢复结果监听' : '已继续任务，正在由原账号窗口重新执行';
    } catch (error) { alert(error.message || String(error)); }
  }
  renderJobs = function () {
    const list = byId('job-list'); list.textContent = '';
    if (!state.jobs.length) { list.innerHTML = '<p class="empty">本工作区还没有任务。</p>'; return; }
    const labels = { queued:'等待扩展', dispatching:'正在准备', awaiting_user:'等待你处理', prepared:'已填入网页', submitted:'已提交', generating:'生成中', succeeded:'生成成功', face_rejected:'肖像保护未通过', content_rejected:'内容审核未通过', failed:'生成失败', quota_exhausted:'额度已用完' };
    const active = new Set(['queued','dispatching','awaiting_user','prepared','submitted','generating']);
    state.jobs.forEach((job) => {
      const row = document.createElement('article'); row.className = 'job';
      const action = job.status === 'awaiting_user' ? `<section class="job-action"><b>${esc(job.userAction?.title || '需要在豆包页面处理')}</b><small>${esc(job.userAction?.instructions || job.statusDetail || '')}</small><button class="ghost" data-resume-job="${job.id}">我已处理，继续</button>${job.userAction?.canConfirmSent ? `<button class="ghost" data-sent-job="${job.id}">我已在网页发送</button>` : ''}</section>` : '';
      row.innerHTML = `<div class="job-status ${job.status}">${labels[job.status] || job.status}</div>${job.stage ? `<small>步骤：${esc(job.stage)}</small>` : ''}<strong>${esc(job.prompt)}</strong><small>${esc(job.statusDetail || '')}</small>${job.accountName ? `<small>账号容器：${esc(job.accountName)}</small>` : ''}${action}${job.result?.localUrl ? `<a class="result-link" href="${job.result.localUrl}" download>下载成片</a>` : ''}${active.has(job.status) ? `<button class="ghost job-cancel" data-cancel-job="${job.id}">结束并移除</button>` : ''}`;
      row.querySelector('[data-cancel-job]')?.addEventListener('click', () => cancelJob(job.id));
      row.querySelector('[data-resume-job]')?.addEventListener('click', () => continuePausedJob(job.id, 'retry'));
      row.querySelector('[data-sent-job]')?.addEventListener('click', () => continuePausedJob(job.id, 'sent'));
      list.append(row);
    });
  };
})();
