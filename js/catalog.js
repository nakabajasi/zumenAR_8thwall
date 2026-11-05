// 台帳（data/items.json）の読み込みと整理。three.js を使わないページ（一覧・管理用）からも使う
//
// ファイルの置き場所と名前は決まっている。差し替えるときは、data/ の中のファイルを同じ名前のまま上書きする
//   data/items.json       台帳（題名と、図面とモデルの重ね方の数値）
//   data/all.mind         認識データ（図面すべてぶんを1つに。MindAR 版 ar-mindar.html で使う）
//   data/target8.json     8th Wall 用の認識データ（図面ごと。ar.html で使う）
//   data/target8.jpg      　〃　（白黒 480×640 の図面）
//   data/image.jpg        図面画像
//   data/model.glb        3Dモデル
//   data/annotation.glb   注記の図形（無ければ注記なし）
//   data/annotation.csv   注記の表（遺構一覧表）
//   data/meta.json        資料情報（無くてもよい）
// 図面や資料を2つ以上にするときは、data/<id>/ に分けて同じ名前で置く（1つしかないものは data/ にそのまま）。
// 置き場所は "folder" で変えられる。
//
// 図面の実寸（targets の realWidthM・realHeightM、m）を書けば、3Dモデルは自分の座標のまま図面に重なる。
// モデルの座標は、図面画像の左下を原点、右を X、上を Y とした m 単位（Blender で図面画像を実寸で原点から敷き、
// その上にモデルを合わせて書き出したもの）。このとき資料の display.at・headingDeg は書かない
//
// 台帳の形：
//   targets … 図面（認識の対象）。並び順が all.mind の中の順番になる
//   items   … 資料（3Dモデル1つ）。target に図面の id を書く（図面が1枚なら省略）
//   id は省略すると並び順の番号（1, 2, …）。URL（?id=、?t=）とフォルダ名に使う
// 旧形式（資料ごとに target の中身と targetIndex を書く形）や、ファイルの場所を直接書いた台帳も読める
const ROOT = new URL('..', import.meta.url);
export const siteUrl = (path) => new URL(path, ROOT).href;

export const MIND_FILE = 'data/all.mind';
export const FILE_NAMES = {
  image: 'image.jpg',
  model: 'model.glb',
  annotation: 'annotation.glb',
  table: 'annotation.csv',
  meta: 'meta.json',
  target8: 'target8.json',      // 8th Wall 用の認識データ（図面ごと。tools/ の「1b」で作る）
  target8Image: 'target8.jpg',
};

// 1つしかないなら data/、2つ以上なら data/<id>/
function folderOf(entry, list) {
  let f = entry.folder || (list.length === 1 ? 'data/' : `data/${entry.id}/`);
  if (!f.endsWith('/')) f += '/';
  return f;
}

export function normalizeCatalog(raw) {
  const c = JSON.parse(JSON.stringify(raw));
  c.site = c.site || {};
  c.warnings = [];
  c.items = c.items || [];
  if (!Array.isArray(c.targets)) {
    const legacy = c.items.slice().sort((a, b) => a.targetIndex - b.targetIndex);
    c.targets = legacy.map((it) => ({ id: it.id, title: it.title, ...it.target }));
    for (const it of c.items) it.target = it.id;
  }
  const byId = new Map();
  c.targets.forEach((t, i) => {
    t.id = t.id == null ? String(i + 1) : String(t.id);
    if (byId.has(t.id)) throw new Error(`図面の id「${t.id}」が重複しています`);
    t.index = i;
    t.items = [];
    t.folder = folderOf(t, c.targets);
    t.source = t.source || t.folder + FILE_NAMES.image;
    t.target8 = t.target8 || t.folder + FILE_NAMES.target8;
    t.target8Image = t.target8Image || t.folder + FILE_NAMES.target8Image;
    // 3Dだけ見る画面で、図面を敷いてモデルを重ねる（"viewerImage": false で敷かない）
    t.viewerImage = t.viewerImage === false ? null : (t.viewerImage || t.source);
    byId.set(t.id, t);
  });
  const ids = new Set();
  c.items.forEach((it, i) => {
    it.id = it.id == null ? String(i + 1) : String(it.id);
    if (ids.has(it.id)) throw new Error(`資料の id「${it.id}」が重複しています`);
    ids.add(it.id);
    if (it.target == null) {
      if (c.targets.length !== 1) throw new Error(`資料「${it.title || it.id}」の target（図面の id）を書いてください`);
      it.target = c.targets[0].id;
    }
    const t = byId.get(String(it.target));
    if (!t) throw new Error(`資料「${it.title || it.id}」の図面「${it.target}」が targets にありません`);
    it.index = i;
    it.drawing = t;
    it.targetIndex = t.index;
    t.items.push(it);

    it.folder = folderOf(it, c.items);
    it.model = { ...(it.model || {}) };
    it.model.src = it.model.src || it.folder + FILE_NAMES.model;
    // 注記：書かなければ決まった名前のファイルを探し、無ければ注記なし。false で使わない
    if (it.annotations === false) it.annotations = null;
    else if (typeof it.annotations !== 'string') {
      const spec = { ...(it.annotations || {}) };
      if (!spec.glb) { spec.glb = it.folder + FILE_NAMES.annotation; spec.optional = true; }
      if (spec.table === undefined) spec.table = it.folder + FILE_NAMES.table;
      it.annotations = spec;
    }
    if (it.meta === false) it.meta = null;
    else if (!it.meta) { it.meta = it.folder + FILE_NAMES.meta; it.metaOptional = true; }
  });
  return c;
}

