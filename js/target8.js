// 8th Wall 用の認識データ（平面の画像ターゲット）を、図面画像から作る。ブラウザの中だけで処理する。
//
// 8th Wall は図面を、縦横 3:4（横長の図面は 90° 回して縦長にしたもの）の白黒画像 480×640 として扱う。
// 縦横比が 4:3 でない図面は、切り落とさずに白地を上下（または左右）へ同じだけ足して 4:3 にする。
// 足した白地の量は metadata.zumen に残し、AR の画面でモデルを置くときに図面画像の中心と幅へ戻す。
//
// 出力（図面ごと、図面画像と同じフォルダ）
//   target8.json … 8th Wall の画像ターゲットの設定（8th Wall の作成ツール image-target-cli と同じ形）
//   target8.jpg  … 白黒 480×640 の画像（8th Wall はこの画像だけを見て図面を探す）
export const TARGET8_JSON = 'target8.json';
export const TARGET8_IMAGE = 'target8.jpg';
const LW = 480, LH = 640;

// 図面画像（img：読み込み済みの画像）から、白地を足した大きさと、回すかどうかを決める
export function target8Layout(width, height) {
  const landscape = width >= height;
  const [long, short] = landscape ? [width, height] : [height, width];
  // 長辺:短辺 = 4:3 にする。短辺が足りなければ短辺側に、長辺が足りなければ長辺側に白地を足す
  let pl = long, ps = short;
  if (long * 3 > short * 4) ps = Math.round((long * 3) / 4);
  else pl = Math.round((short * 4) / 3);
  const [pw, ph] = landscape ? [pl, ps] : [ps, pl];
  return { landscape, srcWidth: width, srcHeight: height, padWidth: pw, padHeight: ph, padX: (pw - width) / 2, padY: (ph - height) / 2 };
}

// 図面画像から 480×640 の白黒画像（canvas）を作る。横長は時計回りに 90° 回す（8th Wall の作成ツールと同じ）
export function target8Canvas(img, layout = target8Layout(img.naturalWidth || img.width, img.naturalHeight || img.height)) {
  const canvas = document.createElement('canvas');
  canvas.width = LW; canvas.height = LH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, LW, LH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  if (layout.landscape) {
    // 白地を足した図面（padWidth×padHeight）を、時計回りに回して 480×640 に収める
    ctx.translate(LW, 0);
    ctx.rotate(Math.PI / 2);
    ctx.scale(LH / layout.padWidth, LW / layout.padHeight);
  } else {
    ctx.scale(LW / layout.padWidth, LH / layout.padHeight);
  }
  ctx.drawImage(img, layout.padX, layout.padY, layout.srcWidth, layout.srcHeight);
  ctx.restore();
  const im = ctx.getImageData(0, 0, LW, LH);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(im, 0, 0);
  return canvas;
}

// 8th Wall の画像ターゲットの設定。imagePath は AR の画面で実際の場所に置き換える
export function target8Json(name, layout) {
  const rotated = layout.landscape;
  // 回したあとの画像での大きさ（作成ツールの「既定の切り抜き」で、白地を足した画像全体を使う）
  const w = rotated ? layout.padHeight : layout.padWidth;
  const h = rotated ? layout.padWidth : layout.padHeight;
  const now = Date.now();
  return {
    imagePath: TARGET8_IMAGE,
    metadata: { zumen: { srcWidth: layout.srcWidth, srcHeight: layout.srcHeight, padWidth: layout.padWidth, padHeight: layout.padHeight, padX: layout.padX, padY: layout.padY } },
    name,
    type: 'PLANAR',
    properties: { top: 0, left: 0, width: w, height: h, isRotated: rotated, originalWidth: w, originalHeight: h },
    resources: { luminanceImage: TARGET8_IMAGE },
    created: now,
    updated: now,
  };
}
