// 注記一覧：資料情報と注記を表にまとめる（報告書作成に向けた整理用）。CSV保存と印刷ができる
import { loadCatalogData, siteUrl, shareUrl } from './catalog.js';
import { loadAnnotationData, pathLength, surfaceArea } from './annotations.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const TYPE = { Point: '点', Line: '線', Area: '面' };

async function json(path) {
  if (!path) return null;
  const res = await fetch(siteUrl(path), { cache: 'no-cache' });
  return res.ok ? res.json().catch(() => null) : null;
}

// 線は折れ線の長さ、面は境界の一周の長さ（GLB の座標 × metersPerUnit。glTF の単位はメートル）。
// 線が何本かに分かれているものは合計する
// 面の輪郭が複数（上端と下端など）あるときは足さずに、輪郭ごとの長さを並べる
function perimeters(it, scale) {
  const paths = it.paths || [{ points: it.points || [], closed: true }];
  return paths.filter((p) => p.closed !== false).map((p) => pathLength(p.points, true) * scale);
}
function lengthOf(it, type, scale) {
  const paths = it.paths || [{ points: it.points || [], closed: type === 'Area' }];
  return paths.reduce((sum, p) => sum + pathLength(p.points, p.closed === undefined ? type === 'Area' : p.closed), 0) * scale;
}

const catalog = await loadCatalogData({ measure: false });
const only = new URLSearchParams(location.search).get('id');
const items = only ? catalog.items.filter((it) => it.id === only) : catalog.items;
if (only) $('link-all').hidden = false;

const rows = [];       // CSV 用
const metaKeys = new Set();
const list = $('list');
list.innerHTML = '';

for (const item of items) {
  const [meta, anno] = await Promise.all([
    json(item.meta),
    loadAnnotationData(item).catch((err) => ({ layers: [], warnings: [err.message] })),
  ]);
  const scale = item.model.metersPerUnit == null ? 1 : item.model.metersPerUnit;
  const section = el('section', 'notes-item');
  section.append(el('h2', 'notes-title', (meta && meta.title) || item.title || item.id));
  section.append(el('p', 'sub', `資料ID ${item.id}／図面 ${item.drawing.title || item.drawing.id}`));

  const fields = ((meta && meta.fields) || []).filter((f) => String(f.value || '').trim());
  if (fields.length) {
    const dl = el('dl', 'fields light');
    for (const f of fields) dl.append(el('dt', null, f.label), el('dd', null, f.value));
    section.append(dl);
  }
  if (meta && meta.notice) section.append(el('p', 'callout', meta.notice));

  const layers = (anno && anno.layers) || [];
  // Blender から書き出した注記で、表と GLB が食い違っているもの（作る人向けの確認）
  for (const w of (anno && anno.warnings) || []) section.append(el('p', 'callout no-print', w));
  if (!layers.length) {
    section.append(el('p', 'muted', '注記はありません。'));
  } else {
    const table = el('table', 'plain notes-table');
    const head = el('tr');
    for (const h of ['レイヤー', '種類', 'ラベル', '説明', '内容', '長さ・面積', '']) head.append(el('th', null, h));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    for (const layer of layers) {
      Object.keys(layer.metadata || {}).forEach((k) => metaKeys.add(k));
      (layer.items || []).forEach((it, index) => {
        const type = layer.Annotation_Type;
        const len = type === 'Point' || it.solid ? null : lengthOf(it, type, scale);
        const area = it.fill && !it.solid ? surfaceArea(it.fill) * scale * scale : null;
        Object.keys(it.fields || {}).forEach((k) => metaKeys.add(k));
        const tr = el('tr');
        const swatch = el('span', 'chip-dot');
        swatch.style.background = it.color || layer.color || '#d9482b';
        const nameCell = el('td');
        nameCell.append(swatch, document.createTextNode(` ${layer.name}`));
        tr.append(nameCell, el('td', null, TYPE[type] || type), el('td', null, it.label || ''), el('td', null, it.note || ''));
        const md = el('td');
        // レイヤーのメタデータは、そのレイヤーの最初の行にだけ出す。注記ごとの項目（表の列）は毎行出す
        const layerMeta = Object.entries(layer.metadata || {});
        if (index === 0) for (const [k, v] of layerMeta) md.append(el('div', null, `${k}：${v}`));
        else if (layerMeta.length) md.append(el('span', 'muted', '〃'));
        for (const [k, v] of Object.entries(it.fields || {})) md.append(el('div', null, `${k}：${v}`));
        const rims = type === 'Area' && !it.solid ? perimeters(it, scale) : [];
        const lenText = type === 'Area' ? (rims.length ? `${rims.map((v) => v.toFixed(2)).join('・')} m（周）` : '') : (len == null ? '' : `${len.toFixed(2)} m`);
        const measure = [lenText, area == null ? '' : `${area.toFixed(area < 1 ? 4 : 2)} m²`];
        tr.append(md, el('td', 'num', measure.filter(Boolean).join(' / ')));
        const link = el('a', null, '3Dで見る');
        const note = it.key || `${layer.uid}.${index}`;
        link.href = shareUrl('viewer.html', { id: item.id, note });
        const lc = el('td', 'no-print'); lc.append(link); tr.append(lc);
        body.append(tr);
        rows.push({
          資料ID: item.id, 資料名: (meta && meta.title) || item.title || '', 図面: item.drawing.id,
          レイヤー: layer.name, 種類: TYPE[type] || type, レイヤーuid: layer.uid, 番号: index + 1,
          ラベル: it.label || '', 説明: it.note || '', '長さ(m)': type === 'Area' ? rims.map((v) => v.toFixed(3)).join('・') : (len == null ? '' : len.toFixed(3)),
          '面積(m2)': area == null ? '' : area.toFixed(4), オブジェクト名: it.key || '',
          点の数: type === 'Point' ? 1 : (it.paths || [{ points: it.points || [] }]).reduce((s, p) => s + p.points.length, 0),
          X: type === 'Point' ? it.position[0] : '', Y: type === 'Point' ? it.position[1] : '', Z: type === 'Point' ? it.position[2] : '',
          meta: { ...(layer.metadata || {}), ...(it.fields || {}) }, リンク: link.href,
        });
      });
    }
    table.append(body);
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    section.append(wrap);
  }
  list.append(section);
}

const stamp = [catalog.site.edition ? `データ版 ${catalog.site.edition}` : '', catalog.site.cite || ''].filter(Boolean).join('　');
$('foot').textContent = `${stamp}${stamp ? '　' : ''}座標は各3DモデルのGLBの座標です。長さは metersPerUnit をかけたメートル。`;

// CSV（Excel で文字化けしないよう、先頭に印を付ける）
$('btn-csv').addEventListener('click', () => {
  const keys = [...metaKeys];
  const header = ['資料ID', '資料名', '図面', 'レイヤー', '種類', 'レイヤーuid', '番号', 'オブジェクト名', 'ラベル', '説明', ...keys, '長さ(m)', '面積(m2)', '点の数', 'X', 'Y', 'Z', 'リンク'];
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [header.map(cell).join(',')];
  for (const r of rows) lines.push(header.map((h) => cell(keys.includes(h) ? r.meta[h] : r[h])).join(','));
  const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = only ? `notes_${only}.csv` : 'notes.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('btn-print').addEventListener('click', () => window.print());
window.__notes = { rows }; // 確認用
