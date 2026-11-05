// AR表示（MindAR 版。ar-mindar.html）。画面の共通部分は ar-core.js、ここは MindAR での認識だけ
import * as THREE from 'three';
// 読み込む順番に意味がある：tracking.js が先。MindAR の2つのファイルはどちらも window.MINDAR.IMAGE に
// 部品を登録するが、tracking.js が使う側は丸ごと置き換え、下の three 用は追記する。逆順だと追記分が消える
import { TRACKING_DEFAULTS, trackingStats, installTracking, addTrackingLevels } from './tracking.js';
import { ZOOM_PURPOSE, ZOOM_SIZES } from './trackpoints.js';
import { MindARThree } from '../lib/mindar/mindar-image-three.prod.js';
import { url, addLights, syncLineResolution } from './common.js';
import { MIND_FILE } from './catalog.js';
import { PoseStabilizer } from './stabilizer.js';
import { runArPage } from './ar-core.js';

// 図面は近いほど見つけやすい（擬似映像での成功率：画面いっぱい約9割、画面幅の半分では約3割）
const SCAN_HINT = '図面が画面いっぱいになるように近づけてください';
const HOLD_HINT = '図面を見失いました。図面を画面いっぱいに映すと再開します';

let mindar = null;
let core = null;
let tracking = { ...TRACKING_DEFAULTS };
const debug = new URLSearchParams(location.search).has('debug');

const engine = {
  scanHint: SCAN_HINT,
  holdHint: HOLD_HINT,
  start,
  restart,
  view: () => ({ dom: mindar.renderer.domElement, camera: mindar.camera }),
  isTracking: (st) => st.anchor.visible,
  isShowing: (st) => st.stabilizer.ready,
  onModelsLoaded: noteModelHeight,
  handle: { get mindar() { return mindar; }, get heals() { return heals; }, restart, tracking, stats: trackingStats },
};

/* ---------- 図面ごとの置き場所 ---------- */

function makeMindStage(target) {
  const anchor = mindar.addAnchor(target.index); // MindAR が出す生の姿勢（そのままでは細かく揺れる）
  const st = core.makeStage(target, { anchor, stabilizer: new PoseStabilizer(tracking) });
  mindar.scene.add(st.root);                     // なめらかにした姿勢。モデルはこちらに入れる
  st.stabilizer.camera = mindar.camera;          // 手ブレの遊びを、画面の大きさに対する割合で測るため
  anchor.onTargetFound = () => core.onFound(st);
  anchor.onTargetLost = () => core.onLost(st, tracking.hold && st.slots.some((s) => s.model) ? HOLD_HINT : SCAN_HINT);
  return st;
}

// モデルが図面の面からいちばん離れる所の高さ（図面の幅を1とした長さ、下向きは負）を、手ブレの遊びの測り方に教える。
// 深いモデルほど、向きのわずかな揺れで底の方が大きく動いて見えるため
function noteModelHeight(st) {
  const box = new THREE.Box3();
  const toRoot = new THREE.Matrix4();
  st.root.updateWorldMatrix(true, false);
  toRoot.copy(st.root.matrixWorld).invert();
  let z = 0;
  for (const s of st.slots) {
    if (!s.model) continue;
    s.place.updateWorldMatrix(false, true);
    box.setFromObject(s.place).applyMatrix4(toRoot);
    if (box.isEmpty()) continue;
    if (-box.min.z > Math.abs(z)) z = box.min.z;
    if (box.max.z > Math.abs(z)) z = box.max.z;
  }
  if (z) st.stabilizer.probeZ = Math.max(-0.5, Math.min(0.5, z));
}

/* ---------- 描画 ---------- */

let lastRender = 0;
function render(now) {
  const dt = Math.min((now - lastRender) / 1000, 0.1);
  lastRender = now;
  for (const st of core.stages) {
    const live = st.anchor.visible ? st.anchor.group.matrix : null;
    st.stabilizer.update(live, dt, now);
    st.root.visible = st === core.active && st.stabilizer.ready && st.slots.some((s) => s.model);
    if (st.root.visible) st.stabilizer.applyTo(st.root);
  }
  syncLineResolution(mindar.renderer);
  mindar.renderer.render(mindar.scene, mindar.camera);
  watchdog(now);
  if (debug) updateDebug(now);
}

