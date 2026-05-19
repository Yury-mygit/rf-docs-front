let docsModule = null;
async function getDocsModule() {
  if (!docsModule) docsModule = await import('./docs.js');
  return docsModule;
}
async function mountDocsEditor(rootEl, md, onChange) {
  const m = await getDocsModule();
  return m.mountEditor(rootEl, md, onChange);
}
async function unmountDocsEditor() {
  if (!docsModule) return;
  return docsModule.unmountEditor();
}
async function insertDocsText(text) {
  const m = await getDocsModule();
  return m.insertText(text);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// crypto.randomUUID() requires a secure context (HTTPS) — fall back to v4 via getRandomValues.
function randomUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ── API ───────────────────────────────────────────────────────────────────────

const BASE = '/api/v1';

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(body || res.statusText), { status: res.status });
  }
  return res;
}

const api = {
  workspacesList: () => apiFetch('/workspaces').then(r => r.json()),
  createWorkspace: body =>
    apiFetch('/workspaces', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  patchWorkspace: (id, data) =>
    apiFetch(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }).then(r => r.json()),

  docsTree: wsId => apiFetch(`/docs/tree?workspaceId=${wsId}`).then(r => r.json()),
  getDoc: id => apiFetch(`/docs/${id}`).then(r => r.json()),
  createDoc: body =>
    apiFetch('/docs', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  patchDoc: (id, data) =>
    apiFetch(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }).then(r => r.json()),
  deleteDoc: id =>
    apiFetch(`/docs/${id}`, { method: 'DELETE' }),
  shareDoc: id =>
    apiFetch(`/docs/${id}/share`, { method: 'POST' }).then(r => r.json()),
  searchDocs: (q, wsId, limit = 20) => {
    const params = new URLSearchParams({ q, limit });
    if (wsId) params.set('workspaceId', wsId);
    return apiFetch(`/docs/search?${params}`).then(r => r.json());
  },

  transcribeAudio: async blob => {
    const fd = new FormData();
    fd.append('audio', blob, blob.name || 'recording.webm');
    const r = await fetch(BASE + '/transcribe/audio', { method: 'POST', body: fd });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw Object.assign(new Error(body || r.statusText), { status: r.status });
    }
    return r.json();
  },
};

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'err' : 'ok';
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
}

// ── Docs ─────────────────────────────────────────────────────────────────────

let allWorkspaces = [];
let currentWorkspaceId = null;
let allDocs = [];
let currentDocId = null;
let docSearchTimer = null;
let docSaveTimer = null;
let pendingDocPatch = null;

function escapeHtmlDoc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

async function loadWorkspaces() {
  try {
    allWorkspaces = await api.workspacesList();
    if (!allWorkspaces.length) {
      setStatus('Нет ни одного workspace', true);
      return;
    }
    renderWorkspacesSwitcher();
    const stored = localStorage.getItem('livenotes_docs_ws');
    const target = allWorkspaces.find(w => w.id === stored) || allWorkspaces[0];
    await setCurrentWorkspace(target.id);
  } catch (e) {
    setStatus(`Ошибка загрузки workspaces: ${e.message}`, true);
  }
}

