// ============================================
// GLOBAL STATE
// ============================================
const state = {
    svg: null,
    projection: null,
    path: null,
    cellNodes: [],          // raw DOM nodes (SVGPathElement[])
    clusterMeta: [],        // [{ clusterId }]
    clustersData: null,
    loadedPM25YearData: {},
    allDates: [],
    dateToDataMap: {},
    currentDateIndex: 0,
    svgWidth: 0,
    svgHeight: 0,
    boundaryGeoJSON: null,
    pendingPM25Loads: new Set(),

    // ── Performance caches ──────────────────────────────────────────
    // colorCache[dateIndex][cellIndex] = pre-resolved hex string
    colorCache: {},
    // currentColors[cellIndex] = last colour written to the DOM
    // (DOM-diffing: only write when the value actually changes)
    currentColors: [],
};

const HF_BASE = 'https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/resolve/main';


// ============================================
// PM2.5 COLOR SCALE
// ============================================
const PM25_DOMAIN_MIN = 2;
const PM25_DOMAIN_MAX = 150;
const PM25_COLOR_SCALE = d3.scaleLinear()
    .domain([
        2,    // Matches 0%
        5,    // Matches 10%
        10,   // Transition point (matches CSS 18%)
        15,   // Matches 40% (Amber)
        35,   // Transition point (matches CSS 55%)
        60,   // Matches 68% (Vermilion)
        100,  // Matches 82% (Crimson)
        150   // Matches 100% (Velvet Ash)
    ])
    .range([
        "#2FA37F", // 2: Premium Jade
        "#2FA37F", // 5: Holds solid Jade
        "#D6C545", // 10: Luminous yellow transition
        "#FFAE00", // 15: Vibrant Amber-Yellow
        "#E65C17", // 35: High-vibrancy Orange
        "#E63917", // 60: Intense Vermilion
        "#8A1C1C", // 100: Menacing Crimson Red
        "#4D1C1C"  // 150: Deep Velvet Ash
    ])
    .clamp(true); // Ensures any data > 150 st
const NO_DATA_COLOR = '#1c2a3a';

// Pre-built lookup table: integer µg/m³ value → hex string
// Covers [PM25_DOMAIN_MIN … PM25_DOMAIN_MAX] (136 entries).
// Values outside this range are clamped at call-time, so we never
// miss a table entry during the hot rendering loop.
const COLOR_LUT = (() => {
    const lut = new Array(PM25_DOMAIN_MAX + 1);
    for (let v = 0; v <= PM25_DOMAIN_MAX; v++) {
        const capped = Math.max(PM25_DOMAIN_MIN, v);
        lut[v] = PM25_COLOR_SCALE(capped);
    }
    return lut;
})();

/**
 * Fastest possible color lookup for a PM2.5 value.
 * - null/undefined  →  NO_DATA_COLOR
 * - value < MIN     →  same as MIN
 * - value > MAX     →  same as MAX (deep red)
 * - otherwise       →  pre-built LUT entry (no d3 call at runtime)
 */
function getColorPM25(value) {
    if (value === null || value === undefined) return NO_DATA_COLOR;
    const v = Math.round(value);                       // integer index
    if (v <= PM25_DOMAIN_MIN)  return COLOR_LUT[PM25_DOMAIN_MIN];
    if (v >= PM25_DOMAIN_MAX)  return COLOR_LUT[PM25_DOMAIN_MAX];
    return COLOR_LUT[v];
}

function showLoading() { document.getElementById('loading-overlay').classList.add('active'); }
function hideLoading() { document.getElementById('loading-overlay').classList.remove('active'); }

// ============================================
// ROBUST HUGGINGFACE FETCH
// ============================================
async function hfFetch(filename) {
    const urls = [
        `${HF_BASE}/${filename}?download=true`,
        `${HF_BASE}/${filename}`,
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const text = await res.text();
            const trimmed = text.trimStart();
            if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
            return JSON.parse(text);
        } catch (err) {
            console.warn(`Fetch failed for ${url}:`, err.message);
        }
    }
    throw new Error(`All fetch attempts failed for: ${filename}`);
}

// ============================================
// MAP INITIALIZATION
// ============================================
function initMap() {
    const container = document.getElementById('map');
    state.svgWidth  = container.clientWidth;
    state.svgHeight = container.clientHeight;
    state.projection = d3.geoMercator()
        .center([82.0, 22.5])
        .scale(1000)
        .translate([state.svgWidth / 2, state.svgHeight / 2]);
    state.path = d3.geoPath().projection(state.projection);

    state.svg = d3.select('#map')
        .append('svg')
        .attr('width',  state.svgWidth)
        .attr('height', state.svgHeight);

    state.svg.append('defs')
        .append('clipPath').attr('id', 'india-clip')
        .append('path').attr('id', 'clip-path-geometry');

    state.svg.append('g').attr('id', 'voronoi-group');
    state.svg.append('g').attr('id', 'boundary-group');
}

function onResize() {
    const container = document.getElementById('map');
    state.svgWidth  = container.clientWidth;
    state.svgHeight = container.clientHeight;
    state.svg.attr('width', state.svgWidth).attr('height', state.svgHeight);
    if (state.boundaryGeoJSON) {
        fitProjectionToBoundary(state.boundaryGeoJSON, state.svgWidth, state.svgHeight);
        redrawBoundary();
        redrawClusters();
        updateMapColors();
    }
}

function fitProjectionToBoundary(geojson, width, height) {
    state.projection.fitExtent([[20, 20], [width - 20, height - 20]], geojson);
    state.path = d3.geoPath().projection(state.projection);
}

// ============================================
// DATA LOADING
// ============================================
async function loadBoundary() {
    try {
        const data = await hfFetch('india_boundary.geojson');
        state.boundaryGeoJSON = data;
        fitProjectionToBoundary(data, state.svgWidth, state.svgHeight);
        redrawBoundary();
    } catch (err) { console.error(err); }
}

function redrawBoundary() {
    state.svg.select('#clip-path-geometry').attr('d', state.path(state.boundaryGeoJSON));
    const g = state.svg.select('#boundary-group');
    g.selectAll('*').remove();
    g.append('path')
        .datum(state.boundaryGeoJSON)
        .attr('class', 'india-boundary')
        .attr('d', state.path);
}

async function loadClusters() {
    try {
        const data = await hfFetch('clusters.geojson');
        state.clustersData = data;
        state.clusterMeta  = data.features.map(f => ({ clusterId: f.properties.cluster_id }));
        redrawClusters();
    } catch (err) { console.error(err); }
}

function redrawClusters() {
    if (!state.clustersData) return;
    const vGroup = state.svg.select('#voronoi-group');
    vGroup.selectAll('*').remove();
    state.cellNodes    = [];
    state.currentColors = [];

    const W = state.svgWidth;
    const H = state.svgHeight;
    const points   = state.clustersData.features.map(f => state.projection(f.geometry.coordinates));
    const delaunay = d3.Delaunay.from(points);
    const voronoi  = delaunay.voronoi([0, 0, W, H]);

    vGroup.attr('clip-path', 'url(#india-clip)');

    state.clustersData.features.forEach((_, i) => {
        const cellPath = voronoi.renderCell(i);
        if (!cellPath) {
            state.cellNodes.push(null);
            state.currentColors.push(NO_DATA_COLOR);
            return;
        }
        const node = vGroup.append('path')
            .attr('d', cellPath)
            .attr('class', 'cluster-cell')
            .attr('fill', NO_DATA_COLOR)
            .node();
        state.cellNodes.push(node);
        state.currentColors.push(NO_DATA_COLOR);
    });

    // Invalidate color cache — geometry has changed
    state.colorCache = {};
}