// 追跡の処理が止まった・例外が続くときは、追跡だけを作り直す（カメラはそのまま）
let healedAt = -1e9;
let heals = 0;
function watchdog(now) {
  if (!core.running) return;
  const t = trackingStats;
  if (t.errorStreak < 5 && now - t.lastFrameAt < tracking.stallMs) return;
  if (now - healedAt < 8000) {
    // 作り直した直後にまた止まった：自動では直せない
    if (now - healedAt > 3000) { core.showHint('追跡が止まりました。「探し直す」を押してください'); core.$('recover').hidden = false; }
    return;
  }
  healedAt = now; heals += 1;
  const controller = mindar.controller;
  controller.stopProcessVideo();
  // MindAR 側の「見えている」という記録を消してから始め直す
  core.stages.forEach((st) => { if (st.anchor.visible) controller.onUpdate({ type: 'updateMatrix', targetIndex: st.target.index, worldMatrix: null }); });
  t.errorStreak = 0; t.lastFrameAt = performance.now();
  controller.processVideo(mindar.video);
}

// ?debug=1 を付けると、追跡の状態を画面に出す（実機での調整用）
let debugBox = null;
let debugAt = 0;
let renderCount = 0;
let renderFps = 0;
function updateDebug(now) {
  renderCount += 1;
  if (now - debugAt < 500) return;
  renderFps = (renderCount * 1000) / (now - debugAt);
  renderCount = 0; debugAt = now;
  if (!debugBox) {
    debugBox = document.createElement('pre');
    debugBox.className = 'debug';
    document.body.append(debugBox);
  }
  const t = trackingStats;
  const v = mindar.video;
  const { active } = core;
  debugBox.textContent = [
    `状態 ${t.state}${active && active.stabilizer.held ? '（固定表示）' : active && active.stabilizer.holding ? '（手ブレの遊びの中）' : ''}`,
    `認識 ${t.fps.toFixed(1)}回/秒  描画 ${renderFps.toFixed(0)}回/秒`,
    `手がかり ${t.points}点（表示中の最少 ${Number.isFinite(t.minPointsSeen) ? t.minPointsSeen : '-'}）`,
    `見本 ${t.level || '-'}（持っている段 ${t.levels || '-'}）  やり直し ${t.retries}  粗→細 ${t.coarse}`,
    `段の合い方 ${t.scores || '-'}  替えた ${t.switches}  傾き直し ${t.flips}`,
    `直近の試し ${(t.tryLog || []).join(' ')}`,
    `発見 ${t.detections}  却下 ${t.rejected}`,
    `探索 ${Object.keys(t.tries).map((k) => `${k} ${t.hits[k] || 0}/${t.tries[k]}`).join('  ')}`,
    `探し直し ${t.fallbacks}  見失い ${t.lost}  作り直し ${heals}`,
    `エラー ${t.errors}${t.lastError ? ` ${t.lastError.slice(0, 40)}` : ''}${performance.now() - t.lastFrameAt > 2500 ? '  ※処理停止中' : ''}`,
    `映像 ${v ? `${v.videoWidth}×${v.videoHeight}` : '-'}  画素比 ${mindar.renderer.getPixelRatio()}`,
  ].join('\n');
}

/* ---------- 起動 ---------- */

// 端末を回すとカメラ映像の縦横が入れ替わるので、認識を作り直す
let restartTimer = null;
function scheduleRestart() {
  if (!core.running) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, 350);
}
// カメラと追跡を最初から作り直す（ページの再読み込みに近いが、モデルや情報パネルは残る）
async function restart() {
  if (!core.running) return;
  core.running = false;
  core.$('recover').hidden = true;
  core.showHint('探し直しています…');
  mindar.renderer.setAnimationLoop(null);
  try {
    mindar.stop();
    core.stages.forEach((st) => { st.stabilizer.reset(); st.anchor.visible = false; }); // 前の姿勢は捨てる
    await mindar.start();
    trackingStats.errorStreak = 0; trackingStats.lastFrameAt = performance.now();
    mindar.renderer.setAnimationLoop(render);
    core.running = true;
    core.showHint(SCAN_HINT);
  } catch (err) {
    core.showHint('カメラを再開できません。ページを読み込み直してください');
  }
}

