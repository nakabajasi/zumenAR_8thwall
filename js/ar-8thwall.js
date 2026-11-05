// AR表示（8th Wall 版。ar.html）。画面の共通部分は ar-core.js、ここは 8th Wall での認識だけ。
//
// 8th Wall は、カメラの映像とスマホの動きのセンサーで部屋そのものを追う（MindAR は図面だけを見ていた）。
// 図面は「部屋のどこにあるか」を決めるのに使い、見つけたらモデルを部屋のその位置に置く。
//   ・手ブレ：スマホの動きは部屋ごと追うので、モデルは机に置いたように止まって見える
//   ・図面の位置は動かないはずなので、図面が写っているあいだの位置の測り直しは、ゆっくり平均して取り込む
//     （1回ごとの測り直しの細かいばらつきでモデルを動かさない）。はっきり違う位置が続いたとき
//     （図面を動かした・部屋の追跡がずれた）だけ、新しい位置へ移す
//   ・図面が画面から外れても、モデルは部屋のその位置に残る（keepOnLost）
import * as THREE from 'three';
import { url, fetchJson, addLights, syncLineResolution } from './common.js';
import { runArPage } from './ar-core.js';

// 8th Wall の three.js 用の部品は、three.js を window.THREE から使う
window.THREE = { ...THREE };

export const AR8_DEFAULTS = {
  slam: 1,          // 1＝部屋ごと追う（スマホのみ）／0＝図面だけで追う（パソコンでの確認用。手ブレは止まらない）
  keepOnLost: 1,    // 1＝図面が画面から外れても、モデルを部屋のその位置に残す／0＝消す
  settleSec: 1.0,   // 図面が写っているあいだ、位置の測り直しを取り込む速さ（秒。大きいほどゆっくり平均する）
  moveTol: 0.03,    // これ以上違う位置（図面の長辺に対する割合）を「図面が動いた」とみなす
  moveTolDeg: 4,    // これ以上違う向き（度）を「図面が動いた」とみなす
  moveSec: 0.3,     // 「動いた」が続いたら新しい位置へ移すまでの時間（秒。一瞬の測り違いでは動かさない）
  pixelRatio: 2,    // 描画の細かさ（画面の画素比の上限）
  turn: 0,          // 図面の向きの補正（度。0・90・180・270）。?debug=1 で出る赤い枠が紙の縁と合わないときだけ使う
  frame: 0,         // 1＝図面の縁を赤い枠で示す（?debug=1 のときは常に出す）
};

const SCAN_HINT = '図面をカメラに映してください';
const HOLD_HINT = '図面を見失いました。図面をカメラに映すと再開します';
const LEFT_NOTE = '図面から外れても、モデルはその場所に残ります';

const query = new URLSearchParams(location.search);
const debug = query.has('debug');
let settings = { ...AR8_DEFAULTS };
let core = null;
let XR8 = null;
let xr = null;           // XR8.Threejs.xrScene()：scene・camera・renderer
let canvas = null;
let motionAsk = null;
let status = { status: '', reason: '' };
let toldLeft = false;
const byName = new Map();  // 8th Wall の画像ターゲット名 → 図面の置き場所

const engine = {
  scanHint: SCAN_HINT,
  holdHint: HOLD_HINT,
  beforeStart,
  start,
  restart,
  view: () => ({ dom: canvas, camera: xr.camera }),
  isTracking: (st) => st.anchor.seen,
  isShowing: (st) => st.anchor.has,
  handle: { inject: (detail, fresh = true) => onImage(detail, fresh), get XR8() { return XR8; }, get xr() { return xr; }, settings, get status() { return status; }, get events() { return events; }, get lastCpu() { return lastCpu; } },
};

/* ---------- 準備 ---------- */

// iPhone の動きのセンサーの許可は、ボタンを押した処理の中で同期的に求めないと出ない
function beforeStart() {
  const ask = (C) => (C && typeof C.requestPermission === 'function'
    ? C.requestPermission().catch(() => 'denied') : Promise.resolve('granted'));
  motionAsk = Promise.all([ask(window.DeviceMotionEvent), ask(window.DeviceOrientationEvent)]);
}

function xr8Ready(ms) {
  if (window.XR8) return Promise.resolve(window.XR8);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AR の部品（8th Wall）を読み込めませんでした。通信状態を確かめて、読み込み直してください。')), ms);
    window.addEventListener('xrloaded', () => { clearTimeout(timer); resolve(window.XR8); }, { once: true });
  });
}