async function loadPM25YearDataHF(year) {
    if (state.loadedPM25YearData[year]) return state.loadedPM25YearData[year];
    try {
        const data = await hfFetch(`pm25_data_${year}.json`);
        state.loadedPM25YearData[year] = data;
        return data;
    } catch (err) {
        console.error(err);
        return null;
    }
}

// ============================================
// COLOR CACHE — built eagerly after data loads
// ============================================
/**
 * Pre-resolve every cell colour for a single date index and store it
 * in state.colorCache[dateIndex].  Called once per date the first time
 * it is needed (lazy) or in a background sweep after load completes.
 */
function buildColorCacheForDate(dateIndex) {
    if (state.colorCache[dateIndex]) return state.colorCache[dateIndex];

    const date     = state.allDates[dateIndex];
    const dataInfo = state.dateToDataMap[date];
    if (!dataInfo) {
        state.colorCache[dateIndex] = null;
        return null;
    }

    const yearData = state.loadedPM25YearData[dataInfo.year];
    if (!yearData) {
        state.colorCache[dateIndex] = null;
        return null;
    }

    const pm25Data   = yearData.pm25;
    const localIndex = dataInfo.localIndex;
    const meta       = state.clusterMeta;
    const n          = meta.length;
    const colors     = new Array(n);

    for (let i = 0; i < n; i++) {
        const vals    = pm25Data[meta[i].clusterId];
        colors[i]     = vals ? getColorPM25(vals[localIndex]) : NO_DATA_COLOR;
    }

    state.colorCache[dateIndex] = colors;
    return colors;
}

/**
 * Warm the cache for a window around the current index in a background
 * idle callback so frames that are about to be rendered are already ready.
 */
function warmColorCache(centerIndex, radius = 30) {
    const total = state.allDates.length;
    if (!total) return;

    const lo = Math.max(0, centerIndex - radius);
    const hi = Math.min(total - 1, centerIndex + radius);

    let i = centerIndex;
    let step = 1;

    function warmNext() {
        // spiral outward from center so the nearest frames are warmed first
        if (i > hi && i - step < lo) return;
        if (!state.colorCache[i]) buildColorCacheForDate(i);
        i += step;
        step = -(step > 0 ? step : -step) + (step > 0 ? 1 : 0); // 0,1,-1,2,-2…
        if (i < lo || i > hi) {
            // finished this batch; schedule no more work
            return;
        }
        requestIdleCallback ? requestIdleCallback(warmNext, { timeout: 500 }) : setTimeout(warmNext, 0);
    }
    requestIdleCallback ? requestIdleCallback(warmNext, { timeout: 500 }) : setTimeout(warmNext, 0);
}

// ============================================
// DATE MANAGEMENT
// ============================================
function rebuildDateIndex() {
    const prevDate = state.allDates.length > 0 ? state.allDates[state.currentDateIndex] : null;
    state.allDates      = [];
    state.dateToDataMap = {};
    // Invalidate color cache — data set changed
    state.colorCache = {};

    Array.from(document.querySelectorAll('.pm25-year-checkbox:checked'))
        .map(cb => parseInt(cb.value))
        .sort((a, b) => a - b)
        .forEach(year => {
            const yd = state.loadedPM25YearData[year];
            if (!yd) return;
            yd.dates.forEach((d, idx) => {
                state.allDates.push(d);
                state.dateToDataMap[d] = { year, localIndex: idx };
            });
        });

    if (prevDate !== null && state.dateToDataMap[prevDate] !== undefined) {
        state.currentDateIndex = state.allDates.indexOf(prevDate);
    } else {
        state.currentDateIndex = 0;
    }

    updateSlider();
}

function updateSlider() {
    const slider  = document.getElementById('date-slider');
    const playBtn = document.getElementById('play-btn');
    const hint    = document.getElementById('date-range-hint');
    if (!state.allDates.length) {
        slider.disabled = playBtn.disabled = true;
        slider.max = 0;
        document.getElementById('current-date').textContent = 'Select years to begin';
        document.getElementById('badge-date-display').textContent = '—';
        hint.textContent = '—';
        return;
    }

    const hasInflight = state.pendingPM25Loads.size > 0;
    slider.disabled = playBtn.disabled = hasInflight;
    slider.max   = state.allDates.length - 1;
    slider.value = state.currentDateIndex;

    const first = state.allDates[0];
    const last  = state.allDates[state.allDates.length - 1];
    hint.textContent = `${first} → ${last}`;
    updateDateDisplay();
}

function updateDateDisplay() {
    const date = state.allDates[state.currentDateIndex] || '—';
    document.getElementById('current-date').textContent = date;
    document.getElementById('badge-date-display').textContent = date;
    document.getElementById('date-slider').value = state.currentDateIndex;
}

// ============================================
// MAP RENDERING — hot path
// ============================================
/**
 * Paint the map for state.currentDateIndex.
 *
 * Strategy:
 *  1. Check the pre-built color cache. If it exists, the inner loop is
 *     just an array read + one string comparison per cell — no d3, no
 *     object look-ups, no color math.
 *  2. If the cache is cold (shouldn't happen after the warm-up pass),
 *     fall back to building it on the spot then applying.
 */
function updateMapColors() {
    const dateIndex = state.currentDateIndex;

    // Ensure cache entry exists
    let colors = state.colorCache[dateIndex];
    if (!colors) colors = buildColorCacheForDate(dateIndex);
    if (!colors) return;  // no data at all for this date

    const nodes        = state.cellNodes;
    const currentColors = state.currentColors;
    const n            = nodes.length;

    for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (!node) continue;
        const c = colors[i];
        if (currentColors[i] !== c) {
            node.style.fill  = c;
            currentColors[i] = c;
        }
    }

    // Warm cache for frames we're about to visit
    warmColorCache(dateIndex);
}

function setInteractivityEnabled(enabled) {
    const slider  = document.getElementById('date-slider');
    const playBtn = document.getElementById('play-btn');
    if (!enabled || !state.allDates.length) {
        slider.disabled  = true;
        playBtn.disabled = true;
    } else {
        slider.disabled  = false;
        playBtn.disabled = false;
    }
}

// ============================================
// EVENT HANDLERS
// ============================================
async function handlePM25YearCheckboxChange(e) {
    stopPlayback();
    const year = parseInt(e.target.value);

    if (e.target.checked) {
        state.pendingPM25Loads.add(year);
        setInteractivityEnabled(false);
        showLoading();

        await loadPM25YearDataHF(year);

        state.pendingPM25Loads.delete(year);

        if (state.pendingPM25Loads.size === 0) {
            hideLoading();
            rebuildDateIndex();
            updateMapColors();
            setInteractivityEnabled(true);
        }
    } else {
        delete state.loadedPM25YearData[year];
        rebuildDateIndex();
        updateMapColors();
    }
}

function handleSliderChange(e) {
    state.currentDateIndex = parseInt(e.target.value);
    updateDateDisplay();
    updateMapColors();
}

// ============================================
// PLAYBACK
// ============================================
/**
 * Use a generation counter to invalidate stale RAF callbacks.
 *
 * The original code called cancelAnimationFrame() in stopPlayback() and
 * relied on `playback.running` being false to short-circuit the tick.
 * This caused a bug: if the button was clicked rapidly, a prior-generation
 * RAF callback could still be queued and would call startPlayback logic
 * inside the tick, creating double-RAF chains that were impossible to
 * stop cleanly.
 *
 * With a generation counter, every tick immediately bails if its captured
 * generation no longer matches the current one — making the old chain
 * completely inert even if a callback fires after cancelAnimationFrame.
 */
const playback = {
    generation: 0,   // incremented on every start/stop; each tick holds a copy
    running: false,
    lastFrameTime: 0,
    fps: 6,          // mutable at any time — tick reads it live every frame
};

const isPlaying = () => playback.running;

