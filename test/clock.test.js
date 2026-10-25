const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/load-app');

const app = loadApp();
const at = (h, m, s = 0) => new Date(2026, 9, 25, h, m, s);

test('formatClockTime is 24 h, zero padded, and never 24:00', () => {
    assert.equal(app.formatClockTime(at(9, 5)), '09:05');
    assert.equal(app.formatClockTime(at(0, 0)), '00:00');
    assert.equal(app.formatClockTime(at(23, 59, 59)), '23:59');
});

test('parseClock accepts H:MM and HH:MM and rejects everything else', () => {
    assert.equal(app.parseClock('08:30'), 510);
    assert.equal(app.parseClock('8:30'), 510);
    assert.equal(app.parseClock('00:00'), 0);
    for (const bad of ['', '24:00', '08:60', '8', 'half eight', null, undefined, '08:30:15']) {
        assert.equal(app.parseClock(bad), null, String(bad));
    }
});

test('minutesIntoCase: later the same day', () => {
    assert.equal(app.minutesIntoCase(at(9, 0), '09:45'), 45);
    assert.equal(app.minutesIntoCase(at(9, 0), '09:00'), 0);
});

test('minutesIntoCase: a time before the start is the next day (case past midnight)', () => {
    assert.equal(app.minutesIntoCase(at(22, 0), '01:30'), 210);
    assert.equal(app.minutesIntoCase(at(23, 50), '00:10'), 20);
});

test('minutesIntoCase: the start counts as the minute it fell in, whatever its seconds', () => {
    assert.equal(app.minutesIntoCase(at(9, 15, 40), '09:15'), 0);
    assert.equal(app.minutesIntoCase(at(9, 15, 40), '09:16'), 1);
});

test('minutesIntoCase: unparsable text gives NaN, which the dose validation rejects', () => {
    assert.ok(Number.isNaN(app.minutesIntoCase(at(9, 0), '')));
    assert.ok(Number.isNaN(app.minutesIntoCase(at(9, 0), '25:00')));
    const event = new app.DoseEvent(app.minutesIntoCase(at(9, 0), ''), 0, 0);
    assert.equal(event.validate().isValid, false);
});

test('clockTimeAfter and minutesIntoCase are inverse for whole minutes, across midnight', () => {
    const start = at(22, 40);
    for (const m of [0, 1, 59, 80, 120, 600, 1439]) {
        assert.equal(app.minutesIntoCase(start, app.clockTimeAfter(start, m)), m, `minute ${m}`);
    }
});

test('clockTimeAfter floors the seconds of a fractional minute', () => {
    assert.equal(app.clockTimeAfter(at(9, 0), 0.99), '09:00');
    assert.equal(app.clockTimeAfter(at(9, 0), 1), '09:01');
});

test('Patient and DoseEvent show the same clock as clockTimeAfter', () => {
    const patient = new app.Patient('p', 40, 70, 170, 0, 0, at(23, 30));
    assert.equal(patient.formattedStartTime, '23:30');
    assert.equal(new app.DoseEvent(45, 0, 0).formattedClockTime(patient), '00:15');
});

test('a Patient survives a JSON round trip with its start time', () => {
    const patient = new app.Patient('p', 40, 70, 170, 0, 0, at(7, 5));
    const back = app.Patient.fromJSON(JSON.parse(JSON.stringify(patient)));
    assert.equal(back.formattedStartTime, '07:05');
});
