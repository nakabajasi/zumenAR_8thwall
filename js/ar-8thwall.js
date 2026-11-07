// AR表示（8th Wall 版。ar.html）。
// v22: 初期認識は図面全体が画面内にある場合だけ受け入れる。
// いったん図面の四隅が見切れたら imageTargetData を [] に差し替え、
// 8th Wall Engine 内の「図面画像ターゲットの認識・追跡」自体を停止する。
// 以後は SLAM（カメラ画像の環境特徴点＋IMU）のカメラ姿勢だけで、同じワールド座標を描画する。
// 自動で画像認識を再開しない。「探し直す」でのみターゲットを再登録する。
// この切替は disableWorldTracking を変更しない。SLAM は常に有効。
export const AR_BUILD_VERSION = 'v22.2';
// HTMLが新しくてもJSが古いキャッシュなら「読込待ち」のままになる。
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
  glideSec: 0.4,    // 新しい位置へ移すとき、この秒数をかけて滑らかに移す（0＝一瞬で移す）
  limitedHide: 1,   // 1＝図面が外れているあいだに部屋の追跡が不安定になったら、モデルを消す（図面を映し直すと出る）／0＝残す
  cornerEdge: 0.02, // 四隅の投影が画面内と判定する余裕
  lockEdge: 0.08,   // SLAM専用へ切替える境界（NDC。画面端の約4%手前で画像認識を停止）
  stallSec: 3,      // 映像の真っ黒がこの秒数続いたら、本当にカメラが止まったとみなして起動し直す（0＝8th Wall の安全装置のまま）
  pixelRatio: 2,    // 描画の細かさ（画面の画素比の上限）
  turn: 0,          // 図面の向きの補正（度。0・90・180・270）。?debug=1 で出る赤い枠が紙の縁と合わないときだけ使う
  frame: 0,         // 1＝図面の縁を赤い枠で示す（?debug=1 のときは常に出す）
};

const SCAN_HINT = '図面をカメラに映してください';
const HOLD_HINT = '図面を見失いました。図面をカメラに映すと再開します';
const LEFT_NOTE = '図面から外れても、モデルはその場所に残ります';
const DOUBT_HINT = 'モデルの位置を保てなくなりました。図面をもう一度カメラに映してください';
const DOUBT_MS = 500;    // 部屋の追跡の不安定がこの時間続いたら消す（一瞬の乱れでは消さない）
const RESTART_HINT = 'カメラが止まったので、モデルを消しました。図面をもう一度カメラに映してください';
const WHOLE_NOTE = '図面全体の四隅を映して、最初の位置を合わせてください';

const query = new URLSearchParams(location.search);
// 8th Wall の座標スケール比較用（診断のみ。URLで二択）。
// 既定の responsive と、実寸単位の absolute を他条件同一で比較する。
const worldScaleMode = query.get('scaleMode') === 'absolute' ? 'absolute' : 'responsive';
const versionIndicator = document.getElementById('ar-build-version');
if (versionIndicator) versionIndicator.textContent = `${AR_BUILD_VERSION} / ${worldScaleMode} / AR JS 読込済`;
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
let allTargetData = [];     // 画像認識を再開するときに登録し直すターゲットデータ
let scanMode = 'SCANNING'; // SCANNING（画像認識＋SLAM） / SLAM_ONLY（SLAMのみ）
let scanEpoch = 0;         // 画像認識停止を非同期で行うときの世代（再開時の競合防止）
let targetSwitches = 0;
let targetSwitchError = '';