function playbackTick(now, gen) {
    // Bail immediately if this callback belongs to a dead generation
    if (gen !== playback.generation || !playback.running) return;

    const frameMs = 1000 / playback.fps;   // read live — responds to slider instantly
    const elapsed = now - playback.lastFrameTime;

    if (elapsed >= frameMs) {
        if (state.currentDateIndex >= state.allDates.length - 1) {
            stopPlayback();
            return;
        }

        state.currentDateIndex++;
        updateDateDisplay();
        updateMapColors();

        // Subtract remainder so we don't drift (keep cadence accurate)
        playback.lastFrameTime = now - (elapsed % frameMs);
    }

    // Schedule next frame, passing the same generation token
    requestAnimationFrame(t => playbackTick(t, gen));
}

function startPlayback() {
    if (isPlaying() || !state.allDates.length) return;

    if (state.currentDateIndex >= state.allDates.length - 1) {
        state.currentDateIndex = 0;
        updateDateDisplay();
    }

    // Update button UI
    document.getElementById('play-btn-label').textContent = 'Pause';
    document.getElementById('play-icon').style.display   = 'none';
    document.getElementById('pause-icon').style.display  = 'block';

    // Bump generation — any previous tick callbacks are now inert
    playback.generation++;
    playback.running       = true;
    playback.lastFrameTime = performance.now();

    const gen = playback.generation;
    requestAnimationFrame(t => playbackTick(t, gen));
}

function stopPlayback() {
    // Bump generation first — makes any in-flight tick bail immediately
    playback.generation++;
    playback.running = false;

    document.getElementById('play-btn-label').textContent = 'Play';
    document.getElementById('play-icon').style.display   = 'block';
    document.getElementById('pause-icon').style.display  = 'none';
}

function stepDate(dir) {
    if (!state.allDates.length) return;
    stopPlayback();
    state.currentDateIndex = Math.max(0, Math.min(state.allDates.length - 1, state.currentDateIndex + dir));
    updateDateDisplay();
    updateMapColors();
}

// ============================================
// STAT COUNTERS ANIMATION
// ============================================

function animateStatCounters() {
    const statNumbers = document.querySelectorAll('.stat-number');
    if (statNumbers.length < 3) return;

    const targets = [
        { element: statNumbers[0], target: 2700, suffix: '+' },
        { element: statNumbers[1], target: 30000, suffix: '+' },
        { element: statNumbers[2], target: 100, suffix: '%' }
    ];

    const duration = 2500;
    const startTime = performance.now();

    function updateCounters(currentTime) {
        const elapsed = currentTime - startTime;
        const linearProgress = Math.min(elapsed / duration, 1);

        let progress;

        if (linearProgress < 0.7) {
            // Reach 90% quickly
            progress = (linearProgress / 0.7) * 0.9;
        } else {
            // Crawl through final 10%
            const t = (linearProgress - 0.7) / 0.3;
            const crawl = 1 - Math.pow(1 - t, 13);
            progress = 0.9 + crawl * 0.1;
        }

        targets.forEach(({ element, target, suffix }) => {
            const current = Math.floor(target * progress);
            element.textContent =
                current.toLocaleString() + suffix;
        });

        if (linearProgress < 1) {
            requestAnimationFrame(updateCounters);
        } else {
            targets.forEach(({ element, target, suffix }) => {
                element.textContent =
                    target.toLocaleString() + suffix;
            });
        }
    }

    requestAnimationFrame(updateCounters);
}



// ============================================
// UI WIRING (DROPDOWNS & CONTROLS)
// ============================================
function setupUIControls() {
    // Dropdown toggles
    const toggles = [
        { btn: 'year-dropdown-btn',  panel: 'year-dropdown-panel'  },
        { btn: 'speed-dropdown-btn', panel: 'speed-dropdown-panel' },
    ];
    toggles.forEach(({ btn, panel }) => {
        const b = document.getElementById(btn);
        const p = document.getElementById(panel);
        b.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = p.classList.contains('open');
            document.querySelectorAll('.tb-dropdown-panel').forEach(pan => pan.classList.remove('open'));
            document.querySelectorAll('.tb-btn--dropdown').forEach(bt => bt.setAttribute('aria-expanded', 'false'));
            if (!isOpen) {
                p.classList.add('open');
                b.setAttribute('aria-expanded', 'true');
            }
        });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', e => {
        if (!e.target.closest('.tb-dropdown-wrapper')) {
            document.querySelectorAll('.tb-dropdown-panel').forEach(pan => pan.classList.remove('open'));
            document.querySelectorAll('.tb-btn--dropdown').forEach(bt => bt.setAttribute('aria-expanded', 'false'));
        }
    });

    // Year select-all / clear-all
    document.getElementById('year-select-all').addEventListener('click', () => {
        document.querySelectorAll('.pm25-year-checkbox:not(:checked)').forEach(cb => {
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        });
    });
    document.getElementById('year-clear-all').addEventListener('click', () => {
        document.querySelectorAll('.pm25-year-checkbox:checked').forEach(cb => {
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
        });
    });

    // ── Speed slider ───────────────────────────────────────────────
    // playback.fps is read live inside playbackTick every frame, so
    // changing it here takes effect on the very next animation frame —
    // no need to restart playback.
    const speedSlider   = document.getElementById('fps-slider');
    const speedValDisp  = document.getElementById('fps-value');
    const speedBadgeDisp = document.getElementById('speed-display');

    speedSlider.addEventListener('input', e => {
        e.stopPropagation();
        const val = parseInt(e.target.value);
        playback.fps = val;

        // If mid-playback, reset lastFrameTime so the new interval takes
        // effect immediately rather than waiting for the old interval to expire.
        if (playback.running) {
            playback.lastFrameTime = performance.now();
        }

        speedValDisp.textContent  = `${val} fps`;
        speedBadgeDisp.textContent = `${val} fps`;
    });
}

// ============================================
// INITIALIZATION
// ============================================
async function init() {
    setupUIControls();
    showLoading();
    initMap();
    await loadBoundary();
    await loadClusters();

    const checkedYears = Array.from(document.querySelectorAll('.pm25-year-checkbox:checked'))
        .map(cb => parseInt(cb.value));

    if (checkedYears.length > 0) {
        state.pendingPM25Loads = new Set(checkedYears);
        await Promise.all(checkedYears.map(year => loadPM25YearDataHF(year)));
        state.pendingPM25Loads.clear();
        rebuildDateIndex();
        updateMapColors();
        setInteractivityEnabled(true);
        clockRebuildMeans();  
        clockUpdate();  
    }

    hideLoading();

    // Animate stat counters
    animateStatCounters();

    // Wire up year checkboxes
    document.querySelectorAll('.pm25-year-checkbox')
        .forEach(cb => cb.addEventListener('change', handlePM25YearCheckboxChange));

    // Wire up timeline slider
    const dateSlider = document.getElementById('date-slider');
    dateSlider.addEventListener('input',     handleSliderChange);
    dateSlider.addEventListener('mousedown', stopPlayback);

    // Wire up play button — single toggle
    document.getElementById('play-btn').addEventListener('click', () => {
        isPlaying() ? stopPlayback() : startPlayback();
    });

    // Keyboard navigation
    document.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDate(+1); }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); stepDate(-1); }
        if (e.key === ' ')          { e.preventDefault(); isPlaying() ? stopPlayback() : startPlayback(); }
    });

    window.addEventListener('resize', onResize);
}

document.addEventListener('DOMContentLoaded', init);