// 図面ごとの 8th Wall 用データ（tools/ の「1b」で作る target8.json・target8.jpg）
async function loadTargets(catalog) {
  return Promise.all(catalog.targets.map(async (t) => {
    let data;
    try { data = await fetchJson(t.target8); } catch (err) {
      throw new Error(`図面「${t.title || t.id}」の 8th Wall 用の認識データ（${t.target8}）がありません。管理用ページ tools/ の「1b. 8th Wall 用の認識データを作る」で作って置いてください。`);
    }
    const z = (data.metadata && data.metadata.zumen) || null;
    if (!z) throw new Error(`${t.target8} は、この仕組み用に作ったデータではありません。管理用ページで作り直してください。`);
    if (t.widthPx && t.heightPx && Math.abs((z.srcHeight / z.srcWidth) / (t.heightPx / t.widthPx) - 1) > 0.01) {
      warn(`図面「${t.title || t.id}」：8th Wall 用データは ${z.srcWidth}×${z.srcHeight}、図面画像は ${t.widthPx}×${t.heightPx} で縦横比が違います。管理用ページで作り直してください`);
    }
    return { ...data, name: `zumen-${t.id}`, imagePath: url(t.target8Image) };
  }));
}

function warn(text) {
  console.warn(text);
  const box = core.$('config-warn');
  box.textContent = box.hidden ? text : `${box.textContent}。${text}`;
  box.hidden = false;
}

/* ---------- 図面の位置（部屋の中） ---------- */

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

function makeAnchor(data) {
  const z = data.metadata.zumen;
  // 8th Wall の図面の座標は、白地を足した図面の中心が原点、長辺が1。こちらの置き場所は、元の図面の中心が原点、幅が1
  const unit = z.srcWidth / Math.max(z.padWidth, z.padHeight);
  const inner = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(settings.turn || 0))
    .multiply(new THREE.Matrix4().makeScale(unit, unit, unit));
  return {
    has: false, seen: false,                 // 位置を決めたか／いま写っているか
    p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1,
    inner, aspect: z.srcHeight / z.srcWidth,
    lastAt: 0, bigSince: 0,
    updates: 0, snaps: 0, skipped: 0, lastDiff: 0, lastDeg: 0, rate: 0, rateCount: 0, rateAt: 0,
  };
}

// 8th Wall が図面の位置を測り直すたびに呼ぶ
function measure(st, detail, fresh) {
  const a = st.anchor;
  const now = performance.now();
  _p.set(detail.position.x, detail.position.y, detail.position.z);
  _q.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w).normalize();
  const s = detail.scale;
  a.updates += 1; a.rateCount += 1;
  if (now - a.rateAt > 1000) { a.rate = (a.rateCount * 1000) / (now - a.rateAt || 1); a.rateCount = 0; a.rateAt = now; }
  // 見失っていた時間が長いと、部屋の追跡のずれがたまっているかもしれないので、見つけ直したら新しい位置をそのまま使う
  const longGone = fresh && now - a.lastAt > 1500;
  if (!a.has || longGone) {
    if (a.has) a.snaps += 1;
    a.p.copy(_p); a.q.copy(_q); a.s = s;
    a.has = true; a.bigSince = 0; a.lastAt = now;
    return;
  }
  const dt = Math.min((now - a.lastAt) / 1000, 0.5);
  a.lastAt = now;
  a.lastDiff = _p.distanceTo(a.p) / Math.max(a.s, 1e-6);
  a.lastDeg = THREE.MathUtils.radToDeg(_q.angleTo(a.q));
  if (a.lastDiff > settings.moveTol || a.lastDeg > settings.moveTolDeg) {
    // はっきり違う位置：続くときだけ移す（一瞬の測り違いは無視する）
    if (!a.bigSince) a.bigSince = now;
    if (now - a.bigSince >= settings.moveSec * 1000) {
      a.p.copy(_p); a.q.copy(_q); a.s = s; a.bigSince = 0; a.snaps += 1;
    } else a.skipped += 1;
    return;
  }
  a.bigSince = 0;
  // 同じ所を測り直している：ゆっくり平均して取り込む
  const k = 1 - Math.exp(-dt / Math.max(settings.settleSec, 0.01));
  a.p.lerp(_p, k); a.q.slerp(_q, k); a.s += (s - a.s) * k;
}

// 図面の縁（置き場所の座標で、幅1・高さ aspect の長方形）。紙の縁と重なれば、図面の向きと大きさが合っている
function outline(aspect) {
  const h = aspect / 2;
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, -h, 0), new THREE.Vector3(0.5, -h, 0), new THREE.Vector3(0.5, h, 0), new THREE.Vector3(-0.5, h, 0),
    new THREE.Vector3(-0.5, -h, 0), new THREE.Vector3(0, h * 0.6, 0), new THREE.Vector3(0.5, -h, 0), // 上向きの印（V字）
  ]);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false }));
  line.renderOrder = 999;
  return line;
}

