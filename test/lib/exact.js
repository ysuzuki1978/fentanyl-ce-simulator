// Exact solution of the three-compartment + effect-site system by a matrix exponential.
// Independent of the code under test: the matrix is written from the rate constants,
// and the dose rates are passed in by the test, not read from the app.
//
// (Adapted from the rocuronium simulator test helper; amounts are in ug here.)
// dy/dt = A y + b u with u constant between events  =>  y(t+h) = exp(M h) [y; u],
// M = [[A, b], [0, 0]]. Boluses are added to the central amount at their instant.

const zeros = (n) => Array.from({ length: n }, () => new Array(n).fill(0));
const identity = (n) => zeros(n).map((row, i) => { row[i] = 1; return row; });

function multiply(a, b) {
    const n = a.length;
    const out = zeros(n);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < n; k++) {
            const aik = a[i][k];
            if (aik === 0) continue;
            for (let j = 0; j < n; j++) out[i][j] += aik * b[k][j];
        }
    }
    return out;
}

const maxAbs = (a) => a.reduce((m, row) => row.reduce((r, x) => Math.max(r, Math.abs(x)), m), 0);

/** exp(M) by scaling and squaring with a Taylor series on the scaled matrix. */
function expm(matrix) {
    const n = matrix.length;
    const norm = matrix.reduce((m, row) => Math.max(m, row.reduce((s, x) => s + Math.abs(x), 0)), 0);
    const squarings = norm > 0.5 ? Math.ceil(Math.log2(norm / 0.5)) : 0;
    const scale = Math.pow(2, -squarings);
    const scaled = matrix.map(row => row.map(x => x * scale));
    let term = identity(n);
    let sum = identity(n);
    for (let k = 1; k <= 30; k++) {
        term = multiply(term, scaled).map(row => row.map(x => x / k));
        sum = sum.map((row, i) => row.map((x, j) => x + term[i][j]));
        if (maxAbs(term) < 1e-20 * maxAbs(sum)) break;
    }
    for (let i = 0; i < squarings; i++) sum = multiply(sum, sum);
    return sum;
}

/**
 * Cp and Ce (amount per volume, e.g. ug/L = ng/mL when amounts are in ug and volumes in L) at every whole minute from 0 to durationMin.
 * pk: { v1, k10, k12, k13, k21, k31 }, ke0 in 1/min.
 * events: [{ timeMin, bolus, rate }], integer minutes. A bolus at minute m
 * is in the sample at m, and a rate set at m acts from m on.
 */
function exactTrajectory(events, pk, ke0, durationMin) {
    const { v1, k10, k12, k13, k21, k31 } = pk;
    const M = [
        [-(k10 + k12 + k13), k21, k31, 0, 1],
        [k12, -k21, 0, 0, 0],
        [k13, 0, -k31, 0, 0],
        [ke0 / v1, 0, 0, -ke0, 0],
        [0, 0, 0, 0, 0]
    ];
    const oneMinute = expm(M); // exp(M * 1 min); the horizon is whole minutes
    let y = [0, 0, 0, 0];
    let rate = 0;
    const sorted = [...events].sort((p, q) => p.timeMin - q.timeMin);
    let next = 0;
    const samples = [];
    for (let minute = 0; minute <= durationMin; minute++) {
        while (next < sorted.length && sorted[next].timeMin <= minute) {
            y[0] += sorted[next].bolus || 0;
            if (sorted[next].rate !== undefined) rate = sorted[next].rate;
            next++;
        }
        samples.push({ minute, cp: y[0] / v1, ce: y[3] });
        const z = [...y, rate];
        y = y.map((_, i) => oneMinute[i].reduce((s, e, j) => s + e * z[j], 0));
    }
    return samples;
}

module.exports = { expm, exactTrajectory };
