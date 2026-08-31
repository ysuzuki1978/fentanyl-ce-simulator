/**
 * Fentanyl pharmacokinetic models.
 *
 * All three models share the same effect-compartment equation
 *   dCe/dt = ke0 * (Cp - Ce)
 * and the same ke0 (0.147 /min). Only one of them is a model in which the PK
 * and the ke0 were estimated together; the other two borrow the ke0, and the
 * application labels them as hybrids everywhere they appear.
 *
 * ---------------------------------------------------------------------------
 * 1. Scott & Stanski 1987  — the reference PK/PD pair (default)
 *    Scott JC, Stanski DR. Decreased fentanyl and alfentanil dose requirements
 *    with age. A simultaneous pharmacokinetic and pharmacodynamic evaluation.
 *    J Pharmacol Exp Ther 1987;240:159-66. PMID 3100765.
 *    PK and ke0 were estimated simultaneously against the EEG spectral edge, so
 *    this is the one internally consistent fentanyl PK/PD model of the three.
 *    Parameter values as tabulated in the open-access review
 *    Choi BM. Korean J Anesthesiol 2016;69:211-8 (PMC4891531), Table 3, which
 *    attributes them to Scott & Stanski 1987:
 *      V1 13.0 L, k10 0.0492, k12 0.380, k21 0.0960, k13 0.179, k31 0.0077,
 *      ke0 0.147 /min.
 *    Consistency check: this set reproduces the published bolus behaviour of
 *    fentanyl — Ce peaks 3.7 min after a bolus at 16.5% of the initial plasma
 *    concentration, against the quoted 3.6 min and 17%. Neither of the other
 *    two parameter sets does, which is the evidence that ke0 = 0.147 belongs
 *    with this PK and not with the others.
 *    Limitations: adult male patients, EEG endpoint, no weight covariate.
 *
 * 2. Shafer 1990 PK + Scott/Stanski ke0  — HYBRID
 *    Shafer SL, Varvel JR, Aziz N, Scott JC. Pharmacokinetics of fentanyl
 *    administered by computer-controlled infusion pump.
 *    Anesthesiology 1990;73:1091-102. PMID 2248388.
 *      V1 6.09 L, V2 28.1 L, V3 228 L, CL 0.504, Q2 2.87, Q3 1.37 L/min
 *      (values as implemented at opentci.org; the paper's own abstract states
 *      the model has "a smaller central compartment volume and a more rapid
 *      initial distribution half-life than previously estimated for fentanyl",
 *      which is consistent with V1 6.09 L against Scott & Stanski's 13.0 L).
 *    A plasma PK model with no ke0 of its own. With the borrowed ke0 the bolus
 *    peak moves to 3.2 min.
 *    Shibutani K et al. Anesthesiology 2004;101:603-13 (PMID 15329584) found
 *    that this model systematically overestimates fentanyl concentration as
 *    total body weight rises, hence the obesity warning in the UI.
 *
 * 3. Bae 2020 allometric PK + Scott/Stanski ke0  — HYBRID
 *    Bae J, Kwon M, Lee YH, Lee EK, Choi BM, Noh GJ. An allometric
 *    pharmacokinetic model and minimum effective analgesic concentration of
 *    fentanyl in patients undergoing major abdominal surgery.
 *    Br J Anaesth 2020;125:976-85. PMID 32861508.
 *      70 kg: V1 10.1, V2 26.5, V3 206 L, Cl 0.704, Q1 2.38, Q2 1.49 L/min.
 *      (The paper writes Cl, Q1, Q2; Q1 and Q2 are the inter-compartmental
 *      clearances to V2 and V3, i.e. Q2 and Q3 in the notation used here.)
 *    The only one of the three with a body-weight covariate. Reports plasma PK
 *    only — no ke0 — so this too is a hybrid. Bolus peak moves to 4.3 min.
 *
 * ALLOMETRIC EXPONENT CAVEAT: the Bae abstract states that an allometric
 * expression was used but does not print the exponents, and the full text is
 * not open access. This implementation applies the conventional theory-based
 * exponents (1 for volumes, 0.75 for clearances). Only the Bae curve depends on
 * that assumption; the exponents are exposed below so they can be corrected in
 * one place if the published values differ.
 */

const FENTANYL_KE0 = 0.147;          // /min, Scott & Stanski 1987
const BAE_REFERENCE_WEIGHT = 70.0;   // kg
const BAE_VOLUME_EXPONENT = 1.0;     // assumption, see caveat above
const BAE_CLEARANCE_EXPONENT = 0.75; // assumption, see caveat above

