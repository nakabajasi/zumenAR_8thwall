// 位置合わせ：3Dモデルを図面のどこに・どの向きで・どの縮尺で重ねるかを、図面を見ながら決める。
// 表示は AR と同じ計算（common.js の placePosition / buildPose）で行うので、ここで合わせた通りに AR でも重なる
import * as THREE from 'three';
import {
  url, loadCatalog, loadItemObject, buildPose, placePosition, drawingPoint, drawingPixel, displayMode, placedByCoordinates,
} from '../js/common.js';
import { loadCatalogRaw } from '../js/catalog.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

const raw = await loadCatalogRaw();          // 保存用（書いたままの形）
const catalog = await loadCatalog();
const query = new URLSearchParams(location.search);
const item = catalog.items.find((it) => it.id === query.get('id')) || catalog.items[0];
if (!item) throw new Error('台帳に資料がありません');
const drawing = item.drawing;

for (const it of catalog.items) {
  const o = document.createElement('option');
  o.value = it.id;
  o.textContent = `${it.drawing.title || it.drawing.id}／${it.title || it.id}`;
  o.selected = it === item;
  $('item-select').append(o);
}
$('item-select').addEventListener('change', (e) => { location.search = `?id=${encodeURIComponent(e.target.value)}`; });

// 編集中の値。保存するまで台帳には書かない
const d = JSON.parse(JSON.stringify(item.display || {}));
d.mode = d.mode || 'stand';
if (!Array.isArray(d.at)) {
  const [u, v] = d.anchor || [0.5, 0.5];
  d.at = [u * drawing.widthPx, v * drawing.heightPx];
  delete d.anchor;
}
let ppm = drawing.pxPerMeter || 0;
const ppm0 = ppm;   // 台帳に書いてあった縮尺（実寸から求めたもの）。変えなければ、実寸は書いてあった値のまま保存する
// 図面の実寸があって置き場所を書いていない資料は、モデルの座標のまま重ねる（位置を動かすまで）
let followCoords = placedByCoordinates(item);
const editing = () => ({ ...item, display: d, drawing: { ...drawing, pxPerMeter: ppm } });

/* ---------- 描画 ---------- */

const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xddd8cc);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100);
camera.position.set(0, 0, 10);
const aspect = drawing.heightPx / drawing.widthPx;
const cam = { x: 0, y: 0, height: aspect * 1.05 };   // 見ている範囲（図面の座標）

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  const halfH = cam.height / 2, halfW = halfH * (w / h);
  Object.assign(camera, { left: cam.x - halfW, right: cam.x + halfW, top: cam.y + halfH, bottom: cam.y - halfH });
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// 図面（モデルを隠さないよう、いちばん先に、奥行きを持たせずに描く）
const texture = await new THREE.TextureLoader().loadAsync(url(drawing.source));
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
const paper = new THREE.Mesh(new THREE.PlaneGeometry(1, aspect), new THREE.MeshBasicMaterial({ map: texture, depthWrite: false, depthTest: false }));
paper.renderOrder = -2;
scene.add(paper);

// 置き場所の印（十字）と、モデルの北の向き（線）
const markMat = new THREE.LineBasicMaterial({ color: 0xc2412a, depthTest: false });
const mark = new THREE.Group();
mark.renderOrder = 10;
const cross = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)]), markMat);
const north = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 3, 0)]), markMat);
mark.add(cross, north);
scene.add(mark);

// 縮尺バーを測った線
const measureLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x1e64c8, depthTest: false }));
measureLine.renderOrder = 11;
scene.add(measureLine);

const place = new THREE.Group();
scene.add(place);
const lights = new THREE.HemisphereLight(0xffffff, 0x8a8478, 2);
scene.add(lights);

function render() { resize(); renderer.render(scene, camera); }

