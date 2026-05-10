import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

let crepe = null;
let currentRoot = null;
let onChangeCb = null;

export async function mountEditor(rootEl, initialMd, onChange) {
  await unmountEditor();
  currentRoot = rootEl;
  onChangeCb = onChange;
  rootEl.innerHTML = '';
  crepe = new Crepe({ root: rootEl, defaultValue: initialMd || '' });
  await crepe.create();
  crepe.on(listener => {
    listener.markdownUpdated((_ctx, md) => {
      if (onChangeCb) onChangeCb(md);
    });
  });
}

export async function unmountEditor() {
  if (!crepe) return;
  const old = crepe;
  crepe = null;
  onChangeCb = null;
  try { await old.destroy(); } catch (_) { /* ignore */ }
  if (currentRoot) currentRoot.innerHTML = '';
  currentRoot = null;
}

export function getMarkdown() {
  if (!crepe) return '';
  try { return crepe.getMarkdown(); } catch (_) { return ''; }
}

export function isMounted() { return crepe !== null; }

export function insertText(text) {
  if (!crepe || !text) return false;
  try {
    crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const tr = view.state.tr.insertText(text);
      view.dispatch(tr);
      view.focus();
    });
    return true;
  } catch (e) {
    console.error('docs.insertText failed', e);
    return false;
  }
}