function renderWorkspacesSwitcher() {
  const sel = document.getElementById('docs-ws-select');
  sel.innerHTML = '';
  for (const w of allWorkspaces) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.title || 'Без названия';
    if (w.id === currentWorkspaceId) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function setCurrentWorkspace(wsId) {
  if (wsId === currentWorkspaceId) return;
  await flushDocSave();
  currentWorkspaceId = wsId;
  localStorage.setItem('livenotes_docs_ws', wsId);
  if (currentDocId) {
    currentDocId = null;
    document.body.classList.add('docs-noselection');
    const titleEl = document.getElementById('doc-title');
    titleEl.value = '';
    titleEl.disabled = true;
    document.getElementById('docs-delete-btn').disabled = true;
    document.getElementById('docs-new-child-btn').disabled = true;
    document.getElementById('docs-share-btn').disabled = true;
    const kindSelectEl = document.getElementById('doc-kind-select');
    kindSelectEl.value = 'page';
    kindSelectEl.disabled = true;
    syncSlugInput('page', '');
    setMicState('idle');
    document.getElementById('docs-status').textContent = '';
    await unmountDocsEditor();
  }
  document.getElementById('docs-ws-select').value = wsId;
  document.getElementById('docs-search-input').value = '';
  await loadDocs();
}

async function loadDocs() {
  if (!currentWorkspaceId) return;
  try {
    allDocs = await api.docsTree(currentWorkspaceId);
    document.body.classList.toggle('docs-noselection', !currentDocId);
    renderDocsTree();
  } catch (e) {
    setStatus(`Ошибка загрузки docs: ${e.message}`, true);
  }
}

async function createWorkspace() {
  const title = prompt('Название воркспейса:');
  if (!title || !title.trim()) return;
  const id = randomUUID();
  const now = Date.now();
  try {
    const ws = await api.createWorkspace({
      id, title: title.trim(),
      position: allWorkspaces.length,
      createdAt: now, updatedAt: now,
    });
    allWorkspaces = [...allWorkspaces, ws];
    renderWorkspacesSwitcher();
    await setCurrentWorkspace(id);
  } catch (e) {
    setStatus(`Ошибка создания workspace: ${e.message}`, true);
  }
}

function renderSubpages() {
  const el = document.getElementById('docs-subpages');
  el.innerHTML = '';
  if (!currentDocId) return;
  const children = allDocs
    .filter(d => d.parentId === currentDocId)
    .sort((a, b) => (a.position - b.position) || (b.updatedAt - a.updatedAt));
  for (const c of children) {
    const link = document.createElement('span');
    link.className = c.title ? 'docs-subpage-link' : 'docs-subpage-link docs-subpage-untitled';
    link.dataset.id = c.id;
    link.textContent = c.title || 'Без названия';
    link.addEventListener('click', () => openDoc(c.id));
    el.appendChild(link);
  }
}

const KIND_ICONS = {
  page: '📄',
  change_map: '🗺',
  project_root: '📦',
  website_base: '🌐',
  api_contract: '📋',
};

const KINDS_WITH_SLUG = new Set(['project_root', 'api_contract']);

function kindIcon(kind) {
  return KIND_ICONS[kind] || KIND_ICONS.page;
}

function renderDocsTree() {
  const treeEl = document.getElementById('docs-tree');
  if (!allDocs.length) {
    treeEl.innerHTML = '<div class="hint">Нет страниц</div>';
    return;
  }
  const byParent = new Map();
  for (const d of allDocs) {
    const k = d.parentId || '';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(d);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.position - b.position) || (b.updatedAt - a.updatedAt));
  }
  treeEl.innerHTML = '';
  const renderNode = (d, depth) => {
    const item = document.createElement('div');
    item.className = 'docs-tree-item' + (d.id === currentDocId ? ' active' : '');
    item.dataset.id = d.id;
    item.style.paddingLeft = `${12 + depth * 14}px`;
    const titleClass = d.title ? 'doc-title-text' : 'doc-title-text doc-untitled';
    item.innerHTML = `<span class="doc-kind-icon" title="${d.kind}">${kindIcon(d.kind)}</span><span class="${titleClass}">${escapeHtmlDoc(d.title || 'Без названия')}</span>`;
    item.addEventListener('click', () => openDoc(d.id));
    treeEl.appendChild(item);
    for (const c of byParent.get(d.id) || []) renderNode(c, depth + 1);
  };
  for (const r of byParent.get('') || []) renderNode(r, 0);
}

async function openDoc(id) {
  if (id === currentDocId) return;
  await flushDocSave();
  try {
    const doc = await api.getDoc(id);
    currentDocId = id;
    document.body.classList.remove('docs-noselection');
    const titleEl = document.getElementById('doc-title');
    titleEl.value = doc.title || '';
    titleEl.disabled = false;
    document.getElementById('docs-delete-btn').disabled = false;
    document.getElementById('docs-new-child-btn').disabled = false;
    document.getElementById('docs-share-btn').disabled = false;
    const kindSelectEl = document.getElementById('doc-kind-select');
    kindSelectEl.value = doc.kind || 'page';
    kindSelectEl.disabled = false;
    syncSlugInput(doc.kind || 'page', doc.slug || '');
    setMicState('idle');
    document.getElementById('docs-status').textContent = '';
    const editorEl = document.getElementById('docs-editor');
    if (!docsModule) editorEl.innerHTML = '<div class="docs-editor-loading">Загрузка редактора…</div>';
    await mountDocsEditor(editorEl, doc.bodyMd || '', onDocBodyChanged);
    renderDocsTree();
    renderSubpages();
  } catch (e) {
    setStatus(`Ошибка открытия страницы: ${e.message}`, true);
  }
}