function setOpacity(object, alpha) {
  object.traverse((o) => {
    if (!o.isMesh) return;
    o.material.transparent = alpha < 1;
    o.material.opacity = alpha;
    o.material.depthWrite = alpha >= 1;
    o.material.needsUpdate = true;
  });
}

status('モデルを読み込み中…');
let rotationDeg = (item.model.rotationDeg || [0, 0, 0]).slice();
let model = await loadItemObject(item);
let pose = null;
const mpu = () => (item.model.metersPerUnit == null ? 1 : item.model.metersPerUnit);
// モデルの座標から決まる置き場所（図面画像の画素）。縮尺を変えれば変わる
const coordAt = () => [model.center.x * mpu() * ppm, drawing.heightPx + model.center.z * mpu() * ppm];
const manual = () => { followCoords = false; };

// 同じ図面のほかの資料も薄く出す（並びの確認用）
for (const other of drawing.items) {
  if (other === item) continue;
  loadItemObject(other).then((m) => {
    const g = new THREE.Group();
    g.position.copy(placePosition(other));
    g.add(buildPose(other, m));
    setOpacity(g, 0.35);
    g.renderOrder = -1;
    scene.add(g);
    render();
  }).catch(() => {});
}

/* ---------- 値の反映 ---------- */

const fields = {
  x: $('at-x'), y: $('at-y'), heading: $('heading'), headingRange: $('heading-range'), realW: $('real-w'), realH: $('real-h'),
  groundKind: $('ground-kind'), groundValue: $('ground-value'), fit: $('fit'), mode: $('mode'),
};
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const heightM = () => model.size.y * (item.model.metersPerUnit == null ? 1 : item.model.metersPerUnit);

function apply({ fromInputs = false } = {}) {
  if (followCoords && ppm) { d.at = coordAt(); d.headingDeg = 0; }
  $('coord-note').hidden = !followCoords;
  const it = editing();
  const mode = displayMode(it);
  document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(mode); });

  if (pose) place.remove(pose);
  place.position.copy(placePosition(it));
  pose = buildPose(it, model);
  place.add(pose);
  setOpacity(pose, Number($('opacity').value));

  mark.position.copy(place.position);
  mark.rotation.z = -THREE.MathUtils.degToRad(d.headingDeg || 0);
  mark.scale.setScalar(cam.height / 60);
  north.visible = mode !== 'lay';

  if (!fromInputs) {
    fields.x.value = round(d.at[0]); fields.y.value = round(d.at[1]);
    fields.heading.value = round(d.headingDeg || 0, 1); fields.headingRange.value = d.headingDeg || 0;
    fields.realW.value = ppm ? round(drawing.widthPx / ppm, 4) : '';
    fields.realH.value = ppm ? round(drawing.heightPx / ppm, 4) : '';
    if (ppm && Math.abs(ppm - ppm0) < 1e-9) {   // 台帳の実寸のまま（縦横の書き方を崩さない）
      if (drawing.realWidthM) fields.realW.value = drawing.realWidthM;
      if (drawing.realHeightM) fields.realH.value = drawing.realHeightM;
    }
    fields.mode.value = mode;
    const g = d.ground;
    fields.groundKind.value = typeof g === 'number' ? 'value' : g === 'bottom' ? 'bottom' : 'top';
    fields.groundValue.value = typeof g === 'number' ? g : round(heightM(), 2);
    fields.fit.value = d.size && d.size.type === 'fit' ? d.size.value : 0.35;
  }
  $('ground-value-wrap').hidden = fields.groundKind.value !== 'value';

  // 結果
  $('ppm-note').textContent = ppm ? `図面画像 ${drawing.widthPx}×${drawing.heightPx} 画素、1m ＝ ${round(ppm, 3)} 画素` : '実寸を入れてください';
  const out = { display: cleanDisplay(), model: { rotationDeg }, drawing: { id: drawing.id, ...realSize() } };
  $('out').value = JSON.stringify(out, null, 2);
  const m = item.model.metersPerUnit == null ? 1 : item.model.metersPerUnit;
  const s = model.size;
  $('size-note').textContent = `モデルの大きさ ${round(s.x * m)} × ${round(s.z * m)} m、高さ ${round(s.y * m)} m`
    + (mode === 'plan' && ppm ? `／図面上で約 ${Math.round(Math.max(s.x, s.z) * m * ppm)} 画素` : '');
  render();
}

