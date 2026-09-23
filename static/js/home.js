/* Home page: list / create / import plays. */
(function () {
  'use strict';
  const { el, downloadJson } = U;

  async function loadPlays() {
    const res = await fetch('/api/plays');
    const plays = await res.json();
    const box = document.getElementById('plays');
    box.innerHTML = '';
    if (plays.length === 0) {
      box.appendChild(el('div', { class: 'empty-hint' }, '暂无剧目，先新建一个或导入 JSON。'));
      return;
    }
    for (const p of plays) {
      box.appendChild(
        el('div', { class: 'play-card' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'title' }, [
              el('a', { href: '/play.html?id=' + encodeURIComponent(p.id) }, p.name),
            ]),
            el('div', { class: 'meta' }, [
              '场次 ' + p.scene_count,
              '动作/音效 ' + p.cue_count,
              '🟢 在线 ' + p.online,
              p.conflict_count > 0
                ? el('span', { style: { color: 'var(--danger)' } }, '⚠ 待处理冲突 ' + p.conflict_count)
                : '无冲突',
            ]),
          ]),
          el('button', {
            class: 'ghost',
            onclick: async () => {
              const res = await fetch('/api/plays/' + encodeURIComponent(p.id) + '/export');
              const data = await res.json();
              const safe = (p.name || 'play').replace(/[\\/:*?"<>|\s]+/g, '_');
              downloadJson(safe + '.theater.json', data);
            },
          }, '导出'),
          el('button', {
            class: 'primary',
            onclick: () => { location.href = '/play.html?id=' + encodeURIComponent(p.id); },
          }, '进入排练'),
        ])
      );
    }
  }

  document.getElementById('btn-create').addEventListener('click', async () => {
    const input = document.getElementById('new-name');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const res = await fetch('/api/plays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const play = await res.json();
    location.href = '/play.html?id=' + encodeURIComponent(play.id);
  });

  document.getElementById('new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-create').click();
  });

  document.getElementById('btn-import-file').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
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
      location.href = '/play.html?id=' + encodeURIComponent(out.play_id);
    } catch (err) {
      alert('导入失败：JSON 解析错误 — ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  loadPlays();
  setInterval(loadPlays, 5000);
})();
