// 追跡用の手がかり（図面上の目印の位置）を選び直す。
//
// MindAR の標準の選び方は、目印どうしを大きく離す（短辺の1/10、約12画素）ので、
// 線画のように目印になる場所が偏っている図面では数が足りなくなる。
// ここでは選ぶ基準（周囲と見分けがつくこと）は変えずに、間隔だけを詰めて数を増やす。

const T = 6;            // 見比べる小窓の半径（13×13画素）。MindAR の追跡と同じ
const SEARCH = 10;      // 追跡が探す範囲（±10画素）。この中に似た場所があると取り違える
const NEAR = 2;         // 自分のすぐ隣（半径2画素）は「似ていて当然」なので見分けの判定から外す
const SD_MIN = 8;       // 小窓の濃淡のばらつきの下限。これ未満は平坦すぎて目印にならない
const UNIQUE_MAX = 0.9; // 探す範囲の中で、他の場所とどれだけ似ていてよいかの上限
const FRAGILE = 0.2;    // 1〜2画素ずれただけで似なくなる場所は、ぼけに弱いので使わない

export function extractDense(image, { spacing = 7, candidateRatio = 0.08, maxPoints = Infinity } = {}) {
  const { data, width, height } = image;
  const side = 2 * T + 1;
  const n = side * side;

  // 小窓の平均とばらつきを速く出すための累積和
  const W1 = width + 1;
  const sum = new Float64Array(W1 * (height + 1));
  const sum2 = new Float64Array(W1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0, row2 = 0;
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      row += v; row2 += v * v;
      sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row;
      sum2[(y + 1) * W1 + x + 1] = sum2[y * W1 + x + 1] + row2;
    }
  }
  const box = (s, cx, cy) => s[(cy + T + 1) * W1 + cx + T + 1] - s[(cy - T) * W1 + cx + T + 1] - s[(cy + T + 1) * W1 + cx - T] + s[(cy - T) * W1 + cx - T];
  const inside = (cx, cy) => cx - T >= 0 && cx + T < width && cy - T >= 0 && cy + T < height;
  // 小窓の「濃淡の大きさ」（平均を引いた長さ）
  const norm = (cx, cy) => { const s = box(sum, cx, cy); return Math.sqrt(Math.max(box(sum2, cx, cy) - (s * s) / n, 0)); };
  // 2つの小窓の似ている度合い（-1〜1。明るさと濃さの違いは無視される）
  const similarity = (ax, ay, an, bx, by) => {
    if (!inside(bx, by)) return null;
    const bn = norm(bx, by);
    if (bn === 0) return null;
    let dot = 0;
    for (let j = -T; j <= T; j++) {
      let pa = (ay + j) * width + ax - T, pb = (by + j) * width + bx - T;
      for (let i = 0; i < side; i++) dot += data[pa++] * data[pb++];
    }
    return (dot - (box(sum, ax, ay) * box(sum, bx, by)) / n) / (an * bn);
  };

  // 1. 濃淡の変化が強く、周囲より際立つ画素を候補にする
  const grad = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      let dx = 0, dy = 0;
      for (let k = -1; k <= 1; k++) {
        dx += data[p + width * k + 1] - data[p + width * k - 1];
        dy += data[p + width + k] - data[p - width + k];
      }
      grad[p] = Math.hypot(dx, dy);
    }
  }
  let candidates = [];
  for (let y = T; y < height - T; y++) {
    for (let x = T; x < width - T; x++) {
      const p = y * width + x, g = grad[p];
      if (g > grad[p - 1] && g > grad[p + 1] && g > grad[p - width] && g > grad[p + width]) candidates.push({ x, y, g });
    }
  }
  candidates.sort((a, b) => b.g - a.g);
  candidates = candidates.slice(0, Math.floor(width * height * candidateRatio));

  // 2. 周囲と見分けがつく候補だけ残す
  const scored = [];
  for (const c of candidates) {
    const cn = norm(c.x, c.y);
    if (cn / side < SD_MIN) continue;
    let nearestTwin = -1;   // 探す範囲の中で、いちばん似ている別の場所
    let fragile = false;
    for (let j = -SEARCH; j <= SEARCH && nearestTwin <= UNIQUE_MAX && !fragile; j++) {
      for (let i = -SEARCH; i <= SEARCH; i++) {
        if (i === 0 && j === 0) continue;
        const s = similarity(c.x, c.y, cn, c.x + i, c.y + j);
        if (s === null) continue;
        if (i * i + j * j <= NEAR * NEAR) { if (s < FRAGILE) { fragile = true; break; } continue; }
        if (s > nearestTwin) { nearestTwin = s; if (s > UNIQUE_MAX) break; }
      }
    }
    if (fragile || nearestTwin > UNIQUE_MAX) continue;
    scored.push({ x: c.x, y: c.y, score: nearestTwin });
  }

  // 3. 見分けやすい順に、間隔を空けながら採用する。
  // 多すぎると1コマの処理が重くなる（追跡は見本の目印をすべて照合する）ので、上限を超えたら間隔を広げて選び直す。
  // 間隔で間引くので、目印は図面全体に散らばったまま減る
  scored.sort((a, b) => a.score - b.score);
  const pick = (gap) => {
    const taken = new Uint8Array(width * height);
    const points = [];
    for (const s of scored) {
      if (taken[s.y * width + s.x]) continue;
      points.push({ x: s.x, y: s.y });
      for (let j = -gap; j <= gap; j++) {
        for (let i = -gap; i <= gap; i++) {
          const x = s.x + i, y = s.y + j;
          if (x >= 0 && x < width && y >= 0 && y < height) taken[y * width + x] = 1;
        }
      }
    }
    return points;
  };
  let gap = spacing;
  let points = pick(gap);
  while (points.length > maxPoints && gap < 200) {
    gap = Math.ceil(gap * Math.max(1.08, Math.sqrt(points.length / maxPoints) * 0.95));
    points = pick(gap);
  }
  return points.length > maxPoints ? points.slice(0, maxPoints) : points;
}

