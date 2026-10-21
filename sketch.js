// Quantum Cloud style: random walkers seeded on a model's surface.
//
// Overview:
//   1. Load an .obj model (and optionally its texture).
//   2. Scatter `numWalkers` points uniformly over its surface.
//   3. Place a walker on each point; each takes `maxSteps` random steps,
//      with a slight drift along the surface normal (away from the body).
//   4. Trails fade in alpha with distance from their starting point.
//   5. Each walk's segments are written into GPU buffers as it is walked, with
//      no bake step. Once every walk is generated, the structure is grown on
//      screen step by step, all walkers advancing together.
//
// All parameters live in the settings panel. Editing the panel changes
// nothing on screen until the Render button is pressed: `cfg` (the settings
// actually in use) is only replaced by render().
//
// Presets (see presets.js) only fill in the panel; they never render by
// themselves, so applying one goes through the same Render path as manual edits.

// ---- Model library ----
// Models shown in the dropdown. `texture` is optional. Files dropped onto the
// panel are appended here at runtime (as blob: URLs).
const library = [
  {
    id: "orchid",
    label: "Orchid",
    model: "assets/orchid-flower/source/Orchid_highpoly/Orchid_Highpoly.obj",
    texture: "assets/orchid-flower/source/Orchid_highpoly/Orchid_Highpoly.jpg",
  },
  {
    id: "figure",
    label: "Female figure",
    model: "assets/source/untitled.obj",
    texture: null,
  },
  {
    id: "bust",
    label: "Napoleon",
    model:
      "assets/napoleon/source/3D_MNK_A_810_Popiersie_Napoleona/3D_MNK_A_810_Popiersie_Napoleona.obj",
    texture:
      "assets/napoleon/source/3D_MNK_A_810_Popiersie_Napoleona/810_Diffuse.jpg",
  },
];
let uploadCount = 0;

// ---- Settings schema ----
// Drives both the defaults and the panel UI. `int` rounds the value; `min`/`max`
// clamp it when Render is pressed.
const SETTINGS = [
  { group: "Walkers" },
  {
    key: "numWalkers",
    label: "Number of walkers",
    type: "number",
    value: 10000,
    min: 1,
    max: 200000,
    step: 1000,
    int: true,
  },
  {
    key: "maxSteps",
    label: "Steps per walker",
    type: "number",
    value: 1,
    min: 1,
    max: 500,
    step: 1,
    int: true,
  },
  {
    key: "stepSize",
    label: "Step size",
    type: "number",
    value: 20,
    min: 0,
    max: 200,
    step: 1,
  },
  {
    key: "outwardBias",
    label: "Outward bias",
    type: "number",
    value: 0.9,
    min: 0,
    max: 5,
    step: 0.05,
  },
  { group: "Model" },
  { key: "modelId", label: "Model", type: "select", value: "orchid" },
  {
    key: "modelHeight",
    label: "Model height",
    type: "number",
    value: 500,
    min: 10,
    max: 5000,
    step: 10,
  },
  { group: "Colour" },
  {
    key: "useTextureColour",
    label: "Use texture colour",
    type: "bool",
    value: true,
  },
  {
    key: "textureSampleSize",
    label: "Texture sample size (px)",
    type: "number",
    value: 4096,
    min: 64,
    max: 8192,
    step: 64,
    int: true,
  },
  {
    key: "walkerColour",
    label: "Trail grey (no texture)",
    type: "number",
    value: 0,
    min: 0,
    max: 255,
    step: 1,
    int: true,
  },
  {
    key: "backgroundColour",
    label: "Background grey",
    type: "number",
    value: 255,
    min: 0,
    max: 255,
    step: 1,
    int: true,
  },
  { group: "Appearance" },
  {
    key: "animateGrowth",
    label: "Animate growth",
    type: "bool",
    value: true,
  },
  {
    key: "maxAlpha",
    label: "Max alpha",
    type: "number",
    value: 255,
    min: 0,
    max: 255,
    step: 1,
    int: true,
  },
  {
    key: "minAlpha",
    label: "Min alpha (far end)",
    type: "number",
    value: 0,
    min: 0,
    max: 255,
    step: 1,
    int: true,
  },
  {
    key: "fadeHeadroom",
    label: "Fade length (× walk reach)",
    type: "number",
    value: 1,
    min: 0.1,
    max: 10,
    step: 0.1,
  },
  {
    key: "walkerSize",
    label: "Stroke weight",
    type: "number",
    value: 1,
    min: 0.1,
    max: 20,
    step: 0.1,
  },
];

const PROGRESS_BAR_WIDTH = 300; // px, width of the loading bar

// ---- State ----
const fields = SETTINGS.filter((s) => s.key);
// Settings currently in effect. Only render() replaces this.
let cfg = Object.fromEntries(fields.map((s) => [s.key, s.value]));
let walkers = []; // one object per walker (see createWalkers)
let cloud = null; // GPU-ready storage for every trail segment (see createCloud)
let walkCursor = 0; // index of the next walker still to be walked
let growth = 0; // steps of the finished walk revealed so far (fractional)
let finished = false; // true once the walk is fully grown on screen
const WALK_BUDGET_MS = 12; // walking time per frame, leaves room to draw at 30fps+
const GROW_SECONDS = 4; // how long the whole walk takes to grow on screen
let rendering = false; // true while render() is loading / sampling
let progressTrack = null; // DOM elements of the loading bar
let progressBar = null;
// Panel DOM references
const inputs = {};
let renderButton = null;
let statusEl = null;
// Presets offered in the panel: built-ins (with any saved overwrites) plus
// the user's own, loaded from localStorage when available.
const presetStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked or not in a browser
  }
})();
let presetStore = presetStorage
  ? readPresetStore(presetStorage)
  : { overrides: {}, user: [] };
