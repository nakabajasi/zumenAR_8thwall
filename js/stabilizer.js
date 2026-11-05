// 表示側で姿勢をなめらかにする。MindAR が出す生の姿勢は細かく揺れ、見失うと消えるので、
// モデルはこの結果で動かす。
//
// 2段で処理する。
// 1. ならし：動きの速さを見て、ならす強さを変える。
//      手を止めている … 強くならす（揺れを止める）
//      動かしている   … 弱くならす（遅れずについてくる）
//    速さは1回ごとの差ではなく、ならした値で見る。1回ごとの差は揺れそのものなので、
//    それで判断すると「揺れ＝動いている」と誤解して揺れを素通しにしてしまう。
// 2. 手ブレの遊び（shakeHold）：ならした姿勢が、表示中のモデルの位置から画面の上で shakeHold（画面の短辺の％）
//    以内しかずれていなければ、モデルは動かさない（ゆっくり寄せるだけ）。それを超えた分だけ動かす。
//    手ブレや認識の細かな揺れではモデルが画面の上で止まって見える代わりに、
//    図面とモデルが最大 shakeHold だけずれることがある（手を止めると、ゆっくり図面に戻る）。
//    ずれは「いま見ている画面の中央あたりの図面の上」と「モデルの深さ」の両方で測る。
import * as THREE from 'three';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const TWO_PI = Math.PI * 2;
const alpha = (cutoffHz, dt) => 1 - Math.exp(-TWO_PI * cutoffHz * dt);
const DEFAULT_TAN = 240 / 772.5;   // 画面の短辺の半分の見込み角の tan（カメラの情報が無いとき。MindAR の既定の画角）

export class PoseStabilizer {
  constructor(cfg) {
    this.cfg = cfg;
    this.position = new THREE.Vector3();    // 表示するモデルの姿勢
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3(1, 1, 1);
    this.ready = false;     // 一度でも姿勢が得られたか
    this.held = false;      // 見失って、最後の姿勢のまま表示しているか
    this.camera = null;     // 画面の大きさ（画角）を知るためのカメラ。無ければ MindAR の既定の画角とみなす
    this.probeZ = -0.05;    // モデルのいちばん深い（高い）所の、図面の面からの高さ（図面の幅を1とした長さ。下向きは負）。
                            // 図面から離れた点ほど、向きの揺れで大きく動くので、そこでも測る
    this.holding = false;   // 遊びの中で止めているか（確認用）
    this._fP = new THREE.Vector3();         // ならした姿勢
    this._fQ = new THREE.Quaternion();
    this._lastP = new THREE.Vector3();    // 直前に受け取った生の姿勢
    this._lastQ = new THREE.Quaternion();
    this._lastAt = 0;
    this._velP = new THREE.Vector3();     // ならした速さ（位置：カメラから見た角度/秒、向き：ラジアン/秒）
    this._velQ = new THREE.Vector3();
    this._key = NaN;
    this._flipSince = 0;
  }

  reset() { this.ready = false; this.held = false; }