const engine = {
  scanHint: SCAN_HINT,
  holdHint: HOLD_HINT,
  beforeStart,
  start,
  restart,
  view: () => ({ dom: canvas, camera: xr.camera }),
  isTracking: (st) => st.anchor.seen || (scanMode === 'SLAM_ONLY' && st.anchor.has && !st.anchor.doubt),
  isShowing: (st) => st.anchor.has && !st.anchor.doubt,
  handle: { inject: (detail, fresh = true) => onImage(detail, fresh), lose: (name) => onImageLost({ name }), setStatus: (d) => onStatus(d), get stall() { return { blocked: stallBlocked, restarted: stallRestarted, cameraRestarts, blackSince }; }, cornersFor: (d, i = 0) => { const a = core.stages[i].anchor; return cornersInView(new THREE.Vector3(d.position.x, d.position.y, d.position.z), new THREE.Quaternion(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w).normalize(), d.scale, a.inner, a.aspect); }, get XR8() { return XR8; }, get xr() { return xr; }, settings, get status() { return status; }, get events() { return events; }, get lastCpu() { return lastCpu; }, get scanMode() { return scanMode; }, get targetSwitches() { return targetSwitches; } },
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
    firm: false,                             // 四隅を画面に入れた状態で初期位置を決めたか
    locked: false,                           // 本当に画像ターゲットを解除して SLAM のみで追跡しているか
    doubt: false,                            // 図面が外れているあいだに部屋の追跡が不安定になり、位置が当てにならない（消している）
    badSince: 0,
    p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1,     // 図面の位置（部屋の中）
    dp: new THREE.Vector3(), dq: new THREE.Quaternion(), ds: 1,  // いま表示している位置（滑らかに移しているあいだは p と違う）
    gP: new THREE.Vector3(), gQ: new THREE.Quaternion(), gS: 1, gAt: 0,  // 滑らかに移し始めた位置と時刻
    inner, aspect: z.srcHeight / z.srcWidth,
    lastAt: 0, bigSince: 0,
    updates: 0, snaps: 0, skipped: 0, cut: 0, glides: 0, doubts: 0, restarts: 0, ratio: 0, inView: 0, lastDiff: 0, lastDeg: 0, rate: 0, rateCount: 0, rateAt: 0,
  };
}

// 画像認識が有効で、四隅を映したときだけ図面の姿勢を更新する
function measure(st, detail, fresh) {
  const a = st.anchor;
  const now = performance.now();
  _p.set(detail.position.x, detail.position.y, detail.position.z);
  _q.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w).normalize();
  const s = detail.scale;
  a.updates += 1; a.rateCount += 1;
  if (now - a.rateAt > 1000) { a.rate = (a.rateCount * 1000) / (now - a.rateAt || 1); a.rateCount = 0; a.rateAt = now; }
  a.ratio = xr ? xr.camera.position.distanceTo(_p) / Math.max(s, 1e-6) : 99;   // 確認用の表示だけに使う
  // 信用してよい測り直しか：8th Wall が測った位置で、図面の四隅がすべて画面に入っているか。
  // 角が写らず長い線ばかりになると、8th Wall の測る向き・位置が大きく狂う（線に沿ったずれと回りが決まらない）
  a.inView = cornersInView(_p, _q, s, a.inner, a.aspect);
  const whole = a.inView === 4;
  // 初期アンカーを部分認識から生成しない。四隅を画面内に収めてから認識する。
  if (!a.has && !whole) { a.cut += 1; return; }
  // 見失っていた時間が長いと、部屋の追跡のずれがたまっているかもしれないので、見つけ直したら新しい位置をそのまま使う
  // （ただし四隅が写っていないときは、いまの位置を保つ）
  const longGone = fresh && now - a.lastAt > 1500 && whole;
  // 部屋の追跡が乱れた・カメラが起動し直したなどで消していたときも、覚えていた位置は捨てて、最初に見つけたときと同じに扱う
  if (!a.has || a.doubt || longGone) {
    if (a.has && !a.doubt) a.snaps += 1;
    moveTo(st, _p, _q, s, now);
    a.firm = whole;   // 角が欠けた状態で見つけた位置は仮のもの
    a.has = true; a.doubt = false; a.bigSince = 0; a.lastAt = now;
    return;
  }
  const dt = Math.min((now - a.lastAt) / 1000, 0.5);
  a.lastAt = now;
  a.lastDiff = _p.distanceTo(a.p) / Math.max(a.s, 1e-6);
  a.lastDeg = THREE.MathUtils.radToDeg(_q.angleTo(a.q));
  if (!whole) { a.cut += 1; a.bigSince = 0; return; }   // 角が写っていない：受け入れない（位置は部屋の追跡で保つ）
  if (!a.firm) {
    // 仮の位置（角が欠けた状態で見つけた）のあと、四隅が写った：続くのを待たずにそこへ移す
    moveTo(st, _p, _q, s, now); a.firm = true; a.bigSince = 0; a.snaps += 1;
    return;
  }
  if (a.lastDiff > settings.moveTol || a.lastDeg > settings.moveTolDeg) {
    // はっきり違う位置：続くときだけ移す（一瞬の測り違いは無視する）
    if (!a.bigSince) a.bigSince = now;
    if (now - a.bigSince >= settings.moveSec * 1000) {
      moveTo(st, _p, _q, s, now); a.bigSince = 0; a.snaps += 1;
    } else a.skipped += 1;
    return;
  }
  a.bigSince = 0;
  // 同じ所を測り直している：ゆっくり平均して取り込む
  const k = 1 - Math.exp(-dt / Math.max(settings.settleSec, 0.01));
  a.p.lerp(_p, k); a.q.slerp(_q, k); a.s += (s - a.s) * k;
}