/* ═══════════════════════════════════════════════════════════════════════════
   PM2.5 RADIAL SEASONAL CLOCK
   ─────────────────────────────────────────────────────────────────────────
   PASTE THIS ENTIRE BLOCK at the very END of script.js,
   after the last line:   document.addEventListener('DOMContentLoaded', init);

   HOW IT HOOKS IN (no existing code touched):
   • After DOMContentLoaded fires, we monkey-patch three functions that
     script.js already exposes on the module scope:
       – updateMapColors()   → also calls clockUpdate()
       – updateDateDisplay() → also calls clockUpdate()
       – rebuildDateIndex()  → also calls clockRebuildMeans()
   • The clock reads from state.* (already global) and state.loadedPM25YearData
   • No existing logic is altered — only new code runs after the originals.
═══════════════════════════════════════════════════════════════════════════ */

/* ── Constants ─────────────────────────────────────────────────────────── */
const CLOCK = {
    SVG_SIZE:    220,           // viewBox dimension
    CX:          110,           // centre X
    CY:          110,           // centre Y
    R_INNER:     52,            // inner radius of bar ring
    R_RING:      56,            // where bars START (base of bars)
    R_MAX_BAR:   34,            // max additional radius for tallest bar
    R_MONTH_LBL: 98,            // radius of month label text
    R_HIT:       90,            // radius of outer hit zone
    DAYS_IN_YEAR: 365,          // always 365 for the ring (leap handled by mapping)
    MONTH_NAMES:  ['J','F','M','A','M','J','J','A','S','O','N','D'],
    MONTH_STARTS: [0,31,59,90,120,151,181,212,243,273,304,334], // day-of-year index (0-based)
};

/* ── State ──────────────────────────────────────────────────────────────── */
const clockState = {
    svg: null,              // D3 selection of #radial-clock-svg
    barGroup: null,
    trailArc: null,
    needleLine: null,
    needleDot: null,
    centerVal: null,
    centerUnit: null,

    // dayMeans[doy] = mean PM2.5 for day-of-year doy (0-based, 0=Jan1)
    // averaged across all loaded years that have data for that doy
    dayMeans: new Float32Array(365).fill(NaN),

    maxMean: 1,             // for scaling bar heights; recomputed on rebuild
    built: false,           // has initClock() been called?
};

/* ── Colour helper (reuses existing LUT from script.js) ─────────────────── */
function clockColor(value) {
    // Delegate to the existing getColorPM25 function in script.js
    return getColorPM25(value);
}

/* ── Geometry helpers ───────────────────────────────────────────────────── */
function dayToAngle(doy) {
    // doy: 0-based day of year (0 = Jan 1)
    // Angle: 0 = top (12 o'clock = Jan 1), clockwise
    return (doy / CLOCK.DAYS_IN_YEAR) * 2 * Math.PI - Math.PI / 2;
}

function polarToXY(r, angle) {
    return {
        x: CLOCK.CX + r * Math.cos(angle),
        y: CLOCK.CY + r * Math.sin(angle),
    };
}

function arcPath(r, startAngle, endAngle, largeArc) {
    const s = polarToXY(r, startAngle);
    const e = polarToXY(r, endAngle);
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
}

/* ── DOY from a YYYY-MM-DD string ───────────────────────────────────────── */
function dateToDOY(dateStr) {
    // Returns 0-based day-of-year, treating every year as 365 days
    // (we map leap-day Feb 29 → Feb 28 via clamping, keeping the ring at 365)
    if (!dateStr || dateStr === '—') return -1;
    const [, m, d] = dateStr.split('-').map(Number);
    const cumDays = [0,31,59,90,120,151,181,212,243,273,304,334];
    const doy = cumDays[m - 1] + Math.min(d, m === 2 ? 28 : d) - 1;
    return Math.min(doy, 364);  // clamp leap day
}

/* ── Build dayMeans from all loaded year data ───────────────────────────── */
function clockRebuildMeans() {
    const means   = new Float32Array(365).fill(NaN);
    const counts  = new Uint16Array(365).fill(0);
    const sums    = new Float64Array(365).fill(0);

    const yearData = state.loadedPM25YearData;
    const meta     = state.clusterMeta;

    if (!meta || meta.length === 0) {
        clockState.dayMeans = means;
        clockRedrawBars();
        return;
    }

    const nClusters = meta.length;

    for (const year in yearData) {
        const yd = yearData[year];
        if (!yd || !yd.dates || !yd.pm25) continue;

        yd.dates.forEach((dateStr, localIdx) => {
            const doy = dateToDOY(dateStr);
            if (doy < 0 || doy > 364) return;

            // Compute spatial mean for this date
            let sum = 0, n = 0;
            for (let c = 0; c < nClusters; c++) {
                const clId = meta[c].clusterId;
                const vals = yd.pm25[clId];
                if (!vals) continue;
                const v = vals[localIdx];
                if (v !== null && v !== undefined && !isNaN(v)) {
                    sum += v;
                    n++;
                }
            }
            if (n > 0) {
                sums[doy]   += sum / n;
                counts[doy] += 1;
            }
        });
    }

    let maxVal = 0;
    for (let doy = 0; doy < 365; doy++) {
        if (counts[doy] > 0) {
            means[doy] = sums[doy] / counts[doy];
            if (means[doy] > maxVal) maxVal = means[doy];
        }
    }

    clockState.dayMeans = means;
    clockState.maxMean  = maxVal > 0 ? maxVal : 1;
    clockRedrawBars();
}

/* ── Initialise the SVG skeleton (called once) ──────────────────────────── */
function initClock() {
    const svgEl = document.getElementById('radial-clock-svg');
    if (!svgEl) return;

    clockState.svg = d3.select('#radial-clock-svg');

    // ── 1. Interaction hit zone ring (transparent, catches pointer events) ──
    const hitGroup = clockState.svg.append('g').attr('class', 'rc-hit-group');

    // We'll add individual hit-zone slices later in clockRedrawBars.
    // For now draw a full-ring invisible circle for "click to scrub"
    clockState.svg.append('circle')
        .attr('cx', CLOCK.CX).attr('cy', CLOCK.CY)
        .attr('r', CLOCK.R_RING + CLOCK.R_MAX_BAR + 4)
        .attr('fill', 'transparent')
        .attr('class', 'rc-ring-click-target')
        .style('cursor', 'crosshair')
        .on('click',     clockHandleRingClick)
        .on('mousemove', clockHandleRingHover)
        .on('mouseleave', clockHandleRingLeave);

    // ── 2. Background ring ──────────────────────────────────────────────────
    clockState.svg.append('circle')
        .attr('cx', CLOCK.CX).attr('cy', CLOCK.CY)
        .attr('r', CLOCK.R_RING)
        .attr('class', 'rc-ring-bg')
        .attr('stroke-width', 1);

    // ── 3. Trail arc (elapsed days highlight) ───────────────────────────────
    // We pre-size the circumference; dashoffset is updated live
    const circumference = 2 * Math.PI * CLOCK.R_RING;
    clockState.trailArc = clockState.svg.append('circle')
        .attr('cx', CLOCK.CX).attr('cy', CLOCK.CY)
        .attr('r', CLOCK.R_RING)
        .attr('class', 'rc-trail-arc')
        .attr('stroke-width', 6)
        .attr('stroke-dasharray', `${circumference} ${circumference}`)
        .attr('stroke-dashoffset', circumference)   // fully hidden initially
        .attr('transform', `rotate(-90 ${CLOCK.CX} ${CLOCK.CY})`);  // start at 12 o'clock

    // ── 4. Bar group (bars drawn/redrawn when data changes) ─────────────────
    clockState.barGroup = clockState.svg.append('g').attr('class', 'rc-bars');

    // ── 5. Month labels ─────────────────────────────────────────────────────
    const labelGroup = clockState.svg.append('g').attr('class', 'rc-month-labels');
    CLOCK.MONTH_STARTS.forEach((startDoy, i) => {
        // place label at midpoint of month
        const daysInMonth = (i < 11 ? CLOCK.MONTH_STARTS[i+1] : 365) - startDoy;
        const midDoy  = startDoy;
        const angle   = dayToAngle(midDoy);
        const pos     = polarToXY(CLOCK.R_MONTH_LBL, angle);

        labelGroup.append('text')
            .attr('x', pos.x).attr('y', pos.y)
            .attr('class', 'rc-month-label')
            .text(CLOCK.MONTH_NAMES[i]);
    });

    // ── 6. Centre readout ───────────────────────────────────────────────────
    // Pinned exactly at the geometric center (110, 110)
    
    // "Avg:" label sits slightly higher (-18px from center)
    clockState.centerLabel = clockState.svg.append('text')
        .attr('x', CLOCK.CX)
        .attr('y', CLOCK.CY )
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('class', 'rc-center-label')
        .text('Avg:');

    // Main changing data number sits exactly at the geometric center (0px offset)
    clockState.centerVal = clockState.svg.append('text')
        .attr('x', CLOCK.CX)
        .attr('y', CLOCK.CY) // +2px tweak optical adjustment for font baseline
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('class', 'rc-center-val')
        .style('font-weight', '700')
        .text('—');

    // ── 7. Needle (drawn last so it's always on top) ────────────────────────
    clockState.needleLine = clockState.svg.append('line')
        .attr('class', 'rc-needle-line')
        .attr('x1', CLOCK.CX).attr('y1', CLOCK.CY)
        .attr('x2', CLOCK.CX).attr('y2', CLOCK.CY - CLOCK.R_RING - CLOCK.R_MAX_BAR - 2);

    clockState.needleDot = clockState.svg.append('circle')
        .attr('class', 'rc-needle-dot')
        .attr('r', 3)
        .attr('cx', CLOCK.CX).attr('cy', CLOCK.CY - CLOCK.R_RING - 2);

    clockState.built = true;
}

