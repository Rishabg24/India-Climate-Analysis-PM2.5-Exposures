// ============================================
// GLOBAL STATE
// ============================================

const state = {
    svg: null,
    projection: null,
    path: null,
    // PERF: Flat array indexed by voronoi order (same as clustersData.features[i])
    // Much faster than hash map lookup per frame
    cellNodes: [],           // cellNodes[i] = raw DOM <path> node for cluster i
    clusterMeta: [],         // clusterMeta[i] = { clusterId } — pre-cached at load time
    clustersData: null,
    loadedPM25YearData: {},  // PM2.5 year data
    allDates: [],
    dateToDataMap: {},
    currentDateIndex: 0,
    svgWidth: 0,
    svgHeight: 0,
    boundaryGeoJSON: null,
    // RACE-CONDITION FIX: Track in-flight loads so the UI stays locked
    // until every selected year has arrived — regardless of which resolves first.
    pendingPM25Loads: new Set(),   // years currently being fetched
};

const HF_BASE = 'https://huggingface.co/datasets/Lotus-28/India_Temperature_Analysis_Data/resolve/main';

// ============================================
// PM2.5 COLOR SCALE
// Mirrors the CSS gradient in .pm25-gradient:
//   green(Good) → yellow(Moderate) → orange(Sensitive) → red(Unhealthy) → maroon(Hazardous)
// WHO 24-hr guideline: 15 µg/m³; India's typical range: 0–250+
// We cap at 150 (Hazardous) so extreme outliers don't wash out the scale.
// ============================================

const PM25_DOMAIN_MAX = 150;  // µg/m³ — anything ≥ this renders as full maroon

const PM25_COLOR_SCALE = d3.scaleSequential(
    d3.interpolateRgbBasis([
        '#00e400',  //   0  Good
        '#cccc00',  //  ~35 Moderate
        '#ff7e00',  //  ~75 Sensitive Groups
        '#ff0000',  // ~110 Unhealthy
        '#7e0023',  //  150 Hazardous
    ])
).domain([0, PM25_DOMAIN_MAX]);

const NO_DATA_COLOR = '#474747';

// PM2.5 color (single global scale)
function getColorPM25(value) {
    if (value === null || value === undefined) return NO_DATA_COLOR;
    const capped = Math.max(0, Math.min(PM25_DOMAIN_MAX, value));
    return PM25_COLOR_SCALE(capped);
}

function showLoading() { document.getElementById('loading-overlay').classList.add('active'); }
function hideLoading()  { document.getElementById('loading-overlay').classList.remove('active'); }

// ============================================
// ROBUST HUGGINGFACE FETCH
// HF "resolve" URLs sometimes serve an HTML redirect page instead of raw data.
// Adding ?download=true forces the raw file. We also validate the response
// is actually JSON before parsing.
// ============================================

async function hfFetch(filename) {
    const urls = [
        `${HF_BASE}/${filename}?download=true`,
        `${HF_BASE}/${filename}`,
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.warn(`HTTP ${res.status} for ${url}`);
                continue;
            }

            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
                console.warn(`Got HTML response from ${url} — trying fallback`);
                continue;
            }

            const text = await res.text();
            const trimmed = text.trimStart();
            if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
                console.warn(`Non-JSON response from ${url} — trying fallback`);
                continue;
            }

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
        console.log('Boundary loaded');
    } catch (err) {
        console.error(err);
        alert('Failed to load India boundary.\n' + err.message);
    }
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
        console.log(`Loaded ${data.features.length} clusters`);

        // PERF: Pre-cache clusterId per index — computed once, used every frame
        state.clusterMeta = data.features.map(f => ({
            clusterId: f.properties.cluster_id,
        }));

        redrawClusters();
        console.log('Clusters drawn');
    } catch (err) {
        console.error(err);
        alert('Failed to load clusters.\n' + err.message);
    }
}

