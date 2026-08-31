/**
 * Evaluator pass for the per-patient MEAC estimator.
 * Run with:  node validation/validate-individualisation.js
 *
 * The claim this module makes is that it estimates the individual patient's
 * own analgesic threshold. These checks test that claim directly:
 *   - the variance decomposition is arithmetically consistent
 *   - with no observations the individualised curve IS the published
 *     population curve, so the readout degrades safely
 *   - given data from a patient with a known threshold, the posterior recovers
 *     that threshold
 *   - the posterior narrows with consistent data and does not collapse on
 *     contradictory data
 */

const analgesia = require('../js/analgesia.js');
Object.assign(globalThis, analgesia);
const indiv = require('../js/individualisation.js');
Object.assign(globalThis, indiv);

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

console.log('\n=== 1. Variance decomposition ===');
{
    const s = IndividualMEAC.scales();
    check('not degenerate: the within-patient CV leaves between-patient variance',
        !s.degenerate);
    check('total SD equals the population fit', near(s.sdTotal, sdFromLogisticScale(1 / Analgesia.MEAC.gamma), 1e-12),
        `${s.sdTotal.toFixed(4)}`);
    check('within-patient SD comes from the published CV',
        near(s.sdWithin, Math.sqrt(Math.log(1 + 0.302 * 0.302)), 1e-12),
        `${s.sdWithin.toFixed(4)} (CV ${IndividualMEAC.withinPatientCv})`);
    check('sd_between^2 + sd_within^2 = sd_total^2',
        near(s.sdBetween ** 2 + s.sdWithin ** 2, s.sdTotal ** 2, 1e-12),
        `${s.sdBetween.toFixed(4)}^2 + ${s.sdWithin.toFixed(4)}^2 = ${s.sdTotal.toFixed(4)}^2`);
    check('between-patient spread exceeds within-patient spread',
        s.sdBetween > s.sdWithin,
        `between ${s.sdBetween.toFixed(4)} vs within ${s.sdWithin.toFixed(4)}`);
    console.log(`        prior shape gamma_between = ${(1 / s.scaleBetween).toFixed(3)}, ` +
        `likelihood steepness kappa_within = ${(1 / s.scaleWithin).toFixed(3)} ` +
        `(population gamma = ${Analgesia.MEAC.gamma.toFixed(3)})`);
}

console.log('\n=== 2. With no observations the readout is the population curve ===');
{
    const posterior = IndividualMEAC.posterior([]);
    let maxDiff = 0;
    let worstAt = 0;
    for (let ce = 0.1; ce <= 5.0; ce += 0.05) {
        const diff = Math.abs(IndividualMEAC.probabilityAdequate(ce, posterior)
            - Analgesia.probability(ce, Analgesia.MEAC));
        if (diff > maxDiff) { maxDiff = diff; worstAt = ce; }
    }
    check('prior-predictive matches the published population curve within 2 points',
        maxDiff < 0.02, `max difference ${(maxDiff * 100).toFixed(2)} points at Ce ${worstAt.toFixed(2)}`);

    const summary = IndividualMEAC.summary(posterior);
    check('prior median equals the published MEAC median',
        near(summary.median, Analgesia.MEAC.median, 0.01), `${summary.median.toFixed(3)} ng/mL`);
    check('observation count is zero', summary.observationCount === 0);
    console.log(`        prior 90% interval ${summary.lower.toFixed(2)} - ${summary.upper.toFixed(2)} ng/mL`);
}

console.log('\n=== 3. The posterior is a proper density ===');
{
    for (const obs of [[], [{ ce: 1.2, adequate: true }],
                       [{ ce: 0.6, adequate: false }, { ce: 1.9, adequate: true }]]) {
        const p = IndividualMEAC.posterior(obs);
        const area = IndividualMEAC.trapezoid(p.density, p.step);
        check(`integrates to 1 with ${obs.length} observation(s)`, near(area, 1, 1e-9),
            `area ${area.toFixed(12)}`);
        check(`density is non-negative and finite with ${obs.length} observation(s)`,
            p.density.every(v => isFinite(v) && v >= 0));
    }
}

console.log('\n=== 4. Recovery: does it find a known threshold? ===');
{
    // Deterministic generator so the check is reproducible.
    let seed = 20260901;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };

    const scaleWithin = IndividualMEAC.scales().scaleWithin;

    for (const trueMeac of [0.6, 1.8, 3.2]) {
        const observations = [];
        for (let i = 0; i < 60; i++) {
            // Spread the probing concentrations around the population median so
            // the test does not quietly hand the answer to the estimator.
            const ce = 0.4 + (i % 12) * 0.28;
            const p = IndividualMEAC.probabilityAdequateGivenThreshold(ce, trueMeac, scaleWithin);
            observations.push({ ce, adequate: rand() < p });
        }
        const posterior = IndividualMEAC.posterior(observations);
        const s = IndividualMEAC.summary(posterior);
        check(`true MEAC ${trueMeac}: posterior median within 25%`,
            Math.abs(s.median - trueMeac) / trueMeac < 0.25,
            `estimate ${s.median.toFixed(2)} (90% CI ${s.lower.toFixed(2)}-${s.upper.toFixed(2)})`);
        check(`true MEAC ${trueMeac}: the credible interval covers the truth`,
            trueMeac >= s.lower && trueMeac <= s.upper);
    }
}