/* ---------- 図面画像の大きさ ---------- */
// 図面の画素数は画像そのものから読む（台帳の数字が古くても、画像を差し替えればそのまま合う）。
// 台帳の widthPx・heightPx は「display.at と pxPerMeter を測ったときの画像の大きさ」。
// 同じ図面を別の解像度で書き出し直した場合は、その比で at と pxPerMeter を直して使う。

// 画像の先頭だけを取って大きさを読む（AR の画面で図面画像を丸ごと読まずに済むように）
function sizeFromBytes(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { // PNG
    const v = new DataView(b.buffer, b.byteOffset);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null; // JPEG でない
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0〜SOF15（DHT・JPG・DAC を除く）に画像の大きさがある
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

async function imageSize(path) {
  const href = siteUrl(path);
  try {
    const res = await fetch(href, { headers: { Range: 'bytes=0-262143' }, cache: 'no-cache' });
    if (res.ok) {
      const size = sizeFromBytes(new Uint8Array(await res.arrayBuffer()));
      if (size && size.width && size.height) return size;
    }
  } catch (err) { /* 下の方法で読む */ }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`図面画像 ${path} を読み込めません`));
    img.src = href;
  });
}

// 図面画像の実寸（m）から、画像の 1m が何画素かを決める。縦と横の両方が書いてあれば、食い違いがないか確かめる
function applyRealSize(c, t) {
  const w = Number(t.realWidthM), h = Number(t.realHeightM);
  if (!(w > 0) && !(h > 0)) return;
  const fromW = w > 0 ? t.widthPx / w : null, fromH = h > 0 ? t.heightPx / h : null;
  t.pxPerMeter = fromW || fromH;
  if (fromW && fromH && Math.abs(fromW / fromH - 1) > 0.005) {
    c.warnings.push(`図面「${t.title || t.id}」の実寸 ${w}×${h} m は、画像の縦横比（${t.widthPx}×${t.heightPx} 画素）と合いません（横から 1m＝${fromW.toFixed(2)} 画素、縦から ${fromH.toFixed(2)} 画素）。横の値で表示します`);
  }
}

async function measureTargets(c) {
  await Promise.all(c.targets.map(async (t) => {
    let size;
    try {
      size = await imageSize(t.source);
    } catch (err) {
      // 図面画像を公開しない運用（台帳に大きさだけ書く）もできる。差し替え忘れは tools/ の「ファイルの確認」で出る
      if (t.widthPx && t.heightPx) { console.warn(`${err.message}（台帳の大きさ ${t.widthPx}×${t.heightPx} で続けます）`); applyRealSize(c, t); return; }
      throw err;
    }
    const refW = t.widthPx, refH = t.heightPx;
    t.widthPx = size.width;
    t.heightPx = size.height;
    applyRealSize(c, t);
    if (!refW || !refH || (refW === size.width && refH === size.height)) return;
    const s = size.width / refW;
    const aspectGap = Math.abs((size.height / size.width) / (refH / refW) - 1);
    if (aspectGap > 0.005) {
      c.warnings.push(`図面「${t.title || t.id}」の画像の縦横比が、位置合わせをしたときの画像（${refW}×${refH}）と違います。図面の範囲が変わったようなので、位置合わせツールで合わせ直してください`);
    } else {
      console.info(`図面「${t.id}」の画像が ${refW}×${refH} から ${size.width}×${size.height} に変わったので、位置と縮尺を ${s.toFixed(4)} 倍して使います`);
    }
    if (t.pxPerMeter && !t.realWidthM && !t.realHeightM) t.pxPerMeter *= s;   // 実寸で書いてあれば、画素数が変わっても直す必要はない
    for (const it of t.items) {
      if (it.display && Array.isArray(it.display.at)) it.display.at = it.display.at.map((v) => v * s);
      if (it.display && it.display.size && it.display.size.pxPerMeter) it.display.size.pxPerMeter *= s;
    }
  }));
  if (c.warnings.length) console.warn(c.warnings.join('\n'));
}

let pending = null;
export function loadCatalogRaw() {
  if (!pending) {
    pending = fetch(siteUrl('data/items.json'), { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`data/items.json を読み込めません (${res.status})`);
      return res.json();
    });
  }
  return pending;
}

// measure: false なら図面画像の大きさを読まない（大きさを使わないページ用）
export async function loadCatalogData({ measure = true } = {}) {
  const c = normalizeCatalog(await loadCatalogRaw());
  if (measure) await measureTargets(c);
  return c;
}

// 決まった名前のファイル（無くてもよいもの）を読む。無ければ null
export async function fetchOptional(path, as = 'json') {
  const res = await fetch(siteUrl(path), { cache: 'no-cache' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} を読み込めません (${res.status})`);
  return as === 'json' ? res.json() : res.arrayBuffer();
}

// 共有用の URL（注記まで指定できる）。note は遺構番号（表の key 列の値）
export function shareUrl(page, { id, note, target } = {}) {
  const u = new URL(page, ROOT);
  if (id) u.searchParams.set('id', id);
  if (target) u.searchParams.set('t', target);
  if (note) u.searchParams.set('note', note);
  return u.href;
}