/* ── Redraw bars whenever day-means change ──────────────────────────────── */
function clockRedrawBars() {
    if (!clockState.built || !clockState.barGroup) return;

    const bars    = clockState.barGroup;
    const means   = clockState.dayMeans;
    const maxMean = clockState.maxMean;
    const n       = CLOCK.DAYS_IN_YEAR;

    bars.selectAll('*').remove();

    const arcWidth = (2 * Math.PI) / n;    // angular width of one day

    for (let doy = 0; doy < n; doy++) {
        const val      = means[doy];
        const hasData  = !isNaN(val);
        const barH     = hasData ? (val / maxMean) * CLOCK.R_MAX_BAR : 0;
        const color    = hasData ? clockColor(val) : 'rgba(36,56,74,0.35)';

        const angleStart = dayToAngle(doy)       - arcWidth * 0.3;
        const angleEnd   = dayToAngle(doy + 0.6) + arcWidth * 0.3;

        const rIn  = CLOCK.R_RING;
        const rOut = hasData ? rIn + Math.max(barH, 1.5) : rIn + 1;

        const p1 = polarToXY(rIn,  angleStart);
        const p2 = polarToXY(rOut, angleStart);
        const p3 = polarToXY(rOut, angleEnd);
        const p4 = polarToXY(rIn,  angleEnd);

        const pathD =
            `M ${p1.x} ${p1.y} ` +
            `L ${p2.x} ${p2.y} ` +
            `A ${rOut} ${rOut} 0 0 1 ${p3.x} ${p3.y} ` +
            `L ${p4.x} ${p4.y} ` +
            `A ${rIn} ${rIn} 0 0 0 ${p1.x} ${p1.y}`;

        bars.append('path')
            .attr('d', pathD)
            .attr('fill', color)
            .attr('class', 'rc-bar')
            .attr('data-doy', doy)
            .attr('data-val', hasData ? val.toFixed(1) : 'NaN');
    }
}

/* ── Update needle + trail + centre readout ──────────────────────────────── */
function clockUpdate() {
    if (!clockState.built) return;

    const dateStr = state.allDates[state.currentDateIndex];
    if (!dateStr) return;

    const doy = dateToDOY(dateStr);
    if (doy < 0) return;

    // ── Needle ────────────────────────────────────────────────────────────
    const angle   = dayToAngle(doy);
    const needleTip = polarToXY(CLOCK.R_RING + CLOCK.R_MAX_BAR + 6, angle);
    const needleBase = polarToXY(CLOCK.R_INNER - 6, angle);

    clockState.needleLine
        .attr('x1', needleBase.x).attr('y1', needleBase.y)
        .attr('x2', needleTip.x) .attr('y2', needleTip.y);

    clockState.needleDot
        .attr('cx', needleTip.x).attr('cy', needleTip.y);

    // ── Trail arc ─────────────────────────────────────────────────────────
    const circumference = 2 * Math.PI * CLOCK.R_RING;
    const fraction      = doy / CLOCK.DAYS_IN_YEAR;
    const offset        = circumference * (1 - fraction);
    clockState.trailArc.attr('stroke-dashoffset', offset);

    // ── Centre readout (today's mean) ─────────────────────────────────────
    const val = clockState.dayMeans[doy];
    clockState.centerVal.text(isNaN(val) ? '—' : val.toFixed(0));

    // ── DOY label in header ───────────────────────────────────────────────
    const doyLabel = document.getElementById('clock-doy-label');
    if (doyLabel) doyLabel.textContent = dateStr;
}

/* ── Ring click → scrub main timeline ──────────────────────────────────── */
function clockHandleRingClick(event) {
    const doy = clockAngleFromEvent(event);
    if (doy < 0 || !state.allDates.length) return;

    // Find the closest date in allDates whose day-of-year matches doy
    let bestIdx = 0, bestDist = Infinity;
    state.allDates.forEach((d, idx) => {
        const dist = Math.abs(dateToDOY(d) - doy);
        if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
    });

    stopPlayback();   // stopPlayback is already global in script.js
    state.currentDateIndex = bestIdx;
    updateDateDisplay();   // global in script.js
    updateMapColors();     // global in script.js
    // clockUpdate() is called via our patched updateMapColors below
}

/* ── Ring hover → tooltip ───────────────────────────────────────────────── */
function clockHandleRingHover(event) {
    const doy = clockAngleFromEvent(event);
    if (doy < 0) return;

    const val = clockState.dayMeans[doy];
    const dateLabel = doyToDateLabel(doy);

    const tooltip  = document.getElementById('clock-tooltip');
    const ctDate   = document.getElementById('ct-date');
    const ctVal    = document.getElementById('ct-val');

    if (ctDate) ctDate.textContent = dateLabel;
    if (ctVal)  ctVal.textContent  = isNaN(val) ? 'No data' : `${val.toFixed(1)} µg/m³`;
    if (tooltip) tooltip.classList.add('visible');
}

function clockHandleRingLeave() {
    const tooltip = document.getElementById('clock-tooltip');
    if (tooltip) tooltip.classList.remove('visible');
}

/* ── Convert a pointer event to day-of-year ─────────────────────────────── */
function clockAngleFromEvent(event) {
    const svgEl = document.getElementById('radial-clock-svg');
    if (!svgEl) return -1;

    const rect = svgEl.getBoundingClientRect();
    const scaleX = CLOCK.SVG_SIZE / rect.width;
    const scaleY = CLOCK.SVG_SIZE / rect.height;

    const mx = (event.clientX - rect.left) * scaleX;
    const my = (event.clientY - rect.top)  * scaleY;

    const dx = mx - CLOCK.CX;
    const dy = my - CLOCK.CY;

    // Ignore clicks too close to centre or too far outside ring
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < CLOCK.R_INNER - 4 || dist > CLOCK.R_MONTH_LBL + 8) return -1;

    // atan2 gives angle from positive-x axis; we want from top (negative-y), clockwise
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += 2 * Math.PI;

    const doy = Math.round((angle / (2 * Math.PI)) * CLOCK.DAYS_IN_YEAR) % CLOCK.DAYS_IN_YEAR;
    return doy;
}

