'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { argumentsFrom, selectedImages } = require('../scripts/ocr_trafalgar_documents.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trafalgar-ocr-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'images'));
    const page = (name, text) => {
      const bytes = Buffer.from(`Synthetic image ${name}`);
      const filename = `images/${name}.png`;
      fs.writeFileSync(path.join(directory, filename), bytes);
      return { page: 1, image_filename: filename, image_sha256: hash(bytes), text, width: 10, height: 20 };
    };
    const empty = page('empty', ''), partial = page('partial', '120');
    const index = { documents: [{ document_id: 'empty', pages: [empty] },
      { document_id: 'partial', pages: [partial] }, { document_id: 'same-image', pages: [{ ...partial }] }] };
    callback({ directory, index, empty, partial });
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('trafalgar-ocr-test-'));
    fs.rmSync(directory, { recursive: true });
  }
}

test('explicit image hashes validate, normalize, and support repeated options', () => {
  const first = 'ab'.repeat(32), second = 'cd'.repeat(32);
  assert.deepEqual(argumentsFrom(['prepared', 'output']).includeImages, []);
  assert.deepEqual(argumentsFrom(['prepared', 'output', '--include-image', first.toUpperCase(),
    '--include-image', second, '--include-image', first]).includeImages, [first, second]);
  for (const value of ['', 'a'.repeat(63), 'g'.repeat(64), '../image.png']) {
    assert.throws(() => argumentsFrom(['prepared', 'output', '--include-image', value]), /64-character/);
  }
  assert.throws(() => argumentsFrom(['prepared', 'output', '--include-image']), /64-character/);
});

test('partial embedded text requires explicit inclusion and keeps every matching reference', () => fixture(({ directory, index, empty, partial }) => {
  const automatic = selectedImages(directory, index, {}, []);
  assert.deepEqual([...automatic.keys()], [empty.image_sha256]);
  const explicit = selectedImages(directory, index, {}, [partial.image_sha256]);
  assert.equal(explicit.size, 2);
  assert.deepEqual(explicit.get(partial.image_sha256).references,
    [{ document_id: 'partial', page: 1 }, { document_id: 'same-image', page: 1 }]);
}));

test('unknown supplemental image cannot create an OCR result', () => fixture(({ directory, index }) => {
  assert.throws(() => selectedImages(directory, index, {}, ['0'.repeat(64)]), /absent from available prepared pages/);
}));

test('supplemental pages verify their bytes and remain within the prepared directory', () => fixture(({ directory, index, partial }) => {
  fs.appendFileSync(path.join(directory, partial.image_filename), 'changed');
  assert.throws(() => selectedImages(directory, index, {}, [partial.image_sha256]), /fingerprint mismatch/);
  partial.image_filename = '../outside.png';
  assert.throws(() => selectedImages(directory, index, {}, [partial.image_sha256]), /escapes its directory/);
}));