const MAP_TEMPLATE = `## Идея

*(Пользователь заполняет: что нужно сделать, зачем, какой результат.)*

## Разрешения

**Уровень: Dev**

✅ В scope, делать без подтверждения:
- Правки в \`*/dev/**\` затронутых проектов
- Rebuild dev-контейнеров
- Alembic-миграции (только dev)
- npm/pip-зависимости в dev
- Коммиты в claude-workspace, LN backend dev, LN frontend dev
- Тики чекбоксов и обновление полей карты через MCP

❌ Запрещено без явного OK:
- Изменения в \`*/test/*\` и \`*/prod/*\`
- Restart shared-инфры (caddy, docker, networks, reboot)
- \`git push\` в remote
- Удаление файлов вне scope карты
- Изменения \`/root/CLAUDE.md\`
- Установка системных пакетов

⏸ Стоп и спросить даже если в scope:
- Объём расходится с «Идеей» более чем в 3 раза
- Найдены незакоммиченные чужие изменения вне scope
- Нужно отступить от уже согласованных «Решений»

## Контекст

*(Claude заполняет после прочтения «Идеи».)*

## Решения

*(Claude заполняет.)*

## Этапы

*(Claude заполняет с чекбоксами.)*

## Оценка

- **Размер:** — *(S < 2ч, M ≈ 2-6ч, L ≈ 6-16ч, XL > 16ч)*
- **Время:** —
- **Риск:** — *(низкий / средний / высокий)*
- **Зависимости:** —

## Риски

*(детальный список конкретных рисков)*
`;

async function createDocImpl(parentId) {
  if (!currentWorkspaceId) {
    setStatus('Сначала выберите workspace', true);
    return;
  }
  await flushDocSave();
  const id = randomUUID();
  const now = Date.now();
  const isChild = parentId !== null;
  try {
    const doc = await api.createDoc({
      id, workspaceId: currentWorkspaceId, parentId,
      title: '', bodyMd: isChild ? MAP_TEMPLATE : '',
      position: 0, createdAt: now, updatedAt: now,
    });
    allDocs = [doc, ...allDocs];
    await openDoc(id);
    document.getElementById('doc-title').focus();
  } catch (e) {
    setStatus(`Ошибка создания страницы: ${e.message}`, true);
  }
}

async function createDoc() {
  return createDocImpl(null);
}

async function createChildDoc() {
  if (!currentDocId) return;
  return createDocImpl(currentDocId);
}

async function deleteCurrentDoc() {
  if (!currentDocId) return;
  if (!confirm('Удалить страницу? Её можно будет восстановить (soft-delete).')) return;
  const id = currentDocId;
  pendingDocPatch = null;
  clearTimeout(docSaveTimer);
  try {
    await api.deleteDoc(id);
    allDocs = allDocs.filter(d => d.id !== id);
    currentDocId = null;
    document.body.classList.add('docs-noselection');
    const titleEl = document.getElementById('doc-title');
    titleEl.value = '';
    titleEl.disabled = true;
    document.getElementById('docs-delete-btn').disabled = true;
    document.getElementById('docs-new-child-btn').disabled = true;
    document.getElementById('docs-share-btn').disabled = true;
    const kindSelectEl = document.getElementById('doc-kind-select');
    kindSelectEl.value = 'page';
    kindSelectEl.disabled = true;
    syncSlugInput('page', '');
    setMicState('idle');
    document.getElementById('docs-status').textContent = '';
    await unmountDocsEditor();
    renderDocsTree();
    renderSubpages();
  } catch (e) {
    setStatus(`Ошибка удаления: ${e.message}`, true);
  }
}

// ── API contract: публичная ссылка ───────────────────────────────────────────

function syncContractLink(kind, slug) {
  const wrap = document.getElementById('doc-contract-link');
  const urlEl = document.getElementById('doc-contract-url');
  const copyBtn = document.getElementById('doc-contract-copy');
  const visible = kind === 'api_contract' && !!slug;
  wrap.hidden = !visible;
  if (visible) {
    urlEl.value = `${location.origin}/api/v1/site/contracts/${slug}`;
    copyBtn.textContent = 'Копировать';
    copyBtn.classList.remove('copied');
  }
}