// モデルの上の向き（台帳の model.rotationDeg）。変えたらモデルを読み直す
const upSelect = $('up-axis');
function showUp() {
  const v = rotationDeg.join(',');
  const known = [...upSelect.options].some((o) => o.value === v);
  upSelect.querySelector('option[value="custom"]').hidden = known;
  upSelect.value = known ? v : 'custom';
  // 平面図に重ねるモデル（遺構）は、ふつう高さより広がりが大きい。高さのほうが大きければ向きが違う疑いがある
  const s = model.unitSize;
  const tall = displayMode(editing()) === 'plan' && s.y > 0.8 * Math.max(s.x, s.z);
  $('up-note').textContent = tall
    ? '⚠ モデルが立っているように見えます。上の向きを切り替えてみてください。'
    : 'Blender の書き出しで「+Y上」を外したモデルは「+Z が上」です。注記の annotation.glb もモデルと同じ設定で書き出します。';
}
upSelect.addEventListener('change', async () => {
  if (upSelect.value === 'custom') return;
  rotationDeg = upSelect.value.split(',').map(Number);
  status('モデルを読み直しています…');
  model = await loadItemObject({ ...item, display: { ...(item.display || {}) }, model: { ...item.model, rotationDeg } });
  status(`${drawing.title || drawing.id}（${drawing.widthPx}×${drawing.heightPx} 画素）`);
  apply();
  showUp();
});

// 保存する実寸。縮尺を変えていなければ、台帳に書いてあった値のまま
function realSize() {
  if (!ppm) return {};
  if (Math.abs(ppm - ppm0) < 1e-9 && (drawing.realWidthM || drawing.realHeightM)) {
    const keep = {};
    if (drawing.realWidthM) keep.realWidthM = drawing.realWidthM;
    if (drawing.realHeightM) keep.realHeightM = drawing.realHeightM;
    return keep;
  }
  return { realWidthM: round(drawing.widthPx / ppm, 4), realHeightM: round(drawing.heightPx / ppm, 4) };
}

function cleanDisplay() {
  const out = { mode: d.mode };
  if (followCoords && d.mode === 'plan') {
    // モデルの座標のまま：置き場所と方位は書かない（図面の実寸とモデルの座標から決まる）
    out.ground = d.ground == null ? 'top' : d.ground;
    if (d.size && d.size.type === 'drawing' && d.size.pxPerMeter) out.size = d.size;
    return out;
  }
  out.at = [round(d.at[0]), round(d.at[1])];
  if (d.mode !== 'lay') out.headingDeg = round(d.headingDeg || 0, 1);
  if (d.mode === 'plan') out.ground = d.ground == null ? 'top' : d.ground;
  if (d.mode !== 'plan') out.size = { type: 'fit', value: Number(fields.fit.value) || 0.35 };
  else if (d.size && d.size.type === 'drawing' && d.size.pxPerMeter) out.size = d.size; // 資料だけ縮尺を変える場合
  return out;
}