// 図面（位置 p・向き q・大きさ s のとき）の四隅のうち、画面に入っているものの数
const _c = new THREE.Vector3();
const _cs = new THREE.Vector3();
const _cm = new THREE.Matrix4();
function cornersInView(p, q, s, inner, aspect, edge = settings.cornerEdge) {
  if (!xr) return 0;
  const cam = xr.camera;
  cam.updateMatrixWorld();
  _cm.compose(p, q, _cs.setScalar(s)).multiply(inner);
  const lim = 1 - edge;
  let n = 0;
  for (const [x, y] of [[-0.5, -1], [0.5, -1], [0.5, 1], [-0.5, 1]]) {
    _c.set(x, (y * aspect) / 2, 0).applyMatrix4(_cm).project(cam);
    if (_c.z > -1 && _c.z < 1 && Math.abs(_c.x) <= lim && Math.abs(_c.y) <= lim) n += 1;
  }
  return n;
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

// 新しい位置へ移す。いま表示しているときは、glideSec 秒かけて滑らかに移す（一瞬で跳ばない）。
// 表示していないとき（最初に見つけたとき・消していたとき）は、そのまま置く
function moveTo(st, p, q, s, now) {
  const a = st.anchor;
  if (st.root.visible && settings.glideSec > 0) {
    a.gP.copy(a.dp); a.gQ.copy(a.dq); a.gS = a.ds; a.gAt = now; a.glides += 1;
  } else a.gAt = 0;
  a.p.copy(p); a.q.copy(q); a.s = s;
}

function placeRoot(st, now) {
  const a = st.anchor;
  if (a.gAt) {
    const t = (now - a.gAt) / (settings.glideSec * 1000);
    if (t >= 1) a.gAt = 0;
    else {
      const e = t * t * (3 - 2 * t);   // 動き始めと終わりをゆっくりに
      a.dp.lerpVectors(a.gP, a.p, e); a.dq.slerpQuaternions(a.gQ, a.q, e); a.ds = a.gS + (a.s - a.gS) * e;
    }
  }
  if (!a.gAt) { a.dp.copy(a.p); a.dq.copy(a.q); a.ds = a.s; }
  _s.setScalar(a.ds);
  st.root.matrix.compose(a.dp, a.dq, _s).multiply(a.inner);
  st.root.matrixWorldNeedsUpdate = true;
}

// 四隅が揃わなくなる前に、保存済みアンカーの投影から切り替えを判定する。
// 認識が返してきた最新の姿勢を利用しない。誤姿勢を根拠に「四隅が見える」と判断しないため。
function lockIfCornerLeaves(st) {
  if (!settings.slam || scanMode !== 'SCANNING' || !st.anchor.has || !st.anchor.firm) return false;
  const a = st.anchor;
  a.inView = cornersInView(a.p, a.q, a.s, a.inner, a.aspect, settings.lockEdge);
  if (a.inView === 4) return false;
  switchToSlamOnly(st, '四隅が画面端に近づいた');
  return true;
}

// imageTargetData=[] は「イベントを無視」ではなく、8th Wall が処理する画像ターゲットを空にする。
// SLAM とカメラは起動したまま。画像認識の再開は手動の「探し直す」のときだけ。
function switchToSlamOnly(st, reason) {
  if (!settings.slam || scanMode !== 'SCANNING' || !st.anchor.has) return;
  const a = st.anchor;
  // すでに移動補間中だった場合も、切り替えた瞬間に見えていた位置で止める。
  if (a.gAt) {
    placeRoot(st, performance.now());
    a.p.copy(a.dp); a.q.copy(a.dq); a.s = a.ds;
    a.gAt = 0;
  }
  scanMode = 'SLAM_ONLY';
  a.locked = true;
  a.seen = false;
  a.bigSince = 0;
  const epoch = ++scanEpoch;
  note(`${reason}: 画像ターゲット停止を要求`);
  core.$('recover').hidden = false;
  core.$('btn-rescan').textContent = '図面を再認識';
  core.flash('画像認識を終了し、SLAM追跡に切り替えました', 2200);
  // イベントコールバック内で8th Wallの設定を変更しない。次のタスクで画像ターゲット登録を解除。
  // モードは同期的に変えておき、停止待ちに届いた imageupdated/imagelost も拒否する。
  setTimeout(() => {
    if (epoch !== scanEpoch || scanMode !== 'SLAM_ONLY') return;
    try {
      XR8.XrController.configure({ imageTargetData: [] });
      targetSwitches += 1;
      targetSwitchError = '';
      note('画像ターゲットを解除（SLAMのみ継続）');
    } catch (err) {
      targetSwitchError = String(err);
      console.error('画像ターゲット認識を停止できませんでした', err);
      core.showHint('画像認識の停止に失敗しました。ページを再読み込みしてください');
    }
  }, 0);
}

// 画像認識が停止している間も SLAM による追跡状態は監視する。
function watchRoom(st, now) {
  const a = st.anchor;
  if (!settings.limitedHide || !a.has || a.seen || a.doubt) { a.badSince = 0; return; }
  const bad = status.status === 'LIMITED' || status.status === 'NOT_AVAILABLE';
  if (!bad) { a.badSince = 0; return; }
  if (!a.badSince) a.badSince = now;
  if (now - a.badSince < DOUBT_MS) return;
  a.doubt = true; a.badSince = 0; a.gAt = 0; a.doubts += 1;
  if (core.active === st) core.onLost(st, DOUBT_HINT, false);
}

/* ---------- カメラの誤った起動し直しを止める ---------- */
// 8th Wall は、カメラの映像が一瞬でも真っ黒（すべて0）だと「Safari でカメラが止まった」とみなし、カメラを起動し直す。
// iPhone では明るい映像でもこれが誤って働き、そのたびに数秒カメラが止まって部屋の追跡がずれていた。
// 8th Wall がこの判定に使う値（window._c8.isAllZeroes）を、8th Wall からは常に「真っ黒ではない」と見えるようにし、
// 真っ黒が stallSec 秒続いたとき（本当に止まったとき）だけ、こちらで起動し直す。同梱の 8th Wall のファイルは書き換えない
let blackSince = 0;        // 8th Wall が「真っ黒」と判定し始めた時刻（0＝真っ黒ではない）
let stallBlocked = 0;      // 誤りとみなして起動し直させなかった回数
let stallRestarted = 0;    // 真っ黒が続いたので、こちらで起動し直した回数
let cameraRestarts = 0;    // カメラが起動し直した回数（理由を問わず）
function stallGet() { return 0; }
function stallSet(v) {
  if (v && window._c8 && window._c8.wasEverNonZero) { if (!blackSince) blackSince = performance.now(); }
  else if (blackSince) { blackSince = 0; stallBlocked += 1; }
}
function guardStall() {
  const c8 = window._c8;
  if (!settings.stallSec || !c8) return;
  const d = Object.getOwnPropertyDescriptor(c8, 'isAllZeroes');
  if (d && d.get === stallGet) return;
  const v = d && 'value' in d ? d.value : 0;
  Object.defineProperty(c8, 'isAllZeroes', { configurable: true, enumerable: true, get: stallGet, set: stallSet });
  stallSet(v);
}
function checkStall(now) {
  guardStall();
  if (!blackSince || now - blackSince < settings.stallSec * 1000) return;
  blackSince = 0; stallRestarted += 1;
  // 処理の途中で止めないよう、このコマの処理が終わってから起動し直す
  setTimeout(() => { try { XR8.pause(); XR8.resume(); } catch (err) { console.warn(err); } }, 0);
}

// カメラが起動し直した：そのあいだ部屋を追えず、部屋の座標がずれるので、保っていた位置は使わない
function onCameraRestart() {
  cameraRestarts += 1;
  for (const st of core.stages) {
    const a = st.anchor;
    a.seen = false;
    if (!a.has || a.doubt) continue;
    a.doubt = true; a.gAt = 0; a.restarts += 1;
    if (core.active === st) core.onLost(st, RESTART_HINT, false);
  }
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

function appModule(datas, started, failed, mine) {
  let live = false;   // 起動し終えたか（そのあとの「カメラ requesting」は、カメラの起動し直し）
  return {
    name: 'zumen',
    onStart: () => {
      if (mine !== attempt) return;   // やり直す前の起動が遅れて始まった：使わない
      live = true;
      guardStall();
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
      if (!xr || mine !== attempt) return;
      if (debug) lastCpu = processCpuResult;
      const now = performance.now();
      checkStall(now);
      for (const st of core.stages) {
        const a = st.anchor;
        if (scanMode === 'SCANNING') lockIfCornerLeaves(st);
        watchRoom(st, now);
        const show = st === core.active && a.has && !a.doubt && (a.seen || settings.keepOnLost || a.locked) && st.slots.some((s) => s.model);
        st.root.visible = show;
        if (show) placeRoot(st, now);
      }
      syncLineResolution(xr.renderer);
      if (debug) updateDebug();
    },
    onCameraStatusChange: ({ status: s }) => {
      note(`カメラ ${s}`);
      if (s === 'requesting' && live && mine === attempt) onCameraRestart();
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

let wholeToldAt = -1e9;
function onImage(detail, fresh) {
  if (scanMode !== 'SCANNING') return;  // 停止の完了前に残っていたイベントも使わない
  const st = byName.get(detail.name);
  if (!st) return;
  const a = st.anchor;
  // 既存アンカーを使って四隅を評価。誤ったimageupdatedの姿勢を参照しない。
  if (lockIfCornerLeaves(st)) return;
  if (!detail.position || !detail.rotation || !Number.isFinite(detail.scale) || detail.scale <= 0) return;
  // 最新の推定姿勢でも四隅が見えない場合は、位置を書き換えずに直接SLAMへ移る。
  const measuredCorners = cornersInView(
    _p.set(detail.position.x, detail.position.y, detail.position.z),
    _q.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w).normalize(),
    detail.scale, a.inner, a.aspect, settings.cornerEdge);
  if (measuredCorners < 4) {
    a.cut += 1;
    if (a.has) switchToSlamOnly(st, '画像認識で四隅が見切れた');
    else if (performance.now() - wholeToldAt > 10000) {
      wholeToldAt = performance.now();
      core.flash(WHOLE_NOTE, 3000);
    }
    return;
  }
  const wasSeen = a.seen;
  measure(st, detail, fresh);
  if (!a.has) return;
  a.seen = true;
  if (fresh || !wasSeen) core.onFound(st);
}

function onImageLost(detail) {
  if (scanMode !== 'SCANNING') return;
  const st = byName.get(detail.name);
  if (!st) return;
  // 部分認識に戻ってしまう前に画像認識自体を終了する。
  if (st.anchor.has && st.anchor.firm && settings.slam) {
    switchToSlamOnly(st, '図面の画像追跡が失われた');
    return;
  }
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

let attempt = 0;          // 起動の回数（起動に失敗して「もう一度試す」を押すと増える）
let running8 = false;     // 8th Wall を動かしたか
let resizeBound = false;

async function start(c) {
  core = c;
  const mine = ++attempt;
  // やり直し：前回の起動で動かした 8th Wall を止め、処理の流れに入れた部品を外してから始め直す
  //（外さないと部品が二重に入り、図面の置き場所も二重にできる）
  if (running8) {
    try { XR8.stop(); XR8.clearCameraPipelineModules(); } catch (err) { console.warn(err); }
    running8 = false;
  }
  byName.clear();
  scanMode = 'SCANNING';
  ++scanEpoch;
  targetSwitchError = '';
  xr = null;
  const { catalog } = core;
  // 設定：既定値 ← 台帳の tracking8 ← URL（例 ar.html?debug=1&settleSec=2）
  Object.assign(settings, catalog.tracking8 || {});
  for (const key of Object.keys(AR8_DEFAULTS)) {
    if (query.has(key) && Number.isFinite(Number(query.get(key)))) settings[key] = Number(query.get(key));
  }
  XR8 = await xr8Ready(30000);
  guardStall();
  core.$('credit8').hidden = false;
  const [motion] = await (motionAsk || Promise.resolve(['granted']));
  if (settings.slam && motion !== 'granted') {
    throw new Error('動きのセンサーの使用が許可されませんでした。もう一度押して「許可」を選んでください（iPhone は 設定 > Safari > モーションと画面の向きのアクセス も確かめてください）。');
  }
  const datas = await loadTargets(catalog);
  allTargetData = datas;

  canvas = document.createElement('canvas');
  canvas.id = 'xr-canvas';
  core.stageEl.append(canvas);
  fillCanvas(window.orientation);
  if (!resizeBound) { resizeBound = true; window.addEventListener('resize', () => fillCanvas(window.orientation)); }
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
    XR8.XrController.configure({ imageTargetData: datas, disableWorldTracking: !settings.slam, scale: worldScaleMode });
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),   // カメラの映像を描く
      XR8.Threejs.pipelineModule(),             // three.js の場面とカメラを、スマホの動きに合わせる
      XR8.XrController.pipelineModule(),        // 部屋の追跡と、図面の認識
      canvasModule(),
      appModule(datas, started, failed, mine),
    ]);
    const { device, camera } = XR8.XrConfig;
    XR8.run({
      canvas,
      allowedDevices: settings.slam ? device().MOBILE : device().ANY,
      cameraConfig: { direction: camera().BACK },
    });
    running8 = true;
  });
}