/** Completes a parameter set from volumes and clearances. */
function fromClearances(p) {
    return {
        v1: p.v1, v2: p.v2, v3: p.v3,
        cl: p.cl, q2: p.q2, q3: p.q3,
        ke0: p.ke0,
        k10: p.cl / p.v1,
        k12: p.q2 / p.v1,
        k21: p.q2 / p.v2,
        k13: p.q3 / p.v1,
        k31: p.q3 / p.v3
    };
}

/** Completes a parameter set published as micro rate constants. */
function fromRateConstants(p) {
    const cl = p.k10 * p.v1;
    const q2 = p.k12 * p.v1;
    const q3 = p.k13 * p.v1;
    return {
        v1: p.v1,
        v2: q2 / p.k21,
        v3: q3 / p.k31,
        cl, q2, q3,
        ke0: p.ke0,
        k10: p.k10, k12: p.k12, k21: p.k21, k13: p.k13, k31: p.k31
    };
}

const FentanylModels = {
    scottStanski: {
        id: 'scottStanski',
        name: 'Scott & Stanski',
        shortLabel: 'Scott-Stanski',
        fullName: 'Scott & Stanski 1987 PK/PD',
        reference: 'Scott JC, Stanski DR. J Pharmacol Exp Ther 1987;240:159-66 (PMID 3100765). パラメータ値は Choi BM. Korean J Anesthesiol 2016;69:211-8 (PMC4891531) Table 3 より。',
        isHybrid: false,
        note: 'PK と ke0 を同一データから同時推定した、本アプリで唯一 PK/PD が単一研究に由来するモデル。ボーラス後の Ce ピークは 3.7 分・初期血漿濃度の 16.5% で、文献の「3.6 分・17%」を再現する。成人男性・EEG spectral edge を効果指標として導出されており、体重共変量は持たない。',
        weightScaled: false,
        validWeightRange: null,
        color: '#2FBFA8',
        cpColor: '#3266AD',

        getParameters() {
            return fromRateConstants({
                v1: 13.0,
                k10: 0.0492, k12: 0.380, k21: 0.0960, k13: 0.179, k31: 0.0077,
                ke0: FENTANYL_KE0
            });
        }
    },

    shafer: {
        id: 'shafer',
        name: 'Shafer',
        shortLabel: 'Shafer',
        fullName: 'Shafer 1990 PK + Scott/Stanski ke0',
        reference: 'Shafer SL et al. Anesthesiology 1990;73:1091-102 (PMID 2248388) + ke0 は Scott & Stanski 1987 より流用',
        isHybrid: true,
        note: 'CCIP 実測に基づく血漿 PK モデルで、ke0 を持たない。Scott/Stanski の ke0 を流用しているため単一研究で検証された PK/PD モデルではなく、ボーラス後の Ce ピークは 3.2 分にずれる。Shibutani ら (Anesthesiology 2004;101:603-13, PMID 15329584) は本モデルが体重増加に伴い濃度を系統的に過大評価すると報告している。',
        weightScaled: false,
        validWeightRange: [40, 90],
        color: '#D08C3A',
        cpColor: '#8A6BB0',

        getParameters() {
            return fromClearances({
                v1: 6.09, v2: 28.1, v3: 228,
                cl: 0.504, q2: 2.87, q3: 1.37,
                ke0: FENTANYL_KE0
            });
        }
    },

    bae: {
        id: 'bae',
        name: 'Bae',
        shortLabel: 'Bae',
        fullName: 'Bae 2020 allometric PK + Scott/Stanski ke0',
        reference: 'Bae J et al. Br J Anaesth 2020;125:976-85 (PMID 32861508) + ke0 は Scott & Stanski 1987 より流用',
        isHybrid: true,
        note: '成人 95 例の現代的な母集団 PK で、3 モデル中で唯一体重を共変量に持つ。血漿 PK のみの報告で ke0 を含まないため hybrid であり、ボーラス後の Ce ピークは 4.3 分にずれる。allometric exponent は原著抄録に記載がなく全文が非公開のため、慣用値 (容積 1、クリアランス 0.75) を仮定している。',
        weightScaled: true,
        validWeightRange: null,
        color: '#5BA4CF',
        cpColor: '#4A6FA5',

        getParameters(patient) {
            const w = patient && isFinite(patient.weight) ? patient.weight : BAE_REFERENCE_WEIGHT;
            const fv = Math.pow(w / BAE_REFERENCE_WEIGHT, BAE_VOLUME_EXPONENT);
            const fc = Math.pow(w / BAE_REFERENCE_WEIGHT, BAE_CLEARANCE_EXPONENT);
            return fromClearances({
                v1: 10.1 * fv, v2: 26.5 * fv, v3: 206 * fv,
                cl: 0.704 * fc, q2: 2.38 * fc, q3: 1.49 * fc,
                ke0: FENTANYL_KE0
            });
        }
    }
};