async function copyContractUrl() {
  const urlEl = document.getElementById('doc-contract-url');
  const btn = document.getElementById('doc-contract-copy');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(urlEl.value);
    } else {
      urlEl.select();
      document.execCommand('copy');
    }
    btn.textContent = 'Скопировано';
    btn.classList.add('copied');
  } catch (e) {
    setStatus(`Не удалось скопировать: ${e.message}`, true);
  }
}

// ── Share ───────────────────────────────────────────────────────────────────

function formatShareExpiry(ms) {
  try {
    return new Date(ms).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function showShareModal(url, expiresAt) {
  const modal = document.getElementById('docs-share-modal');
  const urlEl = document.getElementById('docs-share-url');
  const expEl = document.getElementById('docs-share-expires');
  const copyBtn = document.getElementById('docs-share-copy');
  urlEl.value = url;
  expEl.textContent = `Срок действия: до ${formatShareExpiry(expiresAt)}`;
  copyBtn.textContent = 'Скопировать';
  copyBtn.classList.remove('copied');
  modal.hidden = false;
  setTimeout(() => { urlEl.focus(); urlEl.select(); }, 0);
}

function hideShareModal() {
  document.getElementById('docs-share-modal').hidden = true;
}

async function openShareDialog() {
  if (!currentDocId) return;
  await flushDocSave();
  try {
    const { token, expiresAt } = await api.shareDoc(currentDocId);
    const url = `${location.origin}/api/v1/site/share/${token}`;
    showShareModal(url, expiresAt);
  } catch (e) {
    setStatus(`Не удалось создать ссылку: ${e.message}`, true);
  }
}

async function copyShareUrl() {
  const urlEl = document.getElementById('docs-share-url');
  const copyBtn = document.getElementById('docs-share-copy');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(urlEl.value);
    } else {
      urlEl.select();
      document.execCommand('copy');
    }
    copyBtn.textContent = 'Скопировано';
    copyBtn.classList.add('copied');
  } catch (e) {
    setStatus(`Не удалось скопировать: ${e.message}`, true);
  }
}

function onDocBodyChanged(md) {
  if (!currentDocId) return;
  pendingDocPatch = { ...(pendingDocPatch || {}), bodyMd: md };
  scheduleDocSave();
}

function onDocTitleInput(e) {
  if (!currentDocId) return;
  pendingDocPatch = { ...(pendingDocPatch || {}), title: e.target.value };
  scheduleDocSave();
}

async function setDocKind(newKind) {
  if (!currentDocId) return;
  const id = currentDocId;
  const idx = allDocs.findIndex(d => d.id === id);
  const previousKind = idx >= 0 ? allDocs[idx].kind : 'page';
  if (previousKind === newKind) return;
  await flushDocSave();
  const kindSelectEl = document.getElementById('doc-kind-select');
  try {
    const updated = await api.patchDoc(id, { kind: newKind, updatedAt: Date.now() });
    if (idx >= 0) {
      allDocs[idx] = { ...allDocs[idx], kind: updated.kind, slug: updated.slug, updatedAt: updated.updatedAt };
    }
    kindSelectEl.value = updated.kind;
    syncSlugInput(updated.kind, updated.slug || '');
    renderDocsTree();
    renderSubpages();
  } catch (e) {
    kindSelectEl.value = previousKind;
    setStatus(`Не получилось сменить тип: ${e.message}`, true);
  }
}

function syncSlugInput(kind, slug) {
  const el = document.getElementById('doc-slug-input');
  const allowsSlug = KINDS_WITH_SLUG.has(kind);
  el.hidden = !allowsSlug;
  el.disabled = !allowsSlug || !currentDocId;
  el.value = slug || '';
  syncContractLink(kind, slug);
}

async function setDocSlug(newSlug) {
  if (!currentDocId) return;
  const id = currentDocId;
  const idx = allDocs.findIndex(d => d.id === id);
  const previousSlug = idx >= 0 ? (allDocs[idx].slug || '') : '';
  const trimmed = newSlug.trim();
  if (trimmed === previousSlug) return;
  if (trimmed && !/^[a-z0-9-]{1,64}$/.test(trimmed)) {
    setStatus('slug должен соответствовать [a-z0-9-]{1,64}', true);
    document.getElementById('doc-slug-input').value = previousSlug;
    return;
  }
  await flushDocSave();
  const inputEl = document.getElementById('doc-slug-input');
  try {
    const updated = await api.patchDoc(id, { slug: trimmed || null, updatedAt: Date.now() });
    if (idx >= 0) {
      allDocs[idx] = { ...allDocs[idx], slug: updated.slug, updatedAt: updated.updatedAt };
    }
    inputEl.value = updated.slug || '';
  } catch (e) {
    inputEl.value = previousSlug;
    setStatus(`Не получилось задать slug: ${e.message}`, true);
  }
}