/* ── DOY → readable date label (e.g. "Mar 15") ─────────────────────────── */
function doyToDateLabel(doy) {
    const MONTH_FULL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
    let remaining = doy;
    for (let m = 0; m < 12; m++) {
        if (remaining < MONTH_DAYS[m]) {
            return `${MONTH_FULL[m]} ${remaining + 1}`;
        }
        remaining -= MONTH_DAYS[m];
    }
    return `Dec 31`;
}

/* ── Info button toggle ─────────────────────────────────────────────────── */
function setupClockInfoBtn() {
    const btn     = document.getElementById('clock-info-btn');
    const popover = document.getElementById('clock-info-popover');
    if (!btn || !popover) return;

    btn.addEventListener('click', e => {
        e.stopPropagation();
        popover.classList.toggle('visible');
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('#radial-clock-wrap')) {
            popover.classList.remove('visible');
        }
    });
}

/* ══════════════════════════════════════════════════════════════════════════
   MONKEY-PATCH: hook clock into the existing script.js functions
   We capture references AFTER DOMContentLoaded so script.js has already
   defined them at module scope.
══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

    // ── 1. Init the SVG skeleton immediately ────────────────────────────────
    initClock();
    setupClockInfoBtn();

    // ── 2. Patch updateMapColors ────────────────────────────────────────────
    //   script.js defines updateMapColors in the module scope.
    //   We wrap it: call original, then call clockUpdate.
    const _origUpdateMapColors = updateMapColors;
    // Override in global scope
    window._clockPatchedUpdateMapColors = function () {
        _origUpdateMapColors.call(this);
        clockUpdate();
    };
    // Re-bind all call sites that reference updateMapColors by name in the
    // RAF loop. Since playbackTick calls updateMapColors() directly (not via
    // window), we need a different approach: override via the playback path.
    // The cleanest solution: patch the functions that call updateMapColors.

    // Patch handleSliderChange
    const _origHandleSliderChange = handleSliderChange;
    window.handleSliderChange = function(e) {
        state.currentDateIndex = parseInt(e.target.value);
        updateDateDisplay();
        updateMapColors();
        clockUpdate();
    };
    document.getElementById('date-slider')
        .removeEventListener('input', _origHandleSliderChange);
    document.getElementById('date-slider')
        .addEventListener('input', window.handleSliderChange);

    // Patch stepDate
    const _origStepDate = stepDate;
    window._clockPatchedStepDate = function(dir) {
        _origStepDate(dir);
        clockUpdate();
    };

    // Patch playbackTick to call clockUpdate each frame
    //   playbackTick is a local function inside a closure, so we can't patch it
    //   directly. Instead, we hook updateDateDisplay which IS called every tick.
    const _origUpdateDateDisplay = updateDateDisplay;
    // We'll do this via a MutationObserver on the date text node — zero-coupling:
    const dateTextEl = document.getElementById('current-date');
    if (dateTextEl) {
        new MutationObserver(() => {
            clockUpdate();
            // Also sync the badge date
            const badge = document.getElementById('badge-date-display');
            if (badge) badge.textContent = dateTextEl.textContent;
        }).observe(dateTextEl, { characterData: true, childList: true, subtree: true });
    }

    // Patch rebuildDateIndex → clockRebuildMeans
    const _origRebuildDateIndex = rebuildDateIndex;
    // We use a post-action hook via the checkbox change handler chain.
    // The cleanest way: observe when allDates.length changes via a setter.
    // Since state is a plain object, we intercept at the PM25 load completion
    // points by wrapping handlePM25YearCheckboxChange.
    const _origHandlePM25 = handlePM25YearCheckboxChange;
    window._clockHandlePM25 = async function(e) {
        await _origHandlePM25.call(this, e);
        clockRebuildMeans();
        clockUpdate();
    };
    // Re-wire checkboxes
    document.querySelectorAll('.pm25-year-checkbox').forEach(cb => {
        cb.removeEventListener('change', _origHandlePM25);
        cb.addEventListener('change', window._clockHandlePM25);
    });

    // ── 3. If data was loaded on init (pre-checked year 2013), rebuild now ──
    //   init() in script.js loads pre-checked years then calls rebuildDateIndex
    //   and updateMapColors. By the time our DOMContentLoaded fires (same tick,
    //   later listener), those may have already completed. So we schedule a
    //   short delay to let async init() settle.
    setTimeout(() => {
        if (Object.keys(state.loadedPM25YearData).length > 0) {
            clockRebuildMeans();
            clockUpdate();
        }
    }, 3000);

});

/* ── Also call clockRebuildMeans when year-select-all / clear-all fires ── */
//   These buttons dispatch 'change' events on the checkboxes, so the patched
//   handler above already covers them. Nothing extra needed.

/* ═══════════════════════════════════════════════════════════════════════════
   IQR RADIAL SPREAD CLOCK  +  MEDIAN OVERRIDE FOR SEASONAL CLOCK
═══════════════════════════════════════════════════════════════════════════ */

/* ── IQR colour scale: sky-blue (uniform) → amber → deep-red (extreme) ──── */
const IQR_COLOR_SCALE = d3.scaleLinear()
    .domain([0, 12, 30, 60, 100])
    .range([
        '#4a9aba',  // very uniform across regions
        '#7eb8d4',  // mild spread
        '#d4a853',  // moderate spread
        '#E65C17',  // high spread
        '#8A1C1C',  // extreme spread
    ])
    .clamp(true);

/* ── IQR widget state ────────────────────────────────────────────────────── */
const iqrState = {
    svg:        null,
    barGroup:   null,
    trailArc:   null,
    needleLine: null,
    needleDot:  null,
    centerQ1:   null,   // D3 text selection
    centerIQR:  null,
    centerQ3:   null,

    dayQ1:  new Float32Array(365).fill(NaN),
    dayQ3:  new Float32Array(365).fill(NaN),
    dayIQR: new Float32Array(365).fill(NaN),
    maxIQR: 1,
    built:  false,
};