const FENTANYL_MODEL_IDS = ['scottStanski', 'shafer', 'bae'];
const FENTANYL_DEFAULT_MODEL = 'scottStanski';

/**
 * Right-hand side of the 3-compartment + effect-site system.
 * a1..a3 in ug, ce in ng/mL, infusion in ug/min.
 */
function fentanylDerivatives(state, infusionUgMin, pk) {
    const cp = state.a1 / pk.v1;
    return {
        a1: infusionUgMin - (pk.k10 + pk.k12 + pk.k13) * state.a1 + pk.k21 * state.a2 + pk.k31 * state.a3,
        a2: pk.k12 * state.a1 - pk.k21 * state.a2,
        a3: pk.k13 * state.a1 - pk.k31 * state.a3,
        ce: pk.ke0 * (cp - state.ce)
    };
}

/** One classical RK4 step over dt minutes at a constant infusion rate. */
function rk4Step(state, infusionUgMin, pk, dt) {
    const k1 = fentanylDerivatives(state, infusionUgMin, pk);
    const k2 = fentanylDerivatives({
        a1: state.a1 + 0.5 * dt * k1.a1,
        a2: state.a2 + 0.5 * dt * k1.a2,
        a3: state.a3 + 0.5 * dt * k1.a3,
        ce: state.ce + 0.5 * dt * k1.ce
    }, infusionUgMin, pk);
    const k3 = fentanylDerivatives({
        a1: state.a1 + 0.5 * dt * k2.a1,
        a2: state.a2 + 0.5 * dt * k2.a2,
        a3: state.a3 + 0.5 * dt * k2.a3,
        ce: state.ce + 0.5 * dt * k2.ce
    }, infusionUgMin, pk);
    const k4 = fentanylDerivatives({
        a1: state.a1 + dt * k3.a1,
        a2: state.a2 + dt * k3.a2,
        a3: state.a3 + dt * k3.a3,
        ce: state.ce + dt * k3.ce
    }, infusionUgMin, pk);

    return {
        a1: Math.max(0, state.a1 + (dt / 6) * (k1.a1 + 2 * k2.a1 + 2 * k3.a1 + k4.a1)),
        a2: Math.max(0, state.a2 + (dt / 6) * (k1.a2 + 2 * k2.a2 + 2 * k3.a2 + k4.a2)),
        a3: Math.max(0, state.a3 + (dt / 6) * (k1.a3 + 2 * k2.a3 + 2 * k3.a3 + k4.a3)),
        ce: Math.max(0, state.ce + (dt / 6) * (k1.ce + 2 * k2.ce + 2 * k3.ce + k4.ce))
    };
}

/** Plasma concentration (ng/mL) for a state under the given parameter set. */
function plasmaConcentration(state, pk) {
    return Math.max(0, state.a1 / pk.v1);
}

/**
 * Bolus response of a parameter set: when Ce peaks after a unit bolus into an
 * empty patient, the peak Ce, and that peak as a fraction of the initial plasma
 * concentration. The fraction is the quantity quoted in the literature as "17%
 * of the initial plasma concentration" and is what distinguishes a matched
 * PK/ke0 pair from a transplanted one.
 */
function timeToPeakEffect(pk, horizonMin = 30, dt = 0.002) {
    let state = { a1: 1.0, a2: 0, a3: 0, ce: 0 };
    let peakTime = 0;
    let peakCe = -1;
    const steps = Math.round(horizonMin / dt);
    for (let i = 1; i <= steps; i++) {
        state = rk4Step(state, 0, pk, dt);
        if (state.ce > peakCe) {
            peakCe = state.ce;
            peakTime = i * dt;
        }
    }
    return { peakTime, peakCe, peakFraction: peakCe * pk.v1 };
}

if (typeof window !== 'undefined') {
    window.FentanylModels = FentanylModels;
    window.FENTANYL_MODEL_IDS = FENTANYL_MODEL_IDS;
    window.FENTANYL_DEFAULT_MODEL = FENTANYL_DEFAULT_MODEL;
    window.FENTANYL_KE0 = FENTANYL_KE0;
    window.fentanylDerivatives = fentanylDerivatives;
    window.rk4Step = rk4Step;
    window.plasmaConcentration = plasmaConcentration;
    window.timeToPeakEffect = timeToPeakEffect;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        FentanylModels, FENTANYL_MODEL_IDS, FENTANYL_DEFAULT_MODEL, FENTANYL_KE0,
        BAE_VOLUME_EXPONENT, BAE_CLEARANCE_EXPONENT,
        fentanylDerivatives, rk4Step, plasmaConcentration, timeToPeakEffect
    };
}
