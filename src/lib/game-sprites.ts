import type { GameSprite } from './game-types';

/** Decode a local raster file once and keep only small, metadata-free RGBA pixels. */
export async function readGameSprite(file: File): Promise<GameSprite> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size < 12 || file.size > 2 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or WebP image up to 2 MB.');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = file.type === 'image/png' ? header.slice(0, 8).every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i]) : file.type === 'image/jpeg' ? header[0] === 255 && header[1] === 216 && header[2] === 255 : String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!matches) throw new Error('The image contents do not match its file type.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('This image could not be read. Choose another PNG, JPEG or WebP.'); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 4096 || bitmap.height > 4096) throw new Error('Choose an image no larger than 4096 × 4096 pixels.');
    const scale = Math.min(1, 64 / bitmap.width, 64 / bitmap.height), width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image processing is unavailable in this browser.');
    context.drawImage(bitmap, 0, 0, width, height);
    const bytes = context.getImageData(0, 0, width, height).data;
    if (!bytes.some((value, index) => index % 4 === 3 && value > 0)) throw new Error('This image is completely transparent. Choose a visible sprite.');
    return { width, height, pixels: btoa(String.fromCharCode(...bytes)) };
  } finally { bitmap.close(); }
}
