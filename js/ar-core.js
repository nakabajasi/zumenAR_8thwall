// AR 画面の共通部分（認識の仕組みによらない部分）。
// 図面ごとの置き場所（stage）と資料ごとのモデル（slot）、情報パネル、指の操作、ボタン。
// 認識の仕組み（8th Wall／MindAR）は engine として渡す。engine がすること：
//   beforeStart()            開始ボタンを押した直後（同期で。iPhone のセンサーの許可はここでしか求められない）
//   start(core, target)      カメラと認識を始め、core.makeStage() で図面ごとの置き場所を作る
//   restart()                「探し直す」
//   view()                   { dom, camera }（たたいた所のモデルを調べるのに使う）
//   isTracking(st)           その図面がいまカメラに写って認識できているか
//   isShowing(st)            その図面のモデルを表示できる状態か（見失っても場所を覚えていれば true）
//   onModelsLoaded(st)       その図面のモデルを読み込み終えたとき（任意）
//   handle                   確認用に window.__ar へ出すもの（任意）
import * as THREE from 'three';
import {
  loadCatalog, itemFromQuery, targetFromQuery, isInAppBrowser, loadItemObject,
  buildAnnotations, pickAnnotation, pickModel, placePosition, buildPose, displayMode, findEntry,
} from './common.js';
import { createPanel } from './panel.js';
import { loadAnnotationData } from './annotations.js';
import { fetchOptional } from './catalog.js';

const $ = (id) => document.getElementById(id);
const MAX_LOADED = 6;     // 同時に持つモデルの数の上限（iPhoneのメモリ不足を避ける）。いま見ている図面の分は必ず持つ

