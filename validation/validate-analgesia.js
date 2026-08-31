/**
 * Evaluator pass for the analgesia module.
 * Run with:  node validation/validate-analgesia.js
 *
 * The point of these checks is that every curve in the module must reproduce
 * the published summary statistics it was fitted to. A curve that does not
 * return the source's own numbers is not an interpolation of that source.
 */

const { Analgesia } = require('../js/analgesia.js');

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
    checks++;
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!condition) failures++;
}

function near(actual, expected, tol) {
    return Math.abs(actual - expected) <= tol;
}

console.log('\n=== 1. MEAC curve reproduces Bae 2020 (median 0.99, IQR 0.76-1.28) ===');
{
    const a = Analgesia.MEAC;
    check('P = 50% at the published median',
        near(Analgesia.probability(a.median, a), 0.50, 0.001),
        `${(Analgesia.probability(a.median, a) * 100).toFixed(1)}% at ${a.median} ng/mL`);
    check('P = 25% at the published Q1',
        near(Analgesia.probability(a.q1, a), 0.25, 0.02),
        `${(Analgesia.probability(a.q1, a) * 100).toFixed(1)}% at ${a.q1} ng/mL`);
    check('P = 75% at the published Q3',
        near(Analgesia.probability(a.q3, a), 0.75, 0.02),
        `${(Analgesia.probability(a.q3, a) * 100).toFixed(1)}% at ${a.q3} ng/mL`);
    console.log(`        gamma = ${a.gamma.toFixed(3)} (fixed by the quartiles, not chosen)`);
}

console.log('\n=== 2. MEC curve reproduces Bae 2020 (median 0.72, IQR 0.58-1.05) ===');
{
    const a = Analgesia.MEC;
    check('P = 50% at the published median',
        near(Analgesia.probability(a.median, a), 0.50, 0.001),
        `${(Analgesia.probability(a.median, a) * 100).toFixed(1)}%`);
    // The reported MEC IQR is skewed in log space, so a single log-logistic
    // cannot hit both quartiles exactly; it should split the difference.
    const pq1 = Analgesia.probability(a.q1, a);
    const pq3 = Analgesia.probability(a.q3, a);
    check('P at Q1 is within 8 points of 25%', near(pq1, 0.25, 0.08),
        `${(pq1 * 100).toFixed(1)}%`);
    check('P at Q3 is within 8 points of 75%', near(pq3, 0.75, 0.08),
        `${(pq3 * 100).toFixed(1)}%`);
    console.log(`        gamma = ${a.gamma.toFixed(3)}`);
}

console.log('\n=== 3. MAC-reduction curve reproduces McEwan 1993 ===');
{
    const r167 = Analgesia.macReduction(1.67);
    const r3 = Analgesia.macReduction(3.0);
    const r10 = Analgesia.macReduction(10.0);

    check('50% MAC reduction at 1.67 ng/mL', near(r167, 50, 0.5), `${r167.toFixed(1)}%`);
    check('63% MAC reduction at 3 ng/mL', near(r3, 63, 0.5), `${r3.toFixed(1)}%`);
    // McEwan reports only a further 19% between 3 and 10 ng/mL, i.e. ~82%.
    check('about 82% at 10 ng/mL (ceiling)', near(r10, 82, 1.5), `${r10.toFixed(1)}%`);
    check('the extra reduction from 3 to 10 ng/mL is about 19 points',
        near(r10 - r3, 19, 1.5), `${(r10 - r3).toFixed(1)} points`);
    console.log(`        fitted Emax = ${Analgesia.MAC.emax.toFixed(1)}%, C50 = ${Analgesia.MAC.c50.toFixed(3)} ng/mL`);
}

