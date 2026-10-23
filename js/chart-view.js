/**
 * Reading aids for a Chart.js line chart whose x axis is linear (minutes).
 *
 * Owns three things and nothing about pharmacology:
 *   - the visible window on the x axis: pinch, drag, ctrl+wheel and the
 *     +/-/Fit buttons move it, double-tap goes back to the whole run
 *   - the y axis, fitted to whatever lies inside that window, so zooming in on
 *     a washout does not leave the curve flat along the bottom of an axis sized
 *     for the peak
 *   - a cursor and an HTML legend whose chips read each series at the cursor.
 *     This replaces the tooltip on a touch screen, where it stayed on after the
 *     finger lifted and covered the traces it described
 *
 * One finger drags the window when zoomed in and moves the cursor when not; a
 * tap puts the cursor there. Two fingers pinch about their midpoint and the
 * midpoint's movement pans. The host needs `touch-action: pan-y`, which leaves
 * vertical scrolling to the browser and hands every sideways move and pinch to
 * this class.
 *
 * Datasets are rebuilt by the caller on every update, so anything that has to
 * survive that (which series are switched off, the window, the cursor) is kept
 * here and applied by `sync()`, which the caller runs instead of
 * `chart.update()`. A dataset takes part by carrying `series` (a stable key)
 * and, for a reference line that has no reading at the cursor, `isRef: true`.
 */
class ChartView {
    /**
     * @param {object} o
     * @param {HTMLElement} o.host        element wrapping the canvas
     * @param {() => Chart} o.getChart
     * @param {() => {min:number,max:number}} o.getExtent   whole run, in x units
     * @param {boolean} [o.fitY]          fit y to the window (default true)
     * @param {string} [o.unit]           y unit, shown at the head of the legend
     * @param {(x:number)=>string} [o.formatX]  x as text, for ticks and the cursor
     * @param {HTMLElement} o.legend
     * @param {HTMLElement} [o.cursorEl]
     * @param {HTMLElement} [o.zoomIn]
     * @param {HTMLElement} [o.zoomOut]
     * @param {HTMLElement} [o.fit]
     */
    constructor(o) {
        this.host = o.host;
        this.getChart = o.getChart;
        this.getExtent = o.getExtent;
        this.fitY = o.fitY !== false;
        this.unit = o.unit || '';
        this.formatX = o.formatX || ((x) => String(Number(x.toFixed(2))));
        this.legend = o.legend;
        this.cursorEl = o.cursorEl || null;
        this.fitButton = o.fit || null;

        this.view = null;           // null = whole run, else {min, max}
        this.cursor = null;         // null = the last point
        this.hidden = new Set();    // series switched off
        this.legendSignature = '';

        this.pointers = new Map();
        this.drag = null;
        this.pinch = null;
        this.lastTap = null;

        this.attachPointers();
        if (o.zoomIn) o.zoomIn.addEventListener('click', () => this.step(0.5));
        if (o.zoomOut) o.zoomOut.addEventListener('click', () => this.step(2));
        if (o.fit) o.fit.addEventListener('click', () => this.reset(true));
        this.legend.addEventListener('click', (e) => {
            const chip = e.target.closest('.legend-chip');
            if (!chip) return;
            const series = chip.dataset.series;
            if (this.hidden.has(series)) this.hidden.delete(series); else this.hidden.add(series);
            this.sync();
        });
        window.addEventListener('resize', () => this.placeCursor());
    }

    // ------------------------------------------------------------- window

    /** Narrowest window, as a fraction of the whole run, and never below this many x units. */
    static get MIN_SPAN_FRACTION() { return 1 / 60; }

    extent() {
        const e = this.getExtent();
        return e.max > e.min ? e : { min: e.min, max: e.min + 1 };
    }

    minSpan() {
        const e = this.extent();
        return (e.max - e.min) * ChartView.MIN_SPAN_FRACTION;
    }

    window() {
        const e = this.extent();
        if (!this.view) return { min: e.min, max: e.max };
        const whole = e.max - e.min;
        const span = Math.min(Math.max(this.view.max - this.view.min, this.minSpan()), whole);
        const min = Math.min(Math.max(this.view.min, e.min), e.max - span);
        return { min, max: min + span };
    }

    isZoomed() {
        const e = this.extent();
        const w = this.window();
        return w.max - w.min < (e.max - e.min) - 1e-9;
    }

    setWindow(min, max) {
        const e = this.extent();
        const whole = e.max - e.min;
        const span = Math.min(Math.max(max - min, this.minSpan()), whole);
        const lo = Math.min(Math.max(min, e.min), e.max - span);
        this.view = span >= whole - 1e-9 ? null : { min: lo, max: lo + span };
        this.sync();
    }

    /** Back to the whole run; `andCursor` also hands the cursor back to the last point. */
    reset(andCursor = false) {
        this.view = null;
        if (andCursor) this.cursor = null;
        this.sync();
    }

