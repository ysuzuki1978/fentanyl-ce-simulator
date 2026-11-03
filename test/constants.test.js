const test = require('node:test');
const assert = require('node:assert/strict');
const { Analgesia } = require('../js/analgesia.js');

test('concentration bands tile the axis from 0 to infinity without gaps or overlaps', () => {
    const bands = Analgesia.BANDS;
    assert.equal(bands[0].min, 0);
    assert.equal(bands[bands.length - 1].max, Infinity);
    for (let i = 1; i < bands.length; i++) assert.equal(bands[i].min, bands[i - 1].max, bands[i].id);
});

test('the MEC and MEAC medians are the same numbers in the curves, bands and decrement thresholds', () => {
    const edges = Analgesia.BANDS.flatMap(b => [b.min, b.max]);
    assert.ok(edges.includes(Analgesia.MEAC.median));
    const thresholds = Analgesia.DECREMENT_THRESHOLDS.map(t => t.value);
    assert.ok(thresholds.includes(Analgesia.MEAC.median));
    assert.ok(thresholds.includes(Analgesia.MEC.median));
});

test('range labels are built from the band edges', () => {
    for (const b of Analgesia.BANDS) {
        const numbers = (b.rangeLabel.match(/\d+(\.\d+)?/g) || []).map(Number);
        for (const n of numbers) assert.ok(n === b.min || n === b.max, `${b.id}: ${n}`);
    }
});

test('probability is 50% at the median and 25% / 75% near the quartiles', () => {
    assert.ok(Math.abs(Analgesia.probability(Analgesia.MEAC.median, Analgesia.MEAC) - 0.5) < 1e-12);
    assert.ok(Math.abs(Analgesia.probability(Analgesia.MEAC.q1, Analgesia.MEAC) - 0.25) < 0.02);
    assert.ok(Math.abs(Analgesia.probability(Analgesia.MEAC.q3, Analgesia.MEAC) - 0.75) < 0.02);
});
