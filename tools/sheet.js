// 展示用シート：図面・QRコード・使い方を1枚にまとめて印刷する（図面1枚につき1ページ）
import { loadCatalogData, siteUrl } from '../js/catalog.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const catalog = await loadCatalogData();
const query = new URLSearchParams(location.search);
$('base-url').value = query.get('base') || siteUrl('');

function render() {
  let base = $('base-url').value.trim();
  if (base && !base.endsWith('/')) base += '/';
  const paper = $('paper').value;
  $('page-size').textContent = `@page { size: ${paper} landscape; margin: 0; }`;
  document.body.dataset.paper = paper;
  const box = $('sheets');
  box.innerHTML = '';
  for (const t of catalog.targets) {
    const page = el('section', 'sheet');
    const head = el('header', 'sheet-head');
    head.append(el('span', 'sheet-site', catalog.site.title || ''), el('h1', null, t.title || t.id));
    page.append(head);

    const fig = el('div', 'sheet-figure');
    const img = el('img');
    img.src = siteUrl(t.source);
    img.alt = t.title || t.id;
    fig.append(img);
    page.append(fig);

    const foot = el('footer', 'sheet-foot');
    const link = `${base}ar.html?t=${encodeURIComponent(t.id)}`;
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    const code = el('div', 'sheet-qr');
    code.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const steps = el('ol', 'sheet-steps');
    ['QRコードを読み、「カメラを起動」を押す', 'この図面が画面いっぱいになるように、スマホをかざす', '重なった3Dモデルをたたくと、資料情報と注記が出る'].forEach((s) => steps.append(el('li', null, s)));
    const info = el('div', 'sheet-info');
    info.append(steps);
    const names = t.items.map((it) => it.title || it.id).join('、');
    if (names) info.append(el('p', 'sheet-items', `この図面の3Dモデル：${names}`));
    info.append(el('p', 'sheet-url', link));
    const stamp = [t.credit ? `図面出典：${t.credit}` : '', catalog.site.edition ? `データ版 ${catalog.site.edition}` : ''].filter(Boolean).join('　');
    if (stamp) info.append(el('p', 'sheet-credit', stamp));
    foot.append(code, info);
    page.append(foot);
    box.append(page);
  }
}
$('base-url').addEventListener('input', render);
$('paper').addEventListener('change', render);
$('btn-print').addEventListener('click', () => window.print());
render();