function redrawClusters() {
    if (!state.clustersData) return;

    const vGroup = state.svg.select('#voronoi-group');
    vGroup.selectAll('*').remove();
    state.cellNodes = [];

    const W = state.svgWidth;
    const H = state.svgHeight;

    const points   = state.clustersData.features.map(f => state.projection(f.geometry.coordinates));
    const delaunay = d3.Delaunay.from(points);
    const voronoi  = delaunay.voronoi([0, 0, W, H]);

    vGroup.attr('clip-path', 'url(#india-clip)');

    // PERF: No CSS transition on fill — transitions on thousands of SVG paths
    // force full style recalculation every frame, making playback glacially slow
    state.clustersData.features.forEach((feature, i) => {
        const cellPath = voronoi.renderCell(i);
        if (!cellPath) {
            state.cellNodes.push(null);
            return;
        }
        const node = vGroup.append('path')
            .attr('d', cellPath)
            .attr('class', 'cluster-cell')
            .attr('fill', NO_DATA_COLOR)
            .node();
        state.cellNodes.push(node);
    });
}

// ─── PM2.5 year loader (HuggingFace) ───
async function loadPM25YearDataHF(year) {
    if (state.loadedPM25YearData[year]) return state.loadedPM25YearData[year];

    console.log(`Loading PM2.5 year ${year} from HuggingFace...`);
    try {
        const data = await hfFetch(`pm25_data_${year}.json`);
        state.loadedPM25YearData[year] = data;
        console.log(`Loaded PM2.5 ${year}: ${data.dates.length} days`);
        return data;
    } catch (err) {
        console.error(err);
        alert(`Failed to load PM2.5 data for ${year}.\n${err.message}`);
        return null;
    }
}

// ============================================
// DATE MANAGEMENT
// ============================================

function rebuildDateIndex() {
    // Remember which date was on screen before rebuilding so we can restore the
    // slider position rather than always snapping back to index 0.
    const prevDate = state.allDates.length > 0
        ? state.allDates[state.currentDateIndex]
        : null;

    state.allDates      = [];
    state.dateToDataMap = {};

    Array.from(document.querySelectorAll('.pm25-year-checkbox:checked'))
        .map(cb => parseInt(cb.value)).sort((a, b) => a - b)
        .forEach(year => {
            const yd = state.loadedPM25YearData[year];
            if (!yd) return;
            yd.dates.forEach((d, idx) => {
                state.allDates.push(d);
                state.dateToDataMap[d] = { year, localIndex: idx };
            });
        });

    // Restore the slider position to the same calendar date if it still exists in
    // the newly-built index. Fall back to 0 only when the previous date is no longer present.
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

    if (!state.allDates.length) {
        slider.disabled = playBtn.disabled = true;
        slider.max = 0;
        document.getElementById('current-date').textContent = 'Select years to begin';
        return;
    }

    // Guard: don't unlock controls if any fetches are still in-flight.
    const hasInflight = state.pendingPM25Loads.size > 0;
    slider.disabled = playBtn.disabled = hasInflight;
    slider.max   = state.allDates.length - 1;
    slider.value = state.currentDateIndex;
    updateDateDisplay();
}

// FIX: date strings like "2014-01-15" are parsed as UTC midnight by the JS Date
// constructor. Displaying them with toLocaleDateString() in a non-UTC timezone
// (e.g. US/Pacific = UTC-8) shifts the date one day back.
// Solution: force UTC rendering via the timeZone option.
function updateDateDisplay() {
    if (!state.allDates.length) return;
    const dateStr = state.allDates[state.currentDateIndex];
    const d = new Date(dateStr);
    document.getElementById('current-date').textContent =
        d.toLocaleDateString('en-US', {
            year:     'numeric',
            month:    'long',
            day:      'numeric',
            timeZone: 'UTC',   // <-- prevents off-by-one-day in western timezones
        });
}

// ============================================
// MAP COLOR UPDATE
// Hot path: optimized for speed across ~30k Voronoi cells
// ============================================

function updateMapColors() {
    updateMapColorsPM25();
}

// ─── PM2.5 ───
function updateMapColorsPM25() {
    if (!state.clustersData || !state.allDates.length) return;

    const dataInfo = state.dateToDataMap[state.allDates[state.currentDateIndex]];
    if (!dataInfo) return;

    const yearData = state.loadedPM25YearData[dataInfo.year];
    if (!yearData) return;

    const pm25Data   = yearData.pm25;
    const localIndex = dataInfo.localIndex;
    const meta       = state.clusterMeta;
    const nodes      = state.cellNodes;
    const n          = meta.length;

    // PERF: Tight loop — clusterId lookup, direct DOM write
    for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (!node) continue;
        const { clusterId } = meta[i];
        const vals = pm25Data[clusterId];
        node.setAttribute('fill', vals ? getColorPM25(vals[localIndex]) : NO_DATA_COLOR);
    }
}