export function runArPage(engine) {
  const stageEl = $('stage');
  const hint = $('hint');
  const showHint = (text) => { hint.textContent = text || ''; hint.hidden = !text; };

  const core = {
    $, showHint, flash, stageEl,
    stages: [],          // 図面ごとの置き場所
    slots: [],           // 資料ごとのモデル
    active: null,        // いま見ている図面
    current: null,       // いま情報パネルに出している資料
    catalog: null,
    preferred: null,     // QR や一覧で指定された資料
    seeThrough: false,
    shapeMode: false,
    running: false,
    makeStage, makeSlot, ensureLoaded, select, onFound, onLost,
  };
  let panel = null;
  let pendingNote = null;  // リンクで指定された注記（レイヤーの uid.番号）

  /* ---------- 図面と資料 ---------- */

  // 図面ごとの置き場所。root に入れたものは、図面の中心を原点・図面の幅を1・図面の面を XY（Z が紙から上）とした座標で置かれる
  function makeStage(target, extra = {}) {
    const root = new THREE.Group();
    root.visible = false;
    const st = { target, root, slots: [], usedAt: 0, toldTap: false, ...extra };
    core.stages.push(st);
    return st;
  }

  function makeSlot(st, item) {
    const place = new THREE.Group();   // 図面の上の置き場所
    place.position.copy(placePosition(item));
    place.visible = false;
    const user = new THREE.Group();    // 指での回転・拡大
    place.add(user);
    st.root.add(place);
    const slot = {
      item, stage: st, place, user, mode: displayMode(item), root: st.root,
      pose: null, model: null, annotations: null, meta: null, loading: null,
    };
    st.slots.push(slot);
    core.slots.push(slot);
    return slot;
  }

  function ensureLoaded(slot) {
    if (slot.model) return Promise.resolve(slot);
    if (slot.loading) return slot.loading;
    const { item } = slot;
    slot.loading = Promise.all([
      loadItemObject(item, (p) => { if (!core.active || core.active === slot.stage) showHint(`モデルを読み込み中… ${Math.round(p * 100)}%`); }),
      item.meta ? fetchOptional(item.meta).catch(() => null) : null,
      loadAnnotationData(item).catch((err) => { console.warn(err); return null; }),
    ]).then(([model, meta, annoData]) => {
      const pose = buildPose(item, model);
      slot.place.position.copy(placePosition(item));   // モデルの座標で置く資料は、読み込んで初めて置き場所が決まる
      slot.user.add(pose);
      const annotations = buildAnnotations(annoData, model.maxDim);
      model.raw.add(annotations.group);
      model.setSeeThrough(core.seeThrough);
      if (core.shapeMode) model.setMode('shape');
      Object.assign(slot, { model, meta, annotations, pose, loading: null });
      slot.place.visible = true;
      if (engine.onModelsLoaded) engine.onModelsLoaded(slot.stage);
      return slot;
    }).catch((err) => {
      slot.loading = null;
      console.error(err);
      showHint(`モデルを読み込めません：${err.message}`);
      throw err;
    });
    return slot.loading;
  }

  // 見ていない図面のモデルから、古い順に捨てる
  function releaseFor(keep) {
    const others = core.stages.filter((st) => st !== keep).sort((a, b) => a.usedAt - b.usedAt);
    const count = () => core.slots.filter((s) => s.model).length;
    for (const st of others) {
      for (const s of st.slots) {
        if (count() <= MAX_LOADED) return;
        if (!s.model || s === core.current) continue;
        s.user.remove(s.pose);
        s.annotations.dispose();
        s.model.dispose();
        s.model = s.annotations = s.pose = null;
        s.place.visible = false;
      }
    }
  }

  /* ---------- 認識の開始・終了 ---------- */

  function select(slot) {
    if (!slot || !slot.model) return;
    if (core.current && core.current !== slot && core.current.annotations) core.current.annotations.select(null);
    core.current = slot;
    panel.setItem(slot.item, slot.meta);
    panel.setSiblings(slot.stage.slots.filter((s) => s.model).map((s) => s.item), slot.item);
    panel.setLayers(slot.annotations.layers);
    $('panel').hidden = false;
    $('btn-reset').hidden = !movable(slot);
    if (pendingNote) {
      const entry = findEntry(slot.annotations, pendingNote);
      if (entry) { pendingNote = null; slot.annotations.select(entry); panel.showSelection(entry); }
    }
  }

  let flashTimer = null;
  function flash(text, ms) {
    showHint(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (hint.textContent === text) showHint(''); }, ms);
  }

  // 図面を認識したとき（engine が呼ぶ）
  function onFound(st) {
    $('recover').hidden = true;
    st.usedAt = performance.now();
    core.active = st;
    showHint('');
    Promise.allSettled(st.slots.map(ensureLoaded)).then(() => {
      if (core.active !== st) return;
      releaseFor(st);
      if (!core.current || core.current.stage !== st || !core.current.model) {
        const want = st.slots.find((s) => s.item === core.preferred && s.model) || st.slots.find((s) => s.model);
        select(want);
      }
      if (!engine.isTracking(st)) showHint(engine.isShowing(st) ? engine.holdHint : engine.scanHint);
      else if (st.slots.filter((s) => s.model).length > 1 && !st.toldTap) {
        st.toldTap = true;
        flash('モデルをたたくと資料を切り替えます', 3500);
      } else showHint('');
    });
  }

  // 図面を見失ったとき（engine が呼ぶ）。text はそのとき出す案内（空なら出さない）
  function onLost(st, text, offerRescan = true) {
    // パネルは残す（図面から目を離しても情報を読み続けられるように）
    if (core.active !== st) return;
    showHint(text);
    if (offerRescan) $('recover').hidden = false; // 戻しても再開しないときに、読み込み直さずやり直せるようにする
  }

  /* ---------- 指の操作 ---------- */

  // 指で回したり大きさを変えたりしてよい資料か。図面に重ねる資料（plan）は、図面と同じ位置・縮尺・向きで
  // 見せるのが目的なので動かさない（位置合わせを見る人に任せる作りにはしない）
  function movable(slot) { return !!(slot && slot.model && slot.mode !== 'plan'); }

  function setupGestures(el) {
    const pointers = new Map();
    let pinch = null;
    let tap = null;

    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, dragging: false });
      tap = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
      const cur = core.current;
      pinch = pointers.size === 2 && movable(cur) ? { dist: spread(), scale: cur.user.scale.x } : null;
    });

    el.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      p.x = e.clientX; p.y = e.clientY;
      const cur = core.current;
      if (!movable(cur)) return;   // 図面に重ねる資料は、指では動かさない
      if (pointers.size === 1) {
        // 横にはっきりなぞったとき（12画素以上）だけ、モデルの軸まわりに回る。たたいたときの指のぶれでは回さない
        if (!p.dragging) { if (Math.abs(e.clientX - p.sx) < 12) return; p.dragging = true; }
        const axis = cur.mode === 'lay' ? 'y' : 'z';
        cur.user.rotation[axis] += dx * 0.01;
      } else if (pinch) {
        const s = THREE.MathUtils.clamp(pinch.scale * (spread() / pinch.dist), 0.3, 4);
        cur.user.scale.setScalar(s);
      }
    });

    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      pinch = null;
      if (e.type !== 'pointerup' || !tap) return;
      const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
      const quick = e.timeStamp - tap.t < 400; // 処理が混んでいても正しく測れるよう、指が触れた時刻そのもので比べる
      tap = null;
      const { active } = core;
      if (moved > 8 || !quick || !active || !active.root.visible) return;
      const { dom, camera } = engine.view();
      // 別のモデルをたたいたら、その資料に切り替える
      const hit = pickModel(e.clientX, e.clientY, dom, camera, active.slots);
      if (hit && hit !== core.current) select(hit);
      const cur = core.current;
      if (!cur || !cur.model) return;
      const entry = pickAnnotation(e.clientX, e.clientY, dom, camera, cur.annotations, cur.model);
      cur.annotations.select(entry);
      panel.showSelection(entry);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /* ---------- 起動 ---------- */

  async function main() {
    core.catalog = await loadCatalog();
    const { catalog } = core;
    core.preferred = itemFromQuery(catalog);
    // 図面が1枚だけなら、指定がなくてもその図面のモデルを先に読み込む
    const preferredTarget = (core.preferred && core.preferred.drawing) || targetFromQuery(catalog)
      || (catalog.targets.length === 1 ? catalog.targets[0] : null);
    pendingNote = new URLSearchParams(location.search).get('note');
    if (core.preferred) $('link-viewer').href = `viewer.html?id=${encodeURIComponent(core.preferred.id)}`;
    else if (preferredTarget && preferredTarget.items[0]) $('link-viewer').href = `viewer.html?id=${encodeURIComponent(preferredTarget.items[0].id)}`;
    if (isInAppBrowser()) $('inapp').hidden = false;

    panel = createPanel($('panel'), {
      onLayerToggle: (layer, on) => { layer.object.visible = on; },
      onClearSelection: () => { if (core.current && core.current.annotations) core.current.annotations.select(null); panel.showSelection(null); },
      onPickItem: (item) => select(core.slots.find((s) => s.item === item)),
      edition: catalog.site.edition,
      cite: catalog.site.cite,
    });

    // 表示の切り替えは、読み込んであるモデルすべてにかける
    const loaded = () => core.slots.filter((s) => s.model);
    $('btn-mode').addEventListener('click', () => {
      core.shapeMode = !core.shapeMode;
      loaded().forEach((s) => s.model.setMode(core.shapeMode ? 'shape' : 'photo'));
      $('btn-mode').setAttribute('aria-pressed', String(core.shapeMode));
    });
    $('btn-see').addEventListener('click', () => {
      core.seeThrough = !core.seeThrough;
      loaded().forEach((s) => s.model.setSeeThrough(core.seeThrough));
      $('btn-see').setAttribute('aria-pressed', String(core.seeThrough));
    });
    $('btn-rescan').addEventListener('click', () => (core.running ? engine.restart() : location.reload()));
    $('btn-reset').addEventListener('click', () => {
      if (!core.active) return;
      for (const s of core.active.slots) { s.user.rotation.set(0, 0, 0); s.user.scale.setScalar(1); }
    });

    const startBtn = $('btn-start');
    const errorBox = $('gate-error');
    startBtn.addEventListener('click', async () => {
      if (engine.beforeStart) engine.beforeStart();
      startBtn.disabled = true;
      startBtn.textContent = '準備中…';
      errorBox.hidden = true;
      try {
        if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('このブラウザではカメラを使えません。SafariかChromeで開いてください。');
        }
        stageEl.innerHTML = ''; // やり直しのときに前回の映像・描画面を残さない
        await engine.start(core, preferredTarget);
        core.running = true;
        setupGestures(stageEl);
        // QRで図面や資料を指定して開いた場合は、認識を待たずにその図面のモデルを先に読み込んでおく
        const first = preferredTarget ? core.stages[preferredTarget.index] : null;
        if (first) Promise.allSettled(first.slots.map(ensureLoaded)).then(() => { if (!core.active) showHint(engine.scanHint); });
        $('gate').hidden = true;
        $('topbar').hidden = false;
        if (!core.current) showHint(engine.scanHint);
      } catch (err) {
        console.error(err);
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        startBtn.disabled = false;
        startBtn.textContent = 'もう一度試す';
      }
    });

    window.__ar = { // 確認用
      core, get stages() { return core.stages; }, get slots() { return core.slots; },
      get active() { return core.active; }, get current() { return core.current; }, select,
    };
    Object.defineProperties(window.__ar, Object.getOwnPropertyDescriptors(engine.handle || {}));
  }

  main().catch((err) => {
    console.error(err);
    $('gate-error').textContent = `準備できません：${err.message}`;
    $('gate-error').hidden = false;
    $('btn-start').disabled = true;
  });
  return core;
}
