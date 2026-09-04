# Fentanyl Ce Simulator V1.0.0

> ## ⚠ Research and educational use only — clinical use is prohibited
>
> **This software must not be used to determine drug dosing, to diagnose, or to guide
> treatment for any patient.**
>
> - It is not a medical device. It has received no approval, clearance, or registration
>   from any regulatory authority.
> - Displayed concentrations are **theoretical values** from population pharmacokinetic
>   models, not measured concentrations in a patient.
> - The analgesia indicators are reference values derived from published population
>   statistics; they do not establish that any individual patient is adequately analgesed.
> - The three implemented PK models give Ce values that **differ by up to 1.8-fold for the
>   same dose** ([the disagreement between models is not small](#the-disagreement-between-models-is-not-small)).
>   No single number can be treated as the correct answer.
> - No prospective validation has been performed. Neither comparison against measured
>   concentrations nor comparison against clinical outcomes has been carried out.
>
> The intended uses are limited to learning how pharmacokinetic models behave, making the
> disagreement between models visible, and simulation for research.

A research and educational simulator that predicts the fentanyl effect-site concentration
(Ce) and shows where that concentration sits with respect to analgesia, with every value
tied to a published source. The interface follows the three-step structure of the companion
Propofol TCI TIVA application.

- **Step 1 Real time** — predicts Cp and Ce for boluses and infusions in real time, with the
  analgesia indicators updating alongside
- **Step 2 Analgesia** — the analgesia indicators at any chosen Ce, the Ce–effect curve, and
  the dosing needed to hold that Ce
- **Step 3 Dose record** — reconstructs the full time course from the dose events on an
  anaesthesia record, gives the decrement times after dosing stops, and estimates the
  patient's own MEAC from recorded analgesia assessments

It runs by opening `index.html` in a browser. No build step; the only external dependency is
Chart.js.

---

## The PK models, and why they were chosen

### Conclusion first

**ke0 = 0.147 /min was estimated jointly with the Scott & Stanski 1987 PK, and transplanting
it onto a different PK model shifts the post-bolus peak time.** The default in this
application is therefore not "Shafer PK + Scott/Stanski ke0" but the **complete Scott &
Stanski 1987 PK/PD set**.

Verification: the behaviour quoted in the literature for a fentanyl bolus — "Ce peaks at
3.6 min, at 17% of the initial plasma concentration" — is reproduced only by the Scott &
Stanski pairing.

| Model | Ce peak time | Peak Ce / Cp(0) | Matches the literature |
|---|---|---|---|
| Published value (via Shafer & Varvel 1991) | 3.6 min | 17% | — |
| **Scott & Stanski 1987 PK + its own ke0** | **3.71 min** | **16.5%** | **yes** |
| Shafer 1990 PK + borrowed ke0 | 3.17 min | 13.7% | no |
| Bae 2020 PK + borrowed ke0 | 4.25 min | 20.1% | no |

This is exactly the problem Minto et al (Anesthesiology 2003;99:324-33, PMID 12883405) warn
about as the "naive approach" to moving a ke0 onto another PK model. All three models are
implemented and switchable, but the two hybrids carry a `HYBRID` badge in the UI and their
peak-time shift is displayed at all times.

### This default is not optimal for every question

The reasoning above rests on internal consistency between the PK and the ke0. **For some
questions a different model is more appropriate.** This is also why the application should
not be used with the default model alone, so it is stated explicitly.

**The influence of ke0 has almost vanished by five minutes.** The spread in Ce when ke0 is
varied by ±70% (0.10 / 0.147 / 0.25, with the PK fixed at Bae), against the spread when ke0
is fixed and the PK model is varied:

| Time | Varying ke0 | Varying the PK model |
|---|---|---|
| 3 min | 1.94× | 1.79× |
| 10 min | **1.10×** | 1.80× |
| 30 min | **1.29×** | 1.53× |
| 120 min | **1.10×** | 1.28× |

Consistency of the ke0 therefore matters only in the window where it least affects the
MEC / MEAC readout. MEAC was defined at steady state (Ce ≈ Cp) in the first place, which
makes this more pronounced still. **Bae 2020, by contrast, determined its PK and its MEAC in
the same study, in the same patients, using the same assay**, so the concentration on screen
and the threshold it is compared against sit on the same scale.

For a 60 kg patient given fentanyl 100 µg, then 50 µg at 30 min and 50 µg at 70 min, over a
120 min case, the fraction of the case for which Ce exceeded the MEAC of 0.99 ng/mL:

| Model | Time above MEAC |
|---|---|
| Scott & Stanski | 12.3% |
| Shafer | 44.2% |
| Bae | 43.8% |

The clinically relevant answer for the same dose record differs by 3.6-fold, and the outlier
is the default, Scott & Stanski.

**Guide by question:**

| What you want to see | Suitable model | Why |
|---|---|---|
| Post-bolus peak time | Scott & Stanski | The only pairing reproducing the published 3.6 min / 17% |
| Adequacy against MEC / MEAC | Bae 2020 | Threshold and concentration come from the same study; has a weight covariate |
| Decay after dosing ends | **All three** | The spread itself is the uncertainty (see below) |

For the period after dosing ends, starting from a common effect-titrated point
(Ce 1.5 ng/mL) narrows the concentration difference between models to 1.00–1.38×, but
because the washout curve is flat **the difference in timing widens to 2–3 fold** (time to
fall below MEAC after a 480 min case: Scott & Stanski 152 min, Shafer 83 min, Bae 55 min). A
10% error in the predicted Ce moves the crossing time by 30–92 min. **Decrement times cannot
be read as a schedule in minutes.** Treat them as an ordering and an order of magnitude.

Emergence itself cannot be predicted from a fentanyl-alone Ce. Emergence is governed by the
co-administered hypnotic, and fentanyl contributes indirectly through synergy (in Kazama
1998, PMID 9778007, fentanyl 1 ng/mL lowers the propofol Cp50 by 30–44%). No interaction
model is implemented in this version.

### 1. Scott & Stanski 1987 (default)

Scott JC, Stanski DR. *J Pharmacol Exp Ther* 1987;240:159-66. **PMID 3100765**

The PK and the ke0 were estimated simultaneously from the same data, making this the only
model here whose PK/PD comes from a single study. Parameter values are those tabulated for
Scott & Stanski 1987 in the open-access review Choi BM. *Korean J Anesthesiol*
2016;69:211-8 (PMC4891531), Table 3:

| | Value |
|---|---|
| V1 | 13.0 L |
| k10 / k12 / k21 / k13 / k31 | 0.0492 / 0.380 / 0.0960 / 0.179 / 0.0077 /min |
| ke0 | 0.147 /min |
| Derived V2 / V3 | 51.5 L / 302 L |
| Derived CL / Q2 / Q3 | 0.640 / 4.94 / 2.33 L/min |

Limitations: adult male patients only, EEG spectral edge as the effect measure, no weight
covariate. The same paper shows dose requirement falling by 50% from age 20 to 89, but that
is a **pharmacodynamic change in brain sensitivity** rather than a change in PK, so age does
not enter the Ce prediction.

### 2. Shafer 1990 PK + Scott/Stanski ke0 (HYBRID)

Shafer SL, Varvel JR, Aziz N, Scott JC. *Anesthesiology* 1990;73:1091-102. **PMID 2248388**

V1 6.09 L, V2 28.1 L, V3 228 L, CL 0.504, Q2 2.87, Q3 1.37 L/min (the values implemented at
opentci.org).

Identifying this parameter set required care. A different value, V1 = 26.6 L, surfaced during
the literature search, but V1 = 6.09 L was judged correct on three grounds:

1. The original abstract states explicitly that the model has "a **smaller central
   compartment volume** and a more rapid initial distribution half-life than previously
   estimated", so it must be smaller than the 13.0 L of Scott & Stanski
2. The micro rate constants implied by V1 = 6.09 L (k10 0.083, k12 0.471, k21 0.102,
   k13 0.225, k31 0.0060) agree to three significant figures with the values cited as the
   Shafer model in the TCI literature
3. With V1 = 26.6 L, k12 would be **slower** than Scott & Stanski, contradicting the abstract

Limitations: plasma PK only, with no ke0. Shibutani et al (*Anesthesiology* 2004;101:603-13,
**PMID 15329584**) report that this model systematically overestimates concentration as body
weight rises (R² = 0.689 for error against total body weight). The application warns outside
40–90 kg.

### 3. Bae 2020 allometric PK + Scott/Stanski ke0 (HYBRID)

Bae J, Kwon M, Lee YH, Lee EK, Choi BM, Noh GJ. *Br J Anaesth* 2020;125:976-85.
**PMID 32861508**

For a 70 kg reference adult: V1 10.1, V2 26.5, V3 206 L, Cl 0.704, Q1 2.38, Q2 1.49 L/min.
(The paper's Q1 and Q2 correspond to Q2 and Q3 in the notation used here.) This is the only
one of the three with a body-weight covariate.

**Unresolved assumption**: the abstract states only that an allometric expression was used
and does not print the exponents, and the full text is not open access. This implementation
assumes the conventional theory-based values (1 for volumes, 0.75 for clearances). They are
exposed as `BAE_VOLUME_EXPONENT` / `BAE_CLEARANCE_EXPONENT` in `js/fentanyl-pk.js` so they
can be corrected in one place. **This needs checking against the full text.**

### The disagreement between models is not small

Ce six minutes after a 100 µg bolus plus a 50 µg/hr infusion in a 60 kg patient:

| Model | Ce (ng/mL) | V1 (60 kg) |
|---|---|---|
| Scott & Stanski | 1.233 | 13.00 L |
| Shafer hybrid | 2.092 | 6.09 L |
| Bae hybrid | 2.246 | 8.66 L |

A spread of roughly **1.8-fold**. The main driver is V1 (13.0 L against 6.09 L and 8.66 L),
because immediately after a bolus the plasma concentration passes straight through to Ce.
Where the absolute Ce is compared against an analgesic threshold, the choice of model changes
the conclusion. The "Compare" mode overlays all three.

---

## Displaying the analgesic effect

Rather than showing Ce alone, the application shows where that concentration sits with
respect to analgesia. **Every number is tied to a specific paper; there are no unsourced
constants.**

### Concentration bands

| Band | Ce (ng/mL) | Source |
|---|---|---|
| Sub-analgesic | < 0.63 | Gourlay 1988 (PMID 3354866): MEC 0.63 ± 0.25 |
| MEC band | 0.63 – 0.99 | Gourlay 1988 / Bae 2020 (PMID 32861508) MEC 0.72 |
| Postoperative analgesia | 0.99 – 1.67 | Bae 2020: MEAC median 0.99 (IQR 0.76-1.28) |
| Intraoperative adjunct | 1.67 – 3.26 | McEwan 1993 (PMID 8489058): 50% MAC reduction at 1.67 |
| High-stimulus range | 3.26 – 4.17 | Glass 1993 (PMID 8489055): skin incision Cp50 3.26 / Cp50-BAR 4.17 |
| High concentration | ≥ 4.17 | Mildh 2001 (PMID 11574361): EC50 3.5 for a 50% fall in respiratory rate |

### Population probability curves

MEC and MEAC are per-patient thresholds, so evaluating the distribution of that threshold at
a given Ce gives the fraction of patients for whom that Ce achieves analgesia. A log-logistic
was fitted to the median and quartiles of Bae 2020:

    P(Ce) = 1 / (1 + (median/Ce)^γ),  γ = 2·ln(3) / ln(Q3/Q1)

γ is fixed by the quartiles rather than chosen. For MEAC it comes to γ = 4.215, and the curve
returns 24.7% at the published Q1, 50.0% at the median and 74.7% at Q3. (The MEC IQR is
asymmetric in log space, so a single log-logistic cannot pass through both quartiles; the fit
passes through the median and splits the difference between the quartiles.)

### Volatile MAC reduction

A hyperbolic Emax was fitted to the three published points of McEwan 1993 (50% at
1.67 ng/mL, 63% at 3 ng/mL, a further 19% only by 10 ng/mL). The closed-form fit through two
of them gives Emax = 93.5%, C50 = 1.454 ng/mL, which reproduces the third point's 82% as
81.7% — a check at a point not used in the fit.

### The maintenance rate is not "the rate that reaches that Ce"

Step 2 shows the maintenance rate for a target Ce from `rate = Ce × CL`, but this is a
**steady-state relation**. Fentanyl has a large third compartment (V3 302 L under Scott &
Stanski) and moves into it slowly (k31 = 0.0077 /min), so holding that rate constant reaches
90% of the target Ce only after:

| Model | Time to 90% of steady state |
|---|---|
| Scott & Stanski | 24.3 hours |
| Shafer | 22.9 hours |
| Bae (70 kg) | 15.6 hours |

which will essentially never happen within an operating time. This figure is shown as its own
card because reading the maintenance rate as "the rate that produces that Ce" leads to
underdosing. In a worked example of a 100 µg bolus plus 80 µg/hr for 150 min, Ce was at or
above the MEAC (0.99 ng/mL) for only 11% of the record.

---

## Individualised MEAC estimation (Step 3)

The bands and population probabilities above are all monotone transforms of Ce, and a
monotone transform adds no information. Step 3 therefore adds a feature that **estimates the
patient's own threshold**. Once even one assessment is recorded, the display is no longer a
function of Ce alone.

### The model

Writing the patient's own MEAC as *m* and working in the space of ln *m*:

```
prior        ln m ~ Logistic( ln 0.99 , s_between )
likelihood   P(adequate | Ce = c, m) = 1 / (1 + exp( -(ln c - ln m) / s_within ))
```

Both scales are derived from published statistics rather than chosen.

| Scale | Origin | SD on the log scale |
|---|---|---|
| `s_total` | γ = 4.215, fitted to the Bae 2020 MEAC quartiles | 0.430 |
| `s_within` | **Within-patient CV of 30.2%** from Gourlay 1988 (PMID 3354866) | 0.295 |
| `s_between` | Variance decomposition `sd_between² = sd_total² − sd_within²` | 0.313 |

This decomposition is the key to the construction. The variability Bae observed is the sum of
a between-patient and a within-patient component, so integrating the likelihood over the
prior **returns the published population curve**. With zero records the display therefore
matches the population curve (maximum difference 1.03 percentage points in validation), and
individualises smoothly as records accumulate. It degrades safely.

The posterior is obtained on an 801-point grid over ln *m* by adding each observation's log
likelihood to the prior density.

### What is displayed

- The median and 90% credible interval of the estimated MEAC
- The individualised P(adequate | Ce) curve overlaid on the population curve, with the
  observed points
- The individualised probability of adequate analgesia at the Ce at the end of the record
- **The estimated MEAC when the same records are read through each of the three PK models**

The last line is a by-product but a useful one. Error in the PK model is absorbed directly
into the threshold estimate, so this spread reflects the difference between models rather
than the patient. It is an entry point to quantifying model disagreement without external
data.

### What validation confirms

`validation/validate-individualisation.js` (29 checks):

- The variance decomposition is arithmetically consistent and the between-patient component
  exceeds the within-patient component
- The predictive distribution with zero records matches the published population curve
  (maximum difference 1.03 percentage points)
- The posterior is a proper probability density (integrates to 1)
- **Recovery test**: from 60 observations generated for simulated patients with known
  thresholds (0.6 / 1.8 / 3.2 ng/mL), the posterior medians recover the truth to within 25%
  (0.61 / 1.87 / 3.52) and the credible intervals contain the true value
- Consistent records narrow the interval monotonically (1.05 ng/mL at 0 records to 0.54 at 20)
- Contradictory records do not collapse the posterior; the interval stays wide
- "Inadequate at a high Ce" raises the estimated threshold and "adequate at a low Ce" lowers it

### Honest limitations

1. **Both the prior and the within-patient variability come from postoperative studies.** Bae
   studied the PACU after open abdominal surgery, Gourlay postoperative PCA. Applying them to
   intraoperative surgical stimulus is an extrapolation the sources do not support;
   postoperative analgesia is the intended scope.
2. **Error in the PK model is absorbed into the threshold estimate.** Given that Ce differs by
   up to 1.8-fold across the three models, the estimated MEAC is "the threshold as seen
   through that model" and must always be interpreted together with the model.
3. **An opioid-alone threshold has a fundamental ceiling.** Bouillon 2004 (PMID 15166553)
   showed that remifentanil alone abolishes neither movement nor the response to laryngoscopy,
   and works synergistically with propofol. There is a limit to how accurately intraoperative
   responses can be predicted from a fentanyl Ce alone.
4. **A consistent assessment criterion is assumed.** If the definition of "inadequate" drifts
   within a case, observation noise exceeds the Gourlay within-patient CV and the estimate
   becomes biased.

### The next validation (not yet done)

Applying this retrospectively to existing anaesthesia records and asking whether the
individualised indicator predicts subsequent rescue-dose events better than the population
curve — compared by prediction probability, or by log-loss / Brier score — would be a direct
test of whether the indicator works. This has not been done.

---

### What was deliberately not implemented

The following are not displayed, because no primary source could be verified for them:

- **A fentanyl-alone Ce50 for tracheal intubation** — no primary study was found. The
  frequently cited Kazama 1997 (PMID 9286884) gives the Cp50 of **propofol** with fentanyl
  co-administered, not a Ce50 for fentanyl itself
- **"Respiratory depression begins at 1.5–2 ng/mL"** — no primary source states this. The
  closest verified statement is Cartwright 1983 (PMID 6414339), that at 1.5–3.0 ng/mL the CO2
  response curve is **already depressed by 50%**, which is a different claim. The application
  displays that instead, with its source

---

## Validation

```
npm test        # PK 44 + analgesia 26 + individualisation 29 = 99 checks
```

On the PK side:

- The micro rate constants of all three models reproduce the published values
- Only Scott & Stanski reproduces the published tpeak of 3.6 min and peak ratio of 17%
- Total drug is conserved when elimination is switched off (mass balance)
- At steady state Cp → rate/CL and Ce → Cp
- Reducing the integration step by a factor of eight moves Ce by less than 1e-4 ng/mL
- Bolus linearity and superposition, Ce lagging Cp, monotone decay after dosing stops
- Context-sensitive decrement time lengthens with infusion duration
- The Bae model returns finite, positive parameters from 30 to 200 kg
- Time to steady state is independent of infusion rate (confirming the system is linear)

On the analgesia side:

- All three curves reproduce the published values of their sources, including points not used
  in the fit
- The bands are continuous with no gaps and every boundary matches a published anchor value
- Every band carries a PMID; the curves are monotone and stay within range

The individualisation checks are described in the section above (29 checks including the
recovery test).

---

## Usage

Open `index.html` in a browser. There is no build step.

```
npm test       # run all 99 validation checks
npm run serve  # serve locally on http://localhost:8777
```

It also works opened directly over `file://`, but Chart.js is loaded from a CDN, so the
charts will not render offline.

---

## File layout

```
index.html                     UI
css/main.css                   Styles (vocabulary shared with the Propofol TCI app, teal accent)
js/models.js                   Patient / DoseEvent / validation / session format
js/fentanyl-pk.js              The three PK models, RK4, tpeak calculation
js/analgesia.js                Bands, population probability curves, MAC reduction, respiratory indicators
js/individualisation.js        Per-patient MEAC posterior (sequential Bayes)
js/simulation-engine.js        Dose-record integration, decrement times, maintenance rate
js/realtime-engine.js          Real-time engine (×1 / ×10 / ×60)
js/main.js                     Controller
validation/validate-pk.js      PK evaluator
validation/validate-analgesia.js       Analgesia module evaluator
validation/validate-individualisation.js  Individualisation evaluator (includes the recovery test)
```

Units are consistent throughout: drug amount in µg, volume in L, concentration in ng/mL
(= µg/L), clearance in L/min, time in min. `A1[µg] / V1[L]` therefore yields ng/mL directly.

---

## Disclaimer

**This software is strictly for research and educational use. Clinical use is prohibited.**

It must not be used to determine drug dosing, to diagnose, or to guide treatment for any
patient. It is not a medical device and has received no approval, clearance, or registration
from any regulatory authority. Displayed concentrations are theoretical values from
population pharmacokinetic models, not measured concentrations in an individual patient. The
analgesia indicators are reference values derived from published population statistics and do
not establish that any individual patient is adequately analgesed. The implemented PK models
give Ce values differing by up to 1.8-fold from one another, and this software cannot
determine which of them, if any, is correct. All clinical decisions must be made by qualified
clinicians independently of this software.

The authors accept no liability for any consequence arising from the use, or the inability to
use, this software.

YASUYUKI SUZUKI — Saiseikai Matsuyama Hospital / Ehime University Graduate School of Medicine

## Licence

MIT License, including a disclaimer for medical software. See [LICENSE](LICENSE).