/* ═══════════════════════════════════════════════════════════════════════════
   COMBINED REBUILD — median + IQR for all 365 DOYs, one histogram pass
   ─────────────────────────────────────────────────────────────────────────
   For each date we build a 300-bucket histogram over [0, 150] µg/m³
   and read the P25 / P50 / P75 percentiles directly — O(nClusters) per date,
   no sorting. Per-doy stats are then averaged across all loaded years.
═══════════════════════════════════════════════════════════════════════════ */
function rebuildAllClockStats() {
    const NBUCKETS  = 300;                // ~0.5 µg/m³ resolution
    const BSCALE    = NBUCKETS / 150;     // value → bucket index

    const medSums   = new Float64Array(365).fill(0);
    const q1Sums    = new Float64Array(365).fill(0);
    const q3Sums    = new Float64Array(365).fill(0);
    const iqrSums   = new Float64Array(365).fill(0);
    const dayCounts = new Uint16Array(365).fill(0);

    const yearData  = state.loadedPM25YearData;
    const meta      = state.clusterMeta;

    /* reset both widgets if there's nothing to compute */
    function zeroOut() {
        clockState.dayMeans = new Float32Array(365).fill(NaN);
        clockState.maxMean  = 1;
        iqrState.dayQ1  = new Float32Array(365).fill(NaN);
        iqrState.dayQ3  = new Float32Array(365).fill(NaN);
        iqrState.dayIQR = new Float32Array(365).fill(NaN);
        iqrState.maxIQR = 1;
        clockRedrawBars();
        if (iqrState.built) iqrRedrawBars();
    }

    if (!meta || meta.length === 0) { zeroOut(); return; }

    const nClusters = meta.length;
    const buckets   = new Uint32Array(NBUCKETS + 1);  // reused each date

    for (const year in yearData) {
        const yd = yearData[year];
        if (!yd || !yd.dates || !yd.pm25) continue;

        yd.dates.forEach((dateStr, localIdx) => {
            const doy = dateToDOY(dateStr);
            if (doy < 0 || doy > 364) return;

            /* ── fill histogram for this date ───────────────────────────── */
            buckets.fill(0);
            let totalN = 0;

            for (let c = 0; c < nClusters; c++) {
                const clId = meta[c].clusterId;
                const vals = yd.pm25[clId];
                if (!vals) continue;
                const v = vals[localIdx];
                if (v !== null && v !== undefined && !isNaN(v) && v >= 0) {
                    const b = Math.min(Math.floor(v * BSCALE), NBUCKETS);
                    buckets[b]++;
                    totalN++;
                }
            }

            if (totalN === 0) return;

            /* ── read P25 / P50 / P75 from histogram ────────────────────── */
            const t25 = totalN * 0.25;
            const t50 = totalN * 0.50;
            const t75 = totalN * 0.75;

            let acc = 0, q1 = 0, med = 0, q3 = 0;
            let f1 = false, f2 = false, f3 = false;

            for (let b = 0; b <= NBUCKETS; b++) {
                acc += buckets[b];
                if (!f1 && acc >= t25) { q1  = b / BSCALE; f1 = true; }
                if (!f2 && acc >= t50) { med = b / BSCALE; f2 = true; }
                if (!f3 && acc >= t75) { q3  = b / BSCALE; f3 = true; break; }
            }

            medSums[doy]  += med;
            q1Sums[doy]   += q1;
            q3Sums[doy]   += q3;
            iqrSums[doy]  += (q3 - q1);
            dayCounts[doy]++;
        });
    }

    /* ── finalise per-DOY averages across loaded years ──────────────────── */
    const dayMed = new Float32Array(365).fill(NaN);
    const dayQ1  = new Float32Array(365).fill(NaN);
    const dayQ3  = new Float32Array(365).fill(NaN);
    const dayIQR = new Float32Array(365).fill(NaN);
    let maxMed = 0, maxIQR = 0;

    for (let doy = 0; doy < 365; doy++) {
        const cnt = dayCounts[doy];
        if (cnt > 0) {
            dayMed[doy]  = medSums[doy]  / cnt;
            dayQ1[doy]   = q1Sums[doy]   / cnt;
            dayQ3[doy]   = q3Sums[doy]   / cnt;
            dayIQR[doy]  = iqrSums[doy]  / cnt;
            if (dayMed[doy]  > maxMed)  maxMed  = dayMed[doy];
            if (dayIQR[doy]  > maxIQR)  maxIQR  = dayIQR[doy];
        }
    }

    /* ── push into both widgets ─────────────────────────────────────────── */
    clockState.dayMeans = dayMed;
    clockState.maxMean  = maxMed  > 0 ? maxMed  : 1;

    iqrState.dayQ1  = dayQ1;
    iqrState.dayQ3  = dayQ3;
    iqrState.dayIQR = dayIQR;
    iqrState.maxIQR = maxIQR > 0 ? maxIQR : 1;

    clockRedrawBars();
    if (iqrState.built) { iqrRedrawBars(); iqrUpdate(); }
}

/* ── Redirect the existing clock's rebuild to our combined function ───────── */
/* clockRebuildMeans is a global function declaration; assigning here safely
   replaces it for all future call-sites (checkboxes, timeouts, patched handlers) */
clockRebuildMeans = rebuildAllClockStats;   // eslint-disable-line no-undef

/* ── IQR bar colour helper ───────────────────────────────────────────────── */
function iqrBarColor(val) { return IQR_COLOR_SCALE(val); }

/* ══════════════════════════════════════════════════════════════════════════
   IQR WIDGET — SVG SKELETON (called once)
══════════════════════════════════════════════════════════════════════════ */
function initIQRClock() {
    const svgEl = document.getElementById('iqr-clock-svg');
    if (!svgEl) return;

    iqrState.svg = d3.select('#iqr-clock-svg');
    const S = iqrState.svg;
    const CX = CLOCK.CX, CY = CLOCK.CY;

    /* ── interaction hit zone ───────────────────────────────────────────── */
    S.append('circle')
        .attr('cx', CX).attr('cy', CY)
        .attr('r', CLOCK.R_RING + CLOCK.R_MAX_BAR + 4)
        .attr('fill', 'transparent')
        .attr('class', 'rc-ring-click-target')
        .style('cursor', 'crosshair')
        .on('click',      iqrHandleRingClick)
        .on('mousemove',  iqrHandleRingHover)
        .on('mouseleave', iqrHandleRingLeave);

    /* ── background ring ────────────────────────────────────────────────── */
    S.append('circle')
        .attr('cx', CX).attr('cy', CY).attr('r', CLOCK.R_RING)
        .attr('class', 'rc-ring-bg').attr('stroke-width', 1);

    /* ── trail arc (sky blue) ───────────────────────────────────────────── */
    const circ = 2 * Math.PI * CLOCK.R_RING;
    iqrState.trailArc = S.append('circle')
        .attr('cx', CX).attr('cy', CY).attr('r', CLOCK.R_RING)
        .attr('class', 'iqr-trail-arc')
        .attr('stroke-width', 6)
        .attr('stroke-dasharray', `${circ} ${circ}`)
        .attr('stroke-dashoffset', circ)
        .attr('transform', `rotate(-90 ${CX} ${CY})`);

    /* ── bar group ──────────────────────────────────────────────────────── */
    iqrState.barGroup = S.append('g').attr('class', 'iqr-bars');

    /* ── month labels (same as seasonal clock) ──────────────────────────── */
    const lblG = S.append('g').attr('class', 'rc-month-labels');
    CLOCK.MONTH_STARTS.forEach((startDoy, i) => {
        const pos = polarToXY(CLOCK.R_MONTH_LBL, dayToAngle(startDoy));
        lblG.append('text')
            .attr('x', pos.x).attr('y', pos.y)
            .attr('class', 'rc-month-label')
            .text(CLOCK.MONTH_NAMES[i]);
    });

    /* ── centre readout: Q1 · IQR (large) · unit · Q3 ─────────────────── */
    iqrState.centerQ1 = S.append('text')
        .attr('x', CX).attr('y', CY - 22)
        .attr('class', 'iqr-center-qval')
        .text('Q1: —');

    iqrState.centerIQR = S.append('text')
        .attr('x', CX).attr('y', CY)
        .attr('class', 'iqr-center-iqr-val')
        .text('—');

    S.append('text')
        .attr('x', CX).attr('y', CY + 6)
        .attr('class', 'rc-center-unit')

    iqrState.centerQ3 = S.append('text')
        .attr('x', CX).attr('y', CY + 19)
        .attr('class', 'iqr-center-qval')
        .text('Q3: —');

    /* ── needle (drawn last → always on top) ────────────────────────────── */
    iqrState.needleLine = S.append('line')
        .attr('class', 'iqr-needle-line')
        .attr('x1', CX).attr('y1', CY)
        .attr('x2', CX).attr('y2', CY - CLOCK.R_RING - CLOCK.R_MAX_BAR - 2);

    iqrState.needleDot = S.append('circle')
        .attr('class', 'iqr-needle-dot').attr('r', 3)
        .attr('cx', CX).attr('cy', CY - CLOCK.R_RING - 2);

    iqrState.built = true;
}

