// 管理用：認識用データ（all.mind）の作成、資料ごとの位置合わせへの入口、QRコードと展示用シート
import { Compiler } from '../lib/mindar/mindar-image.prod.js';
import { extractDense, makeZoomLevels, toGray, ZOOM_PURPOSE, ZOOM_MAX_POINTS } from '../js/trackpoints.js';
import { loadCatalogData, siteUrl, MIND_FILE } from '../js/catalog.js';
import { loadAnnotationSources, glbBounds, collectUnits, matchDrawing } from '../js/annotations.js';
import { target8Layout, target8Canvas, target8Json } from '../js/target8.js';

const $ = (id) => document.getElementById(id);
const ROOT = new URL('..', import.meta.url);
// 判定の目安（追跡用の手がかりの数）。実機での確認に代わるものではない。
// 実際に各コマで使えるのは、このうち半分弱（ぼけ・暗さ・傾きで減る）。姿勢の計算には6点以上が要る
const GOOD = 45;
const POOR = 20;

const catalog = await loadCatalogData();
const targets = catalog.targets; // この並び順が all.mind の中の順番になる

/* ---------- 0. ファイルの確認 ---------- */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const m = (v) => `${v.toFixed(v < 10 ? 2 : 1)} m`;

// ファイルの有無と大きさ。GLB は先頭（JSON の部分）だけ読めば中身の範囲がわかる
async function probe(path, { glbHead = false } = {}) {
  const headers = glbHead ? { Range: 'bytes=0-1048575' } : {};
  const res = await fetch(siteUrl(path), { cache: 'no-cache', headers }).catch(() => null);
  if (!res || res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} を読み込めません (${res.status})`);
  const buffer = await res.arrayBuffer();
  const range = res.headers.get('Content-Range');
  const total = range ? Number(range.split('/')[1]) : buffer.byteLength;
  if (glbHead && buffer.byteLength >= 20) {
    const json = new DataView(buffer).getUint32(12, true);
    if (20 + json <= buffer.byteLength) return { buffer: buffer.slice(0, 20 + json), total };
    if (buffer.byteLength < total) return probe(path); // JSON が大きいときは丸ごと読む
  }
  return { buffer, total };
}

// 台帳の rotationDeg（three.js と同じ XYZ の順）で回したあとの範囲。+Y が上
function rotatedSize(bounds, deg) {
  const [a, b, c] = (deg || [0, 0, 0]).map((v) => (v * Math.PI) / 180);
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  const R = [
    [cb * cc, -cb * sc, sb],
    [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
    [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
  ];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    for (let k = 0; k < 3; k++) {
      const v = R[k][0] * x + R[k][1] * y + R[k][2] * z;
      lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v);
    }
  }
  return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
}

// 注記の範囲のうち、モデルの範囲（少し広げたもの）に入っている割合。座標がそろっていれば 1 に近い
function insideRatio(inner, outer) {
  let ratio = 1;
  for (let k = 0; k < 3; k++) {
    const pad = (outer.max[k] - outer.min[k]) * 0.1 + 0.05;
    const lo = Math.max(inner.min[k], outer.min[k] - pad), hi = Math.min(inner.max[k], outer.max[k] + pad);
    const len = inner.max[k] - inner.min[k];
    ratio *= len > 1e-6 ? Math.max(0, hi - lo) / len : (hi >= lo ? 1 : 0);
  }
  return ratio;
}

async function checkFiles() {
  const box = $('files');
  const table = el('table', 'plain files-table');
  table.innerHTML = '<thead><tr><th>ファイル</th><th>状態</th><th>内容</th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  let problems = 0;
  const row = (path, state, text, level = 'ok') => {
    const tr = el('tr', `file-${level}`);
    tr.append(el('td', 'mono', path), el('td', 'file-state', state), el('td', null, text));
    tbody.append(tr);
    if (level === 'ng') problems++;
  };
  const guard = async (path, fn) => { try { await fn(); } catch (err) { row(path, '読めない', err.message, 'ng'); } };

  for (const w of catalog.warnings) row('data/items.json', '注意', w, 'warn');

  // 認識データ
  await guard(MIND_FILE, async () => {
    const f = await probe(MIND_FILE);
    if (!f) { row(MIND_FILE, 'ない', '1. で作って置いてください', 'ng'); return; }
    const list = new Compiler().importData(f.buffer);
    const notes = [];
    let level = 'ok';
    if (list.length !== targets.length) { notes.push(`図面${list.length}枚ぶん（台帳は${targets.length}枚）`); level = 'ng'; }
    list.forEach((d, i) => {
      const t = targets[i];
      const { width: w, height: h } = d.targetImage;
      const frame = d.trackingData[Math.min(1, d.trackingData.length - 1)];
      const zoomLv = d.trackingData.filter((k) => k.purpose === ZOOM_PURPOSE);
      let text = `${t ? (t.title || t.id) : `${i + 1}枚目`}：${w}×${h}、追跡用 ${frame.points.length}、近づいたとき用 ${zoomLv.length ? zoomLv.map((k) => Math.min(k.width, k.height)).join('/') : 'なし（AR の画面で図面画像から作る。ここで作り直すと開くのが速い）'}`;
      if (t && Math.abs((h / w) / (t.heightPx / t.widthPx) - 1) > 0.01) { text += `（図面画像 ${t.widthPx}×${t.heightPx} と縦横比が違う。作り直す）`; level = 'ng'; }
      notes.push(text);
    });
    row(MIND_FILE, level === 'ok' ? 'OK' : '合わない', `${kb(f.total)}。${notes.join('／')}`, level);
  });

  // 8th Wall 用の認識データ（図面ごと）
  for (const t of targets) {
    await guard(t.target8, async () => {
      const f = await probe(t.target8);
      if (!f) { row(t.target8, 'ない', `図面「${t.title || t.id}」。1b. で作って置いてください（8th Wall 版 ar.html で使う）`, 'ng'); return; }
      const data = JSON.parse(new TextDecoder().decode(f.buffer));
      const z = (data.metadata && data.metadata.zumen) || null;
      if (!z) { row(t.target8, '合わない', 'この仕組みで作ったデータではありません。1b. で作り直す', 'ng'); return; }
      const img = await probe(t.target8Image);
      let text = `元の図面 ${z.srcWidth}×${z.srcHeight}、白地を足して ${z.padWidth}×${z.padHeight}（4:3）`;
      let level = 'ok';
      if (Math.abs((z.srcHeight / z.srcWidth) / (t.heightPx / t.widthPx) - 1) > 0.01) { text += `。図面画像 ${t.widthPx}×${t.heightPx} と縦横比が違う。作り直す`; level = 'ng'; }
      if (!img) { text += `。${t.target8Image} がない`; level = 'ng'; }
      row(t.target8, level === 'ok' ? 'OK' : '合わない', text, level);
    });
  }

  // 図面画像
  for (const t of targets) {
    await guard(t.source, async () => {
      const f = await probe(t.source, { glbHead: false }).catch(() => null);
      if (!f) { row(t.source, 'ない', `図面「${t.title || t.id}」の画像`, 'ng'); return; }
      const real = t.pxPerMeter ? `、実寸 ${+(t.realWidthM || t.widthPx / t.pxPerMeter).toFixed(4)} × ${+(t.realHeightM || t.heightPx / t.pxPerMeter).toFixed(4)} m（1m = ${Math.round(t.pxPerMeter * 100) / 100} 画素）` : '、実寸（realWidthM・realHeightM）未設定';
      row(t.source, t.pxPerMeter ? 'OK' : '注意', `${t.widthPx}×${t.heightPx} 画素、${kb(f.total)}${real}`, t.pxPerMeter ? 'ok' : 'warn');
    });
  }

  // 資料ごとのファイル
  for (const item of catalog.items) {
    let modelBounds = null;
    await guard(item.model.src, async () => {
      const f = await probe(item.model.src, { glbHead: true });
      if (!f) { row(item.model.src, 'ない', `資料「${item.title || item.id}」の3Dモデル`, 'ng'); return; }
      modelBounds = glbBounds(f.buffer, item.model.src);
      const scale = item.model.metersPerUnit == null ? 1 : item.model.metersPerUnit;
      const s = rotatedSize(modelBounds, item.model.rotationDeg);
      let text = `${kb(f.total)}。東西 ${m(s.x * scale)} × 南北 ${m(s.z * scale)}、高さ ${m(s.y * scale)}（rotationDeg ${JSON.stringify(item.model.rotationDeg || [0, 0, 0])} で回したあと）`;
      let level = 'ok';
      if ((item.display || {}).mode === 'plan' && s.y > 0.8 * Math.max(s.x, s.z)) {
        text += '。⚠ 遺構なのに高さが大きい：上の向き（rotationDeg）が違う疑い。2. の位置合わせで「モデルの上の向き」を切り替える';
        level = 'warn';
      }
      if (f.total > 25 * 1048576) { text += '。⚠ スマホには重い（テクスチャを JPEG にする・縮める）'; level = 'warn'; }
      row(item.model.src, level === 'ok' ? 'OK' : '注意', text, level);
    });

    const spec = item.annotations;
    if (spec && typeof spec === 'object') {
      await guard(spec.glb, async () => {
        const f = await probe(spec.glb);
        if (!f) { row(spec.glb, 'なし', '注記を表示しません', spec.optional ? 'none' : 'ng'); return; }
        const src = await loadAnnotationSources(item, { tableRequired: false });
        const units = collectUnits(src.nodes);
        const count = { Point: 0, Line: 0, Area: 0 };
        for (const u of units) count[u.type]++;
        let text = `${kb(f.total)}。図形 ${units.length}（点 ${count.Point}・線 ${count.Line}・面 ${count.Area}）`;
        let level = 'ok';
        const b = glbBounds(f.buffer, spec.glb);
        if (b && modelBounds) {
          const r = insideRatio(b, modelBounds);
          if (r < 0.5) {
            // 「+Y上」の設定がモデルと逆なら、Y と Z を入れ替えると範囲に入る
            const swap = (f) => {
              const pts = [];
              for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) pts.push(f(x, y, z));
              return { min: [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), max: [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]))) };
            };
            const flipped = Math.max(insideRatio(swap((x, y, z) => [x, -z, y]), modelBounds), insideRatio(swap((x, y, z) => [x, z, -y]), modelBounds));
            text += flipped >= 0.5
              ? '。⚠ 図形がモデルの範囲から外れています。書き出しの「+Y上」の設定がモデルと逆のようです（モデルと同じにして書き出し直す）'
              : '。⚠ 図形がモデルの範囲から外れています。モデルと同じ座標で作ったか（Blender の中でモデルを動かしていないか）確かめる';
            level = 'warn';
          }
        }
        row(spec.glb, level === 'ok' ? 'OK' : '注意', text, level);

        if (!spec.table) return;
        if (!src.table) { row(spec.table, 'ない', '図形をオブジェクト名だけで表示します（遺構一覧表を置くと文字が付きます）', 'warn'); return; }
        const t = src.table;
        const res = matchDrawing(src.nodes, t);
        const roles = Object.entries({ 種別: t.roles.layer, 説明: t.roles.note, 名前: t.roles.label })
          .filter(([, v]) => v).map(([k, v]) => `${k}＝「${v}」`).join('、');
        let tText = `${t.encoding}、${t.headerLine}行目が見出し、遺構番号＝「${t.keyTitle}」${roles ? `、${roles}` : ''}。${t.rows.length}行、図形と対応 ${res.matched.length}`;
        let tLevel = 'ok';
        if (res.drawingOnly.length) { tText += `。表に無い図形 ${res.drawingOnly.length}（表示しない）：${res.drawingOnly.slice(0, 8).map((u) => u.name).join('、')}${res.drawingOnly.length > 8 ? '…' : ''}`; tLevel = 'warn'; }
        if (res.duplicates.length) { tText += `。番号の重複 ${res.duplicates.length}`; tLevel = 'warn'; }
        row(spec.table, tLevel === 'ok' ? 'OK' : '注意', tText, tLevel);
      });
    }

    if (item.meta) {
      await guard(item.meta, async () => {
        const f = await probe(item.meta);
        if (!f) { row(item.meta, 'なし', '資料情報を出しません（無くてもよい）', 'none'); return; }
        const meta = JSON.parse(new TextDecoder().decode(f.buffer));
        const n = (meta.fields || []).filter((x) => String(x.value || '').trim()).length;
        row(item.meta, 'OK', `題名「${meta.title || ''}」、項目 ${n}`);
      });
    }
  }

  box.innerHTML = '';
  box.append(el('p', problems ? 'callout' : 'muted', problems ? `直すところが ${problems} か所あります。` : 'そろっています。'));
  box.append(table);
  window.__files = { problems, rows: [...tbody.rows].map((r) => [...r.cells].map((c) => c.textContent)) }; // 確認用
}
checkFiles().catch((err) => { $('files').innerHTML = ''; $('files').append(el('p', 'callout', err.message)); });

/* ---------- 1. 認識用データ ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${src} を読み込めません`));
    img.src = new URL(src, ROOT).href;
  });
}