function scheduleDocSave() {
  document.getElementById('docs-status').textContent = '…';
  clearTimeout(docSaveTimer);
  docSaveTimer = setTimeout(flushDocSave, 500);
}

async function flushDocSave() {
  if (!currentDocId || !pendingDocPatch) return;
  const id = currentDocId;
  const data = { ...pendingDocPatch, updatedAt: Date.now() };
  pendingDocPatch = null;
  clearTimeout(docSaveTimer);
  try {
    const updated = await api.patchDoc(id, data);
    const idx = allDocs.findIndex(d => d.id === id);
    if (idx >= 0) {
      allDocs[idx] = { ...allDocs[idx], title: updated.title, updatedAt: updated.updatedAt };
    }
    renderDocsTree();
    renderSubpages();
    const s = document.getElementById('docs-status');
    s.textContent = '✓';
    setTimeout(() => { if (s.textContent === '✓') s.textContent = ''; }, 1500);
  } catch (e) {
    document.getElementById('docs-status').textContent = '!';
    setStatus(`Ошибка сохранения: ${e.message}`, true);
  }
}

// ── Voice input (mic → VAD → phrase → whisper → insert) ─────────────────────

const VAD_VOLUME_THRESHOLD = 0.015;
const VAD_SILENCE_MS = 800;
const VAD_MIN_PHRASE_MS = 300;
const VAD_MAX_PHRASE_MS = 30_000;
const VAD_TICK_MS = 50;

let micState = 'idle';
let vadActive = false;
let recordingStream = null;
let audioCtx = null;
let analyser = null;
let phraseRecorder = null;

function setMicState(state) {
  micState = state;
  const btn = document.getElementById('docs-mic-btn');
  btn.classList.toggle('recording', state === 'recording');
  btn.classList.toggle('uploading', state === 'uploading');
  btn.disabled = !currentDocId;
  if (state === 'recording') btn.title = 'Остановить (VAD активен)';
  else if (state === 'uploading') btn.title = 'Распознаю фразу…';
  else btn.title = 'Голосовой ввод (микрофон)';
}

function stopMicResources() {
  if (phraseRecorder && phraseRecorder.state === 'recording') {
    try { phraseRecorder.stop(); } catch (_) {}
  }
  phraseRecorder = null;
  if (audioCtx) { try { audioCtx.close(); } catch (_) {}; audioCtx = null; }
  analyser = null;
  if (recordingStream) {
    recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
  }
}