function placeRoot(st) {
  const a = st.anchor;
  _s.setScalar(a.s);
  st.root.matrix.compose(a.p, a.q, _s).multiply(a.inner);
  st.root.matrixWorldNeedsUpdate = true;
}

/* ---------- 8th Wall の処理の流れに入れる部品 ---------- */

// 描画面を画面いっぱいにする（8th Wall の FullWindowCanvas と同じ考え方。ただし描画面は #stage の中に置いたまま、
// 画素比を上げて細かく描く。見た目の大きさは CSS で画面に合わせる）
function fillCanvas(orientation) {
  const ww = window.innerWidth, wh = window.innerHeight;
  // 端末を回した直後は、画面の縦横が入れ替わるまで待つ
  if (((orientation === 0 || orientation === 180) && ww > wh) || ((orientation === 90 || orientation === -90) && wh > ww)) {
    requestAnimationFrame(() => fillCanvas(orientation));
    return;
  }
  const r = Math.min(window.devicePixelRatio || 1, settings.pixelRatio);
  const w = Math.round(ww * r), h = Math.round(wh * r);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
function canvasModule() {
  return {
    name: 'zumen-canvas',
    onAttach: ({ orientation }) => fillCanvas(orientation),
    onDeviceOrientationChange: ({ orientation }) => fillCanvas(orientation),
  };
}

function appModule(datas, started, failed) {
  return {
    name: 'zumen',
    onStart: () => {
      xr = XR8.Threejs.xrScene();
      const { scene, camera } = xr;
      addLights(scene);
      datas.forEach((data, i) => {
        const st = core.makeStage(core.catalog.targets[i], { anchor: makeAnchor(data) });
        st.root.matrixAutoUpdate = false;
        scene.add(st.root);
        if (debug || settings.frame) st.root.add(outline(st.anchor.aspect));
        byName.set(data.name, st);
      });
      core.catalog.items.forEach((it) => core.makeSlot(core.stages[it.targetIndex], it));
      // 部屋の座標の始まりを、いまのカメラの位置と向きに合わせる
      camera.position.set(0, 1.5, 0);
      XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
      started();
    },
    onUpdate: ({ processCpuResult }) => {
      if (!xr) return;
      if (debug) lastCpu = processCpuResult;
      for (const st of core.stages) {
        const a = st.anchor;
        const show = st === core.active && a.has && (a.seen || settings.keepOnLost) && st.slots.some((s) => s.model);
        st.root.visible = show;
        if (show) placeRoot(st);
      }
      syncLineResolution(xr.renderer);
      if (debug) updateDebug();
    },
    onCameraStatusChange: ({ status: s }) => {
      note(`カメラ ${s}`);
      if (s === 'failed') failed(new Error('カメラを起動できませんでした。ブラウザの設定でこのページのカメラ使用を許可してください。'));
    },
    onException: (err) => {
      console.error(err);
      const text = String((err && err.message) || err);
      if (/non-mobile|requires disableWorldTracking/i.test(text)) {
        failed(new Error('部屋ごと追う方式はスマートフォンでだけ動きます。パソコンで確かめるときは、URL の最後に ?slam=0 を付けてください。'));
      } else failed(new Error(`AR を始められません：${text}`));
    },
    listeners: [
      { event: 'reality.imageloading', process: () => note('図面データ読み込み開始') },
      { event: 'reality.imagescanning', process: () => note('図面を探し始めた') },
      { event: 'reality.imagefound', process: ({ detail }) => onImage(detail, true) },
      { event: 'reality.imageupdated', process: ({ detail }) => onImage(detail, false) },
      { event: 'reality.imagelost', process: ({ detail }) => onImageLost(detail) },
      { event: 'reality.trackingstatus', process: ({ detail }) => onStatus(detail) },
    ],
  };
}

function onImage(detail, fresh) {
  const st = byName.get(detail.name);
  if (!st) return;
  const wasSeen = st.anchor.seen;
  measure(st, detail, fresh);
  st.anchor.seen = true;
  if (fresh || !wasSeen) core.onFound(st);
}

function onImageLost(detail) {
  const st = byName.get(detail.name);
  if (!st) return;
  st.anchor.seen = false;
  if (settings.keepOnLost && st.anchor.has) {
    core.onLost(st, '', false);
    if (!toldLeft && core.active === st) { toldLeft = true; core.flash(LEFT_NOTE, 3000); }
  } else core.onLost(st, HOLD_HINT, true);
}

// 起動の経過（?debug=1 の表示と確認用）
const events = [];
let lastCpu = null;   // 確認用：直近のコマの 8th Wall の処理結果
function note(text) { events.push(`${Math.round(performance.now() / 100) / 10}s ${text}`); if (events.length > 12) events.shift(); }

let motionToldAt = 0;
function onStatus(detail) {
  status = detail || status;
  // 速く動かしすぎて部屋を追えないとき
  if (status.reason === 'TOO_MUCH_MOTION' && performance.now() - motionToldAt > 4000) {
    motionToldAt = performance.now();
    core.flash('ゆっくり動かしてください', 2000);
  }
}

/* ---------- 開始・探し直し ---------- */

async function start(c) {
  core = c;
  const { catalog } = core;
  // 設定：既定値 ← 台帳の tracking8 ← URL（例 ar.html?debug=1&settleSec=2）
  Object.assign(settings, catalog.tracking8 || {});
  for (const key of Object.keys(AR8_DEFAULTS)) {
    if (query.has(key) && Number.isFinite(Number(query.get(key)))) settings[key] = Number(query.get(key));
  }
  XR8 = await xr8Ready(30000);
  core.$('credit8').hidden = false;
  const [motion] = await (motionAsk || Promise.resolve(['granted']));
  if (settings.slam && motion !== 'granted') {
    throw new Error('動きのセンサーの使用が許可されませんでした。もう一度押して「許可」を選んでください（iPhone は 設定 > Safari > モーションと画面の向きのアクセス も確かめてください）。');
  }
  const datas = await loadTargets(catalog);

  canvas = document.createElement('canvas');
  canvas.id = 'xr-canvas';
  core.stageEl.append(canvas);
  fillCanvas(window.orientation);
  window.addEventListener('resize', () => fillCanvas(window.orientation));
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    core.showHint('表示が止まりました。ページを読み込み直してください');
  });

  await new Promise((resolve, reject) => {
    let done = false;
    let timer = 0;
    const started = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const failed = (err) => {
      if (!done) { done = true; clearTimeout(timer); reject(err); return; }
      core.showHint(err.message);
    };
    timer = setTimeout(() => failed(new Error('カメラの準備に時間がかかっています。ページを読み込み直してください。')), 30000);
    XR8.XrController.configure({ imageTargetData: datas, disableWorldTracking: !settings.slam, scale: 'responsive' });
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),   // カメラの映像を描く
      XR8.Threejs.pipelineModule(),             // three.js の場面とカメラを、スマホの動きに合わせる
      XR8.XrController.pipelineModule(),        // 部屋の追跡と、図面の認識
      canvasModule(),
      appModule(datas, started, failed),
    ]);
    const { device, camera } = XR8.XrConfig;
    XR8.run({
      canvas,
      allowedDevices: settings.slam ? device().MOBILE : device().ANY,
      cameraConfig: { direction: camera().BACK },
    });
  });
}

