/**
 * 生成 PWA 应用图标（纯 Node.js，无外部依赖）
 * 生成 192x192 和 512x512 两个 PNG 图标
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(width, height, pixelFn) {
  // PNG 文件签名
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR 块
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  // 图像数据（每行前加 filter byte 0）
  const rawData = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      rawData[offset++] = r;
      rawData[offset++] = g;
      rawData[offset++] = b;
      rawData[offset++] = a;
    }
  }
  const compressed = zlib.deflateSync(rawData);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type);
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const ihdr = chunk('IHDR', ihdrData);
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// 图标绘制函数：蓝色渐变背景 + 白色库存盒子图案
function iconPixel(x, y, w, h) {
  const cx = w / 2, cy = h / 2;
  const nx = x / w, ny = y / h;

  // 圆角矩形背景（简单实现：四角圆角）
  const cornerRadius = w * 0.18;
  let inBackground = true;
  if (x < cornerRadius && y < cornerRadius) {
    const dx = cornerRadius - x, dy = cornerRadius - y;
    inBackground = (dx * dx + dy * dy) <= cornerRadius * cornerRadius;
  } else if (x > w - cornerRadius && y < cornerRadius) {
    const dx = x - (w - cornerRadius), dy = cornerRadius - y;
    inBackground = (dx * dx + dy * dy) <= cornerRadius * cornerRadius;
  } else if (x < cornerRadius && y > h - cornerRadius) {
    const dx = cornerRadius - x, dy = y - (h - cornerRadius);
    inBackground = (dx * dx + dy * dy) <= cornerRadius * cornerRadius;
  } else if (x > w - cornerRadius && y > h - cornerRadius) {
    const dx = x - (w - cornerRadius), dy = y - (h - cornerRadius);
    inBackground = (dx * dx + dy * dy) <= cornerRadius * cornerRadius;
  }

  if (!inBackground) return [0, 0, 0, 0];

  // 蓝色渐变背景
  const t = ny;
  const r = Math.round(30 + (15 - 30) * t);
  const g = Math.round(64 + (58 - 64) * t);
  const b = Math.round(175 + (138 - 175) * t);

  // 白色盒子图案（居中）
  const boxSize = w * 0.42;
  const boxLeft = cx - boxSize / 2;
  const boxRight = cx + boxSize / 2;
  const boxTop = cy - boxSize * 0.35;
  const boxBottom = cy + boxSize * 0.45;
  const boxStroke = w * 0.025;

  let isWhite = false;
  // 盒子主体（矩形轮廓）
  if (x >= boxLeft && x <= boxRight && y >= boxTop && y <= boxBottom) {
    // 边框
    if (x < boxLeft + boxStroke || x > boxRight - boxStroke ||
        y < boxTop + boxStroke || y > boxBottom - boxStroke) {
      isWhite = true;
    }
    // 中间分隔线
    if (y >= cy - boxStroke / 2 && y <= cy + boxStroke / 2) {
      isWhite = true;
    }
  }
  // 盒子顶部盖子（梯形）
  const lidTop = boxTop - boxSize * 0.18;
  const lidInset = boxSize * 0.12;
  if (y >= lidTop && y <= boxTop + boxStroke) {
    const lidProgress = (y - lidTop) / (boxTop + boxStroke - lidTop);
    const curLeft = boxLeft + lidInset * (1 - lidProgress);
    const curRight = boxRight - lidInset * (1 - lidProgress);
    if (x >= curLeft && x <= curRight) {
      isWhite = true;
    }
  }
  // 盖子顶部横线
  if (y >= lidTop - boxStroke && y <= lidTop + boxStroke) {
    if (x >= boxLeft + lidInset && x <= boxRight - lidInset) {
      isWhite = true;
    }
  }

  if (isWhite) return [255, 255, 255, 255];
  return [r, g, b, 255];
}

// 生成图标
const iconsDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

const icon192 = createPNG(192, 192, iconPixel);
fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), icon192);
console.log('已生成 icon-192.png');

const icon512 = createPNG(512, 512, iconPixel);
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), icon512);
console.log('已生成 icon-512.png');

console.log('图标生成完成！');
