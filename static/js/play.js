/* Play timeline page: rendering + editing gestures + conflict drawer. */
(function () {
  'use strict';
  const { el, escapeHtml, fmtTime, uid, colorFor, downloadJson } = U;

  const params = new URLSearchParams(location.search);
  const playId = params.get('id');
  if (!playId) { location.href = '/'; return; }

  let client = null;
  let play = null;
  let names = {};
  let members = [];
  let state = null;

  // px per second, adjustable with zoom buttons / wheel.
  let pxPerSec = 12;
  const SNAP = 0.5;
  const MIN_DUR = 1;
  let timelineEnd = 300; // seconds shown

  const $ = (id) => document.getElementById(id);

  // ---------- bootstrap ----------

  async function bootstrap() {
    const res = await fetch('/api/plays/' + encodeURIComponent(playId));
    if (res.status === 404) {
      alert('剧目不存在');
      location.href = '/';
      return;
    }
    const data = await res.json();
    play = data.play;
    names = data.names || {};
    renderHeader();
    $('play-name').textContent = play.name;
    document.title = play.name + ' · 排练时间线';

    client = new SyncClient(playId);

    client.on('state', render);
    client.on('status', onStatus);
    client.on('presence', onPresence);
    client.on('queue', renderQueueBadge);
    client.on('identity', renderHeader);
    client.on('remote-op', () => { /* state event covers render */ });
    client.on('server-error', (m) => toast('服务器拒绝了操作：' + (m.message || '')));

    client.start();
  }

  // ---------- op factories ----------

  function newSceneId() { return uid('s'); }
  function newCueId() { return uid('q'); }

  function snap(v) {
    v = Math.max(0, Math.round(v / SNAP) * SNAP);
    return Math.round(v * 10) / 10;
  }

  function addScene() {
    const id = newSceneId();
    const scenes = state ? state.scenes : [];
    const order = scenes.length ? scenes[scenes.length - 1].order + 1 : 1;
    const name = prompt('场次名称：', '第 ' + (scenes.length + 1) + ' 场');
    if (name == null) return;
    client.createOp('scene', 'add', id, { name: name.trim() || '未命名场次', order });
  }

  function moveScene(sceneId, dir) {
    const scenes = state.scenes;
    const i = scenes.findIndex((s) => s.id === sceneId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= scenes.length) return;
    // midpoint between the neighbours at the target position
    const lo = dir < 0
      ? (j - 1 >= 0 ? scenes[j - 1].order : scenes[j].order - 1)
      : scenes[i].order;
    const hi = dir < 0
      ? scenes[i].order
      : (j + 1 < scenes.length ? scenes[j + 1].order : scenes[j].order + 1);
    const order = Math.round(((lo + hi) / 2) * 1000) / 1000;
    client.createOp('scene', 'move', sceneId, { order });
  }

  function renameScene(scene) {
    const name = prompt('场次名称：', scene.name);
    if (name == null) return;
    client.createOp('scene', 'update', scene.id, { name: name.trim() || scene.name });
  }

  function removeScene(scene) {
    if (!confirm('删除场次「' + scene.name + '」？\n（场次内动作/音效会保留并出现在冲突/回收站，可恢复）')) return;
    client.createOp('scene', 'remove', scene.id, {});
  }

  function addCue(sceneId, start, kind) {
    const id = newCueId();
    const name = prompt((kind === 'sound' ? '音效' : '动作') + '名称：', kind === 'sound' ? '音效 ' : '动作 ');
    if (name == null) return;
    client.createOp('cue', 'add', id, {
      scene_id: sceneId,
      name: name.trim() || (kind === 'sound' ? '未命名音效' : '未命名动作'),
      kind: kind || 'action',
      start: snap(start),
      duration: 5,
    });
  }

  function removeCue(cue) {
    if (!confirm('删除「' + cue.name + '」？（可在冲突/回收站恢复）')) return;
    client.createOp('cue', 'remove', cue.id, {});
  }

  function restoreEntity(target, entity) {
    if (target === 'scene') {
      // reviving a scene restores order at end so it can't clash
      const order = state.scenes.length ? state.scenes[state.scenes.length - 1].order + 1 : entity.order || 1;
      client.createOp('scene', 'restore', entity.id, { name: entity.name, order });
    } else {
      // place cue back into a live scene if possible
      let sceneId = entity.scene_id;
      const scene = state.scenes.find((s) => s.id === sceneId);
      if (!scene) {
        if (state.scenes.length === 0) {
          toast('请先创建或恢复一个场次');
          return;
        }
        sceneId = state.scenes[0].id;
      }
      client.createOp('cue', 'restore', entity.id, {
        name: entity.name,
        kind: entity.kind,
        start: entity.start,
        duration: entity.duration,
        scene_id: sceneId,
      });
    }
  }

  // ---------- rendering ----------

  function render() {
    state = client.state();
    renderTimeline();
    renderConflictBadges();
    renderDrawer();
  }

  function computeEnd() {
    let end = 120;
    for (const scene of state.scenes) {
      for (const cue of state.cues_by_scene[scene.id] || []) {
        end = Math.max(end, cue.start + cue.duration + 10);
      }
    }
    // round up to 30s
    timelineEnd = Math.max(120, Math.ceil(end / 30) * 30);
  }

  function renderTimeline() {
    computeEnd();
    const totalWidth = timelineEnd * pxPerSec;

    const ruler = $('ruler');
    ruler.innerHTML = '';
    ruler.style.width = totalWidth + 200 + 'px';
    const labelPad = el('div', { style: { width: '200px', flexShrink: '0' } });
    ruler.appendChild(labelPad);
    const step = pxPerSec >= 30 ? 5 : pxPerSec >= 12 ? 10 : pxPerSec >= 5 ? 30 : 60;
    for (let t = 0; t <= timelineEnd; t += step) {
      ruler.appendChild(el('div', {
        class: 'tick',
        style: { width: (step * pxPerSec) + 'px' },
      }, fmtTime(t)));
    }

    const scenesBox = $('scenes');
    scenesBox.innerHTML = '';
    scenesBox.style.width = totalWidth + 200 + 'px';

    $('empty').style.display = state.scenes.length === 0 ? '' : 'none';

    state.scenes.forEach((scene, idx) => {
      const track = el('div', { class: 'scene-track', 'data-scene-id': scene.id });
      track.style.width = totalWidth + 'px';

      // grid lines
      for (let t = step; t <= timelineEnd; t += step) {
        track.appendChild(el('div', { class: 'grid-line', style: { left: t * pxPerSec + 'px' } }));
      }

      // double click adds a cue at that time; Shift+double = sound
      track.addEventListener('dblclick', (e) => {
        if (e.target !== track && !e.target.classList.contains('grid-line')) return;
        const rect = track.getBoundingClientRect();
        const secs = (e.clientX - rect.left) / pxPerSec;
        addCue(scene.id, secs, e.shiftKey ? 'sound' : 'action');
      });

      // visual cue when dragging cue across tracks
      track.addEventListener('dragover', (e) => {
        if (dragState) {
          e.preventDefault();
          track.classList.add('drop-target');
          dragState.overScene = scene.id;
        }
      });
      track.addEventListener('dragleave', () => track.classList.remove('drop-target'));
      track.addEventListener('drop', (e) => e.preventDefault());

      const cues = state.cues_by_scene[scene.id] || [];
      for (const cue of cues) {
        track.appendChild(renderCue(cue, scene));
      }

      const label = el('div', { class: 'scene-label' }, [
        el('span', { class: 'name', title: scene.name }, [
          (idx + 1) + '. ',
          scene.name,
          cues.length ? el('span', { style: { color: 'var(--muted)', fontWeight: '400' } }, ' (' + cues.length + ')') : null,
        ]),
        el('button', { class: 'icon ghost', title: '上移', onclick: () => moveScene(scene.id, -1) }, '↑'),
        el('button', { class: 'icon ghost', title: '下移', onclick: () => moveScene(scene.id, 1) }, '↓'),
        el('button', { class: 'icon ghost', title: '重命名', onclick: () => renameScene(scene) }, '✎'),
        el('button', { class: 'icon ghost danger', title: '删除场次', onclick: () => removeScene(scene) }, '✕'),
      ]);

      const row = el('div', { class: 'scene-row' }, [label, track]);
      scenesBox.appendChild(row);
    });
  }

  function renderCue(cue, scene) {
    const conflict = state.conflicts['cue:' + cue.id];
    const authorColor = colorFor(cue.client_id);
    const node = el('div', {
      class: 'cue ' + cue.kind + (conflict ? ' conflict' : ''),
      title: cueTitle(cue, conflict),
      style: {
        left: cue.start * pxPerSec + 'px',
        width: Math.max(24, cue.duration * pxPerSec) + 'px',
        borderLeft: '3px solid ' + authorColor,
      },
    }, [
      el('span', { class: 'cue-name' }, cueIcon(cue.kind) + ' ' + cue.name),
      el('span', { class: 'cue-time' }, fmtTime(cue.start, true)),
      el('button', { class: 'del', title: '删除', onclick: (e) => { e.stopPropagation(); removeCue(cue); } }, '✕'),
      el('div', { class: 'cue-resize' }),
    ]);
    attachDrag(node, cue, scene);
    return node;
  }

  function cueIcon(kind) {
    return kind === 'sound' ? '🔊' : '🎬';
  }

  function cueTitle(cue, conflict) {
    const lines = [
      cue.name,
      '开始 ' + fmtTime(cue.start, true) + ' · 时长 ' + cue.duration + 's',
      '创建者 ' + (names[cue.client_id] || cue.client_id.slice(0, 6)),
    ];
    if (conflict) lines.push('⚠ 存在并发冲突，打开冲突面板查看');
    return lines.join('\n');
  }

  // ---------- cue drag / resize ----------

  let dragState = null;

  function attachDrag(node, cue, scene) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('del')) return;
      dragState = {
        cue,
        scene,
        node,
        pointerId: e.pointerId,
        resize: e.target.classList.contains('cue-resize'),
        startX: e.clientX,
        origStart: cue.start,
        origDuration: cue.duration,
        moved: false,
        overScene: scene.id,
        nextStart: cue.start,
        nextDuration: cue.duration,
      };
    });
  }

  // One global gesture driver — dragState carries the active cue node.
  window.addEventListener('pointermove', (e) => {
    const d = dragState;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      endDrag(e);
      return;
    }
    if (!d.moved && Math.abs(e.clientX - d.startX) <= 3) return;
    if (!d.moved) {
      d.moved = true;
      d.node.classList.add('dragging');
      try { d.node.setPointerCapture(e.pointerId); } catch (err) {}
    }
    const dxSec = (e.clientX - d.startX) / pxPerSec;
    if (!d.resize) {
      d.nextStart = snap(d.origStart + dxSec);
      d.node.style.left = d.nextStart * pxPerSec + 'px';
      // detect target scene row for cross-scene moves
      d.node.style.display = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      d.node.style.display = '';
      const track = under && under.closest ? under.closest('.scene-track') : null;
      document.querySelectorAll('.drop-target').forEach((n) => {
        if (n !== track) n.classList.remove('drop-target');
      });
      if (track) {
        track.classList.add('drop-target');
        d.overScene = track.dataset.sceneId;
      }
    } else {
      d.nextDuration = Math.max(MIN_DUR, snap(d.origDuration + dxSec));
      d.node.style.width = Math.max(24, d.nextDuration * pxPerSec) + 'px';
    }
  });

  function endDrag(e) {
    const d = dragState;
    if (!d) return;
    if (e && e.pointerId !== d.pointerId) return;
    dragState = null;
    d.node.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    try { d.node.releasePointerCapture(d.pointerId); } catch (err) {}
    if (!d.moved) return;

    if (d.resize) {
      if (d.nextDuration !== d.origDuration) {
        client.createOp('cue', 'update', d.cue.id, { duration: d.nextDuration });
      }
      return;
    }
    const payload = {};
    if (d.nextStart !== d.origStart) payload.start = d.nextStart;
    if (d.overScene !== d.scene.id) payload.scene_id = d.overScene;
    if (Object.keys(payload).length) client.createOp('cue', 'move', d.cue.id, payload);
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------- header / presence ----------

  function onStatus({ connected }) {
    $('status-dot').className = 'status-dot ' + (connected ? 'online' : 'offline');
    $('status-text').textContent = connected ? '已同步' : '离线（编辑已排队）';
  }

  function renderQueueBadge() {
    if (!client) return;
    const n = client.queue.length;
    $('queue-pill').style.display = n ? '' : 'none';
    $('queue-n').textContent = n;
  }

  function onPresence({ members: m }) {
    if (m) {
      members = m;
      // keep the name map fresh for renamed peers (conflict panel uses it)
      for (const member of m) names[member.client_id] = member.name;
    }
    renderHeader();
  }

  function renderHeader() {
    const box = $('members');
    if (!box) return;
    box.innerHTML = '';
    const onlineIds = new Set((members || []).map((m) => m.client_id));
    const shown = (members || []);
    for (const m of shown) {
      const initial = (m.name || '?').slice(0, 1);
      const av = el('span', {
        class: 'avatar' + (m.client_id === (client && client.identity.client_id) ? ' me' : ''),
        style: { background: m.color || colorFor(m.client_id) },
      }, [
        document.createTextNode(initial),
        el('span', { class: 'tip' }, m.name + (m.client_id === (client && client.identity.client_id) ? '（我）' : '')),
      ]);
      box.appendChild(av);
    }
    if (shown.length === 0) {
      box.appendChild(el('span', { class: 'pill' }, '暂无在线成员'));
    }
  }

  // ---------- conflicts / trash drawer ----------

  function renderConflictBadges() {
    const n = Object.keys(state.conflicts).length;
    $('conflict-pill').style.display = n ? '' : 'none';
    $('conflict-n').textContent = n;
  }

  function renderDrawer() {
    const conflictEntries = Object.values(state.conflicts);
    const tombs = []
      .concat(state.deleted_scenes.map((s) => ({ target: 'scene', entity: s })))
      .concat(state.deleted_cues.map((c) => ({ target: 'cue', entity: c })));

    const hasAnything = conflictEntries.length > 0 || tombs.length > 0;
    $('drawer').style.display = hasAnything ? '' : 'none';
    if (!hasAnything) return;

    $('drawer-title').textContent = '冲突与回收站';
    $('drawer-count').textContent =
      conflictEntries.length + ' 个并发冲突 · ' + tombs.length + ' 个已删除';

    const body = $('drawer-body');
    body.innerHTML = '';

    for (const c of conflictEntries) {
      body.appendChild(renderConflictItem(c));
    }

    if (tombs.length) {
      body.appendChild(el('div', { style: { margin: '10px 0 6px', color: 'var(--muted)', fontSize: '12px' } }, '回收站（确定性规则下删除优先于并发移动，可显式恢复）'));
      for (const { target, entity } of tombs) {
        body.appendChild(el('span', { class: 'tomb-item' }, [
          el('span', { class: 'tag' }, target === 'scene' ? '场次' : (entity.kind === 'sound' ? '音效' : '动作')),
          el('span', { class: 'strike' }, entity.name),
          el('button', {
            class: 'icon',
            onclick: () => restoreEntity(target, entity),
          }, '恢复'),
        ]));
      }
    }
  }

  function entityName(target, id) {
    if (target === 'scene') {
      const s = findScene(id);
      return s ? s.name : '场次 ' + id.slice(0, 6);
    }
    const c = findCue(id);
    return c ? c.name : '动作/音效 ' + id.slice(0, 6);
  }

  function findScene(id) {
    return (
      state.scenes.find((s) => s.id === id) ||
      state.deleted_scenes.find((s) => s.id === id)
    );
  }

  function findCue(id) {
    for (const list of Object.values(state.cues_by_scene)) {
      const c = list.find((x) => x.id === id);
      if (c) return c;
    }
    return state.deleted_cues.find((x) => x.id === id) ||
           state.orphans.find((x) => x.id === id);
  }

  const KIND_LABEL = {
    add: '新建', move: '移动', update: '修改', remove: '删除', restore: '恢复',
  };

  function renderConflictItem(c) {
    const name = entityName(c.target, c.entity_id);
    const winnerName = names[c.winner_client_id] || c.winner_client_id.slice(0, 6);

    const oplines = c.ops.map((o) => {
      const who = names[o.client_id] || o.client_id.slice(0, 6);
      const color = colorFor(o.client_id);
      let detail = '';
      if (o.kind === 'move') {
        if (o.payload.start != null) detail = ' → ' + fmtTime(o.payload.start, true);
        if (o.payload.scene_id) detail += ' / 换场';
      } else if (o.kind === 'update') {
        if (o.payload.duration != null) detail = ' 时长→' + o.payload.duration + 's';
        if (o.payload.name) detail = ' 改名→' + o.payload.name;
      }
      return el('div', { class: 'opline' }, [
        el('span', { style: { color, fontWeight: 600 } }, '● ' + who),
        ' 执行了「' + KIND_LABEL[o.kind] + '」' + detail +
        '（Lamport ' + o.lamport + '）' +
        (o.op_id === c.winner_op_id ? ' 🏆 当前生效' : ''),
      ]);
    });

    const item = el('div', { class: 'conflict-item' }, [
      el('div', { class: 'row1' }, [
        el('span', { class: 'tag' }, c.target === 'scene' ? '场次' : '动作/音效'),
        el('span', { class: 'entity' }, name),
        el('span', { style: { color: 'var(--muted)', fontSize: '12px' } },
          '并发类型：' + c.kinds.map((k) => KIND_LABEL[k] || k).join(' × ')),
      ]),
      ...oplines,
      el('div', { class: 'opline' }, [
        '确定性裁决：',
        c.kinds.includes('remove')
          ? '删除优先（' + escapeHtml(winnerName) + ' 的删除生效；移动不会静默复活元素，可点恢复）'
          : '按总顺序 (Lamport, 客户端id, 操作id) 取最后写入者：' + escapeHtml(winnerName),
      ]),
      el('div', { class: 'actions' }, [
        el('button', {
          onclick: () => {
            const entity = c.target === 'scene' ? findScene(c.entity_id) : findCue(c.entity_id);
            if (entity) restoreEntity(c.target, entity);
            else toast('元素已不存在，无法直接恢复');
          },
        }, c.kinds.includes('remove') ? '恢复被删除的版本' : '以当前生效版本为准（标记已解决）'),
      ]),
    ]);
    return item;
  }

  // ---------- import / export ----------

  async function doExport() {
    const res = await fetch('/api/plays/' + encodeURIComponent(playId) + '/export');
    const data = await res.json();
    const safe = (play.name || 'play').replace(/[\\/:*?"<>|\s]+/g, '_');
    downloadJson(safe + '.theater.json', data);
    toast('已导出 ' + (data.ops ? data.ops.length : 0) + ' 条操作日志');
  }

  function doImportPick() {
    $('import-file').click();
  }

  async function doImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await fetch('/api/plays/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('导入失败：' + (err.detail || res.status));
        return;
      }
      const out = await res.json();
      if (confirm('导入成功：' + out.scene_count + ' 场次 / ' + out.cue_count +
        ' 动作音效。\n导入会创建为新剧目，是否立即打开？')) {
        location.href = '/play.html?id=' + encodeURIComponent(out.play_id);
      } else {
        // Stay — pull new ops into this view is not meaningful (different play).
        location.reload();
      }
    } catch (err) {
      alert('导入失败：JSON 解析错误 — ' + err.message);
    } finally {
      e.target.value = '';
    }
  }

  // ---------- rename / identity modals ----------

  function renamePlay() {
    const name = prompt('剧目名称：', play.name);
    if (name == null || !name.trim()) return;
    fetch('/api/plays/' + encodeURIComponent(playId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    }).then((r) => r.json()).then((p) => {
      play = p;
      $('play-name').textContent = p.name;
      document.title = p.name + ' · 排练时间线';
    });
  }

  function editIdentity() {
    const name = prompt('我的昵称：', client.identity.name);
    if (name == null || !name.trim()) return;
    client.setName(name.trim());
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(text) {
    let n = document.querySelector('.toast');
    if (!n) {
      n = el('div', { class: 'toast' });
      document.body.appendChild(n);
    }
    n.textContent = text;
    n.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.style.opacity = '0'; }, 2400);
  }

  // ---------- zoom ----------

  const ZOOMS = [2, 4, 8, 12, 20, 32, 48];
  function setZoom(pps) {
    pxPerSec = Math.min(60, Math.max(2, pps));
    $('zoom-val').textContent = pxPerSec + 'px/s';
    if (state) renderTimeline();
  }

  // ---------- wire controls ----------

  document.addEventListener('DOMContentLoaded', () => {
    $('btn-add-scene').addEventListener('click', addScene);
    $('btn-export').addEventListener('click', doExport);
    $('btn-import-file').addEventListener('click', doImportPick);
    $('import-file').addEventListener('change', doImportFile);
    $('btn-rename').addEventListener('click', renamePlay);
    $('btn-name').addEventListener('click', editIdentity);
    $('conflict-pill').addEventListener('click', () => {
      const d = $('drawer');
      if (d.style.display === 'none') return;
      d.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    $('zoom-in').addEventListener('click', () => {
      const next = ZOOMS.find((z) => z > pxPerSec) || 60;
      setZoom(next);
    });
    $('zoom-out').addEventListener('click', () => {
      const below = ZOOMS.filter((z) => z < pxPerSec);
      setZoom(below.length ? below[below.length - 1] : 2);
    });
    $('scroll').addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87));
      }
    }, { passive: false });

    bootstrap();
  });
})();
