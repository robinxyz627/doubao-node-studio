(() => {
  let selectedEdge = null;
  let marquee = null;
  let cutting = null;
  let suppressContextMenuUntil = 0;
  const edgeKey = (sourceId, targetId) => `${sourceId}:${targetId}`;
  const nodeModel = (id) => state.canvas.videos.find((item) => item.id === id) || state.canvas.localVideos?.find((item) => item.id === id) || state.canvas.texts.find((item) => item.id === id) || state.canvas.drafts.find((item) => item.id === id) || state.assets.find((item) => item.id === id);
  const nodePosition = (id) => {
    const model = nodeModel(id); if (!model) return null;
    return state.assets.some((asset) => asset.id === id) ? (state.canvas.images[id] || imagePos(id, state.assets.findIndex((asset) => asset.id === id))) : model;
  };
  const setNodePosition = (id, position) => {
    const model = nodeModel(id); if (!model) return;
    if (state.assets.some((asset) => asset.id === id)) state.canvas.images[id] = position;
    else { model.x = position.x; model.y = position.y; }
  };
  const selectedIds = () => new Set(state.canvas?.selectedNodeIds || []);
  const syncSelection = () => layer.querySelectorAll('.graph-node').forEach((node) => node.classList.toggle('selected-node', selectedIds().has(node.dataset.nodeId)));
  const setSelectedNodes = (ids) => { state.canvas.selectedNodeIds = [...new Set(ids)]; syncSelection(); saveCanvas(); };
  const cubic = (from, to) => {
    const bend = Math.max(75, (to.x - from.x) * .45);
    return { d:`M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`, mid:{ x:(from.x + 3 * (from.x + bend) + 3 * (to.x - bend) + to.x) / 8, y:(from.y + 3 * from.y + 3 * to.y + to.y) / 8 } };
  };
  const removeEdge = ({ sourceId, targetId }) => {
    const video = state.canvas.videos.find((item) => item.id === targetId); if (!video) return;
    if (video.textNodeId === sourceId) video.textNodeId = null;
    else video.assetIds = video.assetIds.filter((assetId) => assetId !== sourceId);
    selectedEdge = null; saveCanvas(); render();
  };
  renderEdges = function () {
    if (!state.canvas) return;
    const paths = [];
    state.canvas.videos.forEach((video) => {
      const to = point(video.id, 'in');
      [...video.assetIds, video.textNodeId].filter(Boolean).forEach((sourceId) => {
        const from = point(sourceId, 'out'), curve = cubic(from, to), key = edgeKey(sourceId, video.id), active = selectedEdge?.key === key;
        paths.push(`<path class="graph-edge-visible${active ? ' selected' : ''}" data-edge-key="${key}" d="${curve.d}"></path><path class="graph-edge-hit" data-edge-key="${key}" data-source-id="${sourceId}" data-target-id="${video.id}" d="${curve.d}"></path>`);
        if (active) paths.push(`<g class="edge-cut" data-source-id="${sourceId}" data-target-id="${video.id}" transform="translate(${curve.mid.x} ${curve.mid.y})"><circle r="15"></circle><text text-anchor="middle" dominant-baseline="central">✂</text></g>`);
      });
    });
    if (connection) { const from = point(connection.assetId, 'out'), curve = cubic(from, connection.end); paths.push(`<path class="graph-edge-visible preview" d="${curve.d}"></path>`); }
    if (cutting?.points?.length > 1) paths.push(`<path class="edge-slash" d="M ${cutting.points.map((item) => `${item.x} ${item.y}`).join(' L ')}"></path>`);
    edges.innerHTML = paths.join(''); syncSelection();
  };
  edges.addEventListener('pointerdown', (event) => {
    const cutter = event.target.closest?.('.edge-cut');
    if (cutter) { removeEdge({ sourceId:cutter.dataset.sourceId, targetId:cutter.dataset.targetId }); event.preventDefault(); event.stopPropagation(); return; }
    const edge = event.target.closest?.('.graph-edge-hit[data-edge-key]'); if (!edge) return;
    selectedEdge = { key:edge.dataset.edgeKey, sourceId:edge.dataset.sourceId, targetId:edge.dataset.targetId };
    renderEdges(); event.preventDefault(); event.stopPropagation();
  });
  edges.addEventListener('pointermove', (event) => {
    const edge = event.target.closest?.('.graph-edge-hit[data-edge-key]'), key = edge?.dataset.edgeKey || '';
    edges.querySelectorAll('.graph-edge-visible').forEach((path) => path.classList.toggle('hovered', Boolean(key) && path.dataset.edgeKey === key));
  });
  edges.addEventListener('pointerleave', () => edges.querySelectorAll('.graph-edge-visible.hovered').forEach((path) => path.classList.remove('hovered')));
  const orientation = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const intersects = (a, b, c, d) => {
    const ab1 = orientation(a, b, c), ab2 = orientation(a, b, d), cd1 = orientation(c, d, a), cd2 = orientation(c, d, b);
    return ((ab1 > 0 && ab2 < 0) || (ab1 < 0 && ab2 > 0)) && ((cd1 > 0 && cd2 < 0) || (cd1 < 0 && cd2 > 0));
  };
  const cutEdgesBetween = (start, end) => {
    const severed = [];
    edges.querySelectorAll('.graph-edge-visible[data-edge-key]').forEach((path) => {
      const length = path.getTotalLength(); let previous = path.getPointAtLength(0);
      for (let distance = Math.max(4, length / 32); distance <= length; distance += Math.max(4, length / 32)) {
        const current = path.getPointAtLength(Math.min(length, distance));
        if (intersects(start, end, previous, current)) { severed.push({ sourceId:path.dataset.edgeKey.split(':')[0], targetId:path.dataset.edgeKey.slice(path.dataset.edgeKey.indexOf(':') + 1) }); break; }
        previous = current;
      }
    });
    if (!severed.length) return;
    severed.forEach(({ sourceId, targetId }) => {
      const video = state.canvas.videos.find((item) => item.id === targetId); if (!video) return;
      if (video.textNodeId === sourceId) video.textNodeId = null;
      else video.assetIds = video.assetIds.filter((assetId) => assetId !== sourceId);
    });
    selectedEdge = null; saveCanvas(); renderEdges();
  };
  const selectionBox = document.createElement('div'); selectionBox.className = 'canvas-selection-box'; selectionBox.hidden = true; viewport.append(selectionBox);
  const updateMarquee = (event) => {
    if (!marquee) return;
    const bounds = viewport.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const left = Math.min(marquee.startX, x), top = Math.min(marquee.startY, y), width = Math.abs(x - marquee.startX), height = Math.abs(y - marquee.startY);
    marquee.box = { left, top, width, height }; Object.assign(selectionBox.style, { left:`${left}px`, top:`${top}px`, width:`${width}px`, height:`${height}px` }); selectionBox.hidden = false;
  };
  const finishMarquee = () => {
    if (!marquee) return; const viewportRect = viewport.getBoundingClientRect(), box = marquee.box || { left:marquee.startX, top:marquee.startY, width:0, height:0 }, picked = [];
    if (box.width > 4 || box.height > 4) layer.querySelectorAll('.graph-node').forEach((node) => {
      const rect = node.getBoundingClientRect(), left = rect.left - viewportRect.left, top = rect.top - viewportRect.top;
      if (left < box.left + box.width && left + rect.width > box.left && top < box.top + box.height && top + rect.height > box.top) picked.push(node.dataset.nodeId);
    });
    if (box.width > 4 || box.height > 4) setSelectedNodes(picked);
    else setSelectedNodes([]);
    selectionBox.hidden = true; marquee = null;
  };
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('.graph-node, .graph-edges path, .edge-cut, .video-popover, .drawer, .topbar, .context-menu, button, input, select, [contenteditable]')) return;
    if (!viewport.contains(event.target)) return; const rect = viewport.getBoundingClientRect(); marquee = { startX:event.clientX - rect.left, startY:event.clientY - rect.top }; selectedEdge = null; renderEdges();
  }, true);
  document.addEventListener('pointermove', (event) => updateMarquee(event), true);
  document.addEventListener('pointerup', () => finishMarquee(), true);
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 2 || !viewport.contains(event.target) || event.target.closest?.('.drawer, .topbar, .context-menu, .video-popover')) return;
    cutting = { points:[worldAt(event.clientX, event.clientY)], moved:false }; selectedEdge = null; renderEdges(); event.preventDefault();
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!cutting || !(event.buttons & 2)) return;
    const next = worldAt(event.clientX, event.clientY), previous = cutting.points.at(-1);
    if (Math.hypot(next.x - previous.x, next.y - previous.y) < 3) return;
    cutting.points.push(next); cutting.moved = true; cutEdgesBetween(previous, next); renderEdges(); event.preventDefault(); event.stopPropagation();
  }, true);
  document.addEventListener('pointerup', (event) => {
    if (event.button !== 2 || !cutting) return;
    suppressContextMenuUntil = cutting.moved ? Date.now() + 350 : 0; cutting = null; renderEdges(); event.preventDefault();
  }, true);
  document.addEventListener('contextmenu', (event) => {
    if (Date.now() < suppressContextMenuUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('.port, button, input, select, [contenteditable], .edge-cut')) return;
    const node = event.target.closest?.('.graph-node'); if (!node || !state.canvas) return;
    const id = node.dataset.nodeId, current = selectedIds();
    if (event.shiftKey) { if (current.has(id)) current.delete(id); else current.add(id); }
    else if (!current.has(id)) { current.clear(); current.add(id); }
    setSelectedNodes([...current]);
  }, true);
  // fixups.js 的拖拽监听在 capture 阶段创建 drag。这里也必须在 capture 阶段、
  // 且在“选中当前节点”之后建立整组坐标快照；若放在冒泡阶段，前面的
  // stopPropagation 会让这段逻辑根本不执行，表现就是框选后只移动首个节点。
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('.port, button, input, select, [contenteditable], .edge-cut')) return;
    const node = event.target.closest?.('.graph-node'); if (!node || !drag || drag.id !== node.dataset.nodeId) return;
    drag.group = [...selectedIds()].map((nodeId) => {
      const origin = nodePosition(nodeId); return origin ? { id:nodeId, origin:{ x:origin.x, y:origin.y } } : null;
    }).filter(Boolean);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!drag?.group?.length) return;
    const dx = (event.clientX - drag.startX) / state.view.scale, dy = (event.clientY - drag.startY) / state.view.scale;
    drag.group.forEach((item) => {
      const next = { x:item.origin.x + dx, y:item.origin.y + dy }; setNodePosition(item.id, next); position(layer.querySelector(`[data-node-id="${item.id}"]`), next);
    });
    renderEdges(); event.stopPropagation();
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && selectedEdge) { selectedEdge = null; renderEdges(); } });
})();
