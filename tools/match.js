// 図形（GLB のオブジェクト名）と遺構一覧表（key 列）の照合
import { loadCatalogData } from '../js/catalog.js';
import { loadAnnotationSources, matchDrawing, normalizeKey } from '../js/annotations.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const TYPE_JA = { Point: '点', Line: '線', Area: '面' };

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// 表に無い図形の名前に近い遺構番号を探す。数字の部分が同じものを先に、次に1〜2文字違いのもの
function suggest(name, rows) {
  const n = normalizeKey(name);
  const digits = (n.match(/\d+/g) || []).join('-');
  const scored = [];
  for (const r of rows) {
    const k = normalizeKey(r.key);
    const sameDigits = digits && (k.match(/\d+/g) || []).join('-') === digits;
    const dist = distance(n, k);
    if (sameDigits || dist <= 2) scored.push([sameDigits ? 0 : 1, dist, r.key]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 3).map((s) => s[2]);
}

function table(head, rows) {
  const t = el('table', 'plain');
  const thead = el('thead'); const tr = el('tr');
  for (const h of head) tr.append(el('th', null, h));
  thead.append(tr); t.append(thead);
  const tbody = el('tbody');
  for (const r of rows) { const row = el('tr'); for (const c of r) row.append(el('td', null, c)); tbody.append(row); }
  t.append(tbody);
  const wrap = el('div', 'table-wrap'); wrap.append(t);
  return wrap;
}

const catalog = await loadCatalogData({ measure: false });
const list = $('list');
list.innerHTML = '';
const targets = catalog.items.filter((it) => it.annotations && typeof it.annotations === 'object');
if (!targets.length) list.append(el('p', 'muted', '注記を使う資料がありません。'));
const report = {};
for (const item of targets) {
  const section = el('section', 'notes-item');
  section.append(el('h2', 'notes-title', item.title || item.id));
  list.append(section);
  try {
    const src = await loadAnnotationSources(item);
    if (!src) {
      section.append(el('p', 'muted', `図形のファイル（${item.annotations.glb}）がないので、注記はありません。`));
      report[item.id] = { none: true };
      continue;
    }
    const { spec, nodes, table: tbl } = src;
    const m = matchDrawing(nodes, tbl);
    const layerTitle = tbl && tbl.roles.layer;
    section.append(el('p', 'sub', `図形 ${spec.glb}／表 ${spec.table || '（なし）'}`));
    if (tbl) {
      section.append(el('p', null,
        `表：${tbl.encoding}・見出しは ${tbl.headerLine} 行目・遺構番号の列「${tbl.keyTitle}」・${tbl.rows.length} 件`
        + `${tbl.roles.layer ? `・まとまりの列「${tbl.roles.layer}」` : ''}${tbl.roles.note ? `・説明の列「${tbl.roles.note}」` : ''}${tbl.roles.label ? `・名前の列「${tbl.roles.label}」` : ''}`));
    }
    section.append(el('p', null, `一致 ${m.matched.length}・表に無い図形 ${m.drawingOnly.length}・この資料に無い表の行 ${m.tableOnly.length}${m.duplicates.length ? `・表の番号の重複 ${m.duplicates.length}` : ''}`));
    if (m.drawingOnly.length) {
      section.append(el('h3', null, '表に無い図形（表示されません）'));
      section.append(el('p', 'muted', '注記でない線（調査区の境界など）なら問題ありません。遺構なら、オブジェクト名か表の遺構番号を直してください。'));
      section.append(table(['オブジェクト名', '種類', 'Blender のオブジェクト', '近い遺構番号'],
        m.drawingOnly.map((u) => [u.name, TYPE_JA[u.type], u.nodes.map((n) => n.name).join(' / '), suggest(u.name, m.tableOnly).join('、') || '—'])));
    }
    if (m.duplicates.length) {
      section.append(el('h3', null, '表の番号の重複（後の行は使いません）'));
      section.append(table(['行', '遺構番号'], m.duplicates.map((r) => [String(r.line), r.key])));
    }
    if (m.matched.length) {
      section.append(el('h3', null, '一致'));
      section.append(table(['遺構番号（表）', '種類', 'Blender のオブジェクト', ...(layerTitle ? [layerTitle] : [])],
        m.matched.map(({ unit, row }) => [row.key, TYPE_JA[unit.type], unit.nodes.map((n) => n.name).join(' / '), ...(layerTitle ? [row.layer] : [])])));
    }
    if (m.tableOnly.length) {
      const details = el('details');
      details.append(el('summary', null, `この資料に無い表の行（${m.tableOnly.length} 件。ほかの資料の遺構なら問題ありません）`));
      details.append(el('p', 'mono', m.tableOnly.map((r) => r.key).join('、')));
      section.append(details);
    }
    report[item.id] = {
      matched: m.matched.map(({ unit, row }) => [row.key, unit.nodes.map((n) => n.name)]),
      drawingOnly: m.drawingOnly.map((u) => [u.name, suggest(u.name, m.tableOnly)]),
      tableOnly: m.tableOnly.length, duplicates: m.duplicates.map((r) => r.key), header: tbl && tbl.headerLine, encoding: tbl && tbl.encoding,
    };
  } catch (err) {
    section.append(el('p', 'callout', `照合できません：${err.message}`));
    report[item.id] = { error: err.message };
  }
}
window.__match = report; // 確認用
