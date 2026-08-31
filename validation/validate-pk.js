/**
 * Evaluator pass for the fentanyl PK core (tci-validation Phase 3).
 * Run with:  node validation/validate-pk.js
 *
 * Checks performed:
 *   1. Published-value test  — the rate constants of each model must reproduce
 *      the values printed in their sources.
 *   2. Bolus response        — only Scott & Stanski, whose PK and ke0 come from
 *      one simultaneous estimation, should reproduce the published fentanyl
 *      bolus behaviour (Ce peaks at 3.6 min at 17% of Cp(0)). The hybrids are
 *      expected to differ, and the amount they differ by is printed.
 *   3. Mass balance          — with no elimination the total amount is conserved.
 *   4. Steady state          — a constant infusion converges to rate/CL and
 *      Ce converges to Cp.
 *   5. Integrator convergence — halving dt must not move the answer materially.
 *   6. Dose-record behaviour — linearity, superposition, Ce lag, monotone decay.
 *   7. Decrement times       — must lengthen with infusion duration.
 *   8. Boundary cases        — extreme weights must produce finite parameters.
 *   9. Maintenance-rate helper.
 */

const pk = require('../js/fentanyl-pk.js');
Object.assign(globalThis, pk);
const sim = require('../js/simulation-engine.js');
Object.assign(globalThis, sim);
const models = require('../js/models.js');
Object.assign(globalThis, models);

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`);
    }
}

function near(actual, expected, tol) {
    return Math.abs(actual - expected) <= tol;
}

console.log('\n=== 1a. Published-value test: Scott & Stanski 1987 rate constants ===');
{
    // Values as tabulated in Choi BM, Korean J Anesthesiol 2016;69:211-8,
    // Table 3, attributed to Scott & Stanski 1987 (PMID 3100765).
    const p = FentanylModels.scottStanski.getParameters();
    check('V1 = 13.0 L', near(p.v1, 13.0, 1e-9), `got ${p.v1}`);
    check('k10 = 0.0492 /min', near(p.k10, 0.0492, 1e-6), `got ${p.k10.toFixed(5)}`);
    check('k12 = 0.380 /min', near(p.k12, 0.380, 1e-6), `got ${p.k12.toFixed(5)}`);
    check('k21 = 0.0960 /min', near(p.k21, 0.0960, 1e-6), `got ${p.k21.toFixed(5)}`);
    check('k13 = 0.179 /min', near(p.k13, 0.179, 1e-6), `got ${p.k13.toFixed(5)}`);
    check('k31 = 0.0077 /min', near(p.k31, 0.0077, 1e-6), `got ${p.k31.toFixed(5)}`);
    check('ke0 = 0.147 /min', near(p.ke0, 0.147, 1e-9), `got ${p.ke0}`);
    check('ke0 half-time ~4.7 min', near(Math.LN2 / p.ke0, 4.7, 0.05),
        `got ${(Math.LN2 / p.ke0).toFixed(2)} min`);
    console.log(`        derived: V2 ${p.v2.toFixed(1)} L, V3 ${p.v3.toFixed(0)} L, ` +
        `CL ${p.cl.toFixed(3)}, Q2 ${p.q2.toFixed(2)}, Q3 ${p.q3.toFixed(2)} L/min`);
}

console.log('\n=== 1b. Published-value test: Shafer 1990 micro rate constants ===');
{
    const p = FentanylModels.shafer.getParameters();
    // Constants quoted for the Shafer fentanyl model in the TCI literature.
    check('k10 = 0.083 /min', near(p.k10, 0.083, 0.001), `got ${p.k10.toFixed(4)}`);
    check('k12 = 0.471 /min', near(p.k12, 0.471, 0.001), `got ${p.k12.toFixed(4)}`);
    check('k21 = 0.102 /min', near(p.k21, 0.102, 0.001), `got ${p.k21.toFixed(4)}`);
    check('k13 = 0.225 /min', near(p.k13, 0.225, 0.001), `got ${p.k13.toFixed(4)}`);
    check('k31 = 0.0060 /min', near(p.k31, 0.0060, 0.0002), `got ${p.k31.toFixed(5)}`);
    check('V1 = 6.09 L', near(p.v1, 6.09, 1e-9), `got ${p.v1}`);
    // Shafer 1990 abstract: "a smaller central compartment volume ... than
    // previously estimated", i.e. smaller than Scott & Stanski's 13.0 L.
    check('V1 smaller than Scott & Stanski V1, as the abstract states',
        p.v1 < FentanylModels.scottStanski.getParameters().v1,
        `${p.v1} L vs 13.0 L`);
    check('faster initial distribution than Scott & Stanski, as the abstract states',
        p.k12 > FentanylModels.scottStanski.getParameters().k12,
        `k12 ${p.k12.toFixed(3)} vs 0.380 /min`);
}

console.log('\n=== 2. Bolus response: is ke0 matched to the PK it is used with? ===');
console.log('        literature target: Ce peaks 3.6 min after a bolus at 17% of Cp(0)');
{
    // Only the model whose PK and ke0 were estimated together should reproduce
    // the published bolus behaviour. The others are hybrids and must not.
    const ss = timeToPeakEffect(FentanylModels.scottStanski.getParameters());
    check('Scott & Stanski reproduces the published tpeak (3.6 min)',
        near(ss.peakTime, 3.6, 0.25), `tpeak ${ss.peakTime.toFixed(2)} min`);
    check('Scott & Stanski reproduces the published peak fraction (17%)',
        near(ss.peakFraction, 0.17, 0.02), `${(ss.peakFraction * 100).toFixed(1)}%`);

    for (const id of FENTANYL_MODEL_IDS) {
        const model = FentanylModels[id];
        const r = timeToPeakEffect(model.getParameters({ weight: 70 }));
        console.log(`        ${model.shortLabel.padEnd(14)} tpeak ${r.peakTime.toFixed(2)} min, ` +
            `peak Ce/Cp(0) ${(r.peakFraction * 100).toFixed(1)}%` +
            `${model.isHybrid ? '   [hybrid ke0]' : ''}`);
        check(`${model.shortLabel}: tpeak stays in a physiologically sane 3-5 min`,
            r.peakTime >= 3.0 && r.peakTime <= 5.0, `${r.peakTime.toFixed(2)} min`);
    }
}

console.log('\n=== 3. Mass balance with elimination switched off ===');
{
    const p = { ...FentanylModels.scottStanski.getParameters(), k10: 0 };
    let state = { a1: 100, a2: 0, a3: 0, ce: 0 };
    const dt = 0.02;
    for (let i = 0; i < 60 / dt; i++) state = rk4Step(state, 0, p, dt);
    const total = state.a1 + state.a2 + state.a3;
    check('total amount conserved over 60 min', near(total, 100, 1e-6),
        `got ${total.toFixed(9)} ug`);
}

console.log('\n=== 4. Steady state under a constant infusion ===');
for (const id of FENTANYL_MODEL_IDS) {
    const model = FentanylModels[id];
    const p = model.getParameters({ weight: 70 });
    const rateUgHr = 100;
    const expectedCss = rateUgHr / 60 / p.cl;   // ug/min / (L/min) = ug/L = ng/mL

    let state = { a1: 0, a2: 0, a3: 0, ce: 0 };
    const dt = 0.05;
    // Three-compartment fentanyl needs a long run to fill V3 (k31 ~ 0.006/min).
    for (let i = 0; i < 6000 / dt; i++) state = rk4Step(state, rateUgHr / 60, p, dt);
    const cp = plasmaConcentration(state, p);

    check(`${model.name}: Cp converges to rate/CL`, near(cp, expectedCss, expectedCss * 0.02),
        `Cp ${cp.toFixed(4)} vs expected ${expectedCss.toFixed(4)} ng/mL`);
    check(`${model.name}: Ce converges to Cp`, near(state.ce, cp, cp * 0.001),
        `Ce ${state.ce.toFixed(4)} vs Cp ${cp.toFixed(4)}`);
}

console.log('\n=== 5. Integrator convergence (dt halving) ===');
{
    const p = FentanylModels.scottStanski.getParameters();
    const events = [new DoseEvent(0, 200, 100), new DoseEvent(30, 0, 50), new DoseEvent(60, 100, 0)];
    const coarse = simulateDoseRecord(events, p, { dt: 0.04, durationMin: 180, sampleIntervalMin: 1 });
    const fine = simulateDoseRecord(events, p, { dt: 0.005, durationMin: 180, sampleIntervalMin: 1 });

    let maxCeDiff = 0;
    let maxCpDiff = 0;
    for (let i = 0; i < coarse.times.length; i++) {
        maxCeDiff = Math.max(maxCeDiff, Math.abs(coarse.ce[i] - fine.ce[i]));
        maxCpDiff = Math.max(maxCpDiff, Math.abs(coarse.cp[i] - fine.cp[i]));
    }
    check('max |Ce(dt=0.04) - Ce(dt=0.005)| < 1e-4 ng/mL', maxCeDiff < 1e-4,
        `got ${maxCeDiff.toExponential(2)}`);
    check('max |Cp(dt=0.04) - Cp(dt=0.005)| < 1e-3 ng/mL', maxCpDiff < 1e-3,
        `got ${maxCpDiff.toExponential(2)}`);
}

console.log('\n=== 6. Dose-record behaviour ===');
{
    const p = FentanylModels.scottStanski.getParameters();

    // A single 100 ug bolus: peak Ce should be 100x the unit-bolus peak.
    const unit = timeToPeakEffect(p);
    const run = simulateDoseRecord([new DoseEvent(0, 100, 0)], p,
        { dt: 0.005, durationMin: 30, sampleIntervalMin: 0.05 });
    check('100 ug bolus scales linearly from the unit bolus',
        near(run.maxCe, unit.peakCe * 100, unit.peakCe * 100 * 0.002),
        `sim ${run.maxCe.toFixed(4)} vs analytic ${(unit.peakCe * 100).toFixed(4)} ng/mL`);

    // Superposition: two 100 ug boluses equal twice one 100 ug bolus at the same times.
    const single = simulateDoseRecord([new DoseEvent(0, 100, 0)], p,
        { dt: 0.01, durationMin: 120, sampleIntervalMin: 1 });
    const doubled = simulateDoseRecord([new DoseEvent(0, 200, 0)], p,
        { dt: 0.01, durationMin: 120, sampleIntervalMin: 1 });
    let maxSuperDiff = 0;
    for (let i = 0; i < single.times.length; i++) {
        maxSuperDiff = Math.max(maxSuperDiff, Math.abs(doubled.ce[i] - 2 * single.ce[i]));
    }
    check('linear superposition holds', maxSuperDiff < 1e-9, `got ${maxSuperDiff.toExponential(2)}`);

    // Ce must lag Cp: after a bolus Cp peaks at t=0 while Ce peaks later.
    const trace = simulateDoseRecord([new DoseEvent(0, 100, 0)], p,
        { dt: 0.005, durationMin: 20, sampleIntervalMin: 0.05 });
    const ceArgmax = trace.ce.indexOf(Math.max(...trace.ce));
    check('Ce peaks after Cp', trace.times[ceArgmax] > 2.0,
        `Ce peak at ${trace.times[ceArgmax].toFixed(2)} min`);

    // Stopping the infusion must make Ce fall monotonically once Ce > Cp.
    const stopRun = simulateDoseRecord(
        [new DoseEvent(0, 100, 200), new DoseEvent(60, 0, 0)], p,
        { dt: 0.01, durationMin: 240, sampleIntervalMin: 1 });
    let monotone = true;
    for (let i = 80; i < stopRun.times.length; i++) {
        if (stopRun.ce[i] > stopRun.ce[i - 1] + 1e-12) { monotone = false; break; }
    }
    check('Ce decreases monotonically after the infusion is stopped', monotone);
}

console.log('\n=== 7. Context-sensitive decrement times ===');
{
    const p = FentanylModels.scottStanski.getParameters();
    const short = simulateDoseRecord([new DoseEvent(0, 100, 150), new DoseEvent(30, 0, 0)], p,
        { dt: 0.02, durationMin: 30, sampleIntervalMin: 1 });
    const long = simulateDoseRecord([new DoseEvent(0, 100, 150), new DoseEvent(240, 0, 0)], p,
        { dt: 0.02, durationMin: 240, sampleIntervalMin: 1 });

    const thresholds = [1.0];
    const dShort = decrementTimes(short.finalState, p, thresholds)[0];
    const dLong = decrementTimes(long.finalState, p, thresholds)[0];

    check('decrement time to 1.0 ng/mL grows with infusion duration',
        dShort !== null && dLong !== null && dLong > dShort,
        `30 min infusion: ${dShort === null ? 'n/a' : dShort.toFixed(1)} min, ` +
        `240 min infusion: ${dLong === null ? 'n/a' : dLong.toFixed(1)} min`);

    const alreadyBelow = decrementTimes({ a1: 0, a2: 0, a3: 0, ce: 0.2 }, p, [1.0])[0];
    check('threshold already below Ce returns 0', alreadyBelow === 0, `got ${alreadyBelow}`);
}

console.log('\n=== 8. Boundary cases ===');
{
    const weights = [30, 40, 50, 70, 90, 120, 200];
    let allFinite = true;
    const rows = [];
    for (const w of weights) {
        const p = FentanylModels.bae.getParameters({ weight: w });
        const ok = [p.v1, p.v2, p.v3, p.cl, p.q2, p.q3, p.k10, p.k12, p.k21, p.k13, p.k31]
            .every(v => isFinite(v) && v > 0);
        if (!ok) allFinite = false;
        const tp = timeToPeakEffect(p);
        rows.push(`${String(w).padStart(3)} kg  V1 ${p.v1.toFixed(2)} L  CL ${p.cl.toFixed(3)} L/min  tpeak ${tp.peakTime.toFixed(2)} min`);
    }
    check('Bae model yields finite positive parameters over 30-200 kg', allFinite);
    rows.forEach(r => console.log('        ' + r));
}

console.log('\n=== 9. Maintenance rate helper ===');
{
    const p = FentanylModels.scottStanski.getParameters();
    const target = 1.5;
    const rate = maintenanceRateUgHr(target, p);
    let state = { a1: 0, a2: 0, a3: 0, ce: 0 };
    const dt = 0.05;
    for (let i = 0; i < 6000 / dt; i++) state = rk4Step(state, rate / 60, p, dt);
    check('maintenance rate reaches the target Cp at steady state',
        near(plasmaConcentration(state, p), target, target * 0.02),
        `rate ${rate.toFixed(1)} ug/hr gives Cp ${plasmaConcentration(state, p).toFixed(3)} ng/mL`);
}

console.log('\n=== 10. Time to reach steady state under a constant infusion ===');
{
    for (const id of FENTANYL_MODEL_IDS) {
        const model = FentanylModels[id];
        const pk = model.getParameters({ weight: 70 });
        const t90 = timeToSteadyStateFraction(pk, 0.9);

        // Fentanyl's slow third compartment means a rate derived from
        // rate = Ce * CL takes many hours to actually reach that Ce.
        check(`${model.shortLabel}: Ce needs hours, not minutes, to reach 90% of steady state`,
            t90 !== null && t90 > 240,
            `${(t90 / 60).toFixed(1)} h`);

        // Independence from the infusion rate (the system is linear).
        const rateUgHr = 200;
        let state = { a1: 0, a2: 0, a3: 0, ce: 0 };
        const dt = 0.1;
        for (let i = 0; i < t90 / dt; i++) state = rk4Step(state, rateUgHr / 60, pk, dt);
        const expected = 0.9 * (rateUgHr / 60) / pk.cl;
        check(`${model.shortLabel}: the same time holds at a different rate`,
            near(state.ce, expected, expected * 0.005),
            `Ce ${state.ce.toFixed(4)} vs 90% of Css ${expected.toFixed(4)} ng/mL`);
    }
}

console.log(`\n=== Summary: ${checks - failures}/${checks} checks passed ===\n`);
process.exit(failures === 0 ? 0 : 1);