let presets = buildPresets(presetStore);
let appliedPresetId = null; // last preset applied, null after a reset
let presetSelect = null;
let presetPlaceholder = null; // the "Custom" / "<name> (modified)" option
// Caches so re-rendering doesn't reload unchanged assets
let modelCache = { path: null, geom: null };
let imageCache = { path: null, img: null }; // the full-size p5.Image
let textureCache = { key: null, tex: null }; // downscaled pixel data for sampling

// Small preview of the original model (bottom left). It only changes when
// render() swaps in new settings, like everything else.
const PREVIEW_SIZE = 220;
let previewGfx = null; // p5.Graphics (WEBGL) drawn into previewEl
let previewEl = null;
let previewLabel = null;
const preview = {
  geom: null,
  img: null,
  scale: 1,
  centre: [0, 0, 0],
  rotX: -0.2,
  rotY: 0.6,
};

async function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  drawingContext.canvas.addEventListener("wheel", onCanvasWheel, {
    passive: true,
  });
  buildPanel();
  buildPreview();
  // Dropping a file outside the drop box must not make the browser navigate to it.
  for (const ev of ["dragover", "drop"]) {
    window.addEventListener(ev, (e) => e.preventDefault());
  }
  await render();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ---- Settings panel ----

// Builds the fixed settings panel (styled in style.css) from SETTINGS.
function buildPanel() {
  const panel = document.createElement("div");
  panel.id = "settings-panel";

  const header = document.createElement("div");
  header.className = "panel-header";
  header.textContent = "Settings";
  panel.appendChild(header);

  const body = document.createElement("div");
  body.className = "panel-body";
  panel.appendChild(body);
  // Clicking the header collapses / expands the panel.
  header.addEventListener("click", () => panel.classList.toggle("collapsed"));

  buildPresetControls(body);

  for (const s of SETTINGS) {
    if (s.group) {
      const g = document.createElement("div");
      g.className = "panel-group";
      g.textContent = s.group;
      body.appendChild(g);
      continue;
    }
    const row = document.createElement("label");
    row.className = "panel-row";
    const text = document.createElement("span");
    text.textContent = s.label;
    let input;
    if (s.type === "select") {
      input = document.createElement("select");
      input.addEventListener("change", updateDirty);
    } else {
      input = document.createElement("input");
      if (s.type === "bool") {
        input.type = "checkbox";
        input.checked = s.value;
      } else {
        input.type = s.type === "number" ? "number" : "text";
        input.value = s.value;
        if (s.type === "number") {
          input.min = s.min;
          input.max = s.max;
          input.step = s.step;
        }
      }
      // Typing only marks the panel as having unapplied changes.
      input.addEventListener("input", updateDirty);
    }
    inputs[s.key] = input;
    row.append(text, input);
    body.appendChild(row);

    // The drop box sits directly under the model dropdown.
    if (s.type === "select") {
      refreshModelSelect(s.value);
      body.appendChild(buildDropZone());
    }
  }

  renderButton = document.createElement("button");
  renderButton.textContent = "Render";
  renderButton.addEventListener("click", render);
  statusEl = document.createElement("div");
  statusEl.className = "panel-status";
  body.append(renderButton, statusEl);

  // Keep panel interaction away from p5's window-level mouse handlers,
  // otherwise dragging or scrolling in the panel would orbit/zoom the model.
  for (const ev of ["mousedown", "pointerdown", "touchstart", "wheel"]) {
    panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  }
  document.body.appendChild(panel);
}

// Reads and validates the panel. Numbers are clamped / rounded and the cleaned
// values are written back to the inputs (when `writeBack`) so the panel always
// shows exactly what will be rendered. Empty/invalid numbers fall back to the
// value currently in effect.
function readPanel(writeBack) {
  const out = {};
  for (const s of fields) {
    const input = inputs[s.key];
    if (s.type === "bool") {
      out[s.key] = input.checked;
    } else if (s.type === "text" || s.type === "select") {
      out[s.key] = input.value.trim();
    } else {
      let n = parseFloat(input.value);
      if (!isFinite(n)) n = cfg[s.key];
      n = Math.min(s.max, Math.max(s.min, n));
      if (s.int) n = Math.round(n);
      out[s.key] = n;
      if (writeBack) input.value = n;
    }
  }
  return out;
}