function getRMS() {
  if (!analyser) return 0;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function pickMimeType() {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  return '';
}

function waitForSpeechStart() {
  return new Promise(resolve => {
    const tick = () => {
      if (!vadActive) return resolve(false);
      if (getRMS() > VAD_VOLUME_THRESHOLD) return resolve(true);
      setTimeout(tick, VAD_TICK_MS);
    };
    tick();
  });
}

function recordPhrase() {
  return new Promise(resolve => {
    const chunks = [];
    const mimeType = pickMimeType();
    phraseRecorder = mimeType
      ? new MediaRecorder(recordingStream, { mimeType })
      : new MediaRecorder(recordingStream);
    phraseRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    phraseRecorder.onstop = () => {
      const blob = chunks.length ? new Blob(chunks, { type: chunks[0].type || 'audio/webm' }) : null;
      resolve({ blob, durationMs: Date.now() - startedAt });
    };
    const startedAt = Date.now();
    phraseRecorder.start();

    let silenceStart = null;
    let hadSpeech = true;

    const tick = () => {
      if (!vadActive) {
        if (phraseRecorder.state === 'recording') phraseRecorder.stop();
        return;
      }
      const now = Date.now();
      if (now - startedAt > VAD_MAX_PHRASE_MS) {
        phraseRecorder.stop();
        return;
      }
      const vol = getRMS();
      if (vol > VAD_VOLUME_THRESHOLD) {
        silenceStart = null;
      } else {
        if (silenceStart === null) silenceStart = now;
        else if (now - silenceStart > VAD_SILENCE_MS) {
          phraseRecorder.stop();
          return;
        }
      }
      setTimeout(tick, VAD_TICK_MS);
    };
    tick();
  });
}

async function vadLoop() {
  let seq = 0;
  let nextToInsert = 0;
  const pending = new Map();
  const uploads = [];
  let inFlight = 0;

  const refreshTitle = () => {
    const btn = document.getElementById('docs-mic-btn');
    if (!vadActive) return;
    btn.title = inFlight > 0
      ? `Слушаю · в очереди: ${inFlight}`
      : 'Слушаю (нажмите для остановки)';
  };

  const insertInOrder = async (s, text) => {
    pending.set(s, text);
    while (pending.has(nextToInsert)) {
      const t = pending.get(nextToInsert);
      pending.delete(nextToInsert);
      nextToInsert++;
      if (t) await insertDocsText(t + ' ');
    }
  };

  const transcribeAndInsert = async (s, blob) => {
    inFlight++;
    refreshTitle();
    try {
      const { text } = await api.transcribeAudio(blob);
      await insertInOrder(s, text);
    } catch (e) {
      setStatus(`Ошибка распознавания: ${e.message}`, true);
      await insertInOrder(s, null);
    } finally {
      inFlight--;
      refreshTitle();
    }
  };

  while (vadActive) {
    const speechDetected = await waitForSpeechStart();
    if (!speechDetected) break;
    const { blob, durationMs } = await recordPhrase();
    if (!blob || durationMs < VAD_MIN_PHRASE_MS) {
      if (!vadActive) break;
      continue;
    }
    const mySeq = seq++;
    uploads.push(transcribeAndInsert(mySeq, blob));
  }

  if (uploads.length) {
    setMicState('uploading');
    await Promise.all(uploads);
  }
  setMicState('idle');
}

async function startVAD() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Браузер не поддерживает запись с микрофона', true);
    return;
  }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus('Нет доступа к микрофону. Разрешите в настройках сайта.', true);
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(recordingStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  vadActive = true;
  setMicState('recording');
  vadLoop().catch(e => {
    console.error('vad loop error', e);
    setStatus(`VAD error: ${e.message}`, true);
  }).finally(() => {
    stopMicResources();
    setMicState('idle');
  });
}

function stopVAD() {
  vadActive = false;
  if (phraseRecorder && phraseRecorder.state === 'recording') {
    try { phraseRecorder.stop(); } catch (_) {}
  }
}

async function onMicClick() {
  if (!currentDocId) return;
  if (micState === 'idle') return startVAD();
  return stopVAD();
}

function onDocsSearchInput(e) {
  clearTimeout(docSearchTimer);
  const q = e.target.value.trim();
  if (!q) { renderDocsTree(); return; }
  docSearchTimer = setTimeout(() => runDocsSearch(q), 250);
}

async function runDocsSearch(q) {
  try {
    const hits = await api.searchDocs(q, currentWorkspaceId, 30);
    const treeEl = document.getElementById('docs-tree');
    if (!hits.length) {
      treeEl.innerHTML = '<div class="hint">Ничего не найдено</div>';
      return;
    }
    treeEl.innerHTML = '';
    for (const h of hits) {
      const el = document.createElement('div');
      el.className = 'docs-search-hit';
      el.dataset.id = h.id;
      el.innerHTML = `<div class="hit-title">${escapeHtmlDoc(h.title || 'Без названия')}</div><div class="hit-snippet">${h.snippet || ''}</div>`;
      el.addEventListener('click', () => {
        document.getElementById('docs-search-input').value = '';
        openDoc(h.id);
      });
      treeEl.appendChild(el);
    }
  } catch (e) {
    setStatus(`Ошибка поиска: ${e.message}`, true);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Перехват кликов по cross-ref ссылкам [title](#doc-<id>) — раньше, чем Crepe/ProseMirror.
function docCrossRefHandler(e) {
  const a = e.target.closest('a[href^="#doc-"]');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === 'click') {
    const id = a.getAttribute('href').slice(5);
    openDoc(id);
  }
}
const docsScroll = document.querySelector('.docs-content-scroll');
docsScroll.addEventListener('mousedown', docCrossRefHandler, true);
docsScroll.addEventListener('click', docCrossRefHandler, true);

// ── Mobile: Docs sidebar drawer ──
const docsSidebarEl = document.querySelector('.docs-sidebar');
const docsBackdropEl = document.getElementById('docs-sidebar-backdrop');
const docsSidebarToggleEl = document.getElementById('docs-sidebar-toggle');

function setDocsSidebar(open) {
  docsSidebarEl.classList.toggle('open', open);
  docsBackdropEl.classList.toggle('open', open);
}
docsSidebarToggleEl.addEventListener('click', () => {
  setDocsSidebar(!docsSidebarEl.classList.contains('open'));
});
docsBackdropEl.addEventListener('click', () => setDocsSidebar(false));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && docsSidebarEl.classList.contains('open')) {
    setDocsSidebar(false);
  }
});
document.getElementById('docs-tree').addEventListener('click', () => {
  if (docsSidebarEl.classList.contains('open')) setDocsSidebar(false);
}, true);