  // matrix：MindAR が出した最新の姿勢（見失っているときは null）、dt：前の描画からの秒数、now：ミリ秒
  update(matrix, dt, now) {
    if (!matrix) {
      this.held = this.ready;
      if (!this.cfg.hold) this.ready = false;
      return;
    }
    const e = matrix.elements;
    const key = e[12] + e[13] * 3 + e[14] * 7 + e[0] * 11 + e[5] * 13 + e[9] * 17;
    const fresh = key !== this._key;   // 追跡は描画より遅いので、同じ姿勢が何コマか続く
    this._key = key;
    matrix.decompose(_p, _q, _s);

    if (!this.ready || this.held) {
      // 初回と、見失いからの復帰直後は、新しい姿勢へそのまま合わせる
      this._fP.copy(_p); this._fQ.copy(_q); this.scale.setScalar((_s.x + _s.y + _s.z) / 3);
      this.position.copy(_p); this.quaternion.copy(_q);
      this._lastP.copy(_p); this._lastQ.copy(_q); this._lastAt = now;
      this._velP.set(0, 0, 0); this._velQ.set(0, 0, 0);
      this.ready = true; this.held = false; this._flipSince = 0; this.holding = false;
      return;
    }
    // 大きさは本来一定（図面の幅）。生の値は軸ごとにわずかにばらつくので、平均してゆっくり合わせる
    const size = (_s.x + _s.y + _s.z) / 3;
    this.scale.setScalar(this.scale.x + (size - this.scale.x) * alpha(this.cfg.stillCutoff, dt));

    // 向きが一瞬だけ大きく跳ぶこと（平面の姿勢推定で起きる裏返り）があるので、
    // ならした向きから25°を超える変化は、0.25秒続くまで採用しない
    if (this._fQ.angleTo(_q) > 0.44) {
      if (!this._flipSince) this._flipSince = now;
      if (now - this._flipSince < 250) return;
    } else {
      this._flipSince = 0;
    }

    if (fresh) {
      const gap = Math.max((now - this._lastAt) / 1000, 1 / 120);
      const a = alpha(this.cfg.speedCutoff, gap);
      // 位置の速さ：カメラからの距離で割り、見かけの角度で測る
      _v.copy(_p).sub(this._lastP).multiplyScalar(1 / (Math.max(_p.length(), 1e-6) * gap));
      this._velP.lerp(_v, a);
      // 向きの速さ：前回からの回転を、軸×角度のベクトルにして測る
      _dq.copy(this._lastQ).invert().premultiply(_q);
      if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
      const half = Math.acos(Math.min(1, _dq.w));
      const sin = Math.sin(half);
      const k = sin > 1e-6 ? (2 * half) / (sin * gap) : 0;
      _v.set(_dq.x * k, _dq.y * k, _dq.z * k);
      this._velQ.lerp(_v, a);
      this._lastP.copy(_p); this._lastQ.copy(_q); this._lastAt = now;
    }

    const { stillCutoff, posFollow, rotFollow } = this.cfg;
    this._fP.lerp(_p, alpha(stillCutoff + posFollow * this._velP.length(), dt));
    this._fQ.slerp(_q, alpha(stillCutoff + rotFollow * this._velQ.length(), dt));

    const hold = (this.cfg.shakeHold || 0) / 100;
    if (!(hold > 0)) {
      this.position.copy(this._fP); this.quaternion.copy(this._fQ); this.holding = false;
      return;
    }
    // 手ブレの遊び：表示中の姿勢とならした姿勢の、画面の上でのずれ（短辺に対する割合）
    const gap = this.screenGap();
    if (gap > hold) {
      // 遊びを超えた分だけ動かす（動かしているあいだは、遊びの幅だけ遅れてついてくる）
      const t = 1 - hold / gap;
      this.position.lerp(this._fP, t); this.quaternion.slerp(this._fQ, t);
      this.holding = false;
    } else {
      this.holding = true;
    }
    // 遊びの中でも、ゆっくり図面に寄せる（手ブレは行ったり来たりなので、ゆっくり寄せれば打ち消し合う）
    const r = alpha(this.cfg.shakeSettle ?? 0.5, dt);
    this.position.lerp(this._fP, r); this.quaternion.slerp(this._fQ, r);
  }

  // 表示中の姿勢とならした姿勢で、図面の点が画面の上でどれだけ違って見えるか（画面の短辺に対する割合の最大値）。
  // 測る点：画面の中央に写っている図面の点と、そのまわり（画面の短辺の2割ほど離れた4点）、それぞれの紙の上とモデルの深さ
  screenGap() {
    let tanShort = DEFAULT_TAN;
    if (this.camera) {
      const m = this.camera.projectionMatrix.elements;
      if (m[0] > 0 && m[5] > 0) tanShort = Math.min(1 / m[0], 1 / m[5]);
    }
    const s = this.scale.x || 1;
    // 画面の中央を通る視線（カメラは -Z 向き）と、表示中の図面の面の交点を、図面の座標（幅1）で求める
    _a.set(0, 0, 1).applyQuaternion(this.quaternion);       // 図面の面の向き
    const nz = -_a.z;
    let dist = this.position.length();
    _qi.copy(this.quaternion).invert();
    if (Math.abs(nz) > 0.1) {
      const lam = _a.dot(this.position) / nz;
      if (lam > 0) dist = lam;
      _c.set(0, 0, -dist).sub(this.position).applyQuaternion(_qi).multiplyScalar(1 / s);
      _c.z = 0;
      _c.x = Math.min(Math.max(_c.x, -0.5), 0.5); _c.y = Math.min(Math.max(_c.y, -0.5), 0.5);
    } else {
      _c.set(0, 0, 0);
    }
    const spread = (0.2 * dist * tanShort) / s;
    const z = this.probeZ || 0;
    let worst = 0;
    for (const [dx, dy] of [[0, 0], [spread, 0], [-spread, 0], [0, spread], [0, -spread]]) {
      for (const dz of z ? [0, z] : [0]) {
        _v.set(_c.x + dx, _c.y + dy, dz).multiplyScalar(s);
        _a.copy(_v).applyQuaternion(this.quaternion).add(this.position);
        _b.copy(_v).applyQuaternion(this._fQ).add(this._fP);
        if (_a.z > -1e-6 || _b.z > -1e-6) continue;
        const du = _a.x / -_a.z - _b.x / -_b.z, dv = _a.y / -_a.z - _b.y / -_b.z;
        worst = Math.max(worst, Math.hypot(du, dv));
      }
    }
    return worst / (2 * tanShort);
  }

  applyTo(object) {
    object.position.copy(this.position);
    object.quaternion.copy(this.quaternion);
    object.scale.copy(this.scale);
  }
}
