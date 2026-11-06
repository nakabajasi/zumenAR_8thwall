// 共通処理：台帳の読み込み、モデルの読み込みと向き・大きさの正規化、アノテーションの生成
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

import { siteUrl, loadCatalogData } from './catalog.js';

// サイトの最上位フォルダからの相対で解決する（GitHub Pages の /リポジトリ名/ 配下でも動くように）
export const url = siteUrl;

export async function fetchJson(path) {
  const res = await fetch(url(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} を読み込めません (${res.status})`);
  return res.json();
}

export const loadCatalog = loadCatalogData;

export function itemFromQuery(catalog) {
  const id = new URLSearchParams(location.search).get('id');
  return catalog.items.find((it) => it.id === id) || null;
}

export function targetFromQuery(catalog) {
  const id = new URLSearchParams(location.search).get('t');
  return catalog.targets.find((t) => t.id === id) || null;
}

// LINE や X などのアプリ内ブラウザではカメラが使えないことがある
export function isInAppBrowser() {
  return /Line\/|FBAN|FBAV|Instagram|Twitter|MicroMessenger/i.test(navigator.userAgent);
}

/* ---------- モデル ---------- */

const draco = new DRACOLoader().setDecoderPath(url('lib/draco/'));
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);

const SHAPE_COLOR = 0xcbc3b4;
const SEE_THROUGH = 0.45; // 透かすときの濃さ

/**
 * モデルを読み込み、次の入れ子にして返す。
 *   unit     … 底面中心が原点、上が+Y、最大寸法が1（置き場所や倍率はこの外側で決める）
 *   └ oriented … 台帳の rotationDeg による向きの補正
 *      └ raw   … GLBの座標そのまま。アノテーションはここに入れる
 */
export async function loadItemObject(item, onProgress) {
  const model = await loadModel(item, onProgress);
  placeFromCoordinates(item, model);
  return model;
}

async function loadModel(item, onProgress) {
  const gltf = await gltfLoader.loadAsync(url(item.model.src), (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });

  const raw = new THREE.Group();
  raw.add(gltf.scene);

  const oriented = new THREE.Group();
  const [rx, ry, rz] = (item.model.rotationDeg || [0, 0, 0]).map(THREE.MathUtils.degToRad);
  oriented.rotation.set(rx, ry, rz);
  oriented.add(raw);
  oriented.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(oriented);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = 1 / maxDim;
  oriented.scale.setScalar(s);
  oriented.position.set(-center.x * s, -box.min.y * s, -center.z * s);

  const unit = new THREE.Group();
  unit.add(oriented);

  // 表示の切り替え：photo＝写真の色をそのまま（光の計算なし）／shape＝色を外して形だけ
  const meshes = [];
  let triangles = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    const photo = new THREE.MeshBasicMaterial({ map: src.map || null, color: src.map ? 0xffffff : src.color });
    // 表面に沿ったアノテーションの線がちらつかないよう、面をわずかに奥へずらす
    photo.polygonOffset = true; photo.polygonOffsetFactor = 1; photo.polygonOffsetUnits = 1;
    o.material = photo;
    src.dispose();
    meshes.push({ mesh: o, photo, shape: null });
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });

  let mode = 'photo';
  let seeThrough = false;
  // 透かす：下の図面の線が見えるよう、モデルを半透明にする
  const applySeeThrough = (mat) => {
    mat.transparent = seeThrough;
    mat.opacity = seeThrough ? SEE_THROUGH : 1;
    mat.needsUpdate = true;
  };
  function setMode(next) {
    mode = next;
    for (const m of meshes) {
      if (next === 'shape') {
        if (!m.shape) {
          if (!m.mesh.geometry.attributes.normal) m.mesh.geometry.computeVertexNormals();
          m.shape = new THREE.MeshStandardMaterial({ color: SHAPE_COLOR, roughness: 0.85, metalness: 0 });
          m.shape.polygonOffset = true; m.shape.polygonOffsetFactor = 1; m.shape.polygonOffsetUnits = 1;
          applySeeThrough(m.shape);
        }
        m.mesh.material = m.shape;
      } else {
        m.mesh.material = m.photo;
      }
    }
  }
  function setSeeThrough(on) {
    seeThrough = !!on;
    for (const m of meshes) { applySeeThrough(m.photo); if (m.shape) applySeeThrough(m.shape); }
  }

  function dispose() {
    for (const m of meshes) {
      m.mesh.geometry.dispose();
      if (m.photo.map) m.photo.map.dispose();
      m.photo.dispose();
      if (m.shape) m.shape.dispose();
    }
  }

  return {
    unit, raw, size, maxDim, triangles,
    center: center.clone(),   // 向きを直したあとの外形の中心（GLB の座標の単位）
    // 単位化後の外寸（最大寸法＝1）。置き方の計算に使う
    unitSize: size.clone().multiplyScalar(s),
    get mode() { return mode; },
    get seeThrough() { return seeThrough; },
    setMode, setSeeThrough, dispose,
  };
}

/* ---------- 図面の上での置き方 ---------- */
// 図面の座標：図面の中心が原点、図面の幅が 1、x は右、y は図面の上方向、z は紙から手前。
// MindAR が図面を見つけたときの置き場所（anchor）と同じ座標なので、AR・ビューア・位置合わせで共通に使う。
//
// display.mode
//   plan  … 平面図に重ねる（遺構）。モデルの上を紙から手前へ、北（-Z）を図面の上へ向け、図面の縮尺で置く
//   stand … 紙の上に立たせる。向きは plan と同じで、大きさは図面の幅に対する割合
//   lay   … 正面図に重ねて寝かせる（遺物）。モデルの上を図面の上方向へ向ける

const DEFAULT_FIT = 0.35;
export const displayMode = (item) => (item.display && item.display.mode) || 'stand';
const metersPerUnit = (item) => (item.model.metersPerUnit == null ? 1 : item.model.metersPerUnit); // glTF の単位はメートル

// 図面画像の画素の位置 → 図面の座標
export function drawingPoint(drawing, px, py) {
  return new THREE.Vector3(px / drawing.widthPx - 0.5, (drawing.heightPx / 2 - py) / drawing.widthPx, 0);
}
// 図面の座標 → 図面画像の画素の位置
export function drawingPixel(drawing, v) {
  return [(v.x + 0.5) * drawing.widthPx, drawing.heightPx / 2 - v.y * drawing.widthPx];
}

// モデルの最大寸法が、図面の幅の何倍になるか
export function displayScale(item, model) {
  const d = item.display || {};
  const size = d.size || (displayMode(item) === 'plan' ? { type: 'drawing' } : { type: 'fit', value: DEFAULT_FIT });
  if (size.type === 'drawing') {
    // 図面と同じ縮尺：図面画像で 1m が何画素か（pxPerMeter）から決める
    const ppm = size.pxPerMeter || item.drawing.pxPerMeter;
    if (ppm) return (model.maxDim * metersPerUnit(item) * ppm) / item.drawing.widthPx;
    console.warn(`${item.id}: 図面の縮尺（targets の pxPerMeter）がないので、図面幅の${DEFAULT_FIT * 100}%で表示します`);
    return DEFAULT_FIT;
  }
  if (size.type === 'scale') {
    // 旧形式：印刷した図面の幅（mm）と縮尺から決める
    const printWidth = item.drawing.printWidthMm;
    if (printWidth) return (model.maxDim * metersPerUnit(item) * 1000 * size.value) / printWidth;
    return DEFAULT_FIT;
  }
  return size.value == null ? DEFAULT_FIT : size.value;
}

// 図面の実寸が書いてあって、置き場所（display.at）を書いていない資料は、モデル自身の座標で図面に重ねる。
// モデルの座標：図面画像の左下が原点、右が X、上が Y（Blender の向き。three.js では X と -Z）、単位 m
export const placedByCoordinates = (item) => {
  const d = item.display || {};
  const t = item.drawing || {};
  return displayMode(item) === 'plan' && (!Array.isArray(d.at) || d.fromCoordinates) && !d.anchor
    && (Number(t.realWidthM) > 0 || Number(t.realHeightM) > 0);
};
// モデルを読み込んだら、モデルの座標から図面上の置き場所（画素）を決めて display.at に入れる（方位は 0）
export function placeFromCoordinates(item, model) {
  if (!placedByCoordinates(item) || !item.drawing.pxPerMeter) return false;
  const k = metersPerUnit(item) * item.drawing.pxPerMeter;
  item.display = { ...(item.display || {}), at: [model.center.x * k, item.drawing.heightPx + model.center.z * k], headingDeg: 0, fromCoordinates: true };
  return true;
}

// モデルの置き場所（図面の座標）。display.at は図面画像の画素、旧形式の anchor は 0〜1 の割合
export function placePosition(item) {
  const d = item.display || {};
  if (Array.isArray(d.at)) return drawingPoint(item.drawing, d.at[0], d.at[1]);
  const [u, v] = d.anchor || [0.5, 0.5];
  return drawingPoint(item.drawing, u * item.drawing.widthPx, v * item.drawing.heightPx);
}

// 紙の面に合わせる高さ（モデルの下端から何 m 上か）。平面図では、遺構を検出した面が紙に来るよう上端が既定
export function groundHeight(item, model) {
  const g = item.display && item.display.ground;
  const height = model.size.y * metersPerUnit(item);
  if (typeof g === 'number') return Math.min(Math.max(g, 0), height);
  if (g === 'top') return height;
  if (g === 'bottom') return 0;
  return displayMode(item) === 'plan' ? height : 0;
}

// 置き場所からの、モデルの向き・大きさ・高さ。返す入れ物を置き場所に入れれば図面の上に乗る
export function buildPose(item, model) {
  const k = displayScale(item, model);
  const pose = new THREE.Group();
  pose.scale.setScalar(k);
  if (displayMode(item) === 'lay') {
    pose.position.set(0, (-model.unitSize.y / 2) * k, (model.unitSize.z / 2) * k);
    pose.add(model.unit);
    return pose;
  }
  // 方位：モデルの北を図面の上から時計回りに headingDeg 度
  pose.rotation.z = -THREE.MathUtils.degToRad((item.display && item.display.headingDeg) || 0);
  const tilt = new THREE.Group();
  tilt.rotation.x = Math.PI / 2;
  tilt.position.z = -groundHeight(item, model) / (model.maxDim * metersPerUnit(item));
  tilt.add(model.unit);
  pose.add(tilt);
  return pose;
}

// 形だけの表示に使う光。写真表示には影響しない
// 見る人の側の左上から当てる（実測図の陰影の慣習に合わせ、かつ手前の面が暗くならない向き）
export function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.0);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(-0.8, 0.7, 1.6);
  scene.add(hemi, key);
  return { hemi, key };
}

/* ---------- アノテーション ---------- */

const lineMaterials = new Set();
const _res = new THREE.Vector2();
// 太線は画面の画素数を知らないと太さが決まらないので、描画のたびに渡す
export function syncLineResolution(renderer) {
  renderer.getDrawingBufferSize(_res);
  for (const m of lineMaterials) m.resolution.copy(_res);
}

const LINE_WIDTH = 3;        // 画面上の太さ（px）
const LINE_WIDTH_ACTIVE = 6;
const TYPE_LABEL = { Point: '点', Line: '線', Area: '面' };
export const typeLabel = (t) => TYPE_LABEL[t] || t;

/**
 * annotations.json からアノテーションを作る。座標は GLB の座標（raw に入れる前提）。
 * 戻り値の layers[n].object の visible でレイヤーごとに表示を切り替える。
 */
export function buildAnnotations(data, maxDim) {
  const group = new THREE.Group();
  const layers = [];
  const pickables = [];
  if (!data || !Array.isArray(data.layers)) return { group, layers, pickables, select() {} };

  const r = maxDim * 0.011;
  const sphereGeo = new THREE.SphereGeometry(r, 20, 14);
  const hitGeo = new THREE.SphereGeometry(r * 2.6, 8, 6); // 指で押しやすいよう当たり判定だけ大きく
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });

  for (const def of data.layers) {
    const object = new THREE.Group();
    const color = new THREE.Color(def.color || '#d9482b');
    const layer = {
      uid: def.uid, name: def.name, type: def.Annotation_Type,
      color: `#${color.getHexString()}`, metadata: def.metadata || {}, object, entries: [],
    };

    (def.items || []).forEach((it, index) => {
      const entry = {
        layer, index, key: it.key || null, label: it.label || '', note: it.note || '', fields: it.fields || {},
        visual: null, lines: [],
      };
      const itemColor = it.color ? new THREE.Color(it.color) : color;
      if (layer.type === 'Point') {
        const dot = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: itemColor }));
        dot.position.fromArray(it.position);
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.userData.entry = entry;
        dot.add(hit);
        object.add(dot);
        pickables.push(hit);
        entry.visual = dot;
      } else {
        // 線は paths（複数の線。Blender から書き出した注記）か points（1本。JSON で書いた注記）
        const paths = it.paths || [{ points: it.points || [], closed: layer.type === 'Area' }];
        for (const path of paths) {
          if (!path.points || path.points.length < 2) continue;
          const pts = path.points.slice();
          // 閉じた線は始点に戻す。閉じているかどうかの記録が無い線（JSON の注記）は、面なら閉じる
          if (path.closed === undefined ? layer.type === 'Area' : path.closed) pts.push(pts[0]);
          const geo = new LineGeometry().setPositions(pts.flat());
          const mat = new LineMaterial({ color: itemColor, linewidth: LINE_WIDTH, worldUnits: false });
          lineMaterials.add(mat);
          const line = new Line2(geo, mat);
          line.computeLineDistances();
          line.userData.entry = entry;
          object.add(line);
          pickables.push(line);
          entry.lines.push(line);
        }
        if (it.fill) {
          // 面を塗ったもの：半透明で重ねる。線を面で作ったもの（solid）は不透明のまま
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(it.fill.positions.flat(), 3));
          geo.setIndex(it.fill.triangles.flat());
          const mat = new THREE.MeshBasicMaterial({
            color: itemColor, transparent: !it.solid, opacity: it.solid ? 1 : 0.32, side: THREE.DoubleSide, depthWrite: !!it.solid,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, // 本体の表面より手前に描く
          });
          const fill = new THREE.Mesh(geo, mat);
          fill.userData.entry = entry;
          object.add(fill);
          pickables.push(fill);
          entry.fill = fill;
        }
        entry.visual = entry.lines[0] || entry.fill || null;
      }
      layer.entries.push(entry);
    });

    group.add(object);
    layers.push(layer);
  }

  let selected = null;
  function mark(entry, on) {
    if (!entry) return;
    if (entry.layer.type === 'Point') entry.visual.scale.setScalar(on ? 1.7 : 1);
    for (const line of entry.lines || []) line.material.linewidth = on ? LINE_WIDTH_ACTIVE : LINE_WIDTH;
    if (entry.fill && !entry.fill.material.depthWrite) entry.fill.material.opacity = on ? 0.55 : 0.32;
  }
  function select(entry) {
    mark(selected, false);
    selected = entry || null;
    mark(selected, true);
  }

  function dispose() {
    group.traverse((o) => {
      if (o.isLine2) { lineMaterials.delete(o.material); o.material.dispose(); o.geometry.dispose(); }
      else if (o.isMesh && o.material !== hitMat) {
        o.material.dispose();
        if (o.geometry !== sphereGeo && o.geometry !== hitGeo) o.geometry.dispose();
      }
    });
    sphereGeo.dispose(); hitGeo.dispose(); hitMat.dispose();
  }

  return { group, layers, pickables, select, dispose };
}