fields.mode.addEventListener('change', () => { d.mode = fields.mode.value; if (d.mode !== 'plan') delete d.ground; apply(); });
fields.x.addEventListener('input', () => { manual(); d.at[0] = Number(fields.x.value); apply({ fromInputs: true }); });
fields.y.addEventListener('input', () => { manual(); d.at[1] = Number(fields.y.value); apply({ fromInputs: true }); });
fields.heading.addEventListener('input', () => { manual(); d.headingDeg = Number(fields.heading.value); fields.headingRange.value = d.headingDeg; apply({ fromInputs: true }); });
fields.headingRange.addEventListener('input', () => { manual(); d.headingDeg = Number(fields.headingRange.value); fields.heading.value = d.headingDeg; apply({ fromInputs: true }); });
// 実寸：横を変えれば縦も同じ縮尺で決まる（図面画像の縦横比のまま）
fields.realW.addEventListener('input', () => {
  const w = Number(fields.realW.value);
  if (w > 0) { ppm = drawing.widthPx / w; fields.realH.value = round(drawing.heightPx / ppm, 4); }
  apply({ fromInputs: true });
});
fields.realH.addEventListener('input', () => {
  const h = Number(fields.realH.value);
  if (h > 0) { ppm = drawing.heightPx / h; fields.realW.value = round(drawing.widthPx / ppm, 4); }
  apply({ fromInputs: true });
});
fields.groundKind.addEventListener('change', () => {
  const k = fields.groundKind.value;
  d.ground = k === 'value' ? Number(fields.groundValue.value) || 0 : k;
  apply({ fromInputs: true });
});
fields.groundValue.addEventListener('input', () => { d.ground = Number(fields.groundValue.value) || 0; apply({ fromInputs: true }); });
fields.fit.addEventListener('input', () => { d.size = { type: 'fit', value: Number(fields.fit.value) || 0.35 }; apply({ fromInputs: true }); });
$('opacity').addEventListener('input', () => apply({ fromInputs: true }));

/* ---------- 画面の操作 ---------- */

function toDrawing(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0).unproject(camera);
  return new THREE.Vector2(v.x, v.y);
}
const raycaster = new THREE.Raycaster();
function onModel(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.intersectObject(pose, true).length > 0;
}

let drag = null;
let measuring = null;    // 縮尺バーを測っている途中（1点目）
view.addEventListener('pointerdown', (e) => {
  view.focus();
  view.setPointerCapture(e.pointerId);
  const p = toDrawing(e);
  if (measuring) {
    if (measuring === true) {
      measuring = p;
      measureLine.geometry.setFromPoints([new THREE.Vector3(p.x, p.y, 0), new THREE.Vector3(p.x, p.y, 0)]);
      $('measure-help').textContent = 'もう一方の端をクリックしてください。';
    } else {
      const meters = Number($('bar-m').value);
      const [ax, ay] = drawingPixel(drawing, new THREE.Vector3(measuring.x, measuring.y, 0));
      const [bx, by] = drawingPixel(drawing, new THREE.Vector3(p.x, p.y, 0));
      const pixels = Math.hypot(bx - ax, by - ay);
      if (meters > 0 && pixels > 0) ppm = pixels / meters;
      measureLine.geometry.setFromPoints([new THREE.Vector3(measuring.x, measuring.y, 0), new THREE.Vector3(p.x, p.y, 0)]);
      $('measure-help').textContent = `縮尺バー ${round(pixels, 1)} 画素 ÷ ${meters} m ＝ ${round(ppm, 3)} 画素/m（図面画像の実寸 ${round(drawing.widthPx / ppm, 3)} × ${round(drawing.heightPx / ppm, 3)} m）`;
      measuring = null;
      view.classList.remove('is-measuring');
      apply();
    }
    render();
    return;
  }
  if (onModel(e)) {
    const at = drawingPoint(drawing, d.at[0], d.at[1]);
    drag = { kind: 'model', dx: at.x - p.x, dy: at.y - p.y };
  } else {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
  }
});
view.addEventListener('pointermove', (e) => {
  if (measuring && measuring !== true) {
    const p = toDrawing(e);
    measureLine.geometry.setFromPoints([new THREE.Vector3(measuring.x, measuring.y, 0), new THREE.Vector3(p.x, p.y, 0)]);
    render();
    return;
  }
  if (!drag) return;
  if (drag.kind === 'model') {
    const p = toDrawing(e);
    manual();
    d.at = drawingPixel(drawing, new THREE.Vector3(p.x + drag.dx, p.y + drag.dy, 0));
    apply();
  } else {
    const perPx = cam.height / view.clientHeight;
    cam.x = drag.cx - (e.clientX - drag.sx) * perPx;
    cam.y = drag.cy + (e.clientY - drag.sy) * perPx;
    render();
  }
});
const endDrag = () => { drag = null; };
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = toDrawing(e);
  cam.height = THREE.MathUtils.clamp(cam.height * Math.exp(e.deltaY * 0.0015), aspect * 0.02, aspect * 3);
  resize();
  const after = toDrawing(e);
  cam.x += before.x - after.x; cam.y += before.y - after.y;
  apply({ fromInputs: true });
}, { passive: false });
view.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) { manual(); d.at = [d.at[0] + moves[e.key][0], d.at[1] + moves[e.key][1]]; apply(); e.preventDefault(); }
  if (e.key === '[' || e.key === ']') { manual(); d.headingDeg = round((d.headingDeg || 0) + (e.key === ']' ? 0.5 : -0.5), 1); apply(); e.preventDefault(); }
});