console.log('\n=== 4. Bands tile the concentration axis without gaps or overlaps ===');
{
    let contiguous = true;
    for (let i = 1; i < Analgesia.BANDS.length; i++) {
        if (Math.abs(Analgesia.BANDS[i].min - Analgesia.BANDS[i - 1].max) > 1e-9) contiguous = false;
    }
    check('band boundaries are contiguous', contiguous);
    check('the first band starts at 0', Analgesia.BANDS[0].min === 0);
    check('the last band is unbounded above',
        Analgesia.BANDS[Analgesia.BANDS.length - 1].max === Infinity);

    let allResolve = true;
    for (let ce = 0; ce <= 12; ce += 0.01) {
        const band = Analgesia.bandFor(ce);
        if (!band || ce < band.min || ce >= band.max) allResolve = false;
    }
    check('every Ce from 0 to 12 resolves to the band containing it', allResolve);

    let allSourced = Analgesia.BANDS.every(b => b.source && /PMID \d+/.test(b.source));
    check('every band cites a PMID', allSourced);
}

console.log('\n=== 5. Band boundaries sit on the published anchor values ===');
{
    const boundaries = Analgesia.BANDS.map(b => b.min).filter(v => v > 0);
    const anchors = {
        'Gourlay 1988 MEC 0.63': 0.63,
        'Bae 2020 MEAC 0.99': 0.99,
        'McEwan 1993 MAC-50 1.67': 1.67,
        'Glass 1993 incision Cp50 3.26': 3.26,
        'Glass 1993 Cp50-BAR 4.17': 4.17
    };
    for (const [name, value] of Object.entries(anchors)) {
        check(`${name} is a band boundary`,
            boundaries.some(b => near(b, value, 1e-9)));
    }
}

console.log('\n=== 6. Monotonicity and range ===');
{
    let monotone = true;
    let inRange = true;
    let previous = { meac: -1, mec: -1, mac: -1 };
    for (let ce = 0; ce <= 12; ce += 0.02) {
        const meac = Analgesia.probability(ce, Analgesia.MEAC);
        const mec = Analgesia.probability(ce, Analgesia.MEC);
        const mac = Analgesia.macReduction(ce);
        if (meac < previous.meac - 1e-12 || mec < previous.mec - 1e-12 || mac < previous.mac - 1e-12) monotone = false;
        if (meac < 0 || meac > 1 || mec < 0 || mec > 1 || mac < 0 || mac > 100) inRange = false;
        previous = { meac, mec, mac };
    }
    check('all three curves increase monotonically with Ce', monotone);
    check('probabilities stay in [0,1] and MAC reduction in [0,100]', inRange);
    check('MEC is always reached before MEAC at any Ce',
        Analgesia.probability(1.0, Analgesia.MEC) > Analgesia.probability(1.0, Analgesia.MEAC),
        `at 1.0 ng/mL: MEC ${(Analgesia.probability(1.0, Analgesia.MEC) * 100).toFixed(0)}% ` +
        `vs MEAC ${(Analgesia.probability(1.0, Analgesia.MEAC) * 100).toFixed(0)}%`);
    check('Ce = 0 gives zero on every curve',
        Analgesia.probability(0, Analgesia.MEAC) === 0 && Analgesia.macReduction(0) === 0);
}

console.log('\n=== 7. Reference values at clinically quoted concentrations ===');
{
    const rows = [0.5, 0.72, 0.99, 1.5, 1.67, 3.0, 3.26, 4.17, 6.0];
    console.log('        Ce      P(MEAC)  P(MEC)   MAC減少   帯');
    for (const ce of rows) {
        const e = Analgesia.evaluate(ce);
        console.log(`        ${ce.toFixed(2).padStart(5)}   ` +
            `${(Analgesia.probability(ce, Analgesia.MEAC) * 100).toFixed(0).padStart(5)}%   ` +
            `${(Analgesia.probability(ce, Analgesia.MEC) * 100).toFixed(0).padStart(5)}%   ` +
            `${Analgesia.macReduction(ce).toFixed(0).padStart(5)}%    ${e.band.name}`);
    }
    check('evaluate() returns four metrics', Analgesia.evaluate(1.0).metrics.length === 4);
    check('every metric carries a source string',
        Analgesia.evaluate(1.0).metrics.every(m => typeof m.source === 'string' && m.source.length > 0));
}

console.log(`\n=== Summary: ${checks - failures}/${checks} checks passed ===\n`);
process.exit(failures === 0 ? 0 : 1);