const raycaster = new THREE.Raycaster();
raycaster.params.Line2 = { threshold: 14 }; // 線は指で押しやすいよう太めに判定（px）
const _ndc = new THREE.Vector2();

const _scale = new THREE.Vector3();

// 画面上の位置からアノテーションを1つ拾う。非表示レイヤーのものと、モデルの裏側に隠れたものは拾わない
export function pickAnnotation(clientX, clientY, dom, camera, annotations, model) {
  const rect = dom.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  const live = annotations.pickables.filter((p) => p.userData.entry.layer.object.visible);
  const hit = raycaster.intersectObjects(live, false)[0];
  if (!hit) return null;
  const surface = raycaster.intersectObject(model.raw.children[0], true)[0];
  if (surface) {
    const slack = model.unit.getWorldScale(_scale).x * 0.06; // モデル最大寸法の6%までの前後差は同じ場所とみなす
    if (surface.distance < hit.distance - slack) return null;
  }
  return hit.object.userData.entry;
}

// 画面上の位置にあるモデルを選ぶ（いちばん手前のもの）。slots は { model } を持つものの配列
export function pickModel(clientX, clientY, dom, camera, slots) {
  const rect = dom.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  let best = null, bestDist = Infinity;
  for (const s of slots) {
    if (!s.model) continue;
    const hit = raycaster.intersectObject(s.model.raw.children[0], true)[0];
    if (hit && hit.distance < bestDist) { best = s; bestDist = hit.distance; }
  }
  return best;
}

// 注記の共有用の名前と、その逆引き。Blender から書き出した注記はオブジェクト名、JSON の注記は「レイヤーの uid.番号」
export const entryKey = (entry) => entry.key || `${entry.layer.uid}.${entry.index}`;
export function findEntry(annotations, key) {
  if (!key || !annotations) return null;
  for (const layer of annotations.layers) {
    const hit = layer.entries.find((e) => e.key === key);
    if (hit) return hit;
  }
  const dot = key.lastIndexOf('.');
  const uid = dot < 0 ? key : key.slice(0, dot);
  const index = dot < 0 ? 0 : Number(key.slice(dot + 1)) || 0;
  const layer = annotations.layers.find((l) => l.uid === uid);
  return layer ? layer.entries[index] || layer.entries[0] || null : null;
}