    /** Forget everything for a new run. */
    clear() {
        this.view = null;
        this.cursor = null;
        this.sync();
    }

    zoomBy(factor, anchor) {
        const w = this.window();
        const span = w.max - w.min;
        const next = Math.min(Math.max(span * factor, this.minSpan()),
            this.extent().max - this.extent().min);
        const frac = span > 0 ? (anchor - w.min) / span : 0.5;
        this.setWindow(anchor - frac * next, anchor - frac * next + next);
    }

    step(factor) {
        const w = this.window();
        this.zoomBy(factor, (w.min + w.max) / 2);
    }

    // ----------------------------------------------------------- geometry

    area() {
        const chart = this.getChart();
        if (!chart || !chart.chartArea || !chart.scales || !chart.scales.x) return null;
        const rect = chart.canvas.getBoundingClientRect();
        return {
            chart,
            left: rect.left + chart.chartArea.left,
            width: chart.chartArea.right - chart.chartArea.left
        };
    }

    timeAt(clientX) {
        const a = this.area();
        if (!a || a.width <= 0) return null;
        const w = this.window();
        const frac = Math.min(Math.max((clientX - a.left) / a.width, 0), 1);
        return w.min + frac * (w.max - w.min);
    }

    // ----------------------------------------------------------- pointers