async function start(c) {
  core = c;
  const { catalog } = core;
  // 追跡の設定：既定値 ← 台帳の tracking ← URL（例 ar-mindar.html?debug=1&stillCutoff=0.3）
  Object.assign(tracking, catalog.tracking || {});
  const query = new URLSearchParams(location.search);
  for (const key of Object.keys(TRACKING_DEFAULTS)) {
    if (query.has(key) && Number.isFinite(Number(query.get(key)))) tracking[key] = Number(query.get(key));
  }
  installTracking(tracking);

  mindar = new MindARThree({
    container: core.stageEl,
    imageTargetSrc: url(MIND_FILE),
    maxTrack: 1,
    uiLoading: 'no', uiScanning: 'no', uiError: 'no',
    warmupTolerance: tracking.warmupTolerance,
  });
  mindar.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mindar.renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    core.showHint('表示が止まりました。ページを読み込み直してください');
  });
  addLights(mindar.scene);
  catalog.targets.forEach(makeMindStage);
  catalog.items.forEach((it) => {
    const st = core.stages[it.targetIndex];
    Object.assign(core.makeSlot(st, it), { anchor: st.anchor, stabilizer: st.stabilizer }); // 確認用の近道
  });

  try {
    await mindar.start();
  } catch (err) {
    throw new Error('カメラを起動できませんでした。ブラウザの設定でこのページのカメラ使用を許可してください。');
  }
  mindar.renderer.setAnimationLoop(render);
  checkMindFile();
  prepareZoomLevels();

  window.addEventListener('orientationchange', scheduleRestart);
  if (screen.orientation) screen.orientation.addEventListener('change', scheduleRestart);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !core.running) return;
    trackingStats.lastFrameAt = performance.now(); // 画面を離れていた時間を「処理が止まった」と数えない
    if (mindar.video && mindar.video.paused) mindar.video.play().catch(() => {});
  });
}

// 近づいて見るための細かい見本。all.mind に入っていなければ（MindAR 公式のページで作った all.mind など）、
// 図面画像から別の処理で作り、できた段から使う。そのあいだも標準の見本で追跡は続く
let zoomWorkerStarted = false;
function prepareZoomLevels() {
  if (zoomWorkerStarted || !tracking.multiLevel) return;
  zoomWorkerStarted = true;
  const lists = (mindar.controller.tracker && mindar.controller.tracker.trackingDataList) || [];
  core.catalog.targets.forEach((t, i) => {
    if (!lists[i] || lists[i].some((k) => k.purpose === ZOOM_PURPOSE)) return;
    let worker;
    try { worker = new Worker(new URL('./levels-worker.js', import.meta.url), { type: 'module' }); } catch (err) { console.warn('細かい見本を作れません', err); return; }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.level) addTrackingLevels(m.targetIndex, [m.level]);
      if (m.error) console.warn(`細かい見本を作れません：${m.error}`);
      if (m.done || m.error) { if (m.done) console.info(`図面「${t.id}」の細かい見本を作りました（${m.ms}ms）`); worker.terminate(); }
    };
    worker.postMessage({ url: url(t.source), targetIndex: i, sizes: ZOOM_SIZES });
  });
}

// all.mind と図面画像（image.jpg）の食い違いを知らせる。片方だけ差し替えると、認識しないかモデルがずれる
function checkMindFile() {
  const dims = (mindar.controller && mindar.controller.markerDimensions) || [];
  const { targets } = core.catalog;
  const problems = [];
  if (dims.length !== targets.length) {
    problems.push(`認識データ（all.mind）の図面は${dims.length}枚、台帳の図面は${targets.length}枚です`);
  }
  targets.forEach((t, i) => {
    if (!dims[i]) return;
    const [w, h] = dims[i];
    if (Math.abs((h / w) / (t.heightPx / t.widthPx) - 1) > 0.01) {
      problems.push(`図面「${t.title || t.id}」：all.mind は ${w}×${h}、図面画像は ${t.widthPx}×${t.heightPx} で縦横比が違います`);
    }
  });
  if (!problems.length) return;
  console.warn(problems.join('\n'));
  const box = core.$('config-warn');
  box.textContent = `${problems.join('。')}。all.mind を図面画像から作り直してください（管理用ページ tools/ の「1. 認識用データを作る」）`;
  box.hidden = false;
}

runArPage(engine);
