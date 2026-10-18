// Your profile photo: picked from the phone, made small (a 256 px square JPEG,
// tens of KB), and kept on this device for the signed-in account. Per account,
// so someone else signing in here doesn't see yours.
// Not in the sign-in token: Supabase puts user metadata in every token, and a
// photo there would ride along on every call.

import { disk } from './disk.js';
import { emit } from './bus.js';

const KEY = (userId) => `echo:photo:${userId}`;
export const PHOTO_PX = 256;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export function photoFor(userId) {
  if (!userId) return null;
  const v = disk.get(KEY(userId), null);
  return typeof v === 'string' && v.startsWith('data:image/jpeg;base64,') ? v : null;
}

// The centre square of a w×h picture: [sx, sy, side].
export function centreSquare(w, h) {
  const side = Math.min(w, h);
  return [Math.round((w - side) / 2), Math.round((h - side) / 2), side];
}

// A picked image file → a small square JPEG data URL. Browser only (canvas).
export async function shrinkPhoto(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('That isn\'t a photo.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That photo is too big. Pick a smaller one.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That photo couldn\'t be opened.'); }
  const [sx, sy, side] = centreSquare(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_PX;
  canvas.height = PHOTO_PX;
  canvas.getContext('2d').drawImage(bitmap, sx, sy, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function savePhoto(userId, dataUrl) {
  if (!userId || !String(dataUrl).startsWith('data:image/jpeg;base64,')) return;
  disk.set(KEY(userId), dataUrl);
  emit('photo', userId);
}

export function removePhoto(userId) {
  if (!userId) return;
  disk.remove(KEY(userId));
  emit('photo', userId);
}