// 「探し直す」：部屋の座標を作り直し、図面の位置を決め直す
function restart() {
  core.$('recover').hidden = true;
  for (const st of core.stages) { st.anchor.has = false; st.anchor.seen = false; }
  try { XR8.XrController.recenter(); } catch (err) { console.warn(err); }
  core.showHint(SCAN_HINT);
}

/* ---------- 確認用の表示（?debug=1） ---------- */

let debugBox = null;
let debugAt = 0;
let frames = 0;
let fps = 0;
function updateDebug() {
  frames += 1;
  const now = performance.now();
  if (now - debugAt < 500) return;
  fps = (frames * 1000) / (now - debugAt);
  frames = 0; debugAt = now;
  if (!debugBox) {
    debugBox = document.createElement('pre');
    debugBox.className = 'debug';
    document.body.append(debugBox);
  }
  const st = core.active || core.stages[0];
  const a = st && st.anchor;
  debugBox.textContent = [
    `方式 8th Wall（${settings.slam ? '部屋ごと追う' : '図面だけ'}）  描画 ${fps.toFixed(0)}回/秒`,
    `部屋の追跡 ${status.status || '-'} ${status.reason || ''}`,
    a ? `図面 ${a.seen ? '写っている' : a.has ? '外れている（位置は保持）' : '未発見'}  測り直し ${a.rate.toFixed(0)}回/秒` : '図面 -',
    a ? `直近の差 ${(a.lastDiff * 100).toFixed(2)}%  ${a.lastDeg.toFixed(2)}°  移した ${a.snaps}  無視 ${a.skipped}` : '',
    `画素 ${canvas ? `${canvas.width}×${canvas.height}` : '-'}`,
    `経過 ${events.slice(-4).join(' / ')}`,
  ].join('\n');
}

// 従来の方式（MindAR）へのリンクは、同じ資料・注記の指定のまま開く
const mindLink = document.getElementById('link-mindar');
if (mindLink) mindLink.href = `ar-mindar.html${location.search}`;

runArPage(engine);
