import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripLoneSurrogates,
  codePointLength,
  clampText,
  sanitizeStrings,
} from '../lib/text.js';

const WHALE = '\uD83D\uDC33'; // 🐳, a single code point (two UTF-16 units)

test('text: stripLoneSurrogates keeps valid pairs and drops lone halves', () => {
  assert.equal(stripLoneSurrogates(`a${WHALE}b`), `a${WHALE}b`);
  assert.equal(stripLoneSurrogates('\uD83D'), '', 'lone high surrogate is dropped');
  assert.equal(stripLoneSurrogates('\uDC33'), '', 'lone low surrogate is dropped');
  assert.equal(stripLoneSurrogates('x\uD83Dy'), 'xy', 'lone high between chars');
  assert.equal(stripLoneSurrogates('y\uDC33x'), 'yx', 'lone low between chars');
  assert.equal(stripLoneSurrogates(123), '', 'non-string is empty');
  assert.equal(stripLoneSurrogates(undefined), '', 'undefined is empty');
});

test('text: codePointLength counts code points, not UTF-16 units', () => {
  assert.equal(codePointLength('abc'), 3);
  assert.equal(codePointLength(WHALE), 1);
  assert.equal(codePointLength(`a${WHALE}`), 2);
  assert.equal(codePointLength('\uD83D'), 0, 'lone surrogate is not a code point');
  assert.equal(codePointLength(42), 0);
});

test('text: clampText cuts on code points and never splits a surrogate pair', () => {
  assert.deepEqual(clampText('hello', 3), { text: 'hel', truncated: true });
  assert.deepEqual(clampText('hi', 5), { text: 'hi', truncated: false });
  // Cutting two of three whale emoji must land on a boundary, never mid-pair.
  assert.deepEqual(clampText(WHALE.repeat(3), 2), { text: WHALE.repeat(2), truncated: true });
  // Non-finite / non-positive limits collapse to empty but keep the truncated flag.
  assert.deepEqual(clampText('abc', 0), { text: '', truncated: true });
  assert.deepEqual(clampText('abc', -1), { text: '', truncated: true });
  assert.deepEqual(clampText('abc', Number.NaN), { text: '', truncated: true });
  assert.deepEqual(clampText('', 0), { text: '', truncated: false });
  // Lone surrogates are stripped before measuring, so they never inflate the count.
  assert.deepEqual(clampText('a\uD83Db', 10), { text: 'ab', truncated: false });
});

test('text: sanitizeStrings cleans strings recursively without touching other types', () => {
  const input = {
    a: 'x\uD83D',
    b: ['y\uDC33', 2, null, true],
    c: { d: `z${WHALE}` },
    n: 5,
    t: false,
  };
  assert.deepEqual(sanitizeStrings(input), {
    a: 'x',
    b: ['y', 2, null, true],
    c: { d: `z${WHALE}` },
    n: 5,
    t: false,
  });
  // Primitives pass through unchanged.
  assert.equal(sanitizeStrings(7), 7);
  assert.equal(sanitizeStrings(null), null);
  assert.equal(sanitizeStrings(undefined), undefined);
});
