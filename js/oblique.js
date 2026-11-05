// 斜めから見た図面を探すための下ごしらえ。
//
// MindAR が図面を探す方法は、正面に近い見え方を前提にしている。図面を斜めから見ると、
// 奥行き方向がつぶれて目印の見た目が変わり、傾きが45°を超えるあたりからほとんど見つからなくなる。
//
// ここでは「カメラをその場で図面と正対する向きに振り向けたら、どう見えるか」を計算で作る。
// カメラの位置を変えずに向きだけ変えた像は、元の映像を引き伸ばすだけで正確に作れ、
// 図面と正対していれば像にゆがみは残らない。その像で図面を探し、得られた姿勢を元の映像での姿勢に戻す。
// 図面の傾きは事前にはわからないので、いくつかの傾きを仮定して順に試す。
//
// 行列はすべて 3×3 の配列（行の配列）。画像の座標は x が右、y が下。

const mul = (A, B) => A.map((row) => [0, 1, 2].map((c) => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));

function inverse(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const project = (M, x, y) => {
  const w = M[2][0] * x + M[2][1] * y + M[2][2];
  return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w];
};

// 図面の面の向き（カメラから見た法線）がわかっているときに、それと正対する向きを返す
export function facing(normal) {
  let [x, y, z] = normal;
  const len = Math.hypot(x, y, z);
  x /= len; y /= len; z /= len;
  if (z > 0) { x = -x; y = -y; z = -z; }     // カメラ側を向く法線にそろえる
  // 法線を (0, 0, -1) に重ねる最小の回転
  const ax = -y, ay = x;                      // 回転軸 = 法線 × (0,0,-1)
  const sin = Math.hypot(ax, ay), cos = -z;
  if (sin < 1e-6) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const ux = ax / sin, uy = ay / sin, k = 1 - cos;
  return [
    [cos + ux * ux * k, ux * uy * k, uy * sin],
    [ux * uy * k, cos + uy * uy * k, -ux * sin],
    [-uy * sin, ux * sin, cos],
  ];
}

// 図面の奥側が画面の上に来る傾き（机の上の図面を手前から見下ろす向き）
export function tiltTowardTop(deg) {
  const t = (deg * Math.PI) / 180;
  return facing([0, -Math.sin(t), -Math.cos(t)]);
}

// 図面の奥側が画面の左右に来る傾き（壁の図面を横から見る向き）。正の値で右が奥
export function tiltTowardSide(deg) {
  const t = (deg * Math.PI) / 180;
  return facing([Math.sin(t), 0, -Math.cos(t)]);
}

// 姿勢（3×4）から、図面の面の向きと、正面からの傾き（度）を得る
export function planeTilt(T) {
  const r1 = [T[0][0], T[1][0], T[2][0]], r2 = [T[0][1], T[1][1], T[2][1]];
  const n = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const len = Math.hypot(...n) || 1;
  return { normal: n, deg: (Math.acos(Math.min(1, Math.abs(n[2]) / len)) * 180) / Math.PI };
}

/**
 * 正対させた像のうち、探す処理に渡す正方形の範囲（窓）を決める。
 *   K       カメラの内部の値（MindAR が仮定しているもの）
 *   turn    正対する向きへの回転
 *   cx, cy  窓の中心に据える、元の映像上の位置
 *   size    窓の一辺の画素数
 * 戻り値 toCamera：窓の画素 → 元の映像の画素
 */
export function planWindow(K, width, turn, cx, cy, size) {
  const toFacing = mul(mul(K, turn), inverse(K));        // 元の映像 → 正対させた像
  const [vx, vy] = project(toFacing, cx, cy);
  const [vx1] = project(toFacing, cx + 1, cy);
  // 元の映像の横幅いっぱいが、窓の横幅に収まる縮尺にする
  const scale = size / (width * Math.abs(vx1 - vx));
  const windowToFacing = [[1 / scale, 0, vx - size / (2 * scale)], [0, 1 / scale, vy - size / (2 * scale)], [0, 0, 1]];
  return { toCamera: mul(inverse(toFacing), windowToFacing) };
}

// 元の映像（RGBA）から、窓の像を濃淡（0〜255）で作る。映像の外は端の画素を延ばして埋める
export function renderWindow(rgba, srcWidth, srcHeight, toSource, size, out) {
  const [[a, b, c], [d, e, f], [g, h, i]] = toSource;
  const maxX = srcWidth - 1.001, maxY = srcHeight - 1.001;
  let p = 0;
  for (let v = 0; v < size; v++) {
    let X = b * v + c, Y = e * v + f, W = h * v + i;
    for (let u = 0; u < size; u++, X += a, Y += d, W += g) {
      let x = X / W, y = Y / W;
      if (!(W > 1e-9)) { x = 0; y = 0; }         // 視野の裏側に回る範囲
      x = x < 0 ? 0 : x > maxX ? maxX : x;
      y = y < 0 ? 0 : y > maxY ? maxY : y;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const q = (y0 * srcWidth + x0) * 4, r = q + srcWidth * 4;
      const g00 = 0.299 * rgba[q] + 0.587 * rgba[q + 1] + 0.114 * rgba[q + 2];
      const g10 = 0.299 * rgba[q + 4] + 0.587 * rgba[q + 5] + 0.114 * rgba[q + 6];
      const g01 = 0.299 * rgba[r] + 0.587 * rgba[r + 1] + 0.114 * rgba[r + 2];
      const g11 = 0.299 * rgba[r + 4] + 0.587 * rgba[r + 5] + 0.114 * rgba[r + 6];
      out[p++] = (g00 * (1 - fx) + g10 * fx) * (1 - fy) + (g01 * (1 - fx) + g11 * fx) * fy;
    }
  }
  return out;
}

// 窓の像で得た姿勢（3×4）を、元の映像での姿勢に直す
export function poseFromWindow(K, toCamera, T) {
  // 図面の点 → 窓の画素（図面は平面なので、姿勢の1・2・4列目だけで決まる）
  const seen = mul(K, [[T[0][0], T[0][1], T[0][3]], [T[1][0], T[1][1], T[1][3]], [T[2][0], T[2][1], T[2][3]]]);
  const G = mul(inverse(K), mul(toCamera, seen));       // 図面の点 → 元の映像での視線の向き
  const sign = G[2][2] < 0 ? -1 : 1;                    // 図面はカメラの前にある
  const n1 = Math.hypot(G[0][0], G[1][0], G[2][0]) * sign, n2 = Math.hypot(G[0][1], G[1][1], G[2][1]) * sign;
  const r1 = [G[0][0] / n1, G[1][0] / n1, G[2][0] / n1], r2 = [G[0][1] / n2, G[1][1] / n2, G[2][1] / n2];
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const n3 = Math.hypot(...r3), nt = (n1 + n2) / 2;
  return [0, 1, 2].map((k) => [r1[k], r2[k], r3[k] / n3, G[k][2] / nt]);
}
