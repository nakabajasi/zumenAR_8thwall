// 通常の3D表示。カメラが使えない端末、図面を持っていない人（共有リンクで開いた人）、認識できなかったときの逃げ先。
// 平面図に重ねる資料（display.mode = plan）では、図面画像（image.jpg）を敷き、AR と同じ位置・縮尺・方位で図面の上に置く
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  url, loadCatalog, itemFromQuery, fetchJson, loadItemObject, addLights, buildAnnotations, pickAnnotation,
  syncLineResolution, placePosition, buildPose, displayMode, findEntry,
} from './common.js';
import { createPanel } from './panel.js';
import { loadAnnotationData } from './annotations.js';
import { fetchOptional } from './catalog.js';
import { shareUrl } from './catalog.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const hint = $('hint');
const showHint = (text) => { hint.textContent = text || ''; hint.hidden = !text; };

function loadTexture(path) {
  return new Promise((resolve, reject) => new THREE.TextureLoader().load(url(path), resolve, undefined, () => reject(new Error(`${path} を読み込めません`))));
}

async function main() {
  const catalog = await loadCatalog();
  const item = itemFromQuery(catalog) || catalog.items[0];
  if (!item) throw new Error('台帳に資料がありません');
  const note = new URLSearchParams(location.search).get('note');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 2000);
  const lights = addLights(scene);
  camera.add(lights.key); // 光はカメラについて回る（どの向きでも左上から当たる）
  scene.add(camera);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 30;

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const drawing = item.drawing;
  const withSheet = displayMode(item) === 'plan' && !!drawing.viewerImage;
  const [model, meta, annoData, sheetTexture] = await Promise.all([
    loadItemObject(item, (p) => showHint(`読み込み中… ${Math.round(p * 100)}%`)),
    item.meta ? fetchOptional(item.meta).catch(() => null) : null,
    loadAnnotationData(item).catch((err) => { console.warn(err); return null; }),
    withSheet ? loadTexture(drawing.viewerImage).catch(() => null) : null,
  ]);
  showHint('');
  const annotations = buildAnnotations(annoData, model.maxDim);
  model.raw.add(annotations.group);

  // 図面ごと置く：図面の座標（紙が xy 面）を、紙が水平になるよう倒し、モデルの最大寸法が 1 になる大きさにする
  let sheetPlane = null;
  if (withSheet) {
    const sheet = new THREE.Group();
    sheet.rotation.x = -Math.PI / 2;
    const pose = buildPose(item, model);
    const place = new THREE.Group();
    place.position.copy(placePosition(item));
    place.add(pose);
    sheet.add(place);
    sheet.scale.setScalar(1 / pose.scale.x);
    sheet.position.copy(place.position).multiplyScalar(-1 / pose.scale.x).applyAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    if (sheetTexture) {
      sheetTexture.colorSpace = THREE.SRGBColorSpace;
      sheetTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const aspect = drawing.heightPx / drawing.widthPx;
      // 紙はモデルを隠さない（AR と同じ見え方にする）
      const mat = new THREE.MeshBasicMaterial({ map: sheetTexture, depthWrite: false, side: THREE.DoubleSide });
      sheetPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, aspect), mat);
      sheetPlane.renderOrder = -1;
      sheet.add(sheetPlane);
    }
    scene.add(sheet);
  } else {
    scene.add(model.unit);
  }
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model.raw.children[0]);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;

  function frame(target, r) {
    // 縦長の画面では横幅が先に切れるので、その分だけ引く
    const fit = Math.max(1, 0.95 / camera.aspect);
    const dist = (r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.05 * fit;
    const dir = withSheet ? new THREE.Vector3(0, 0.92, 0.38) : new THREE.Vector3(0.42, 0.28, 0.86); // 図面は北を上に、南からやや斜めに見下ろす
    camera.position.copy(target).addScaledVector(dir.normalize(), dist);
    controls.target.copy(target);
    controls.update();
  }
  const resetView = () => frame(center, radius);
  resetView();

  const panelEl = $('panel');
  const panel = createPanel(panelEl, {
    onLayerToggle: (layer, on) => { layer.object.visible = on; },
    onClearSelection: () => { annotations.select(null); panel.showSelection(null); },
    onPickItem: (it) => { location.href = shareUrl('viewer.html', { id: it.id }); },
    edition: catalog.site.edition,
    cite: catalog.site.cite,
  });
  panel.setItem(item, meta);
  panel.setSiblings(drawing.items, item);
  panel.setLayers(annotations.layers);
  panelEl.hidden = false;

  // 共有リンクで注記が指定されていたら、その注記を選んで寄る
  const focus = findEntry(annotations, note);
  if (focus) {
    annotations.select(focus);
    panel.showSelection(focus);
    const box = new THREE.Box3();
    for (const o of [focus.visual, ...(focus.lines || []), focus.fill]) if (o) box.expandByObject(o);
    const at = box.getCenter(new THREE.Vector3());
    frame(at, radius * 0.6);
  }

  const modeBtn = $('btn-mode');
  modeBtn.addEventListener('click', () => {
    const shape = model.mode !== 'shape';
    model.setMode(shape ? 'shape' : 'photo');
    modeBtn.setAttribute('aria-pressed', String(shape));
  });
  const seeBtn = $('btn-see');
  seeBtn.addEventListener('click', () => {
    model.setSeeThrough(!model.seeThrough);
    seeBtn.setAttribute('aria-pressed', String(model.seeThrough));
  });
  const sheetBtn = $('btn-sheet');
  if (sheetPlane) {
    sheetBtn.hidden = false;
    sheetBtn.addEventListener('click', () => {
      sheetPlane.visible = !sheetPlane.visible;
      sheetBtn.setAttribute('aria-pressed', String(sheetPlane.visible));
    });
  }
  $('btn-reset').addEventListener('click', resetView);

  // 軽くたたいた（動かしていない）ときだけアノテーションを選ぶ
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = e.timeStamp - down.t < 400;
    down = null;
    if (moved > 8 || !quick) return;
    const entry = pickAnnotation(e.clientX, e.clientY, renderer.domElement, camera, annotations, model);
    annotations.select(entry);
    panel.showSelection(entry);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    syncLineResolution(renderer);
    renderer.render(scene, camera);
  });
  window.__viewer = { model, annotations, camera, controls, sheetPlane, focus }; // 確認用
}

main().catch((err) => { console.error(err); showHint(`表示できません：${err.message}`); });
