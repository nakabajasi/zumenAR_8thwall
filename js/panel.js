// 画面下の情報パネル（AR表示と通常ビューアで共通）
// ARは手ぶれで空中の文字が読めないので、文字はすべてここに固定して出す
import { typeLabel, entryKey } from './common.js';
import { shareUrl } from './catalog.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function fieldList(pairs) {
  const dl = el('dl', 'fields');
  for (const [label, value] of pairs) {
    if (value == null || String(value).trim() === '') continue; // 未入力の項目は出さない
    dl.append(el('dt', null, label), el('dd', null, String(value)));
  }
  return dl;
}

// リンクを渡す：スマホでは共有メニュー、それ以外はコピー。どちらも使えなければ、選んでコピーできる形で出す
async function shareLink(link, title, button, holder) {
  const label = button.textContent;
  const done = (text) => { button.textContent = text; setTimeout(() => { button.textContent = label; }, 1600); };
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title, url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    done('コピーしました');
  } catch (err) {
    if (err && err.name === 'AbortError') return; // 共有メニューを閉じただけ
    holder.innerHTML = '';
    const box = el('input', 'link-box');
    box.readOnly = true;
    box.value = link;
    holder.append(box);
    box.focus();
    box.select();
  }
}

function shareRow(text, link, title) {
  const row = el('div', 'share-row');
  const button = el('button', 'link-button', text);
  button.type = 'button';
  const holder = el('div', 'share-holder');
  button.addEventListener('click', () => shareLink(link, title, button, holder));
  row.append(button, holder);
  return row;
}

/**
 * options
 *   onLayerToggle(layer, on)  レイヤーの表示切り替え
 *   onClearSelection()        注記の選択を外す
 *   onPickItem(item)          同じ図面の別の資料を選ぶ
 *   edition                   データの版（台帳の site.edition）
 *   cite                      引用のしかた（台帳の site.cite）
 */
export function createPanel(root, { onLayerToggle, onClearSelection, onPickItem, edition, cite } = {}) {
  root.classList.add('panel');
  root.innerHTML = '';

  const head = el('button', 'panel-head');
  head.type = 'button';
  const title = el('span', 'panel-title', '');
  const chevron = el('span', 'panel-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  head.append(title, chevron);

  const body = el('div', 'panel-body');
  const selection = el('section', 'panel-selection');
  const siblingsBox = el('section', 'panel-siblings');
  const layersBox = el('section', 'panel-layers');
  const metaBox = el('section', 'panel-meta');
  body.append(selection, siblingsBox, layersBox, metaBox);
  root.append(head, body);

  let currentItem = null;

  function setOpen(open) {
    root.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
  }
  // モデルを指でたたいてパネルが開いた直後は、同じ指の動きで出るクリックを無視する（開いてすぐ閉じるのを防ぐ）
  let openedByTapAt = -1e9;
  head.addEventListener('click', () => {
    if (performance.now() - openedByTapAt < 500) return;
    setOpen(!root.classList.contains('is-open'));
  });
  setOpen(false);

  function setItem(item, meta) {
    currentItem = item;
    const name = (meta && meta.title) || item.title || item.id;
    title.textContent = name;
    metaBox.innerHTML = '';
    const fields = (meta && meta.fields) || [];
    const dl = fieldList(fields.map((f) => [f.label, f.value]));
    if (dl.children.length) {
      metaBox.append(el('h2', null, '資料情報'), dl);
    } else {
      metaBox.append(el('p', 'muted', '資料情報は未入力です。'));
    }
    if (meta && meta.notice) metaBox.append(el('p', 'notice', meta.notice));

    // 共同参照：同じ資料を、図面がない人にも同じ状態で渡せるようにする
    metaBox.append(el('h2', null, '参照'));
    metaBox.append(shareRow('この資料のリンクを渡す', shareUrl('viewer.html', { id: item.id }), name));
    const list = el('a', 'link-button', '注記の一覧');
    list.href = shareUrl('notes.html', { id: item.id });
    metaBox.append(list);
    const stamp = [edition ? `データ版 ${edition}` : '', cite || ''].filter(Boolean).join('　');
    if (stamp) metaBox.append(el('p', 'edition', stamp));
    showSelection(null);
  }

  // 同じ図面に載っている資料（AR では小さなモデルを指でたたくより選びやすい）
  function setSiblings(items, active) {
    siblingsBox.innerHTML = '';
    if (!items || items.length < 2) return;
    siblingsBox.append(el('h2', null, 'この図面の資料'));
    const list = el('div', 'chips');
    for (const it of items) {
      const chip = el('button', `chip${it === active ? ' is-on' : ''}`, it.title || it.id);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(it === active));
      chip.addEventListener('click', () => onPickItem && onPickItem(it));
      list.append(chip);
    }
    siblingsBox.append(list);
  }

  function setLayers(layers) {
    layersBox.innerHTML = '';
    if (!layers.length) return;
    layersBox.append(el('h2', null, 'アノテーション'));
    const list = el('div', 'chips');
    for (const layer of layers) {
      const on = layer.object.visible;
      const chip = el('button', `chip${on ? ' is-on' : ''}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(on));
      const dot = el('span', 'chip-dot');
      dot.style.background = layer.color;
      chip.append(dot, el('span', null, layer.name), el('span', 'chip-type', typeLabel(layer.type)));
      chip.addEventListener('click', () => {
        const next = !chip.classList.contains('is-on');
        chip.classList.toggle('is-on', next);
        chip.setAttribute('aria-pressed', String(next));
        onLayerToggle && onLayerToggle(layer, next);
      });
      list.append(chip);
    }
    layersBox.append(list);
  }

  function showSelection(entry, { open = true } = {}) {
    selection.innerHTML = '';
    selection.hidden = !entry;
    if (!entry) return;
    const { layer } = entry;
    const top = el('div', 'selection-top');
    const dot = el('span', 'chip-dot');
    dot.style.background = layer.color;
    const name = el('strong', null, entry.label ? `${layer.name}／${entry.label}` : layer.name);
    const close = el('button', 'selection-close', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => onClearSelection && onClearSelection());
    top.append(dot, name, el('span', 'chip-type', typeLabel(layer.type)), close);
    selection.append(top);
    if (entry.note) selection.append(el('p', null, entry.note));
    selection.append(fieldList(Object.entries({ ...layer.metadata, ...(entry.fields || {}) })));
    if (currentItem) {
      const link = shareUrl('viewer.html', { id: currentItem.id, note: entryKey(entry) });
      selection.append(shareRow('この注記のリンクを渡す', link, `${currentItem.title || currentItem.id}：${name.textContent}`));
    }
    if (open) {
      if (!root.classList.contains('is-open')) openedByTapAt = performance.now();
      setOpen(true);
    }
  }

  return { setItem, setSiblings, setLayers, showSelection, setOpen, setTitle: (t) => { title.textContent = t; } };
}