console.log('\n=== 5. Consistent data narrows the interval ===');
{
    const widths = [];
    const observations = [];
    for (const n of [0, 2, 6, 20]) {
        while (observations.length < n) {
            const i = observations.length;
            observations.push({ ce: i % 2 === 0 ? 1.0 : 2.2, adequate: i % 2 !== 0 });
        }
        const s = IndividualMEAC.summary(IndividualMEAC.posterior(observations));
        widths.push({ n, width: s.upper - s.lower, median: s.median });
    }
    widths.forEach(w => console.log(
        `        ${String(w.n).padStart(2)} obs: median ${w.median.toFixed(2)}, 90% width ${w.width.toFixed(2)} ng/mL`));
    check('the interval narrows monotonically as observations accumulate',
        widths.every((w, i) => i === 0 || w.width < widths[i - 1].width));
    check('the estimate moves above the population median when 1.0 is judged inadequate',
        widths[widths.length - 1].median > Analgesia.MEAC.median,
        `${widths[widths.length - 1].median.toFixed(2)} vs population ${Analgesia.MEAC.median}`);
}

console.log('\n=== 6. Contradictory data does not collapse the posterior ===');
{
    const contradictory = [
        { ce: 1.5, adequate: true }, { ce: 1.5, adequate: false },
        { ce: 1.5, adequate: true }, { ce: 1.5, adequate: false }
    ];
    const p = IndividualMEAC.posterior(contradictory);
    const s = IndividualMEAC.summary(p);
    const area = IndividualMEAC.trapezoid(p.density, p.step);
    check('the posterior stays a proper density', near(area, 1, 1e-9));
    check('the interval stays wide rather than collapsing', s.upper - s.lower > 0.5,
        `90% CI ${s.lower.toFixed(2)}-${s.upper.toFixed(2)} ng/mL`);
    check('a single contradicting record does not flip the estimate off the probing point',
        s.median > 0.8 && s.median < 2.6, `median ${s.median.toFixed(2)}`);
}

console.log('\n=== 7. Direction and monotonicity ===');
{
    const highInadequate = IndividualMEAC.summary(
        IndividualMEAC.posterior([{ ce: 2.5, adequate: false }, { ce: 2.5, adequate: false }]));
    const lowAdequate = IndividualMEAC.summary(
        IndividualMEAC.posterior([{ ce: 0.5, adequate: true }, { ce: 0.5, adequate: true }]));

    check('"inadequate at a high Ce" raises the estimated threshold',
        highInadequate.median > Analgesia.MEAC.median,
        `${highInadequate.median.toFixed(2)} ng/mL`);
    check('"adequate at a low Ce" lowers the estimated threshold',
        lowAdequate.median < Analgesia.MEAC.median,
        `${lowAdequate.median.toFixed(2)} ng/mL`);

    const posterior = IndividualMEAC.posterior([{ ce: 1.8, adequate: false }]);
    let monotone = true;
    let previous = -1;
    for (let ce = 0; ce <= 8; ce += 0.02) {
        const p = IndividualMEAC.probabilityAdequate(ce, posterior);
        if (p < previous - 1e-12 || p < 0 || p > 1) monotone = false;
        previous = p;
    }
    check('the individualised curve is monotone and stays in [0,1]', monotone);
}

console.log('\n=== 8. Worked example ===');
{
    const observations = [
        { ce: 1.10, adequate: false },
        { ce: 1.60, adequate: false },
        { ce: 2.10, adequate: true },
        { ce: 1.80, adequate: true }
    ];
    const posterior = IndividualMEAC.posterior(observations);
    const s = IndividualMEAC.summary(posterior);
    console.log(`        観測: ${observations.map(o => `${o.ce} ${o.adequate ? '十分' : '不十分'}`).join(' / ')}`);
    console.log(`        推定 MEAC ${s.median.toFixed(2)} ng/mL (90% CI ${s.lower.toFixed(2)}-${s.upper.toFixed(2)})`);
    for (const ce of [1.0, 1.5, 2.0, 2.5]) {
        console.log(`        Ce ${ce.toFixed(1)}: 個体化 ${(IndividualMEAC.probabilityAdequate(ce, posterior) * 100).toFixed(0)}%` +
            `  母集団 ${(Analgesia.probability(ce, Analgesia.MEAC) * 100).toFixed(0)}%`);
    }
    check('the worked example puts the threshold between the last inadequate and adequate probes',
        s.median > 1.10 && s.median < 2.10, `${s.median.toFixed(2)} ng/mL`);
}

console.log(`\n=== Summary: ${checks - failures}/${checks} checks passed ===\n`);
process.exit(failures === 0 ? 0 : 1);