    attachPointers() {
        const host = this.host;
        const distance = () => {
            const [a, b] = [...this.pointers.values()];
            return Math.hypot(a.x - b.x, a.y - b.y);
        };
        const midX = () => {
            const [a, b] = [...this.pointers.values()];
            return (a.x + b.x) / 2;
        };
        const SLOP = 8;

        host.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            host.setPointerCapture(e.pointerId);
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.pointers.size === 1) {
                const w = this.window();
                this.drag = { x: e.clientX, y: e.clientY, min: w.min, span: w.max - w.min, moved: false, scrub: false };
            } else if (this.pointers.size === 2) {
                // A second finger turns whatever the first was doing into a pinch.
                this.drag = null;
                const w = this.window();
                const a = this.area();
                this.pinch = a && {
                    span: w.max - w.min,
                    dist: Math.max(distance(), 1),
                    anchor: this.timeAt(midX())
                };
            }
        });

        host.addEventListener('pointermove', (e) => {
            if (!this.pointers.has(e.pointerId)) return;
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (this.pinch && this.pointers.size >= 2) {
                const a = this.area();
                if (!a || a.width <= 0) return;
                const whole = this.extent().max - this.extent().min;
                const span = Math.min(Math.max(
                    this.pinch.span * this.pinch.dist / Math.max(distance(), 1), this.minSpan()), whole);
                // The x that was under the midpoint at the start stays under it:
                // that is both the zoom centre and the pan.
                const frac = Math.min(Math.max((midX() - a.left) / a.width, 0), 1);
                this.setWindow(this.pinch.anchor - frac * span, this.pinch.anchor - frac * span + span);
                return;
            }

            if (!this.drag || this.pointers.size !== 1) return;
            const dx = e.clientX - this.drag.x;
            const dy = e.clientY - this.drag.y;
            if (!this.drag.moved && Math.hypot(dx, dy) > SLOP) this.drag.moved = true;
            if (!this.drag.moved) return;

            if (this.isZoomed()) {
                const a = this.area();
                if (!a || a.width <= 0) return;
                const min = this.drag.min - (dx / a.width) * this.drag.span;
                this.setWindow(min, min + this.drag.span);
            } else {
                // Nothing to pan, so the finger moves the cursor. Only once the
                // move is mostly sideways, so a vertical page scroll that starts
                // on the chart does not drag the cursor along.
                if (!this.drag.scrub && Math.abs(dx) > Math.abs(dy)) this.drag.scrub = true;
                if (this.drag.scrub) this.setCursor(this.timeAt(e.clientX));
            }
        });

        const finish = (e) => {
            if (!this.pointers.has(e.pointerId)) return;
            const wasTap = this.drag && !this.drag.moved && e.type === 'pointerup';
            this.pointers.delete(e.pointerId);
            if (this.pointers.size < 2) this.pinch = null;
            if (this.pointers.size === 0) {
                this.drag = null;
                if (wasTap) this.tap(e);
            } else if (this.pointers.size === 1) {
                // One finger of a pinch is still down: it pans from where it is
                // now, not from where the first finger started.
                const [rest] = this.pointers.values();
                const w = this.window();
                this.drag = { x: rest.x, y: rest.y, min: w.min, span: w.max - w.min, moved: true, scrub: false };
            }
        };
        host.addEventListener('pointerup', finish);
        host.addEventListener('pointercancel', finish);

        host.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const t = this.timeAt(e.clientX);
                if (t !== null) this.zoomBy(Math.exp(e.deltaY * 0.01), t);
            } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && this.isZoomed()) {
                e.preventDefault();
                const a = this.area();
                if (!a || a.width <= 0) return;
                const w = this.window();
                const shift = (e.deltaX / a.width) * (w.max - w.min);
                this.setWindow(w.min + shift, w.max + shift);
            }
        }, { passive: false });
    }

    tap(e) {
        const now = e.timeStamp;
        const last = this.lastTap;
        if (last && now - last.at < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 32) {
            this.lastTap = null;
            this.reset(false);
            return;
        }
        this.lastTap = { at: now, x: e.clientX, y: e.clientY };
        this.setCursor(this.timeAt(e.clientX));
    }

    setCursor(t) {
        if (t === null || t === undefined) return;
        this.cursor = t;
        this.updateReadings();
        this.placeCursor();
    }

    // --------------------------------------------------------------- draw

    /**
     * Applies the window, the y fit, the hidden series and the legend to the
     * chart, and redraws it. Called in place of `chart.update('none')`.
     */
    sync() {
        const chart = this.getChart();
        if (!chart) return;
        const datasets = chart.data.datasets;
        for (const set of datasets) set.hidden = this.hidden.has(set.series);

        const w = this.window();
        const scales = chart.options.scales;
        scales.x.min = w.min;
        scales.x.max = w.max;
        scales.y.max = this.fitY ? this.top(datasets, w) : undefined;

        chart.update('none');
        if (this.fitButton) this.fitButton.disabled = !this.isZoomed() && this.cursor === null;
        this.drawLegend(datasets);
        this.updateReadings();
        this.placeCursor();
    }

    /** A little air above the tallest thing drawn inside the window. */
    top(datasets, w) {
        let peak = 0;
        for (const set of datasets) {
            if (set.hidden) continue;
            for (const p of set.data) {
                if (p.x >= w.min && p.x <= w.max && p.y > peak) peak = p.y;
            }
        }
        return peak > 0 ? peak * 1.08 : undefined;
    }

    drawLegend(datasets) {
        const seen = new Set();
        const chips = [];
        for (const set of datasets) {
            if (!set.series || seen.has(set.series)) continue;
            seen.add(set.series);
            chips.push(set);
        }
        const signature = chips.map(s => `${s.series}|${s.label}|${this.hidden.has(s.series)}`).join(';');
        if (signature === this.legendSignature) return;
        this.legendSignature = signature;

        this.legend.classList.toggle('dense', chips.length > 4);
        const unit = this.unit ? `<span class="legend-head">${this.unit}</span>` : '';
        this.legend.innerHTML = unit + chips.map((s) => {
            const off = this.hidden.has(s.series);
            const dashed = s.borderDash && s.borderDash.length ? ' dashed' : '';
            return `<button type="button" class="legend-chip${off ? ' off' : ''}${s.isRef ? ' ref' : ''}"
                        data-series="${s.series}" aria-pressed="${!off}">
                    <span class="legend-swatch${dashed}" style="--swatch:${s.borderColor}"></span>
                    <span class="legend-name">${s.label}</span>
                    ${s.isRef ? '' : `<span class="legend-value" data-value-for="${s.series}"></span>`}
                </button>`;
        }).join('');
    }

    /** The reading of each series at the cursor (or at its last point), in its chip. */
    updateReadings() {
        const chart = this.getChart();
        if (!chart) return;
        for (const node of this.legend.querySelectorAll('[data-value-for]')) {
            const set = chart.data.datasets.find(d => d.series === node.dataset.valueFor);
            const point = set && !set.hidden ? this.pointAt(set.data) : null;
            node.textContent = point ? point.y.toPrecision(3) : '';
        }
    }

    pointAt(data) {
        if (!data.length) return null;
        if (this.cursor === null) return data[data.length - 1];
        let lo = 0;
        let hi = data.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (data[mid].x < this.cursor) lo = mid + 1; else hi = mid;
        }
        return lo > 0 && this.cursor - data[lo - 1].x < data[lo].x - this.cursor ? data[lo - 1] : data[lo];
    }

    /** The dashed line, drawn over the canvas so that moving it redraws nothing. */
    placeCursor() {
        const line = this.cursorEl;
        if (!line) return;
        const chart = this.getChart();
        if (this.cursor === null || !chart || !chart.chartArea || !chart.scales.x) { line.hidden = true; return; }
        const x = chart.scales.x;
        if (this.cursor < x.min || this.cursor > x.max) { line.hidden = true; return; }
        line.hidden = false;
        line.style.left = `${x.getPixelForValue(this.cursor)}px`;
        line.style.top = `${chart.chartArea.top}px`;
        line.style.height = `${chart.chartArea.bottom - chart.chartArea.top}px`;
        line.setAttribute('data-label', this.formatX(this.cursor));
    }

    /** The tick label formatter for the x axis, which also tidies the window's own edges. */
    tickFormatter() {
        return (value) => this.formatX(value);
    }
}

/** Whether the primary input is a finger. Fixed at load; a hybrid laptop is treated as a mouse. */
ChartView.COARSE = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches;
