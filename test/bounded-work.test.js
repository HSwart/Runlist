const assert = require('node:assert/strict');
const test = require('node:test');
const { mapWithConcurrency } = require('../src/lifecycle/bounded-work');

for (const size of [100, 500, 1000]) {
  test(`bounds and completes ${size} status checks without reordering`, async () => {
    let active = 0;
    let maximumActive = 0;
    const values = Array.from({ length: size }, (_, index) => index);

    const results = await mapWithConcurrency(values, 8, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return value * 2;
    });

    assert.equal(maximumActive, 8);
    assert.deepEqual(results, values.map((value) => value * 2));
  });
}

test('stops scheduling status checks after cancellation', async () => {
  let cancelled = false;
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = mapWithConcurrency(Array.from({ length: 20 }), 4, async () => {
    started += 1;
    await gate;
  }, { cancelled: () => cancelled });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 4);
  cancelled = true;
  release();
  await pending;
  assert.equal(started, 4);
});

test('waits for active checks and stops scheduling after the first failure', async () => {
  let active = 0;
  let started = 0;
  const failure = new Error('probe failed');

  await assert.rejects(mapWithConcurrency(Array.from({ length: 20 }), 4, async (_, index) => {
    active += 1;
    started += 1;
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (index === 0) {
      throw failure;
    }
  }), (error) => error === failure);

  assert.equal(active, 0);
  assert.equal(started, 4);
});