// Highlights the Render button when the panel differs from what's on screen.
function updateDirty() {
  updatePresetIndicator();
  const next = readPanel(false);
  const dirty = fields.some((s) => next[s.key] !== cfg[s.key]);
  renderButton.classList.toggle("dirty", dirty);
  if (!rendering) setStatus(dirty ? "Unapplied changes" : "");
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// ---- Presets ----

// Preset dropdown (grouped) and a Reset to defaults button, at the top of the panel.
function buildPresetControls(body) {
  const g = document.createElement("div");
  g.className = "panel-group";
  g.textContent = "Presets";
  body.appendChild(g);

  const row = document.createElement("label");
  row.className = "panel-row";
  const text = document.createElement("span");
  text.textContent = "Preset";
  presetSelect = document.createElement("select");
  presetSelect.addEventListener("change", () => {
    if (presetSelect.value) applyPreset(presetSelect.value);
    else updatePresetIndicator(); // "Custom" is a status, not an action
  });
  row.append(text, presetSelect);
  body.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "panel-buttons";
  const save = document.createElement("button");
  save.textContent = "Save preset";
  save.addEventListener("click", saveNewPreset);
  const overwrite = document.createElement("button");
  overwrite.textContent = "Overwrite preset";
  overwrite.addEventListener("click", overwritePreset);
  actions.append(save, overwrite);
  body.appendChild(actions);

  const reset = document.createElement("button");
  reset.className = "secondary";
  reset.textContent = "Reset to defaults";
  reset.addEventListener("click", resetToDefaults);
  body.appendChild(reset);

  refreshPresetSelect();
}

// Rebuilds the dropdown from `presets`, grouped in order of first appearance.
function refreshPresetSelect() {
  presetPlaceholder = document.createElement("option");
  presetPlaceholder.value = "";
  const groups = new Map();
  for (const p of presets) {
    if (!groups.has(p.group)) {
      const el = document.createElement("optgroup");
      el.label = p.group;
      groups.set(p.group, el);
    }
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    groups.get(p.group).appendChild(opt);
  }
  presetSelect.replaceChildren(presetPlaceholder, ...groups.values());
  updatePresetIndicator();
}

// Shows the last applied preset only while the panel still matches it exactly;
// after manual edits it reads "<name> (modified)" instead.
function updatePresetIndicator() {
  if (!presetSelect) return;
  const applied = presets.find((p) => p.id === appliedPresetId);
  const exact = !!applied && settingsMatch(readPanel(false), applied);
  presetPlaceholder.textContent =
    applied && !exact ? `${applied.name} (modified)` : "Custom";
  presetSelect.value = exact ? applied.id : "";
}

// Writes values into the panel inputs (keys not in `values` are left alone).
function writePanel(values) {
  for (const s of fields) {
    if (!(s.key in values)) continue;
    const input = inputs[s.key];
    const v = values[s.key];
    if (s.type === "bool") input.checked = v;
    else if (s.type === "select") {
      // Never select a model that is not in the library (e.g. an unknown id).
      if (library.some((e) => e.id === v)) input.value = v;
    } else input.value = v;
  }
}

// Fills the panel from a preset. Nothing is rendered: press Render to apply it.
function applyPreset(id) {
  const preset = presets.find((p) => p.id === id);
  if (!preset) return;
  appliedPresetId = preset.id;
  writePanel(preset.settings);
  updateDirty();
}

// Restores the defaults declared in SETTINGS. Uploaded models stay in the library.
function resetToDefaults() {
  appliedPresetId = null;
  writePanel(Object.fromEntries(fields.map((s) => [s.key, s.value])));
  updateDirty();
}

// Validated panel values to store in a preset, or null (with a status message)
// when they can't be saved. Uploaded models are blob: URLs that don't survive a
// reload, so presets can only reference models from the built-in library.
function settingsToSave() {
  const values = readPanel(true);
  if (values.modelId.startsWith("upload-")) {
    setStatus("Presets can't use uploaded models");
    return null;
  }
  return pickSettings(values); // playback options like animateGrowth stay out
}

// Stores `presetStore` and rebuilds the list. Returns false if storage failed
// (the change then only lasts until the page is reloaded).
function commitPresetStore() {
  presets = buildPresets(presetStore);
  refreshPresetSelect();
  return !presetStorage || writePresetStore(presetStorage, presetStore);
}

// Saves the current panel as a new preset in the "My presets" group.
function saveNewPreset() {
  const values = settingsToSave();
  if (!values) return;
  const name = (prompt("Name for the new preset:") || "").trim();
  if (!name) return;
  if (presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    setStatus(`A preset named "${name}" already exists`);
    return;
  }
  const id = `user-${Date.now().toString(36)}-${presetStore.user.length}`;
  presetStore.user.push({ id, name, group: USER_GROUP, settings: values });
  appliedPresetId = id;
  const saved = commitPresetStore();
  updateDirty();
  setStatus(saved ? `Saved "${name}"` : `Saved "${name}" (not persisted)`);
}

// Replaces the last applied preset's settings with the current panel values.
// For a built-in preset only the override is stored; the original stays in code.
function overwritePreset() {
  const target = presets.find((p) => p.id === appliedPresetId);
  if (!target) {
    setStatus("Select a preset to overwrite first");
    return;
  }
  const values = settingsToSave();
  if (!values) return;
  if (!confirm(`Overwrite "${target.name}" with the current settings?`)) return;
  const user = presetStore.user.find((p) => p.id === target.id);
  if (user) user.settings = values;
  else presetStore.overrides[target.id] = values;
  const saved = commitPresetStore();
  updateDirty();
  setStatus(
    saved
      ? `Overwrote "${target.name}"`
      : `Overwrote "${target.name}" (not persisted)`,
  );
}

// ---- Rendering ----

// Applies the panel settings: loads assets if needed, samples new walkers and
// then swaps everything in at once. Until the swap the previous render (and its
// settings) stays on screen untouched.
async function render() {
  if (rendering) return;
  rendering = true;
  renderButton.disabled = true;
  const next = readPanel(true);
  try {
    const entry = library.find((e) => e.id === next.modelId);
    if (!entry) throw new Error("Unknown model");
    setStatus("Loading model…");
    const geom = await cachedModel(entry.model);
    // The texture is shown in the preview whenever the model has one, but is
    // only sampled for trail colours when "Use texture colour" is on.
    let img = null;
    let tex = null;
    if (entry.texture) {
      setStatus("Loading texture…");
      img = await cachedImage(entry.texture);
      if (next.useTextureColour) {
        tex = cachedTexture(entry.texture, img, next.textureSampleSize);
      }
    }
    setStatus("Sampling surface…");
    // Give the browser a moment to paint the status before the blocking work.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const newWalkers = createWalkers(geom, next, tex);
    const newCloud = createCloud(
      drawingContext,
      newWalkers.length,
      next.maxSteps,
    );

    // Atomic swap: settings, walkers, preview and trail storage change together.
    if (cloud) freeCloud(drawingContext, cloud);
    cfg = next;
    walkers = newWalkers;
    cloud = newCloud;
    walkCursor = 0;
    growth = 0;
    finished = false;
    removeProgressBar();
    setPreview(geom, img, entry.label);
    setStatus("Walking…");
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message || e}`);
  } finally {
    rendering = false;
    renderButton.disabled = false;
    renderButton.classList.remove("dirty");
    if (!statusEl.textContent.startsWith("Error")) updateDirtyStatusOnly();
  }
}

// After a render, don't overwrite the progress status unless edits are pending.
function updateDirtyStatusOnly() {
  const next = readPanel(false);
  if (fields.some((s) => next[s.key] !== cfg[s.key])) {
    renderButton.classList.add("dirty");
    setStatus("Unapplied changes");
  }
}

async function cachedModel(path) {
  if (modelCache.path !== path) {
    modelCache = { path, geom: await loadModel(path, ".obj", true) };
  }
  return modelCache.geom;
}

async function cachedImage(path) {
  if (imageCache.path !== path) {
    imageCache = { path, img: await loadImage(path) };
  }
  return imageCache.img;
}

// Downscaled pixel data used for sampling trail colours.
function cachedTexture(path, img, sampleSize) {
  const key = `${path}|${sampleSize}`;
  if (textureCache.key !== key) {
    textureCache = { key, tex: readTexture(img, sampleSize) };
  }
  return textureCache.tex;
}

// ---- Model dropdown and drop box ----

// Rebuilds the dropdown from `library`, keeping `selectedId` selected.
function refreshModelSelect(selectedId) {
  const select = inputs.modelId;
  select.replaceChildren(
    ...library.map((e) => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.label;
      return opt;
    }),
  );
  select.value = selectedId;
}

// A box that accepts .obj and image files, by dropping or by clicking to browse.
function buildDropZone() {
  const zone = document.createElement("div");
  zone.className = "drop-zone";
  zone.textContent =
    "Drop .obj model and/or texture image here, or click to browse";

  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.accept = ".obj,image/*";
  picker.style.display = "none";
  picker.addEventListener("change", () => {
    handleFiles(picker.files);
    picker.value = "";
  });
  zone.addEventListener("click", () => picker.click());

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    handleFiles(e.dataTransfer.files);
  });
  zone.appendChild(picker);
  return zone;
}

// Turns dropped files into a library entry and selects it. Nothing is rendered
// until the Render button is pressed.
//  - .obj (+ optional image): a new model entry
//  - image only: the currently selected model with that texture
function handleFiles(fileList) {
  const files = [...fileList];
  const obj = files.find((f) => /\.obj$/i.test(f.name));
  const image = files.find(
    (f) =>
      f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(f.name),
  );
  if (!obj && !image) {
    setStatus("Only .obj models and image textures are supported");
    return;
  }
  const base = library.find((e) => e.id === inputs.modelId.value);
  const entry = {
    id: `upload-${++uploadCount}`,
    label: obj ? `${obj.name} (uploaded)` : `${base.label} + ${image.name}`,
    model: obj ? URL.createObjectURL(obj) : base.model,
    texture: image ? URL.createObjectURL(image) : null,
  };
  library.push(entry);
  refreshModelSelect(entry.id);
  // A freshly supplied texture is almost certainly meant to be used.
  if (entry.texture) inputs.useTextureColour.checked = true;
  updateDirty();
}

// ---- Original-model preview ----

function buildPreview() {
  previewEl = document.createElement("div");
  previewEl.id = "model-preview";
  previewLabel = document.createElement("div");
  previewLabel.className = "preview-label";
  previewGfx = createGraphics(PREVIEW_SIZE, PREVIEW_SIZE, WEBGL);
  const cnv = previewGfx.canvas;
  cnv.style.cssText = `display:block;width:${PREVIEW_SIZE}px;height:${PREVIEW_SIZE}px;`;
  previewEl.append(cnv, previewLabel);

  // Drag inside the preview to rotate it. Events are kept from reaching p5's
  // window handlers so the main model doesn't orbit at the same time.
  let dragging = false;
  previewEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    previewEl.setPointerCapture(e.pointerId);
  });
  previewEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    preview.rotY += e.movementX * 0.01;
    preview.rotX = Math.max(
      -1.5,
      Math.min(1.5, preview.rotX + e.movementY * 0.01),
    );
    drawPreview();
  });
  const stop = () => (dragging = false);
  previewEl.addEventListener("pointerup", stop);
  previewEl.addEventListener("pointercancel", stop);
  for (const ev of ["mousedown", "pointerdown", "touchstart", "wheel"]) {
    previewEl.addEventListener(ev, (e) => e.stopPropagation(), {
      passive: true,
    });
  }
  document.body.appendChild(previewEl);
}

// Swaps in a new model/texture and redraws the preview once.
function setPreview(geom, img, label) {
  preview.geom = geom;
  preview.img = img;
  previewLabel.textContent = `Original: ${label}`;
  // Fit the model inside the window: centre on its bounding box and scale by
  // the largest extent.
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const p of geom.vertices) {
    if (p.x < lo[0]) lo[0] = p.x;
    if (p.y < lo[1]) lo[1] = p.y;
    if (p.z < lo[2]) lo[2] = p.z;
    if (p.x > hi[0]) hi[0] = p.x;
    if (p.y > hi[1]) hi[1] = p.y;
    if (p.z > hi[2]) hi[2] = p.z;
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  preview.scale = (PREVIEW_SIZE * 0.85) / extent;
  preview.centre = lo.map((l, i) => (l + hi[i]) / 2);
  drawPreview();
}

// Draws the preview model. Called only when it changes (new model, drag),
// not every frame, so it costs nothing while the main sketch is running.
function drawPreview() {
  const g = previewGfx;
  if (!preview.geom) return;
  g.clear();
  g.background(36);
  g.push();
  g.rotateX(preview.rotX);
  g.rotateY(preview.rotY);
  // The model's +Y is up but p5's WEBGL +Y is down, hence the flip.
  g.scale(preview.scale, -preview.scale, preview.scale);
  g.translate(-preview.centre[0], -preview.centre[1], -preview.centre[2]);
  g.noStroke();
  if (preview.img) {
    g.noLights();
    g.texture(preview.img);
  } else {
    g.ambientLight(110);
    g.directionalLight(255, 255, 255, 0.3, 0.6, -1);
    g.fill(210);
  }
  // p5.Graphics doesn't expose model() in p5 2.x; the renderer does.
  g._renderer.model(preview.geom);
  g.pop();
}

// Builds `count` walkers at random points on the model surface.
// Area-weighted sampling gives uniform coverage of the surface
// without needing to visit every vertex. `c` is the settings being applied
// (not `cfg`, which still holds the previous render until the swap).
function createWalkers(geom, c, tex) {
  const v = geom.vertices;
  const faces = geom.faces;
  const uvs = geom.uvs; // one [u, v] pair per vertex
  // Uploaded models may have no UV coordinates, in which case texture
  // sampling is impossible and trails use the plain trail colour.
  const hasUVs = Array.isArray(uvs) && uvs.length === v.length;

  // --- Normalise the model: centre it and scale to modelHeight ---
  // Find the vertical extent and the horizontal centre of the vertices.
  let minY = Infinity,
    maxY = -Infinity;
  let cx = 0,
    cz = 0;
  for (const p of v) {
    minY = min(minY, p.y);
    maxY = max(maxY, p.y);
    cx += p.x;
    cz += p.z;
  }
  cx /= v.length;
  cz /= v.length;
  const s = c.modelHeight / (maxY - minY); // uniform scale factor
  const cy = (minY + maxY) / 2; // vertical centre
  // T maps a model-space vertex into the centred, scaled space.
  const T = (p) => createVector((p.x - cx) * s, (p.y - cy) * s, (p.z - cz) * s);

  // --- Precompute triangles and a cumulative area table ---
  // `cumulative[i]` is the total area of triangles 0..i, so a random number
  // in [0, total) picks triangle i with probability proportional to its area.
  const tris = [];
  const cumulative = [];
  let total = 0;
  for (const f of faces) {
    const a = T(v[f[0]]),
      b = T(v[f[1]]),
      d = T(v[f[2]]);
    // Cross product magnitude = 2 * triangle area; direction = face normal.
    const n = p5.Vector.cross(p5.Vector.sub(b, a), p5.Vector.sub(d, a));
    total += n.mag() / 2;
    tris.push({ a, b, c: d, n: n.normalize(), f });
    cumulative.push(total);
  }

  // --- Sample one point per walker ---
  const out = [];
  for (let i = 0; i < c.numWalkers; i++) {
    // Binary search the cumulative table for the triangle containing `r`.
    const r = random(total);
    let lo = 0,
      hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];

    // Uniform random point in a triangle using barycentric coordinates (u, w).
    // If the point falls in the far half of the parallelogram (u + w > 1),
    // reflect it back into the triangle.
    let u = random(),
      w = random();
    if (u + w > 1) {
      u = 1 - u;
      w = 1 - w;
    }
    // point = a + u*(b - a) + w*(c - a)
    const pos = p5.Vector.add(
      t.a,
      p5.Vector.add(
        p5.Vector.mult(p5.Vector.sub(t.b, t.a), u),
        p5.Vector.mult(p5.Vector.sub(t.c, t.a), w),
      ),
    );
    out.push({
      ox: pos.x, // fixed start point, used for the alpha fade
      oy: pos.y,
      oz: pos.z,
      nx: t.n.x, // surface normal at the start, for the outward drift
      ny: t.n.y,
      nz: t.n.z,
      colour:
        tex && hasUVs
          ? sampleTexture(tex, uvs, t.f, u, w)
          : [c.walkerColour, c.walkerColour, c.walkerColour],
    });
  }
  return out;
}

// Returns the [r, g, b] texture colour at a point inside a triangle.
// The point is a + u*(b - a) + w*(c - a), so its UV is interpolated with the
// same barycentric weights: (1-u-w) for vertex a, u for b, w for c.
function sampleTexture(tex, uvs, f, u, w) {
  const wa = 1 - u - w;
  const U = wa * uvs[f[0]][0] + u * uvs[f[1]][0] + w * uvs[f[2]][0];
  const V = wa * uvs[f[0]][1] + u * uvs[f[1]][1] + w * uvs[f[2]][1];
  // Wrap UVs outside 0-1, then convert to pixel coordinates.
  const x = floor((((U % 1) + 1) % 1) * (tex.width - 1));
  const y = floor((((V % 1) + 1) % 1) * (tex.height - 1));
  const i = (y * tex.width + x) * 4;
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2]];
}

// Reads the whole texture into a plain pixel array once. Per-pixel get() calls
// on an 8192px image are far too slow. Downscaled to `sampleSize` max side.
function readTexture(img, sampleSize) {
  const scale = Math.min(1, sampleSize / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);
  const cnv = document.createElement("canvas");
  cnv.width = width;
  cnv.height = height;
  const ctx = cnv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img.canvas, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

// ---- Trail storage and walking ----
// Each segment is one GPU instance of 14 floats: start xyz, end xyz, start
// rgba and end rgba. Positions are stored unflipped; the shader flips y.
// Segments are ordered step by step (index = step × walkers + walker), so all
// the walkers' n-th steps sit together and can be revealed as one range.
const SEGMENT_FLOATS = 14;

// Allocates CPU and GPU storage for `walkerCount × maxSteps` segments.
function createCloud(gl, walkerCount, maxSteps) {
  const data = new Float32Array(walkerCount * maxSteps * SEGMENT_FLOATS);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return { data, buffer, walkerCount, maxSteps };
}

function freeCloud(gl, cloud) {
  gl.deleteBuffer(cloud.buffer);
}

// Walks one walker to completion, writing its segments into its column of the
// cloud. The walk is one call, so its reach is final before colours are set.
function walkInto(w, cloud, slot) {
  const d = cloud.data;
  const steps = cfg.maxSteps;
  const s = cfg.stepSize;
  const push = s * cfg.outwardBias;
  const { ox, oy, oz, nx, ny, nz } = w;
  const stride = cloud.walkerCount * SEGMENT_FLOATS;
  let x = ox,
    y = oy,
    z = oz;
  let reach = 0;
  let o = slot * SEGMENT_FLOATS;
  for (let j = 0; j < steps; j++, o += stride) {
    // Uniform random direction on the sphere, scaled to the step length...
    const dz = Math.random() * 2 - 1;
    const theta = Math.random() * TWO_PI;
    const r = Math.sqrt(1 - dz * dz);
    // ...plus a small push along the surface normal so the cloud thickens
    // outward instead of diffusing back into the body.
    const px = x + r * Math.cos(theta) * s + nx * push;
    const py = y + r * Math.sin(theta) * s + ny * push;
    const pz = z + dz * s + nz * push;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = px;
    d[o + 4] = py;
    d[o + 5] = pz;
    reach = Math.max(reach, Math.hypot(px - ox, py - oy, pz - oz));
    x = px;
    y = py;
    z = pz;
  }
  shadeSegments(w, d, slot, steps, cloud.walkerCount, reach);
}

// Sets colour and alpha at both ends of each of a walker's segments. Alpha is
// maxAlpha at the walker's origin, falling linearly to minAlpha at its fade
// distance (reach × fadeHeadroom), then holding there. `first` is the walker's
// first segment and `stride` the number of segments between its steps.
function shadeSegments(w, d, first, count, stride, reach) {
  const fade = Math.max(reach * cfg.fadeHeadroom, 1e-6);
  const lo = Math.min(cfg.minAlpha, cfg.maxAlpha);
  const [r, g, b] = w.colour.map((c) => c / 255);
  const { ox, oy, oz } = w;
  const step = stride * SEGMENT_FLOATS;
  let o = first * SEGMENT_FLOATS;
  for (let j = 0; j < count; j++, o += step) {
    const dStart = Math.hypot(d[o] - ox, d[o + 1] - oy, d[o + 2] - oz);
    const dEnd = Math.hypot(d[o + 3] - ox, d[o + 4] - oy, d[o + 5] - oz);
    const aStart = lerpAlpha(cfg.maxAlpha, lo, Math.min(dStart / fade, 1));
    const aEnd = lerpAlpha(cfg.maxAlpha, lo, Math.min(dEnd / fade, 1));
    d[o + 6] = r;
    d[o + 7] = g;
    d[o + 8] = b;
    d[o + 9] = aStart;
    d[o + 10] = r;
    d[o + 11] = g;
    d[o + 12] = b;
    d[o + 13] = aEnd;
  }
}

// Alpha in 0-1 at fraction `t` between `from` and `to` (both 0-255).
function lerpAlpha(from, to, t) {
  return (from + (to - from) * t) / 255;
}

// ---- Trail renderer ----
// Each segment is drawn as a screen-space quad, so strokeWeight stays in
// pixels like p5's own strokes. Built on the raw WebGL2 context that p5 uses.
const TRAIL_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
in vec3 aStart;
in vec3 aEnd;
in vec4 aColStart;
in vec4 aColEnd;
uniform mat4 uModelView;
uniform mat4 uProjection;
uniform vec2 uHalfViewport;
uniform float uHalfWidth;
uniform float uGrow; // 0-1: how far each segment in this draw has extended
out vec4 vColour;
void main() {
  // A growing segment extends from its start towards its end.
  vec3 end = mix(aStart, aEnd, uGrow);
  vec4 a = uProjection * uModelView * vec4(aStart * vec3(1.0, -1.0, 1.0), 1.0);
  vec4 b = uProjection * uModelView * vec4(end * vec3(1.0, -1.0, 1.0), 1.0);
  // Segment direction and its perpendicular, measured in pixels.
  vec2 dir = (b.xy / b.w - a.xy / a.w) * uHalfViewport;
  float len = length(dir);
  vec2 perp = len > 1e-6 ? vec2(-dir.y, dir.x) / len : vec2(0.0);
  vec4 p = mix(a, b, aCorner.x);
  vec2 offset = perp * aCorner.y * uHalfWidth / uHalfViewport;
  gl_Position = vec4(p.xy + offset * p.w, p.z, p.w);
  vColour = mix(aColStart, aColEnd, aCorner.x * uGrow);
}`;

const TRAIL_FS = `#version 300 es
precision highp float;
in vec4 vColour;
out vec4 outColor;
void main() {
  // Premultiplied, to match p5's BLEND mode.
  outColor = vec4(vColour.rgb * vColour.a, vColour.a);
}`;

let trailGL = null; // compiled program and static quad corners, made on first use

function linkProgram(gl, vsSource, fsSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return program;
}

function trailRenderer(gl) {
  if (trailGL && trailGL.gl === gl) return trailGL;
  const program = linkProgram(gl, TRAIL_VS, TRAIL_FS);
  // Six corners per segment: (t, side). t runs start→end, side is -1/+1 across it.
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const attr = (name) => gl.getAttribLocation(program, name);
  const uni = (name) => gl.getUniformLocation(program, name);
  trailGL = {
    gl,
    program,
    corners,
    aCorner: attr("aCorner"),
    aStart: attr("aStart"),
    aEnd: attr("aEnd"),
    aColStart: attr("aColStart"),
    aColEnd: attr("aColEnd"),
    uModelView: uni("uModelView"),
    uProjection: uni("uProjection"),
    uHalfViewport: uni("uHalfViewport"),
    uHalfWidth: uni("uHalfWidth"),
    uGrow: uni("uGrow"),
  };
  return trailGL;
}

// Copies every generated segment to the GPU buffer, in chunks to keep each
// call a sensible size.
function uploadCloud(cloud) {
  const gl = drawingContext;
  const chunk = 4 * 1024 * 1024; // floats per call
  gl.bindBuffer(gl.ARRAY_BUFFER, cloud.buffer);
  for (let from = 0; from < cloud.data.length; from += chunk) {
    const count = Math.min(chunk, cloud.data.length - from);
    gl.bufferSubData(gl.ARRAY_BUFFER, from * 4, cloud.data, from, count);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

// Draws the cloud grown to `growth` steps (0 to maxSteps, fractional). Whole
// steps are drawn in full; the step in progress is drawn partly extended. The
// camera matrices are the same ones p5 uses for its own geometry, so the
// trails orbit and zoom with the model.
function drawCloud(cloud, growth) {
  const whole = Math.min(Math.floor(growth), cloud.maxSteps);
  const partial = whole < cloud.maxSteps ? growth - whole : 0;
  if (!whole && !partial) return;
  const gl = drawingContext;
  const r = trailRenderer(gl);
  const st = p5.instance._renderer.states;
  const modelView = st.uModelMatrix.copy().mult(st.uViewMatrix);

  gl.useProgram(r.program);
  gl.uniformMatrix4fv(r.uModelView, false, modelView.mat4);
  gl.uniformMatrix4fv(r.uProjection, false, st.uPMatrix.mat4);
  gl.uniform2f(r.uHalfViewport, width / 2, height / 2);
  gl.uniform1f(r.uHalfWidth, cfg.walkerSize / 2);

  gl.bindBuffer(gl.ARRAY_BUFFER, r.corners);
  gl.enableVertexAttribArray(r.aCorner);
  gl.vertexAttribPointer(r.aCorner, 2, gl.FLOAT, false, 0, 0);

  const stride = SEGMENT_FLOATS * 4;
  const instanced = [
    [r.aStart, 3, 0],
    [r.aEnd, 3, 12],
    [r.aColStart, 4, 24],
    [r.aColEnd, 4, 40],
  ];
  gl.bindBuffer(gl.ARRAY_BUFFER, cloud.buffer);
  for (const [loc] of instanced) gl.enableVertexAttribArray(loc);

  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // Draws `count` segments from segment `first` (WebGL2 has no base instance,
  // so the attribute pointers are offset instead).
  const drawRange = (first, count, grow) => {
    for (const [loc, size, offset] of instanced) {
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset + first * stride);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.uniform1f(r.uGrow, grow);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  };
  if (whole) drawRange(0, whole * cloud.walkerCount, 1);
  if (partial) drawRange(whole * cloud.walkerCount, cloud.walkerCount, partial);

  // Put the attribute state back the way p5 left it.
  for (const [loc] of instanced) {
    gl.vertexAttribDivisor(loc, 0);
    gl.disableVertexAttribArray(loc);
  }
  gl.disableVertexAttribArray(r.aCorner);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.useProgram(null);
}

// Wheel zoom. p5's own zoom adds a fixed kick per wheel event regardless of its
// size, which overshoots on trackpads and fast wheels. Instead the wheel deltas
// are summed in proportion to their size, and the camera eases toward that
// target. Touch pinch zoom is still handled by orbitControl().
const ZOOM_PER_PIXEL = 0.0006; // log10 of camera distance per wheel pixel
const ZOOM_MAX_EVENT = 200; // caps one event, so a hard flick can't jump
const ZOOM_EASE_MS = 90; // smoothing time constant
let zoomRemaining = 0; // log10 distance change still to apply

function onCanvasWheel(e) {
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1;
  const delta = Math.max(-ZOOM_MAX_EVENT, Math.min(ZOOM_MAX_EVENT, e.deltaY * unit));
  zoomRemaining += delta * ZOOM_PER_PIXEL;
}

function easeZoom() {
  if (Math.abs(zoomRemaining) < 1e-4) {
    zoomRemaining = 0;
    return;
  }
  const dt = Math.min(deltaTime, 100);
  const step = zoomRemaining * (1 - Math.exp(-dt / ZOOM_EASE_MS));
  zoomRemaining -= step;
  p5.instance._renderer.states.curCamera._orbit(0, 0, step);
}

// orbitControl() pans on the right button only. With shift held, a left drag is
// presented to it as a right drag, so shift+drag pans instead of rotating.
function orbitOrPan() {
  const p = p5.instance;
  p._mouseWheelDeltaY = 0; // wheel zoom is handled by easeZoom()
  easeZoom();
  const real = p.mouseButton;
  if (p.mouseIsPressed && keyIsDown(SHIFT) && real && real.left) {
    p.mouseButton = { left: false, right: true, center: false };
    orbitControl();
    p.mouseButton = real;
  } else {
    orbitControl();
  }
}

function draw() {
  background(cfg.backgroundColour);
  orbitOrPan(); // mouse orbit / zoom; right-drag or shift+drag pans
  // rotateY(frameCount * 0.003); // slow automatic turntable rotation
  if (!walkers.length) return; // model still loading

  // Phase 1: walk every walker (within the per-frame budget, so the page stays
  // responsive) while the progress bar fills. Phase 2: grow the finished walk
  // on screen one step at a time, so the structure builds up.
  if (!finished) {
    if (walkCursor < walkers.length) {
      const deadline = performance.now() + WALK_BUDGET_MS;
      while (walkCursor < walkers.length && performance.now() < deadline) {
        walkInto(walkers[walkCursor], cloud, walkCursor);
        walkCursor++;
      }
      updateProgressBar(walkCursor / walkers.length);
      if (walkCursor >= walkers.length) {
        removeProgressBar();
        uploadCloud(cloud);
      }
    } else {
      // Clamp the frame time so a hitch doesn't skip part of the growth. With
      // animation off the whole walk is shown at once.
      const dt = Math.min(deltaTime, 100) / 1000;
      growth = cfg.animateGrowth
        ? growth + (dt * cfg.maxSteps) / GROW_SECONDS
        : cfg.maxSteps;
      if (growth >= cfg.maxSteps) {
        growth = cfg.maxSteps;
        finished = true;
        if (!rendering) setStatus("Done");
      }
    }
  }
  drawCloud(cloud, growth);
}

// ---- Progress bar ----
// An HTML overlay fixed to the bottom centre of the window (the canvas is
// full-window), created lazily and removed once walking is finished.
function updateProgressBar(fraction) {
  if (!progressBar) {
    progressTrack = document.createElement("div");
    progressTrack.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
      `width:${PROGRESS_BAR_WIDTH}px;height:8px;border-radius:4px;` +
      "background:rgba(128,128,128,0.3);overflow:hidden;pointer-events:none;";
    progressBar = document.createElement("div");
    progressBar.style.cssText =
      "height:100%;width:0%;background:rgb(128,128,128);";
    progressTrack.appendChild(progressBar);
    document.body.appendChild(progressTrack);
  }
  progressBar.style.width = `${constrain(fraction, 0, 1) * 100}%`;
}

function removeProgressBar() {
  if (progressTrack) progressTrack.remove();
  progressTrack = progressBar = null;
}
