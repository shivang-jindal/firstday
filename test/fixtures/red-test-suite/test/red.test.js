import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deliberately fails', () => {
  assert.equal(1, 2, 'baseline is red on purpose');
});
