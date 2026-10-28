import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readGameSprite } from '../src/lib/game-sprites';

const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const file = (bytes = png, type = 'image/png') => new Blob([bytes], { type }) as File;
test('sprite upload rejects executable formats, mismatched bytes and large files before decoding', async () => {
  for (const value of [file(png, 'image/svg+xml'), file(png, 'image/jpeg'), file(new Uint8Array(2 * 1024 * 1024 + 1)), file(new Uint8Array(0))]) await assert.rejects(readGameSprite(value));
});

test('upload normalizes local pixels, retains aspect ratio and closes the decoded image on success or rejection', async () => {
  const globals = globalThis as unknown as Record<string, unknown>, original = { document: globals.document, createImageBitmap: globals.createImageBitmap };
  let closed = 0, transparent = false, width = 128;
  globals.createImageBitmap = async () => ({ width, height: 64, close() { closed++; } });
  globals.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(transparent ? 0 : 255) }) }) }) };
  try {
    const sprite = await readGameSprite(file());
    assert.equal(sprite.width, 64); assert.equal(sprite.height, 32); assert.equal(atob(sprite.pixels).length, 64 * 32 * 4); assert.equal(closed, 1);
    transparent = true; await assert.rejects(readGameSprite(file()), /transparent/); assert.equal(closed, 2);
    width = 5000; await assert.rejects(readGameSprite(file()), /4096/); assert.equal(closed, 3);
  } finally { Object.assign(globals, original); }
});