async function compile() {
  const status = $('compile-status');
  const btn = $('btn-compile');
  btn.disabled = true;
  $('link-download').hidden = true;
  try {
    status.textContent = '図面画像を読み込み中…';
    const images = await Promise.all(targets.map((t) => loadImage(t.source)));
    const compiler = new Compiler();
    const data = await compiler.compileImageTargets(images, (p) => { status.textContent = `作成中… ${Math.round(p)}%`; });
    // 追跡用の手がかりを、間隔を詰めて選び直す（?dense=0 で標準のまま）
    const dense = new URLSearchParams(location.search).get('dense') !== '0';
    const standardCounts = data.map((d) => d.trackingData[Math.min(1, d.trackingData.length - 1)].points.length);
    if (dense) {
      for (const d of data) {
        const frame = d.trackingData[Math.min(1, d.trackingData.length - 1)];
        const points = extractDense(frame, { maxPoints: ZOOM_MAX_POINTS });
        if (points.length > frame.points.length) frame.points = points;
      }
    }
    // 近づいて図面の一部を見るときのための、細かい見本を足す（?zoom=0 で足さない）
    const zoom = new URLSearchParams(location.search).get('zoom') !== '0';
    if (zoom) {
      for (let i = 0; i < data.length; i++) {
        status.textContent = `近づいて見るための見本を作成中…（${i + 1}/${data.length}）`;
        await new Promise((r) => setTimeout(r, 30)); // 表示を更新させる
        const img = images[i];
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const gray = toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        data[i].trackingData = data[i].trackingData.filter((k) => !k.purpose).concat(makeZoomLevels(gray, canvas.width, canvas.height));
      }
    }
    const buffer = await compiler.exportData();

    const tbody = $('compile-table').querySelector('tbody');
    tbody.innerHTML = '';
    data.forEach((d, i) => {
      // 検出用：図面を見つけるときの手がかり（いちばん細かい段階の数）
      const finest = d.matchingData.reduce((a, b) => (b.width > a.width ? b : a));
      const detect = finest.maximaPoints.length + finest.minimaPoints.length;
      // 追跡用：見つけたあと追い続けるときの手がかり（MindARが実際に使う段階の数）
      const track = d.trackingData[Math.min(1, d.trackingData.length - 1)].points.length;
      const verdict = track >= GOOD ? '十分' : track >= POOR ? 'やや少ない' : '少ない（枠・写真・文字を含めて作り直す）';
      const zoomInfo = d.trackingData.filter((k) => k.purpose === ZOOM_PURPOSE).map((k) => `${Math.min(k.width, k.height)}:${k.points.length}`).join(' / ') || 'なし';
      const size = `${images[i].naturalWidth}×${images[i].naturalHeight}`;
      const tr = document.createElement('tr');
      [[String(i), 'num'], [targets[i].id], [size], [String(detect), 'num'], [dense ? `${track}（標準 ${standardCounts[i]}）` : String(track), 'num'], [verdict], [zoomInfo]].forEach(([text, cls]) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.append(td);
      });
      tbody.append(tr);
    });
    $('compile-table').hidden = false;

    const link = $('link-download');
    link.href = URL.createObjectURL(new Blob([buffer]));
    link.download = 'all.mind';
    link.hidden = false;
    status.textContent = `完了（図面${targets.length}枚、${(buffer.byteLength / 1024).toFixed(0)} KB）`;
    window.__compiled = { buffer, data }; // 確認用
  } catch (err) {
    console.error(err);
    status.textContent = `失敗：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
$('btn-compile').addEventListener('click', compile);

/* ---------- 1b. 8th Wall 用の認識データ ---------- */

async function compile8() {
  const btn = $('btn-compile8');
  const status = $('compile8-status');
  const box = $('compile8-links');
  btn.disabled = true;
  box.innerHTML = '';
  status.textContent = '作成中…';
  try {
    const made = [];
    for (const t of targets) {
      const img = await loadImage(t.source);
      const layout = target8Layout(img.naturalWidth, img.naturalHeight);
      const canvas = target8Canvas(img, layout);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const json = target8Json(`zumen-${t.id}`, layout);
      const jsonBlob = new Blob([`${JSON.stringify(json, null, 2)}\n`], { type: 'application/json' });
      const p = el('p');
      p.append(el('span', null, `図面「${t.title || t.id}」→ ${t.folder} に置く：`));
      for (const [b, name] of [[jsonBlob, 'target8.json'], [blob, 'target8.jpg']]) {
        const a = el('a', 'btn', `${name} を保存`);
        a.href = URL.createObjectURL(b);
        a.download = name;
        p.append(' ', a);
      }
      const preview = el('img', 'target8-preview');
      preview.src = canvas.toDataURL('image/jpeg', 0.8);
      preview.alt = `${t.title || t.id} の 8th Wall 用画像`;
      p.append(el('br'), preview);
      box.append(p);
      made.push({ id: t.id, layout, json, jpg: canvas.toDataURL('image/jpeg', 0.92) });
    }
    status.textContent = `完了（図面${targets.length}枚）。それぞれの図面のフォルダに、2つのファイルを同じ名前で置いてください。`;
    window.__compiled8 = made; // 確認用
  } catch (err) {
    console.error(err);
    status.textContent = `失敗：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
$('btn-compile8').addEventListener('click', compile8);

/* ---------- 2. 位置合わせ ---------- */

{
  const tbody = $('align-table').querySelector('tbody');
  for (const it of catalog.items) {
    const tr = document.createElement('tr');
    const d = it.display || {};
    const cells = [it.drawing.title || it.drawing.id, it.title || it.id, d.mode || 'stand', Array.isArray(d.at) ? `${d.at.map((v) => Math.round(v)).join(', ')}` : '未設定'];
    for (const text of cells) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
    const td = document.createElement('td');
    const a = document.createElement('a');
    a.href = `align.html?id=${encodeURIComponent(it.id)}`;
    a.textContent = '位置合わせ';
    td.append(a);
    tr.append(td);
    tbody.append(tr);
  }
}

/* ---------- 3. QRコードと展示用シート ---------- */

function baseUrl() {
  let base = $('base-url').value.trim();
  if (base && !base.endsWith('/')) base += '/';
  return base;
}

function renderQr() {
  const grid = $('qr-grid');
  grid.innerHTML = '';
  const base = baseUrl();
  $('link-sheet').href = `sheet.html?base=${encodeURIComponent(base)}`;
  if (!base) return;
  for (const t of targets) {
    const target = `${base}ar.html?t=${encodeURIComponent(t.id)}`;
    const qr = window.qrcode(0, 'M');
    qr.addData(target);
    qr.make();
    const box = document.createElement('div');
    box.className = 'qr';
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = t.title || t.id;
    p.append(strong, document.createTextNode(target));
    box.append(p);
    grid.append(box);
  }
}
$('base-url').value = ROOT.href;
$('base-url').addEventListener('input', renderQr);
renderQr();