$('btn-measure').addEventListener('click', () => {
  measuring = true;
  view.classList.add('is-measuring');
  $('measure-help').textContent = '縮尺バーの片方の端をクリックしてください。';
});
function look(center, height) { cam.x = center.x; cam.y = center.y; cam.height = height; apply({ fromInputs: true }); }
$('btn-fit').addEventListener('click', () => {
  const box = new THREE.Box3().setFromObject(pose);
  const size = box.getSize(new THREE.Vector3());
  look(place.position, Math.max(size.x, size.y) * 2.2);
});
$('btn-all').addEventListener('click', () => look(new THREE.Vector3(), aspect * 1.05));

/* ---------- 保存 ---------- */

function updatedCatalog() {
  const out = JSON.parse(JSON.stringify(raw));
  const rawItem = out.items[item.index]; // id を省略した台帳もあるので、並び順で対応させる
  rawItem.display = cleanDisplay();
  rawItem.model = { ...(rawItem.model || {}), rotationDeg };
  if (Array.isArray(out.targets)) {
    const t = out.targets[drawing.index];
    // 縮尺は実寸（m）で書く。画素で書いた古い値は消す
    if (ppm) { delete t.pxPerMeter; delete t.realWidthM; delete t.realHeightM; Object.assign(t, realSize()); }
    // 位置と縮尺は、いまの図面画像の画素で書く。その画像の大きさも一緒に残す（画像を書き出し直したときの換算用）
    const resized = t.widthPx && t.widthPx !== drawing.widthPx;
    t.widthPx = drawing.widthPx;
    t.heightPx = drawing.heightPx;
    if (resized) {
      // 同じ図面のほかの資料の位置も、いまの画像の画素に直して書く
      for (const other of drawing.items) {
        const r = out.items[other.index];
        if (other !== item && r && r.display && Array.isArray(other.display && other.display.at)) r.display.at = other.display.at.map((v) => round(v));
      }
    }
  } else if (rawItem.target && typeof rawItem.target === 'object' && ppm) {
    delete rawItem.target.pxPerMeter; Object.assign(rawItem.target, realSize()); // 旧形式の台帳
  }
  return out;
}
$('btn-save').addEventListener('click', () => {
  const blob = new Blob([`${JSON.stringify(updatedCatalog(), null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'items.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('out').value); $('btn-copy').textContent = 'コピーしました'; } catch { $('out').select(); }
  setTimeout(() => { $('btn-copy').textContent = 'コピー'; }, 1500);
});

status(`${drawing.title || drawing.id}（${drawing.widthPx}×${drawing.heightPx} 画素）`);
apply();
showUp();
$('btn-fit').click();
window.__align = { d, get ppm() { return ppm; }, apply, updatedCatalog, cam, pose: () => pose }; // 確認用