/* ---------- 近づいて見るための細かい見本 ---------- */
// 追跡は、図面の見本（縮めた図面画像と、その上の目印の位置）と映像を見比べて行う。MindAR 標準の見本は
// 短辺128画素の1種類だけなので、近づいて図面の一部を大きく写すと細い線が拾えない。そこで細かい見本を足す。
// 見本の形は MindAR の追跡データと同じ（data・width・height・scale・points）。all.mind の追跡データの後ろに足しても、
// MindAR 標準の動きは変わらない（標準は2番目の見本だけを使う）。

export const ZOOM_SIZES = [256, 384, 576, 864];   // 見本の短辺の画素数。標準（128）の 2・3・4.5・6.75 倍
export const ZOOM_PURPOSE = 'zoom-v2';
export const ZOOM_MAX_POINTS = 300;   // 1つの見本の目印の上限。写真のように模様の多い画像で、処理が重くなりすぎないように

// 灰色の図面画像（gray：0〜255、width×height）を、短辺 L 画素に平均で縮める（MindAR の縮め方と同じ考え方）
export function shrink(gray, width, height, L) {
  const scale = L / Math.min(width, height);
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const data = new Uint8Array(w * h);
  const xs = new Int32Array(w + 1), ys = new Int32Array(h + 1);
  for (let x = 0; x <= w; x++) xs[x] = Math.min(width, Math.floor(x / scale));
  for (let y = 0; y <= h; y++) ys[y] = Math.min(height, Math.floor(y / scale));
  for (let y = 0; y < h; y++) {
    const y0 = ys[y], y1 = Math.max(ys[y + 1], y0 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = xs[x], x1 = Math.max(xs[x + 1], x0 + 1);
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1 && xx < width; xx++) { sum += gray[row + xx]; n++; }
      }
      data[y * w + x] = n ? Math.floor(sum / n) : 255;
    }
  }
  return { data, width: w, height: h, scale };
}

// RGBA の画素から灰色にする
export function toGray(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return gray;
}

// 細かい見本を作る。sizes の順（粗い順）に作り、1つできるたびに onLevel に渡す
export function makeZoomLevels(gray, width, height, { sizes = ZOOM_SIZES, onLevel } = {}) {
  const out = [];
  for (const L of sizes) {
    const level = shrink(gray, width, height, L);
    level.points = extractDense(level, { maxPoints: ZOOM_MAX_POINTS });
    level.purpose = ZOOM_PURPOSE;
    out.push(level);
    if (onLevel) onLevel(level);
  }
  return out;
}