// ── Mobile: «⋮» actions-меню в content-header ──
const docsActionsBtnEl = document.getElementById('docs-actions-btn');
const docsActionsMenuEl = document.getElementById('docs-actions-menu');

function setDocsActionsMenu(open) {
  if (open) {
    const micDisabled = document.getElementById('docs-mic-btn').disabled;
    const childDisabled = document.getElementById('docs-new-child-btn').disabled;
    const shareDisabled = document.getElementById('docs-share-btn').disabled;
    const deleteDisabled = document.getElementById('docs-delete-btn').disabled;
    const kindSelectEl = document.getElementById('doc-kind-select');
    const kindDisabled = kindSelectEl.disabled;
    const currentKind = kindSelectEl.value;
    docsActionsMenuEl.querySelector('[data-action="mic"]').disabled = micDisabled;
    docsActionsMenuEl.querySelector('[data-action="child"]').disabled = childDisabled;
    docsActionsMenuEl.querySelector('[data-action="share"]').disabled = shareDisabled;
    docsActionsMenuEl.querySelector('[data-action="delete"]').disabled = deleteDisabled;
    docsActionsMenuEl.querySelectorAll('button[data-kind]').forEach(b => {
      b.disabled = kindDisabled;
      b.classList.toggle('active', b.dataset.kind === currentKind);
    });
    docsActionsMenuEl.style.display = 'flex';
  } else {
    docsActionsMenuEl.style.display = 'none';
  }
}
docsActionsBtnEl.addEventListener('click', e => {
  e.stopPropagation();
  setDocsActionsMenu(docsActionsMenuEl.style.display === 'none');
});
docsActionsMenuEl.addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  setDocsActionsMenu(false);
  if (action === 'mic') document.getElementById('docs-mic-btn').click();
  else if (action === 'child') document.getElementById('docs-new-child-btn').click();
  else if (action === 'share') document.getElementById('docs-share-btn').click();
  else if (action === 'delete') document.getElementById('docs-delete-btn').click();
  else if (action === 'kind') setDocKind(btn.dataset.kind);
});
document.addEventListener('click', e => {
  if (docsActionsMenuEl.style.display === 'none') return;
  if (e.target.closest('#docs-actions-menu') || e.target.closest('#docs-actions-btn')) return;
  setDocsActionsMenu(false);
});
document.getElementById('new-doc-btn').addEventListener('click', createDoc);
document.getElementById('new-ws-btn').addEventListener('click', createWorkspace);
document.getElementById('docs-ws-select').addEventListener('change', e => setCurrentWorkspace(e.target.value));
document.getElementById('docs-delete-btn').addEventListener('click', deleteCurrentDoc);
document.getElementById('docs-new-child-btn').addEventListener('click', createChildDoc);
document.getElementById('docs-share-btn').addEventListener('click', openShareDialog);
document.getElementById('docs-share-copy').addEventListener('click', copyShareUrl);
document.getElementById('docs-share-close').addEventListener('click', hideShareModal);
document.querySelector('#docs-share-modal .docs-modal-backdrop').addEventListener('click', hideShareModal);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('docs-share-modal').hidden) {
    hideShareModal();
  }
});
document.getElementById('docs-mic-btn').addEventListener('click', onMicClick);
document.getElementById('doc-title').addEventListener('input', onDocTitleInput);
document.getElementById('doc-kind-select').addEventListener('change', e => setDocKind(e.target.value));
document.getElementById('doc-slug-input').addEventListener('change', e => setDocSlug(e.target.value));
document.getElementById('doc-contract-copy').addEventListener('click', copyContractUrl);
document.getElementById('docs-search-input').addEventListener('input', onDocsSearchInput);
document.body.classList.add('docs-noselection');
document.body.classList.add('docs-on');

loadWorkspaces();
