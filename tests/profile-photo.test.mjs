import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centreSquare, photoFor, savePhoto, removePhoto } from '../app/core/profile-photo.js';

test('a photo is cut to its centre square, whatever its shape', () => {
  assert.deepEqual(centreSquare(4000, 3000), [500, 0, 3000]);
  assert.deepEqual(centreSquare(1080, 1920), [0, 420, 1080]);
  assert.deepEqual(centreSquare(512, 512), [0, 0, 512]);
});

test('the photo is kept per account, and only a JPEG made by Mullo is taken back', () => {
  const jpeg = 'data:image/jpeg;base64,/9j/AAAA';
  savePhoto('user-1', jpeg);
  assert.equal(photoFor('user-1'), jpeg);
  assert.equal(photoFor('user-2'), null, 'someone else signed in here sees no photo');
  savePhoto('user-1', 'javascript:alert(1)');
  assert.equal(photoFor('user-1'), jpeg, 'anything else is refused');
  removePhoto('user-1');
  assert.equal(photoFor('user-1'), null);
  assert.equal(photoFor(null), null);
});
