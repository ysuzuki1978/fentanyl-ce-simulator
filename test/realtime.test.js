const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/load-app');
const { exactTrajectory } = require('./lib/exact');

const app0 = loadApp();

function run({ speed, bolusUg, ugHr, wallSeconds, weight = 70 }) {
    const clock = { now: 1e12 };
    const app = loadApp({}, { sandbox: {
        setInterval: () => 1, clearInterval() {},
        Date: Object.assign(function () { return new globalThis.Date(...arguments); }, { now: () => clock.now })
    } });
    const engine = new app.RealtimeEngine();
    engine.setSpeed(speed);
    engine.start({ weight }, bolusUg, ugHr);
    for (let s = 0; s < wallSeconds; s++) { clock.now += 1000; engine.tick(); }
    return { app, engine };
}

test('real-time engine at x60 agrees with the exact solution after 10 simulated minutes', () => {
    const { app, engine } = run({ speed: 60, bolusUg: 100, ugHr: 60, wallSeconds: 10 });
    assert.ok(Math.abs(engine.elapsedMinutes - 10) < 1e-9, `elapsed ${engine.elapsedMinutes}`);
    for (const id of app.FENTANYL_MODEL_IDS) {
        const pk = engine.pkParams[id];
        const exact = exactTrajectory([{ timeMin: 0, bolus: 100, rate: 1 }], pk, pk.ke0, 10)[10];
        const state = engine.states[id];
        assert.ok(Math.abs(state.ce - exact.ce) / exact.ce < 1e-6, `${id} Ce ${state.ce} vs ${exact.ce}`);
        assert.ok(Math.abs(state.a1 / pk.v1 - exact.cp) / exact.cp < 1e-6, `${id} Cp`);
    }
});

test('the speed multiplier changes the pace, not the result at equal simulated time', () => {
    const slow = run({ speed: 10, bolusUg: 50, ugHr: 120, wallSeconds: 60 }).engine;
    const fast = run({ speed: 60, bolusUg: 50, ugHr: 120, wallSeconds: 10 }).engine;
    assert.ok(Math.abs(slow.elapsedMinutes - fast.elapsedMinutes) < 1e-9);
    for (const id of Object.keys(slow.states)) {
        assert.ok(Math.abs(slow.states[id].ce - fast.states[id].ce) < 1e-6, id);
    }
});

test('total dose counts the bolus and the infusion given', () => {
    const { engine } = run({ speed: 60, bolusUg: 100, ugHr: 60, wallSeconds: 10 });
    assert.ok(Math.abs(engine.totalDoseUg - (100 + 10)) < 1e-9, String(engine.totalDoseUg));
});

test('elapsed whole seconds tolerate the float drift of summed time steps', () => {
    let t = 0;
    for (let i = 0; i < 10; i++) t += 0.02;           // 0.19999999999999998, not 0.2
    assert.ok(t < 0.2);
    assert.equal(Math.floor(t * 60), 11);              // what the display showed before
    assert.equal(app0.elapsedWholeSeconds(t), 12);
    assert.equal(app0.elapsedWholeSeconds(0.999), 59);
    assert.equal(app0.elapsedWholeSeconds(0), 0);
});

test('a snapshot shows its time as mm:ss', () => {
    assert.equal(new app0.RealtimeSnapshot('x', 1.5, {}).formattedTime, '01:30');
    assert.equal(new app0.RealtimeSnapshot('x', 75, {}).formattedTime, '75:00');
});

test('elapsed time is shown as mm:ss, then hh:mm:ss', () => {
    const { engine } = run({ speed: 60, bolusUg: 0, ugHr: 0, wallSeconds: 1 });
    assert.equal(engine.formatElapsed(), '01:00');
    const long = run({ speed: 60, bolusUg: 0, ugHr: 0, wallSeconds: 61 }).engine;
    assert.equal(long.formatElapsed(), '01:01:00');
});

test('the trace stays bounded and keeps its last point when the buffer fills', () => {
    const { engine } = run({ speed: 60, bolusUg: 10, ugHr: 0, wallSeconds: 120 });
    assert.ok(engine.history.length <= 2001);
    // Sampled on simulated time: the last point is at most one sampling interval behind.
    assert.ok(engine.elapsedMinutes - engine.history[engine.history.length - 1].t <= engine.historyIntervalMin + 1e-9);
});