// ─── Reset all cells to no-data ───
function clearMapColors() {
    const nodes = state.cellNodes;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
        if (nodes[i]) nodes[i].setAttribute('fill', NO_DATA_COLOR);
    }
}

// ─── Enable / disable slider + play button ───────────────────────────────────
// Called by the checkbox handlers to lock the UI while datasets are in-flight.
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

        // Only unlock the UI and rebuild the date index once every selected year
        // has finished loading.
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
// PLAYBACK — requestAnimationFrame based
//
// WHY RAF instead of setInterval:
//   setInterval fires on a wall-clock schedule regardless of how long each frame
//   takes. With ~30k setAttribute calls per frame, a single tick can exceed the
//   interval period, causing callbacks to queue up. When the main thread catches
//   up, queued ticks fire back-to-back — producing the "freeze then jump" effect.
//
//   requestAnimationFrame self-schedules: the next frame only queues AFTER the
//   browser has painted the current one. Combined with elapsed-time gating for
//   fps control, this guarantees at most one data update per paint cycle and
//   eliminates callback accumulation entirely.
//
//   Bonus: RAF automatically pauses when the tab is hidden.
// ============================================

const playback = {
    rafId:    null,   // current requestAnimationFrame handle
    running:  false,
    lastTime: 0,
    fps:      6,      // frames per second
};

const isPlaying = () => playback.running;

function playbackTick(now) {
    if (!playback.running) return;

    const elapsed = now - playback.lastTime;
    const frameMs = 1000 / playback.fps;

    if (elapsed >= frameMs) {
        // Advance one day
        if (state.currentDateIndex >= state.allDates.length - 1) {
            stopPlayback();
            return;
        }

        state.currentDateIndex++;
        document.getElementById('date-slider').value = state.currentDateIndex;
        updateDateDisplay();
        updateMapColors();

        // Use actual elapsed time for lastTime to avoid drift from integer division
        playback.lastTime = now - (elapsed % frameMs);
    }

    playback.rafId = requestAnimationFrame(playbackTick);
}

function startPlayback() {
    if (isPlaying() || !state.allDates.length) return;

    // If we're at the end, loop back to the start
    if (state.currentDateIndex >= state.allDates.length - 1) {
        state.currentDateIndex = 0;
        document.getElementById('date-slider').value = 0;
        updateDateDisplay();
    }

    document.getElementById('play-btn').textContent = '⏸ Pause';
    playback.running  = true;
    playback.lastTime = performance.now();
    playback.rafId    = requestAnimationFrame(playbackTick);
}

function stopPlayback() {
    if (playback.rafId !== null) {
        cancelAnimationFrame(playback.rafId);
        playback.rafId = null;
    }
    playback.running = false;
    document.getElementById('play-btn').textContent = '▶ Play';
}

function stepDate(dir) {
    if (!state.allDates.length) return;
    stopPlayback();
    state.currentDateIndex = Math.max(0, Math.min(state.allDates.length - 1, state.currentDateIndex + dir));
    document.getElementById('date-slider').value = state.currentDateIndex;
    updateDateDisplay();
    updateMapColors();
}

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    showLoading();
    initMap();
    await loadBoundary();
    await loadClusters();
    hideLoading();

    // ── PM2.5 year checkboxes ──
    document.querySelectorAll('.pm25-year-checkbox')
        .forEach(cb => cb.addEventListener('change', handlePM25YearCheckboxChange));

    // ── Shared slider / play / keyboard ──
    document.getElementById('date-slider').addEventListener('input', handleSliderChange);
    document.getElementById('date-slider').addEventListener('mousedown', stopPlayback);
    document.getElementById('play-btn')
        .addEventListener('click', () => isPlaying() ? stopPlayback() : startPlayback());
    document.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDate(+1); }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); stepDate(-1); }
    });

    window.addEventListener('resize', onResize);
}

document.addEventListener('DOMContentLoaded', init);