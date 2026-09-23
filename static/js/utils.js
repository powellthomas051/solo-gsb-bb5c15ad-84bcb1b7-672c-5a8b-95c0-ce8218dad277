/* Small shared helpers. */
(function (global) {
  'use strict';

  const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#9a6324', '#800000', '#000075',
    '#469990', '#bfef45', '#fabed4', '#ffd8b1', '#808000',
    '#a9a9ff', '#ff4d4f', '#239c65', '#d9822b', '#7e57c2',
  ];

  function uid(prefix) {
    return (
      (prefix || 'id') +
      '-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 9)
    );
  }

  function colorFor(seed) {
    let h = 0;
    for (let i = 0; i < String(seed).length; i++) {
      h = (h * 31 + String(seed).charCodeAt(i)) >>> 0;
    }
    return PALETTE[h % PALETTE.length];
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  // seconds -> "M:SS" or "M:SS.s"
  function fmtTime(sec, withTenths) {
    sec = Math.max(0, Number(sec) || 0);
    const m = Math.floor(sec / 60);
    let s = sec - m * 60;
    if (withTenths) {
      s = s.toFixed(1).padStart(4, '0');
    } else {
      s = String(Math.round(s)).padStart(2, '0');
    }
    return m + ':' + s;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = el('a', {
      href: URL.createObjectURL(blob),
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 100);
  }

  global.U = { uid, colorFor, escapeHtml, fmtTime, el, downloadJson, PALETTE };
})(window);