/* ── Redraw all IQR bars (called after data changes) ────────────────────── */
function iqrRedrawBars() {
    if (!iqrState.built || !iqrState.barGroup) return;

    const bars   = iqrState.barGroup;
    const iqrArr = iqrState.dayIQR;
    const maxIQR = iqrState.maxIQR;
    const n      = CLOCK.DAYS_IN_YEAR;
    const arcW   = (2 * Math.PI) / n;

    bars.selectAll('*').remove();

    for (let doy = 0; doy < n; doy++) {
        const val     = iqrArr[doy];
        const hasData = !isNaN(val);
        const barH    = hasData ? (val / maxIQR) * CLOCK.R_MAX_BAR : 0;
        const color   = hasData ? iqrBarColor(val) : 'rgba(36,56,74,0.35)';

        const a0 = dayToAngle(doy)       - arcW * 0.3;
        const a1 = dayToAngle(doy + 0.6) + arcW * 0.3;

        const rIn  = CLOCK.R_RING;
        const rOut = hasData ? rIn + Math.max(barH, 1.5) : rIn + 1;

        const p1 = polarToXY(rIn,  a0);
        const p2 = polarToXY(rOut, a0);
        const p3 = polarToXY(rOut, a1);
        const p4 = polarToXY(rIn,  a1);

        bars.append('path')
            .attr('d',
                `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} ` +
                `A ${rOut} ${rOut} 0 0 1 ${p3.x} ${p3.y} ` +
                `L ${p4.x} ${p4.y} A ${rIn} ${rIn} 0 0 0 ${p1.x} ${p1.y}`)
            .attr('fill', color)
            .attr('class', 'rc-bar')
            .attr('data-doy', doy);
    }
}

/* ── Update needle, trail arc, and centre readout ────────────────────────── */
function iqrUpdate() {
    if (!iqrState.built) return;

    const dateStr = state.allDates[state.currentDateIndex];
    if (!dateStr) return;

    const doy = dateToDOY(dateStr);
    if (doy < 0) return;

    /* needle */
    const angle      = dayToAngle(doy);
    const needleTip  = polarToXY(CLOCK.R_RING + CLOCK.R_MAX_BAR + 6, angle);
    const needleBase = polarToXY(CLOCK.R_INNER - 6, angle);

    iqrState.needleLine
        .attr('x1', needleBase.x).attr('y1', needleBase.y)
        .attr('x2', needleTip.x) .attr('y2', needleTip.y);
    iqrState.needleDot
        .attr('cx', needleTip.x).attr('cy', needleTip.y);

    /* trail arc */
    const circ = 2 * Math.PI * CLOCK.R_RING;
    iqrState.trailArc.attr(
        'stroke-dashoffset',
        circ * (1 - doy / CLOCK.DAYS_IN_YEAR)
    );

    /* centre readout */
    const q1  = iqrState.dayQ1[doy];
    const q3  = iqrState.dayQ3[doy];
    const iqr = iqrState.dayIQR[doy];

    iqrState.centerQ1.text( isNaN(q1)  ? 'Q1: —' : `Q1: ${q1.toFixed(1)}`);
    iqrState.centerIQR.text(isNaN(iqr) ? '—'     : iqr.toFixed(0));
    iqrState.centerQ3.text( isNaN(q3)  ? 'Q3: —' : `Q3: ${q3.toFixed(1)}`);

    /* header label */
    const lbl = document.getElementById('iqr-doy-label');
    if (lbl) lbl.textContent = dateStr;
}

/* ── Ring click → scrub main timeline ───────────────────────────────────── */
function iqrHandleRingClick(event) {
    const doy = iqrAngleFromEvent(event);
    if (doy < 0 || !state.allDates.length) return;

    let best = 0, bestDist = Infinity;
    state.allDates.forEach((d, i) => {
        const dist = Math.abs(dateToDOY(d) - doy);
        if (dist < bestDist) { bestDist = dist; best = i; }
    });

    stopPlayback();
    state.currentDateIndex = best;
    updateDateDisplay();
    updateMapColors();
    iqrUpdate();
}

/* ── Ring hover → tooltip ─────────────────────────────────────────────────── */
function iqrHandleRingHover(event) {
    const doy = iqrAngleFromEvent(event);
    if (doy < 0) return;

    const q1  = iqrState.dayQ1[doy];
    const q3  = iqrState.dayQ3[doy];
    const iqr = iqrState.dayIQR[doy];

    const tip   = document.getElementById('iqr-tooltip');
    const elD   = document.getElementById('iqr-ct-date');
    const elQ1  = document.getElementById('iqr-ct-q1');
    const elIQR = document.getElementById('iqr-ct-iqr');
    const elQ3  = document.getElementById('iqr-ct-q3');

    if (elD)   elD.textContent   = doyToDateLabel(doy);
    if (elQ1)  elQ1.textContent  = isNaN(q1)  ? 'Q1  —'  : `Q1   ${q1.toFixed(1)} µg/m³`;
    if (elIQR) elIQR.textContent = isNaN(iqr) ? 'IQR  —' : `IQR  ${iqr.toFixed(1)} µg/m³`;
    if (elQ3)  elQ3.textContent  = isNaN(q3)  ? 'Q3  —'  : `Q3   ${q3.toFixed(1)} µg/m³`;
    if (tip)   tip.classList.add('visible');
}

function iqrHandleRingLeave() {
    const tip = document.getElementById('iqr-tooltip');
    if (tip) tip.classList.remove('visible');
}

/* ── Pointer event → day-of-year (mirrors clockAngleFromEvent exactly) ─────── */
function iqrAngleFromEvent(event) {
    const svgEl = document.getElementById('iqr-clock-svg');
    if (!svgEl) return -1;

    const rect = svgEl.getBoundingClientRect();
    const mx   = (event.clientX - rect.left) * (CLOCK.SVG_SIZE / rect.width);
    const my   = (event.clientY - rect.top)  * (CLOCK.SVG_SIZE / rect.height);
    const dx   = mx - CLOCK.CX,  dy = my - CLOCK.CY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < CLOCK.R_INNER - 4 || dist > CLOCK.R_MONTH_LBL + 8) return -1;

    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += 2 * Math.PI;
    return Math.round((angle / (2 * Math.PI)) * CLOCK.DAYS_IN_YEAR) % CLOCK.DAYS_IN_YEAR;
}

/* ── Info button toggle ──────────────────────────────────────────────────── */
function setupIQRInfoBtn() {
    const btn     = document.getElementById('iqr-info-btn');
    const popover = document.getElementById('iqr-info-popover');
    if (!btn || !popover) return;

    btn.addEventListener('click', e => {
        e.stopPropagation();
        popover.classList.toggle('visible');
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('#iqr-clock-wrap')) popover.classList.remove('visible');
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT HOOK
   Uses the same MutationObserver pattern as the existing clock so iqrUpdate
   fires automatically on every playback frame, slider drag, and step press.
═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

    /* 1. Relabel the seasonal clock centre from "Avg:" → "Med:" */
    if (clockState && clockState.centerLabel) {
        clockState.centerLabel.text('');
    }

    /* 2. Build IQR widget skeleton */
    initIQRClock();
    setupIQRInfoBtn();

    /* 3. Drive iqrUpdate whenever the current date text changes.
          The same #current-date MutationObserver pattern the clock uses —
          it fires on every frame during playback, slider drag, or step. */
    const dateEl = document.getElementById('current-date');
    if (dateEl) {
        new MutationObserver(() => iqrUpdate())
            .observe(dateEl, { characterData: true, childList: true, subtree: true });
    }

    /* 4. If year data was already loaded before this block ran, rebuild now.
          The 3 500 ms delay lets the existing clock's 3 000 ms timeout settle
          first, then we do one clean combined pass. */
    setTimeout(() => {
        /* Re-apply the median label in case initClock ran very late */
        if (clockState && clockState.centerLabel) {
            clockState.centerLabel.text('');
        }

        if (Object.keys(state.loadedPM25YearData).length > 0) {
            rebuildAllClockStats();
            iqrUpdate();
        }
    }, 3500);
});