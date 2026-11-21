// ==UserScript==
// @name         Keobase Bridge - Cầu nối Token Base.vn & Desktop App
// @namespace    https://workflow.base.vn/
// @version      0.5.8
// @description  Tự động trích xuất và đồng bộ mã phiên (basessid) từ Chrome vào Clipboard (100% không mở localhost/port mạng, an toàn tuyệt đối)
// @author       phungvip
// @match        https://workflow.base.vn/*
// @match        https://*.base.vn/*
// @match        https://base.vn/*
// @updateURL    https://raw.githubusercontent.com/phungle2508/keobase-userscript-updates/main/keobase-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/phungle2508/keobase-userscript-updates/main/keobase-bridge.user.js
// @grant        unsafeWindow
// @grant        GM_cookie
// @grant        GM.cookie
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  let lastCopiedToken = '';
  let lastCopiedTime = 0;
  let badgeEl = null;

  function getSavedBasessid() {
    try {
      if (typeof GM_getValue !== 'undefined') {
        const val = GM_getValue('saved_basessid', '');
        if (val && typeof val === 'string' && val.trim().length > 5) return val.trim();
      }
    } catch (e) {}
    try {
      const val = localStorage.getItem('kb_saved_basessid') || '';
      if (val && val.trim().length > 5) return val.trim();
    } catch (e) {}
    return '';
  }

  function saveBasessid(val) {
    if (!val || typeof val !== 'string' || val.trim().length < 5) return;
    const clean = val.trim();
    try { if (typeof GM_setValue !== 'undefined') GM_setValue('saved_basessid', clean); } catch (e) {}
    try { localStorage.setItem('kb_saved_basessid', clean); } catch (e) {}
  }

  function queryGmCookie(details) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (list) => { if (!done) { done = true; resolve(Array.isArray(list) ? list : []); } };
      const timer = setTimeout(() => finish([]), 1200);
      try {
        if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
          GM_cookie.list(details, (cookies, error) => {
            clearTimeout(timer);
            finish(!error && Array.isArray(cookies) ? cookies : []);
          });
          return;
        }
        if (typeof GM !== 'undefined' && GM.cookie && typeof GM.cookie.list === 'function') {
          GM.cookie.list(details).then(c => { clearTimeout(timer); finish(c); }).catch(() => { clearTimeout(timer); finish([]); });
          return;
        }
      } catch (e) {}
      clearTimeout(timer);
      finish([]);
    });
  }

  async function getCookies() {
    const cookieMap = {};
    if (document.cookie) {
      document.cookie.split(';').forEach(p => {
        const idx = p.indexOf('=');
        if (idx > 0) cookieMap[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
      });
    }
    const queries = [
      { name: 'basessid', domain: '.base.vn' },
      { name: 'basessid' },
      { url: 'https://workflow.base.vn/' },
      { domain: '.base.vn' }
    ];
    const lists = await Promise.all(queries.map(q => queryGmCookie(q)));
    lists.flat().forEach(c => {
      if (c && c.name && c.value) {
        cookieMap[c.name] = c.value;
        if (c.name === 'basessid') saveBasessid(c.value);
      }
    });
    if (!cookieMap.basessid) {
      const saved = getSavedBasessid();
      if (saved) cookieMap.basessid = saved;
    }
    return Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function showToast(message, color = '#22c55e') {
    let toast = document.getElementById('kb-toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'kb-toast-notification';
      Object.assign(toast.style, {
        position: 'fixed', bottom: '70px', right: '22px', padding: '10px 18px',
        backgroundColor: '#0f172a', color: '#f8fafc', borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)', fontSize: '13px', fontWeight: 'bold',
        zIndex: '2147483647', transition: 'all 0.25s ease', pointerEvents: 'none'
      });
      (document.body || document.documentElement).appendChild(toast);
    }
    toast.textContent = message;
    toast.style.border = `1.5px solid ${color}`;
    toast.style.opacity = '1';
    setTimeout(() => { if (toast) toast.style.opacity = '0'; }, 2800);
  }

  async function copyBasessidToClipboard(manual = true) {
    const cookies = await getCookies();
    let basessidVal = '';
    const m = cookies ? cookies.match(/(?:^|;\s*)basessid=([^;]+)/) : null;
    if (m && m[1]) basessidVal = m[1].trim();

    if (!basessidVal && manual) {
      const promptVal = window.prompt(
        '⚠️ Trình duyệt đang bật HttpOnly cho cookie.\nVui lòng dán mã basessid vào đây (F12 > Application > Cookies > basessid) - Chỉ cần nhập 1 lần:',
        ''
      );
      if (promptVal && promptVal.trim().length > 5) basessidVal = promptVal.trim();
    }

    if (basessidVal) {
      saveBasessid(basessidVal);
      const tokenPayload = `basessid=${basessidVal}`;
      const now = Date.now();
      if (tokenPayload !== lastCopiedToken || (now - lastCopiedTime > 30000) || manual) {
        lastCopiedToken = tokenPayload;
        lastCopiedTime = now;
        try { if (typeof GM_setClipboard !== 'undefined') GM_setClipboard(tokenPayload, 'text'); } catch (e) {}
        try { if (navigator.clipboard) await navigator.clipboard.writeText(tokenPayload); } catch (e) {}
        updateBadgeUI(true, '🟢 Keobase: Đã sao chép basessid vào Clipboard (Chỉ cần mở App là tự nhận)');
        if (manual) {
          showToast('⚡ Đã copy basessid vào Clipboard! Hãy mở App Keobase.', '#22c55e');
        }
      }
      return true;
    }
    updateBadgeUI(false, '🔴 Keobase: Chưa tìm thấy basessid');
    if (manual) {
      showToast('⚠️ Chưa tìm thấy basessid! Hãy đăng nhập Base.vn.', '#ef4444');
    }
    return false;
  }

  function updateBadgeUI(connected, titleText = '') {
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.id = 'keobase-bridge-indicator';
      badgeEl.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:16px;user-select:none;color:#fff;font-weight:bold;">⚡</span>';
      Object.assign(badgeEl.style, {
        position: 'fixed', bottom: '22px', right: '22px', width: '32px', height: '32px',
        borderRadius: '50%', backgroundColor: '#ef4444', boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
        border: '2px solid #fff', cursor: 'pointer', zIndex: '2147483647', transition: 'all 0.25s ease'
      });
      badgeEl.onclick = (e) => { e.stopPropagation(); copyBasessidToClipboard(true); };
      (document.body || document.documentElement).appendChild(badgeEl);
    }
    badgeEl.style.backgroundColor = connected ? '#22c55e' : '#ef4444';
    badgeEl.title = titleText || (connected ? 'Keobase: Đã lưu token (Click để copy basessid)' : 'Keobase: Chưa tìm thấy token (Click để nhập)');
  }

  function init() {
    updateBadgeUI(false);
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('📋 Copy basessid vào Clipboard (Đồng bộ App)', () => copyBasessidToClipboard(true));
    }
    // Tự động copy basessid nhẹ nhàng vào Clipboard khi tải trang hoặc khi người dùng focus tab Base
    setTimeout(() => copyBasessidToClipboard(false), 1200);
    window.addEventListener('focus', () => copyBasessidToClipboard(false));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
