// 「図面を再認識」：画像ターゲットを再登録し、位置合わせを最初からやり直す。
function restart() {
  ++scanEpoch;  // 停止処理がまだキューに残っていても、再開後に動かさない
  scanMode = 'SCANNING';
  targetSwitchError = '';
  core.$('recover').hidden = true;
  core.$('btn-rescan').textContent = '探し直す';
  for (const st of core.stages) Object.assign(st.anchor, {
    has: false, seen: false, firm: false, locked: false,
    doubt: false, badSince: 0, gAt: 0, lastAt: 0, bigSince: 0,
  });
  try {
    XR8.XrController.configure({ imageTargetData: allTargetData });
    note('画像ターゲットを再登録');
    XR8.XrController.recenter();
  } catch (err) {
    targetSwitchError = String(err);
    console.error(err);
    core.showHint('画像認識の再開に失敗しました。ページを再読み込みしてください');
    return;
  }
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
    `バージョン ${AR_BUILD_VERSION} / AR JS 読込済`,
    `方式 8th Wall（${settings.slam ? '部屋ごと追う' : '図面だけ'}）  スケール ${worldScaleMode}  描画 ${fps.toFixed(0)}回/秒`,
    `部屋の追跡 ${status.status || '-'} ${status.reason || ''}`,
    xr ? `カメラ位置 X ${xr.camera.position.x.toFixed(3)} Y ${xr.camera.position.y.toFixed(3)} Z ${xr.camera.position.z.toFixed(3)}（ワールド単位）` : 'カメラ位置 -',
    a && a.has ? `固定図面位置 X ${a.p.x.toFixed(3)} Y ${a.p.y.toFixed(3)} Z ${a.p.z.toFixed(3)} / scale ${a.s.toFixed(4)}` : '固定図面位置 -',
    `画像ターゲット ${scanMode === 'SCANNING' ? '認識ON（四隅の間）' : '認識OFF（SLAM専用）'}  停止成功 ${targetSwitches} ${targetSwitchError ? '※切替エラー: ' + targetSwitchError : ''}`,
    a ? `図面 ${a.seen ? '写っている' : a.has ? '外れている（位置は保持）' : '未発見'}  測り直し ${a.rate.toFixed(0)}回/秒` : '図面 -',
    a ? `直近の差 ${(a.lastDiff * 100).toFixed(2)}%  ${a.lastDeg.toFixed(2)}°  移した ${a.snaps}  無視 ${a.skipped}` : '',
    a ? `四隅 ${a.inView}/4 画面内  角が見えず捨てた ${a.cut}  距離÷長辺 ${a.ratio.toFixed(2)}` : '',
    a ? `位置 ${!a.has ? '-' : a.doubt ? '当てにならないので消している' : a.firm ? '確定' : '仮（角が欠けた状態で見つけた）'}  滑らかに移した ${a.glides}  追跡の乱れで消した ${a.doubts}` : '',
    `カメラの起動し直し 止めた ${stallBlocked}  起きた ${cameraRestarts}（うち真っ黒が続いた ${stallRestarted}）`,
    `画素 ${canvas ? `${canvas.width}×${canvas.height}` : '-'}`,
    `経過 ${events.slice(-4).join(' / ')}`,
  ].join('\n');
}

// 従来の方式（MindAR）へのリンクは、同じ資料・注記の指定のまま開く
const mindLink = document.getElementById('link-mindar');
if (mindLink) mindLink.href = `ar-mindar.html${location.search}`;

runArPage(engine);
