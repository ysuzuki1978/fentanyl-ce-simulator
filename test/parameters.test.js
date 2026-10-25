const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/load-app');

const app = loadApp();
const near = (a, b, rel = 1e-12) => Math.abs(a - b) <= rel * Math.abs(b);

test('Scott & Stanski reproduces the tabulated rate constants and V1', () => {
    const pk = app.FentanylModels.scottStanski.getParameters();
    assert.equal(pk.v1, 13.0);
    for (const [k, v] of Object.entries({ k10: 0.0492, k12: 0.380, k21: 0.0960, k13: 0.179, k31: 0.0077, ke0: 0.147 })) {
        assert.equal(pk[k], v, k);
    }
});

test('Shafer 1990 volumes and clearances are as implemented', () => {
    const pk = app.FentanylModels.shafer.getParameters();
    assert.deepEqual([pk.v1, pk.v2, pk.v3, pk.cl, pk.q2, pk.q3], [6.09, 28.1, 228, 0.504, 2.87, 1.37]);
});

test('Bae 2020 at 70 kg equals the published values; volumes scale linearly, clearances by 0.75', () => {
    const ref = app.FentanylModels.bae.getParameters({ weight: 70 });
    assert.deepEqual([ref.v1, ref.v2, ref.v3, ref.cl, ref.q2, ref.q3], [10.1, 26.5, 206, 0.704, 2.38, 1.49]);
    const heavy = app.FentanylModels.bae.getParameters({ weight: 140 });
    assert.ok(near(heavy.v1, 20.2) && near(heavy.v3, 412));
    assert.ok(near(heavy.cl, 0.704 * Math.pow(2, 0.75)));
    // No weight given: the reference individual, not NaN.
    assert.deepEqual(app.FentanylModels.bae.getParameters(), app.FentanylModels.bae.getParameters({ weight: 70 }));
});

test('rate constants are consistent with volumes and clearances in every model', () => {
    for (const id of app.FENTANYL_MODEL_IDS) {
        const pk = app.FentanylModels[id].getParameters({ weight: 83 });
        assert.ok(near(pk.k10, pk.cl / pk.v1, 1e-9), `${id} k10`);
        assert.ok(near(pk.k12, pk.q2 / pk.v1, 1e-9) && near(pk.k21, pk.q2 / pk.v2, 1e-9), `${id} k12/k21`);
        assert.ok(near(pk.k13, pk.q3 / pk.v1, 1e-9) && near(pk.k31, pk.q3 / pk.v3, 1e-9), `${id} k13/k31`);
        assert.equal(pk.ke0, app.FENTANYL_KE0);
    }
});

test('published bolus behaviour: Scott & Stanski Ce peaks at 3.7 min, 16.5% of the initial Cp', () => {
    const peak = app.timeToPeakEffect(app.FentanylModels.scottStanski.getParameters());
    assert.ok(Math.abs(peak.peakTime - 3.7) < 0.1, `peak time ${peak.peakTime}`);
    assert.ok(Math.abs(peak.peakFraction - 0.165) < 0.005, `fraction ${peak.peakFraction}`);
});

test('maintenance rate is CL x target in ug/hr', () => {
    const pk = app.FentanylModels.shafer.getParameters();
    assert.ok(near(app.maintenanceRateUgHr(2, pk), 2 * 0.504 * 60));
});
