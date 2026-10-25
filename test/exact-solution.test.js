const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/load-app');
const { exactTrajectory } = require('./lib/exact');

const DURATION = 240;
const TOLERANCE = 1e-6;
const WEIGHTS = [45, 70, 120];

// [timeMin, bolusUg, rateUgHr]. Events at 10, 60 and 90 fall on integration steps only
// if the time grid does not drift.
const EVENT_SETS = {
    'bolus, infusion on at 5, up at 30, boluses at 60': [[0, 100, 0], [5, 0, 60], [30, 0, 120], [60, 50, 0]],
    'infusion from 0, bolus at 20, off at 90': [[0, 0, 300], [20, 200, 0], [90, 0, 0]],
    'bolus at 10, infusion 60-90': [[10, 150, 0], [60, 0, 240], [90, 0, 0]],
};

const app = loadApp();

/** Worst relative error of Cp and Ce against the exact solution at every whole minute. */
function worstError(model, weight, events) {
    const pk = app.FentanylModels[model].getParameters({ weight });
    const result = app.simulateDoseRecord(events.map(e => new app.DoseEvent(...e)), pk,
        { durationMin: DURATION, sampleIntervalMin: 1 });
    // The rate is converted here, from ug/hr, not by the code under test.
    const exact = exactTrajectory(
        events.map(([timeMin, bolus, ugHr]) => ({ timeMin, bolus, rate: ugHr / 60 })),
        pk, pk.ke0, DURATION);
    assert.equal(result.times.length, exact.length);
    let worst = 0;
    result.times.forEach((t, i) => {
        assert.ok(Math.abs(t - exact[i].minute) < 1e-9);
        for (const [got, want] of [[result.cp[i], exact[i].cp], [result.ce[i], exact[i].ce]]) {
            if (want > 1e-6) worst = Math.max(worst, Math.abs(got - want) / want);
        }
    });
    return worst;
}

for (const model of app.FENTANYL_MODEL_IDS) {
    for (const weight of WEIGHTS) {
        for (const [name, events] of Object.entries(EVENT_SETS)) {
            test(`exact solution: ${model}, ${weight} kg, ${name}`, () => {
                const worst = worstError(model, weight, events);
                assert.ok(worst < TOLERANCE, `max relative error ${worst.toExponential(2)} >= ${TOLERANCE}`);
            });
        }
    }
}

test('decrement time agrees with the exact solution for a no-infusion washout', () => {
    const pk = app.FentanylModels.scottStanski.getParameters();
    const events = [[0, 200, 0]];
    const run = app.simulateDoseRecord(events.map(e => new app.DoseEvent(...e)), pk, { durationMin: 30, sampleIntervalMin: 1 });
    const [t] = app.decrementTimes(run.finalState, pk, [0.5]);
    // Ce at 30 min + t must equal 0.5 on the exact trajectory (found by bisection on whole minutes).
    const exact = exactTrajectory([{ timeMin: 0, bolus: 200, rate: 0 }], pk, pk.ke0, 400);
    const k = exact.findIndex((s, i) => i >= 30 && s.ce <= 0.5);
    assert.ok(Math.abs((30 + t) - k) <= 1, `decrement ${t.toFixed(2)} min vs exact crossing at minute ${k - 30}`);
});
