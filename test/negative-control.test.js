// Each control reintroduces a plausible defect into the source and requires the
// exact-solution comparison to notice. loadApp throws if the text to break has moved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/load-app');
const { exactTrajectory } = require('./lib/exact');

const EVENTS = [[0, 100, 0], [5, 0, 60], [30, 0, 120], [60, 50, 0]];

function worst(mutations) {
    const app = loadApp(mutations);
    const pk = app.FentanylModels.scottStanski.getParameters();
    const run = app.simulateDoseRecord(EVENTS.map(e => new app.DoseEvent(...e)), pk, { durationMin: 120, sampleIntervalMin: 1 });
    const exact = exactTrajectory(EVENTS.map(([timeMin, bolus, ugHr]) => ({ timeMin, bolus, rate: ugHr / 60 })), pk, pk.ke0, 120);
    let w = 0;
    exact.forEach((s, i) => { if (s.ce > 1e-6) w = Math.max(w, Math.abs(run.ce[i] - s.ce) / s.ce); });
    return w;
}

test('control: the unmodified code passes the comparison', () => {
    assert.ok(worst({}) < 1e-6);
});

test('control: a rate used as ug/min instead of ug/hr is detected', () => {
    assert.ok(worst({ 'simulation-engine.js': [['rateUgHr / 60.0', 'rateUgHr']] }) > 1e-2);
});

test('control: a rate change applied one step late is detected', () => {
    assert.ok(worst({ 'simulation-engine.js': [['const rateUgHr = infusionRateAt(infusionChanges, t);', 'const rateUgHr = infusionRateAt(infusionChanges, t - 0.05);']] }) > 1e-4);
});

test('control: a wrong ke0 is detected', () => {
    assert.ok(worst({ 'fentanyl-pk.js': [['ce: pk.ke0 * (cp - state.ce)', 'ce: 1.01 * pk.ke0 * (cp - state.ce)']] }) > 1e-3);
});

test('control: a bolus put in the peripheral compartment is detected', () => {
    assert.ok(worst({ 'simulation-engine.js': [['state.a1 += boluses', 'state.a2 += boluses']] }) > 1e-2);
});
