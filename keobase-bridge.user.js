// ==UserScript==
// @name         Keobase Bridge - Cầu nối tự động Base Workflow & Desktop App
// @namespace    https://workflow.base.vn/
// @version      3.2.0
// @description  Cầu nối hai chiều 100% tự động giữa Base.vn trong Chrome và Keobase Desktop App (Chỉ chấp nhận URL https://workflow.base.vn/*/jobs)
// @author       phungvip
// @match        https://workflow.base.vn/*/jobs*
// @updateURL    https://raw.githubusercontent.com/phungle2508/keobase-userscript-updates/main/keobase-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/phungle2508/keobase-userscript-updates/main/keobase-bridge.user.js
// @connect      127.0.0.1
// @connect      localhost
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // CHỈ CHẤP NHẬN URL dạng https://workflow.base.vn/<workflow_code>/jobs
  function isJobsPage() {
    const p = location.pathname || '';
    return /^\/[^\/]+\/jobs(?:\/|$)/i.test(p);
  }

  const BRIDGE_HOST = 'http://127.0.0.1:8765';
  let isExecuting = false;
  let lastSyncedJobCount = -1;
  let lastSyncedWfId = null;

  // Lấy ngữ cảnh window thực tế của trang Base (kể cả khi chạy trong sandbox của Tampermonkey)
  function getPageContext() {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow.Client) {
      return unsafeWindow;
    }
    if (typeof window !== 'undefined' && window.Client) {
      return window;
    }
    if (typeof unsafeWindow !== 'undefined') {
      return unsafeWindow;
    }
    return window;
  }

  function getClient() {
    const ctx = getPageContext();
    return ctx.Client || null;
  }

  function getPageData() {
    const client = getClient();
    return client ? client.pageData : null;
  }

  const durationPoints = {
    55: '0',
    115: '1',
    135: '1.5',
    155: '2'
  };

  const formatDate = date => {
    if (!date || Number.isNaN(date.getTime())) return '';
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  };

  const normalizeJobName = value =>
    String(value || '')
      .normalize('NFKC')
      .replace(/^\s*T-\s*/i, '')
      .replace(/\s+/g, '')
      .toLocaleLowerCase();

  const isGood = res => Boolean(
    (typeof res?.good === 'function' ? res.good() : false) ||
    res?.code === 1 ||
    res?.code === '1' ||
    res?.status === 1 ||
    res?.status === '1' ||
    res?.success === true
  );

  const getErrorMessage = res =>
    res?.message || res?.msg || res?.error || res?.error_message || 'Không thể thực hiện';

  // --- HTTP HELPER ĐẾN DESKTOP APP (GM_xmlhttpRequest KHÔNG BỊ CHẶN CORS / PNA) ---
  function bridgeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = `${BRIDGE_HOST}${path}`;
      const payload = body ? JSON.stringify(body) : null;

      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: method,
          url: url,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'application/json'
          },
          data: payload,
          timeout: 25000,
          onload: function (res) {
            try {
              const data = JSON.parse(res.responseText);
              resolve(data);
            } catch (e) {
              resolve({ raw: res.responseText, status: res.status });
            }
          },
          onerror: function (err) {
            reject(err);
          },
          ontimeout: function () {
            reject(new Error('Timeout kết nối tới Keobase Desktop Bridge'));
          }
        });
      } else {
        fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: payload
        })
          .then(res => res.json())
          .then(resolve)
          .catch(reject);
      }
    });
  }

  // --- BÁO TIẾN TRÌNH & KẾT QUẢ VỀ DESKTOP APP ---
  async function reportProgress(taskId, message, progress, level = 'INFO') {
    try {
      await bridgeRequest('POST', '/api/task-progress', { taskId, message, progress, level });
    } catch (e) {
      console.warn('[Keobase Bridge] Report progress error:', e);
    }
  }

  async function reportResult(taskId, result) {
    try {
      await bridgeRequest('POST', '/api/task-result', { taskId, ...result });
    } catch (e) {
      console.error('[Keobase Bridge] Report result error:', e);
    }
  }

  // --- BASE API POST (CHROME TỰ ĐỘNG ĐÍNH KÈM COOKIES & BASESSID) ---
  const post = (url, data, timeoutMs = 25000) => new Promise(resolve => {
    const ctx = getPageContext();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.error(`[Keobase Bridge] Timeout (${timeoutMs}ms) cho API: ${url}`, data);
        resolve({ good: () => false, code: 0, message: 'Hết thời gian chờ phản hồi (Timeout 25s)' });
      }
    }, timeoutMs);

    const handleSuccess = res => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(res);
      }
    };

    const handleError = err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const errMsg = err?.responseJSON?.message || err?.statusText || err?.message || 'Lỗi kết nối máy chủ';
        console.error(`[Keobase Bridge] API error: ${url}`, errMsg, err);
        resolve({ good: () => false, code: 0, message: errMsg });
      }
    };

    try {
      if (!ctx.AP || typeof ctx.AP.post !== 'function') {
        console.error('[Keobase Bridge] ctx.AP.post không tồn tại');
        resolve({ good: () => false, code: 0, message: 'Base AP.post không tồn tại trên trang này' });
        return;
      }
      const res = ctx.AP.post(url, data, handleSuccess, handleError);
      if (res && typeof res.fail === 'function') {
        res.fail(handleError);
      } else if (res && typeof res.catch === 'function') {
        res.catch(handleError);
      }
    } catch (err) {
      handleError(err);
    }
  });

  // --- DYNAMIC FIELD DISCOVERY ---
  function getAllWorkflowFields() {
    const list = [];
    const seen = new Set();

    function add(item) {
      if (!item || typeof item !== 'object') return;
      const id = item.id || item.field_id || item.key || item.code;
      const name = item.name || item.title || item.label || item.placeholder || '';
      if (!id && !name) return;
      const uid = `${id || ''}_${name}`;
      if (seen.has(uid)) return;
      seen.add(uid);
      list.push(item);
    }

    function addFrom(coll) {
      if (!coll) return;
      if (Array.isArray(coll)) {
        coll.forEach(add);
      } else if (typeof coll === 'object') {
        Object.values(coll).forEach(add);
      }
    }

    const pd = getPageData();
    if (pd) {
      addFrom(pd.workflow?.form);
      addFrom(pd.workflow?.fields);
      addFrom(pd.workflow?.custom_fields);
      addFrom(pd.form);
      addFrom(pd.fields);
      addFrom(pd.custom_fields);

      const stages = [
        ...(Array.isArray(pd.workflow?.stages) ? pd.workflow.stages : Object.values(pd.workflow?.stages || {})),
        ...(Array.isArray(pd.stages) ? pd.stages : Object.values(pd.stages || {}))
      ];
      for (const s of stages) {
        if (!s || typeof s !== 'object') continue;
        addFrom(s.form);
        addFrom(s.fields);
        addFrom(s.custom_fields);
      }

      if (Array.isArray(pd.workflows)) {
        for (const wf of pd.workflows) {
          addFrom(wf.form);
          addFrom(wf.fields);
          addFrom(wf.custom_fields);
        }
      }
    }

    const ctx = getPageContext();
    const sm = ctx.StageManager;
    if (sm) {
      addFrom(sm.workflow?.form);
      addFrom(sm.workflow?.fields);
      addFrom(sm.workflow?.custom_fields);
      const smStages = Array.isArray(sm.stages) ? sm.stages : Object.values(sm.stages || {});
      for (const s of smStages) {
        if (!s || typeof s !== 'object') continue;
        addFrom(s.form);
        addFrom(s.fields);
        addFrom(s.custom_fields);
      }
    }

    return list;
  }

  function findFieldInList(terms, allFields) {
    const normalize = value => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, '')
      .toLowerCase();

    return allFields.find(field => {
      const candidates = [
        field?.name,
        field?.placeholder,
        field?.title,
        field?.label,
        field?.key,
        field?.code
      ];
      return terms.some(term => {
        const normTerm = normalize(term);
        return candidates.some(cand => cand && normalize(cand).includes(normTerm));
      });
    });
  }

  function resolveChoice(field, value) {
    const target = String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const seen = new WeakSet();
    function findMatch(candidate) {
      if (typeof candidate === 'string') return candidate.normalize('NFKC').replace(/\s+/g, '').toLowerCase() === target ? candidate : null;
      if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return null;
      seen.add(candidate);
      for (const nested of Array.isArray(candidate) ? candidate : Object.values(candidate)) {
        const match = findMatch(nested);
        if (match != null) return match;
      }
      return null;
    }
    return findMatch(field) || value;
  }

  function resolveChoices(field, value) {
    return String(value || '').split('|').map(item => resolveChoice(field, item.trim())).filter(Boolean).join(', ');
  }

  // --- BƯỚC 1: CHUYỂN SANG THIẾT KẾ ---
  async function executeStep1(taskId, task, currentMovedJobs = []) {
    const ctx = getPageContext();
    const config = task.config || {};
    const sourceStageId = Number(config.source_stage_id || 107970);
    const targetStageId = Number(config.design_stage_id || 107971);
    const assignee = config.assignee || 'khanhldp';
    const inputDuration = config.input_duration ?? config.inputDuration ?? 60;
    const deadlineTime = config.deadline_time || config.deadlineTime || '23:29';

    const deadline = new Date(`${task.deadline}T${deadlineTime}`);
    const kibouDate = String(task.kibou || '').split('-').reverse().join('/');

    const rows = Array.isArray(task.rows) ? task.rows : [];
    const jobNames = rows.map(r => r.name).filter(Boolean);
    const kibouList = rows.filter(r => r.kibou).map(r => ({ name: r.normalized_name, date: r.kibou }));

    const pd = getPageData();
    const allJobs = pd?.jobs || [];
    const jobs = allJobs.filter(job =>
      Number(job.stage_id) === sourceStageId &&
      jobNames.some(name => normalizeJobName(job.name).includes(normalizeJobName(name)))
    );

    if (!jobs.length) {
      await reportProgress(taskId, 'Không tìm thấy công việc phù hợp trong Team 5 nhận việc.', 0.4, 'WARN');
      return { movedJobs: [], failures: ['Không tìm thấy công việc phù hợp trong Team 5 nhận việc'] };
    }

    let start = new Date();
    start.setHours(9, 30, 0, 0);

    const movedJobs = [];
    const failures = [];

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const prog = 0.1 + (i / jobs.length) * 0.4;
      await reportProgress(taskId, `[Bước 1] Đang chuyển (${i + 1}/${jobs.length}): ${job.name}...`, prog);

      const jobStart = new Date(start.getTime() + i * 3600000);
      const jobEnd = new Date(jobStart.getTime() + 3600000);

      const code = await post('api/job/next', {
        id: job.id,
        token: job.token,
        assignee: assignee,
        custom_Nyuryokukikanyotei: inputDuration,
        edit_deadline: 1,
        'deadline-date': formatDate(deadline),
        'deadline-time': `${String(deadline.getHours()).padStart(2, '0')}:${String(deadline.getMinutes()).padStart(2, '0')}`,
        'custom_kaishiyoteijikoku-date': formatDate(jobStart),
        'custom_kaishiyoteijikoku-time': `${String(jobStart.getHours()).padStart(2, '0')}:${String(jobStart.getMinutes()).padStart(2, '0')}`,
        'custom_shuuryoyoteijikoku-date': formatDate(jobEnd),
        'custom_shuuryoyoteijikoku-time': `${String(jobEnd.getHours()).padStart(2, '0')}:${String(jobEnd.getMinutes()).padStart(2, '0')}`
      });

      if (!isGood(code)) {
        failures.push(`${job.name}: ${getErrorMessage(code)}`);
        continue;
      }

      const targetJob = code.job || { ...job, stage_id: targetStageId };
      job.stage_id = targetStageId;
      movedJobs.push(targetJob);

      try {
        if (code.job && typeof ctx.Job?.update === 'function') ctx.Job.update(code.job);
      } catch (err) {}

      // Cập nhật Kibou (hạn giao / 希望納期) nếu có
      const rowKibou = kibouList.find(k => normalizeJobName(job.name).includes(k.name))?.date || kibouDate;
      if (rowKibou) {
        const formattedKibou = rowKibou.includes('-') ? rowKibou.split('-').reverse().join('/') : rowKibou;
        const allFields = getAllWorkflowFields();
        const kibouField = findFieldInList(['kibou_nouki', 'kibou', 'nouki', '希望納期', '納期', 'han_giao', 'hạn giao'], allFields);
        const kibouKey = kibouField?.id || kibouField?.key || kibouField?.code || 'han_giao';
        const kibouCleanKey = String(kibouKey).replace(/^custom_/, '');

        const fixPayload = {
          id: job.id,
          token: job.token,
          key: 'custom_field',
          field: kibouCleanKey
        };
        fixPayload[`custom_${kibouCleanKey}`] = formattedKibou;

        const updated = await post('api/job/fix', fixPayload);
        if (!isGood(updated)) {
          failures.push(`${job.name} (Kibou): ${getErrorMessage(updated)}`);
        }
      }
    }

    await reportProgress(taskId, `[Bước 1] Hoàn tất chuyển ${movedJobs.length}/${jobs.length} việc sang Thiết kế.`, 0.5, 'SUCCESS');
    return { movedJobs, failures };
  }

  // --- BƯỚC 2: CHUYỂN SANG HOÀN THÀNH ---
  async function executeStep2(taskId, task, movedJobsInput = null) {
    const ctx = getPageContext();
    const config = task.config || {};
    const sourceStageId = Number(config.design_stage_id || 107971);
    const targetStageId = Number(config.done_stage_id || 107968);

    const fieldDefinitions = {
      area: ['Tsubosuu', '坪数'],
      designDuration: ['Thoi gian thiet ke', 'Thời gian thiết kế'],
      complexityFactor: ['Nani keisuu', '難易係数'],
      scaleFactor: ['Kibo keisuu', '規模係数'],
      complexityPoints: ['Naniten', '難易点'],
      reason: ['Bikou', '備考', 'Ly do', 'Lý do'],
      kaisuu: ['Kaisuu', '階数'],
      duration: ['Sagyou jikan', '作業時間', 'Nhap thoi gian thiet ke', 'Nhập thời gian thiết kế'],
      checker: ['Chekkusha', 'チェック者'],
      checkDuration: ['Chekkku jikan', 'チェック時間'],
      group: ['Tantou guruubu', '担当グルーブ'],
      rank: ['Rank', 'ランク'],
      amisu: ['Amisu', 'アミス'],
      returnDate: ['Henkyaku hi', '返却日']
    };

    const allDiscoveredFields = getAllWorkflowFields();
    const fields = {};
    for (const [key, terms] of Object.entries(fieldDefinitions)) {
      const found = findFieldInList(terms, allDiscoveredFields);
      if (found && (found.id || found.key)) {
        fields[key] = { ...found, id: found.id || found.key };
      }
    }

    const missing = Object.entries(fieldDefinitions).filter(([k]) => !fields[k]).map(([k]) => k);
    if (missing.length) {
      const errMsg = `Thiếu các custom fields trên Workflow: ${missing.join(', ')}. Hãy mở trực tiếp trang Workflow của Team trên Base!`;
      await reportProgress(taskId, errMsg, 0.6, 'ERROR');
      return { completed: 0, failures: [errMsg], unmatched: [] };
    }

    const rows = Array.isArray(task.rows) ? task.rows.filter(r => r.is_step2_ready) : [];
    if (!rows.length) {
      const errMsg = 'Không có dòng dữ liệu nào đủ thông tin cho Bước 2.';
      await reportProgress(taskId, errMsg, 0.6, 'WARN');
      return { completed: 0, failures: [errMsg], unmatched: [] };
    }

    const pd = getPageData();
    const jobs = movedJobsInput || pd?.jobs || [];
    const selectedJobIds = new Set();
    let completed = 0;
    const failures = [];
    const unmatched = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const prog = 0.5 + (i / rows.length) * 0.48;
      await reportProgress(taskId, `[Bước 2] Đang chuyển (${i + 1}/${rows.length}): ${row.name}...`, prog);

      const job = jobs.find(item =>
        !selectedJobIds.has(item.id) &&
        normalizeJobName(item.name).includes(row.normalized_name) &&
        (movedJobsInput || Number(item.stage_id) === sourceStageId)
      );

      if (!job) {
        unmatched.push(row.name);
        continue;
      }
      selectedJobIds.add(job.id);

      const code = await post('api/job/next', {
        id: job.id,
        token: job.token,
        [`custom_${fields.area.id}`]: row.area,
        custom_ngay_giao_thuc_te: formatDate(new Date()),
        [`custom_${fields.designDuration.id}`]: config.design_duration ?? config.designDuration ?? 240,
        [`custom_${fields.complexityFactor.id}`]: config.complexity_factor ?? config.complexityFactor ?? '1',
        [`custom_${fields.scaleFactor.id}`]: config.scale_factor ?? config.scaleFactor ?? '1',
        [`custom_${fields.complexityPoints.id}`]: durationPoints[row.duration] || '0',
        [`custom_${fields.reason.id}`]: resolveChoices(fields.reason, row.reason),
        [`custom_${fields.kaisuu.id}`]: row.kaisuu,
        [`custom_${fields.duration.id}`]: row.duration,
        [`custom_${fields.checker.id}`]: config.checker || 'bichbtt',
        [`custom_${fields.checkDuration.id}`]: String(row.reason || '').includes('---') ? 10 : 15,
        [`custom_${fields.group.id}`]: config.group || 'TSVB',
        [`custom_${fields.rank.id}`]: config.rank || '基礎',
        [`custom_${fields.amisu.id}`]: config.amisu || '0',
        [`custom_${fields.returnDate.id}`]: formatDate(new Date())
      });

      if (isGood(code)) {
        completed += 1;
        job.stage_id = targetStageId;
        try {
          if (code.job && typeof ctx.Job?.update === 'function') ctx.Job.update(code.job);
        } catch (err) {}
      } else {
        failures.push(`${row.name}: ${getErrorMessage(code)}`);
      }
    }

    await reportProgress(taskId, `[Bước 2] Hoàn tất chuyển ${completed}/${rows.length} việc sang Hoàn thành.`, 0.98, 'SUCCESS');
    return { completed, failures, unmatched };
  }

  // --- THỰC THI TASK NHẬN TỪ DESKTOP APP ---
  async function executeTask(task) {
    if (isExecuting) return;
    isExecuting = true;
    const mode = task.mode;

    try {
      if (mode === 'step1') {
        const { movedJobs, failures } = await executeStep1(task.id, task);
        await reportResult(task.id, {
          status: failures.length > 0 && movedJobs.length === 0 ? 'error' : 'success',
          movedCount: movedJobs.length,
          failures,
          unmatched: [],
          summary: `Đã chuyển ${movedJobs.length} công việc sang Thiết kế.`
        });
      } else if (mode === 'step2') {
        const { completed, failures, unmatched } = await executeStep2(task.id, task);
        await reportResult(task.id, {
          status: failures.length > 0 && completed === 0 ? 'error' : 'success',
          movedCount: completed,
          failures,
          unmatched,
          summary: `Đã hoàn thành ${completed} công việc.`
        });
      } else if (mode === 'all') {
        const { movedJobs, failures: f1 } = await executeStep1(task.id, task);
        if (!movedJobs.length) {
          await reportResult(task.id, {
            status: 'error',
            movedCount: 0,
            failures: f1,
            unmatched: [],
            summary: 'Không có công việc nào chuyển được ở Bước 1, dừng Bước 2.'
          });
          return;
        }

        const { completed, failures: f2, unmatched } = await executeStep2(task.id, task, movedJobs);
        await reportResult(task.id, {
          status: f2.length > 0 && completed === 0 ? 'error' : 'success',
          movedCount: completed,
          failures: [...f1, ...f2],
          unmatched,
          summary: `Đã hoàn thành ${completed} công việc qua cả 2 bước.`
        });
      }
    } catch (err) {
      console.error('[Keobase Bridge] Lỗi ngoại lệ executeTask:', err);
      await reportResult(task.id, {
        status: 'error',
        movedCount: 0,
        failures: [String(err?.message || err)],
        unmatched: [],
        summary: 'Lỗi thực thi trong script Chrome.'
      });
    } finally {
      isExecuting = false;
      pushDataToDesktop(true);
    }
  }

  // --- TỰ ĐỘNG ĐẨY DỮ LIỆU SANG DESKTOP APP ---
  async function pushDataToDesktop(force = false) {
    if (!isJobsPage()) {
      console.warn('[Keobase Bridge] Bỏ qua vì không phải trang /jobs:', location.href);
      updateBadgeUI(false, '⚠️ Hãy mở trang .../jobs!', '#f59e0b');
      return false;
    }

    const ctx = getPageContext();
    const pd = getPageData();

    if (!pd) {
      console.warn('[Keobase Bridge] Chưa tìm thấy Client.pageData trên trang:', ctx.location?.href);
      updateBadgeUI(true, '⚠️ Chưa mở Workflow trên Base', '#f59e0b');
      try {
        await reportProgress(
          'sync',
          '⚠️ Chrome đang mở trang nhưng chưa tìm thấy dữ liệu Workflow. Hãy bấm vào một Workflow cụ thể ở menu bên trái của Base!',
          0,
          'WARN'
        );
      } catch (e) {}
      return false;
    }

    const isListView = /\/jobs(\?|$)/.test(location.pathname + location.search);
    let jobs = pd.jobs || [];

    // Nếu đang ở List View (/jobs) nhưng pd.jobs trống → parse từ DOM table
    if (isListView && jobs.length === 0) {
      const rows = document.querySelectorAll('tr[id^="js-grid-obj-"][data-id]');
      jobs = Array.from(rows).map(row => {
        const id = parseInt(row.getAttribute('data-id'), 10);
        const stageId = parseInt(row.getAttribute('data-stage'), 10);
        const nameEl = row.querySelector('.name [data-url]');
        const name = nameEl ? nameEl.textContent.trim() : '';
        return { id, name, stage_id: stageId };
      }).filter(j => j.id);
      console.log(`[Keobase Bridge] List View DOM: parsed ${jobs.length} jobs từ table`);
    }

    const wf = pd.workflow || {};
    const wfName = wf.name || wf.title || 'Workflow';
    const wfId = wf.id || wf.code || location.pathname;

    if (!force && jobs.length === lastSyncedJobCount && wfId === lastSyncedWfId) {
      return true;
    }

    // Extract kibou date từ DOM (Board không expose custom fields trong pageData)
    // List View (/jobs): mỗi row có data-field="han_giao" → .js-row-field text (Kibou thật!)
    // Board View: title attribute format "name: HH:MM DD/MM/YYYY | Id: ..."

    // Helper: parse "DD/MM/YYYY" → "YYYY-MM-DD"
    function parseDMY(str) {
      if (!str) return null;
      const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      // Try YYYY-MM-DD passthrough
      if (/^\d{4}-\d{2}-\d{2}$/.test(str.trim())) return str.trim();
      return null;
    }


    const jobsWithKibou = jobs.map(job => {
      let kibouDate = null;

      if (isListView) {
        // List View: <tr id="js-grid-obj-{id}"> → td[data-field="han_giao"] .js-row-field
        const row = document.getElementById(`js-grid-obj-${job.id}`);
        if (row) {
          const cell = row.querySelector('[data-field="han_giao"] .js-row-field');
          if (cell) kibouDate = parseDMY(cell.textContent.trim());
        }
      }

      if (!kibouDate) {
        // Board View fallback: title="name: HH:MM DD/MM/YYYY | Id: ..."
        const el = document.getElementById(`js-job-${job.id}`);
        if (el) {
          const title = el.getAttribute('title') || '';
          const dateMatch = title.match(/:\s*\d{1,2}:\d{2}\s+(\d{2}\/\d{2}\/\d{4})/);
          if (dateMatch) kibouDate = parseDMY(dateMatch[1]);
        }
      }

      if (kibouDate) return Object.assign({}, job, { kibou: kibouDate });
      return job;
    });
    console.log(`[Keobase Bridge] Kibou extracted (${isListView ? 'ListV' : 'Board'}): ${jobsWithKibou.filter(j => j.kibou).length}/${jobsWithKibou.length} jobs`);

    try {
      console.log(`[Keobase Bridge] Đang đồng bộ ${jobs.length} jobs sang Desktop App...`);
      const res = await bridgeRequest('POST', '/api/sync-data', {
        url: ctx.location ? ctx.location.href : location.href,
        pageData: {
          workflow: pd.workflow,
          jobs: jobsWithKibou,
          stages: pd.stages,
          form: pd.form,
          fields: pd.fields,
          custom_fields: pd.custom_fields,
          workflows: pd.workflows
        }
      });

      lastSyncedJobCount = jobs.length;
      lastSyncedWfId = wfId;
      updateBadgeUI(true, `🟢 Đã kết nối App (${jobs.length} việc)`);
      console.log('[Keobase Bridge] Đồng bộ thành công:', res);
      return true;
    } catch (err) {
      console.error('[Keobase Bridge] Lỗi gửi sync-data về Desktop App:', err);
      updateBadgeUI(false, '🔴 Chưa mở App Desktop');
      return false;
    }
  }

  // --- UI BADGE TRÊN BASE.VN ---
  let badgeEl = null;
  function createBadgeUI() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.id = 'keobase-bridge-badge';
    badgeEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span id="kb-dot" style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:#ef4444;"></span>
        <span id="kb-badge-text" style="font-weight:600; font-size:12px;">Keobase Bridge</span>
        <button id="kb-sync-now-btn" title="Bấm để đồng bộ ngay sang App Desktop" style="background:#3b82f6; color:#fff; border:none; border-radius:4px; padding:2px 8px; font-size:11px; cursor:pointer; margin-left:4px;">🔄 Đồng bộ</button>
      </div>
    `;
    Object.assign(badgeEl.style, {
      position: 'fixed',
      bottom: '18px',
      right: '18px',
      zIndex: '2147483647',
      backgroundColor: '#0f172a',
      color: '#f8fafc',
      padding: '8px 14px',
      borderRadius: '20px',
      boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      fontFamily: 'Segoe UI, Arial, sans-serif',
      fontSize: '12px',
      border: '1px solid #334155',
      transition: 'all 0.3s ease'
    });

    document.body.appendChild(badgeEl);

    document.getElementById('kb-sync-now-btn').onclick = (e) => {
      e.stopPropagation();
      pushDataToDesktop(true);
    };
  }

  function updateBadgeUI(connected, text, customDotColor = null) {
    if (!badgeEl) createBadgeUI();
    const dot = document.getElementById('kb-dot');
    const badgeText = document.getElementById('kb-badge-text');
    if (dot) {
      dot.style.backgroundColor = customDotColor || (connected ? '#22c55e' : '#ef4444');
    }
    if (badgeText) {
      badgeText.textContent = text || (connected ? '🟢 Đã kết nối App Desktop' : '🔴 Chưa mở App Desktop');
    }
  }

  // --- VÒNG LẶP POLLING KIỂM TRA LỆNH TỪ DESKTOP APP (MỖI 1.5S) ---
  async function pollTasks() {
    if (!isJobsPage()) {
      updateBadgeUI(false, '⚠️ Hãy mở trang .../jobs của Workflow!', '#f59e0b');
      return;
    }

    try {
      const res = await bridgeRequest('GET', '/api/tasks');
      updateBadgeUI(true);

      if (res && res.status === 'ok' && res.task) {
        const task = res.task;
        if (task.type === 'sync_now') {
          console.log('[Keobase Bridge] Nhận yêu cầu sync_now từ Desktop App');
          await pushDataToDesktop(true);
        } else if (task.type === 'run_workflow' && !isExecuting) {
          console.log('[Keobase Bridge] Nhận task run_workflow:', task);
          executeTask(task);
        }
      }
    } catch (e) {
      updateBadgeUI(false);
    }
  }

  // --- KHỞI CHẠY BRIDGE SCRIPT ---
  function init() {
    createBadgeUI();
    if (!isJobsPage()) {
      console.warn('[Keobase Bridge] Script chỉ hoạt động trên URL https://workflow.base.vn/*/jobs. URL hiện tại:', location.href);
      updateBadgeUI(false, '⚠️ Hãy mở trang .../jobs!', '#f59e0b');
      return;
    }

    console.log('[Keobase Bridge] Script đã khởi chạy trên Base.vn (/jobs)');

    // Thử đẩy dữ liệu ban đầu
    setTimeout(() => pushDataToDesktop(false), 800);
    setTimeout(() => pushDataToDesktop(false), 2000);
    setTimeout(() => pushDataToDesktop(false), 4000);

    // Chạy vòng lặp polling mỗi 1.5 giây
    setInterval(pollTasks, 1500);

    // Lắng nghe thay đổi URL (SPA navigation của Base)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[Keobase Bridge] Phát hiện chuyển trang Base:', lastUrl);
        if (isJobsPage()) {
          setTimeout(() => pushDataToDesktop(true), 1200);
        } else {
          updateBadgeUI(false, '⚠️ Hãy mở trang .../jobs!', '#f59e0b');
        }
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

