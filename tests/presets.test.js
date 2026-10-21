// Run with: npm test  (Node's built-in test runner, no dependencies)
//
// presets.js is tested directly. The panel behaviour is tested by loading the
// real sketch.js into a vm context with a tiny fake DOM and building the real
// panel, so the same code that runs in the browser is exercised. Nothing here
// needs p5, and render() itself is not run: the values it would use are read
// with readPanel(), exactly as render() does.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const presetsApi = require("../presets.js");
const { PRESET_KEYS, BUILTIN_PRESETS, validatePreset } = presetsApi;

// Independent copy of the specification, so a typo in presets.js is caught.
const common = {
  modelHeight: 500,
  useTextureColour: true,
  textureSampleSize: 4096,
  walkerColour: 0,
  backgroundColour: 255,
  minAlpha: 0,
  walkerSize: 1,
};
const SPEC = [
  ["Orchid — Dense, Fine Trails", "orchid", 200000, 2, 30, 0.1, 255, 1.4],
  ["Orchid — Long Steps", "orchid", 200000, 1, 40, 0.6, 255, 1.4],
  ["Orchid — Compact Cluster", "orchid", 200000, 5, 10, 0.6, 255, 1.4],
  ["Orchid — Tight Outward Bias", "orchid", 200000, 5, 10, 0.05, 255, 1.4],
  ["Figure — Dense Cloud", "figure", 4000, 20, 20, 0.05, 50, 1.1],
  ["Figure — Fine Diffusion", "figure", 2000, 100, 8, 0.05, 50, 1.1],
  ["Figure — Expanded Diffusion", "figure", 2000, 100, 8, 0.1, 50, 1.1],
  ["Figure — Branching Form", "figure", 2000, 4, 20, 0.2, 120, 1.2],
  ["Figure — Wide Branching Form", "figure", 2000, 4, 20, 0.9, 120, 1.2],
  ["Figure — Sparse Branching", "figure", 800, 20, 3, 0.9, 90, 1.2],
].map(([name, modelId, numWalkers, maxSteps, stepSize, outwardBias, maxAlpha, fadeHeadroom]) => ({
  name,
  settings: { ...common, modelId, numWalkers, maxSteps, stepSize, outwardBias, maxAlpha, fadeHeadroom },
}));

// ---- Fake DOM and sketch loader ----

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.checked = false;
    this._value = "";
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    };
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  append(...c) {
    this.children.push(...c);
  }
  replaceChildren(...c) {
    this.children = c;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {} });
  }
  options() {
    return this.children.flatMap((c) => (c.tagName === "optgroup" ? c.children : [c]));
  }
  get value() {
    return this._value;
  }
  // Like a real <select>: only an existing option can be selected.
  set value(v) {
    this._value =
      this.tagName === "select" && !this.options().some((o) => o.value === String(v))
        ? ""
        : String(v);
  }
}

// Playback options such as animateGrowth are panel settings but not part of a preset.
const pickPresetKeys = (values) => Object.fromEntries(PRESET_KEYS.map((k) => [k, values[k]]));

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

function loadSketch({ storage = fakeStorage(), answers = {} } = {}) {
  const body = new El("body");
  const ctx = vm.createContext({
    console,
    document: { createElement: (t) => new El(t), body },
    URL: { createObjectURL: (f) => `blob:${f.name}` },
    window: { localStorage: storage },
    prompt: () => answers.prompt,
    confirm: () => answers.confirm ?? true,
  });
  for (const file of ["presets.js", "sketch.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, { filename: file });
  }
  const run = (code) => vm.runInContext(code, ctx);
  const json = (code) => JSON.parse(run(`JSON.stringify(${code})`));
  run("buildPanel()");
  return {
    run,
    json,
    storage,
    answers,
    inputs: run("inputs"),
    presetSelect: run("presetSelect"),
    renderButton: run("renderButton"),
    placeholder: () => run("presetPlaceholder"),
    status: () => run("statusEl").textContent,
    // Values the next render would use.
    panel: () => pickPresetKeys(json("readPanel(false)")),
    cfg: () => json("cfg"),
    select(id) {
      const el = run("presetSelect");
      el.value = id;
      el.fire("change");
    },
    edit(key, value) {
      const el = run("inputs")[key];
      el.value = String(value);
      el.fire("input");
    },
  };
}

const byName = (name) => BUILTIN_PRESETS.find((p) => p.name === name);

// ---- Registry ----

test("registers the ten built-in presets with unique ids and readable names", () => {
  assert.equal(BUILTIN_PRESETS.length, 10);
  assert.equal(new Set(BUILTIN_PRESETS.map((p) => p.id)).size, 10);
  assert.equal(new Set(BUILTIN_PRESETS.map((p) => p.name)).size, 10);
  for (const p of BUILTIN_PRESETS) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    assert.ok(p.name.trim().length > 3, p.id);
  }
  assert.deepEqual(
    BUILTIN_PRESETS.map((p) => p.name),
    SPEC.map((s) => s.name),
  );
});

test("every preset defines exactly the required settings", () => {
  for (const p of BUILTIN_PRESETS) {
    assert.deepEqual(validatePreset(p), [], p.name);
    assert.deepEqual(Object.keys(p.settings).sort(), [...PRESET_KEYS].sort(), p.name);
  }
  assert.ok(validatePreset({ id: "x", name: "X", group: "G", settings: {} }).length > 0);
  const extra = { id: "x", name: "X", group: "G", settings: { ...BUILTIN_PRESETS[0].settings, bogus: 1 } };
  assert.deepEqual(validatePreset(extra), ["unknown setting bogus"]);
});

test("preset values match the specification", () => {
  for (const spec of SPEC) {
    assert.deepEqual({ ...byName(spec.name).settings }, spec.settings, spec.name);
  }
});

test("preset schema agrees with the SETTINGS schema in sketch.js", () => {
  const { json } = loadSketch();
  const settings = json("SETTINGS.filter((s) => s.key && s.key !== 'animateGrowth')");
  assert.deepEqual(settings.map((s) => s.key), PRESET_KEYS);
  const libraryIds = json("library.map((e) => e.id)");
  for (const p of BUILTIN_PRESETS) {
    for (const s of settings) {
      const v = p.settings[s.key];
      if (s.type === "bool") assert.equal(typeof v, "boolean", `${p.id}.${s.key}`);
      else if (s.type === "select") assert.ok(libraryIds.includes(v), `${p.id}.${s.key}`);
      else {
        assert.equal(typeof v, "number", `${p.id}.${s.key}`);
        assert.ok(v >= s.min && v <= s.max, `${p.id}.${s.key} within range`);
        if (s.int) assert.ok(Number.isInteger(v), `${p.id}.${s.key} is an integer`);
      }
    }
  }
});

// ---- Panel behaviour ----

test("the panel offers the presets grouped as Orchid and Female figure", () => {
  const { presetSelect } = loadSketch();
  const groups = presetSelect.children.filter((c) => c.tagName === "optgroup");
  assert.deepEqual(groups.map((g) => g.label), ["Orchid", "Female figure"]);
  assert.deepEqual(groups.map((g) => g.children.length), [4, 6]);
  assert.equal(presetSelect.value, "");
});

test("applying each preset populates every control and the values the renderer reads", () => {
  const app = loadSketch();
  const before = app.cfg();
  for (const p of BUILTIN_PRESETS) {
    app.select(p.id);
    for (const key of PRESET_KEYS) {
      const el = app.inputs[key];
      const expected = p.settings[key];
      if (typeof expected === "boolean") assert.equal(el.checked, expected, `${p.id}.${key}`);
      else assert.equal(el.value, String(expected), `${p.id}.${key}`);
    }
    assert.deepEqual(app.panel(), { ...p.settings }, p.id);
    assert.equal(app.presetSelect.value, p.id);
    assert.equal(app.placeholder().textContent, "Custom");
  }
  // Selecting a preset must not render: the settings in effect are unchanged.
  assert.deepEqual(app.cfg(), before);
});

test("applying a preset marks the panel as having unapplied changes", () => {
  const app = loadSketch();
  app.select("figure-dense-cloud");
  assert.ok(app.renderButton.classList.contains("dirty"));
});

test("controls stay editable and the preset is shown as modified, not exact", () => {
  const app = loadSketch();
  const p = byName("Orchid — Long Steps");
  app.select(p.id);
  app.edit("stepSize", 33);
  assert.equal(app.panel().stepSize, 33);
  assert.equal(app.panel().numWalkers, 200000);
  assert.equal(app.presetSelect.value, "");
  assert.equal(app.placeholder().textContent, `${p.name} (modified)`);
  // Editing back to the preset's value restores the exact-match label.
  app.edit("stepSize", p.settings.stepSize);
  assert.equal(app.presetSelect.value, p.id);
  assert.equal(app.placeholder().textContent, "Custom");
});

test("toggling texture colour and appearance edits survive and are flagged", () => {
  const app = loadSketch();
  app.select("orchid-dense-fine");
  app.inputs.useTextureColour.checked = false;
  app.inputs.useTextureColour.fire("input");
  assert.equal(app.panel().useTextureColour, false);
  assert.match(app.placeholder().textContent, /\(modified\)$/);
  app.edit("maxAlpha", 10);
  assert.equal(app.panel().maxAlpha, 10);
});

test("switching presets repeatedly leaves no stale values", () => {
  const app = loadSketch();
  const order = [0, 4, 9, 1, 5, 5, 8, 2, 4, 3, 7, 6, 0, 9];
  for (const i of order) {
    const p = BUILTIN_PRESETS[i];
    app.edit("numWalkers", 123); // a manual edit before each switch
    app.edit("walkerSize", 7);
    app.select(p.id);
    assert.deepEqual(app.panel(), { ...p.settings }, p.id);
  }
});

test("model selection uses the library ids, and uploaded models are preserved", () => {
  const app = loadSketch();
  app.select("figure-sparse-branching");
  assert.equal(app.inputs.modelId.value, "figure");
  app.select("orchid-long-steps");
  assert.equal(app.inputs.modelId.value, "orchid");

  app.run("handleFiles")([{ name: "thing.obj", type: "" }]);
  const uploadedId = app.inputs.modelId.value;
  assert.match(uploadedId, /^upload-/);
  const libraryBefore = app.json("library.map((e) => e.id)");

  app.select("figure-dense-cloud");
  assert.equal(app.inputs.modelId.value, "figure");
  assert.deepEqual(app.json("library.map((e) => e.id)"), libraryBefore);
  assert.ok(app.inputs.modelId.options().some((o) => o.value === uploadedId));
  // The uploaded model can still be chosen afterwards; the preset is then modified.
  app.inputs.modelId.value = uploadedId;
  app.inputs.modelId.fire("change");
  assert.equal(app.panel().modelId, uploadedId);
  assert.match(app.placeholder().textContent, /\(modified\)$/);
});

test("Reset to defaults restores the SETTINGS defaults", () => {
  const app = loadSketch();
  app.select("orchid-compact-cluster");
  app.run("resetToDefaults()");
  const defaults = pickPresetKeys(app.json("Object.fromEntries(fields.map((s) => [s.key, s.value]))"));
  assert.deepEqual(app.panel(), defaults);
  assert.equal(app.presetSelect.value, "");
  assert.equal(app.placeholder().textContent, "Custom");
});

test("user presets can be appended without changing the UI code", () => {
  const app = loadSketch();
  const custom = {
    id: "mine-1",
    name: "My preset",
    group: "My presets",
    settings: { ...BUILTIN_PRESETS[0].settings, numWalkers: 42 },
  };
  assert.deepEqual(validatePreset(custom), []);
  app.run("presets").push(custom);
  app.run("refreshPresetSelect()");
  const groups = app.run("presetSelect").children.filter((c) => c.tagName === "optgroup");
  assert.deepEqual(groups.map((g) => g.label), ["Orchid", "Female figure", "My presets"]);
  app.select("mine-1");
  assert.equal(app.panel().numWalkers, 42);
  assert.equal(app.presetSelect.value, "mine-1");
});

// ---- Save / overwrite / persistence ----

test("progress bar width is no longer a setting", () => {
  const app = loadSketch();
  assert.ok(!PRESET_KEYS.includes("progressBarWidth"));
  assert.ok(!("progressBarWidth" in app.inputs));
  assert.ok(!("progressBarWidth" in app.panel()));
});

test("Save preset stores the panel as a new preset, selected and persisted", () => {
  const app = loadSketch({ answers: { prompt: "  My look " } });
  app.select("orchid-long-steps");
  app.edit("stepSize", 77);
  app.run("saveNewPreset()");
  const saved = app.json("presets").find((p) => p.name === "My look");
  assert.ok(saved);
  assert.equal(saved.group, "My presets");
  assert.equal(saved.settings.stepSize, 77);
  assert.deepEqual(saved.settings, app.panel());
  // Selected as an exact match, listed under its own group.
  assert.equal(app.presetSelect.value, saved.id);
  const groups = app.presetSelect.children.filter((c) => c.tagName === "optgroup");
  assert.deepEqual(groups.map((g) => g.label), ["Orchid", "Female figure", "My presets"]);
  // The original preset is untouched.
  assert.equal(byName("Orchid — Long Steps").settings.stepSize, 40);
  // It survives a reload.
  const again = loadSketch({ storage: app.storage });
  again.select(saved.id);
  assert.deepEqual(again.panel(), saved.settings);
});

test("Save preset rejects empty, cancelled, duplicate and uploaded-model saves", () => {
  const app = loadSketch({ answers: { prompt: "" } });
  app.run("saveNewPreset()");
  assert.equal(app.json("presets").length, 10);
  app.answers.prompt = "orchid — long steps";
  app.run("saveNewPreset()");
  assert.equal(app.json("presets").length, 10);
  assert.match(app.status(), /already exists/);
  app.run("handleFiles")([{ name: "x.obj", type: "" }]);
  app.answers.prompt = "Uploaded";
  app.run("saveNewPreset()");
  assert.equal(app.json("presets").length, 10);
  assert.match(app.status(), /uploaded models/);
});

test("Overwrite preset replaces a built-in's settings and persists the change", () => {
  const app = loadSketch();
  const p = byName("Figure — Dense Cloud");
  app.select(p.id);
  app.edit("numWalkers", 1234);
  app.edit("maxAlpha", 99);
  assert.match(app.placeholder().textContent, /\(modified\)$/);
  app.run("overwritePreset()");
  const now = app.json("presets").find((x) => x.id === p.id);
  assert.equal(now.settings.numWalkers, 1234);
  assert.equal(now.settings.maxAlpha, 99);
  // Now an exact match again, and other presets are untouched.
  assert.equal(app.presetSelect.value, p.id);
  assert.deepEqual(app.json("presets").find((x) => x.id === "figure-fine-diffusion").settings, { ...byName("Figure — Fine Diffusion").settings });
  // The code-defined original is not mutated, but the override is what loads.
  assert.equal(p.settings.numWalkers, 4000);
  const again = loadSketch({ storage: app.storage });
  again.select(p.id);
  assert.equal(again.panel().numWalkers, 1234);
  assert.equal(again.json("presets").length, 10);
});

test("Overwrite preset updates user presets and can be repeated", () => {
  const app = loadSketch({ answers: { prompt: "Mine" } });
  app.run("saveNewPreset()");
  const id = app.presetSelect.value;
  app.edit("stepSize", 5);
  app.run("overwritePreset()");
  app.edit("stepSize", 6);
  app.run("overwritePreset()");
  const mine = app.json("presets").filter((p) => p.id === id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].settings.stepSize, 6);
  assert.equal(app.json("presetStore.user").length, 1);
});

test("Overwrite preset needs a selected preset and honours a cancelled confirm", () => {
  const app = loadSketch();
  app.edit("stepSize", 9);
  app.run("overwritePreset()");
  assert.match(app.status(), /Select a preset/);
  assert.deepEqual(app.json("presetStore"), { overrides: {}, user: [] });
  app.select("orchid-long-steps");
  app.edit("stepSize", 9);
  app.answers.confirm = false;
  app.run("overwritePreset()");
  assert.deepEqual(app.json("presetStore"), { overrides: {}, user: [] });
});

test("corrupt or outdated stored presets are ignored", () => {
  const { PRESET_STORAGE_KEY } = presetsApi;
  const good = { ...BUILTIN_PRESETS[0].settings, numWalkers: 5 };
  const stale = { ...good };
  delete stale.walkerSize; // missing a required key
  const storage = fakeStorage({
    [PRESET_STORAGE_KEY]: JSON.stringify({
      overrides: { "orchid-long-steps": good, "figure-dense-cloud": stale },
      user: [{ id: "u1", name: "Bad", settings: stale }, { id: "u2", name: "Ok", settings: { ...good, progressBarWidth: 300 } }],
    }),
  });
  const app = loadSketch({ storage });
  const list = app.json("presets");
  assert.equal(list.find((p) => p.id === "orchid-long-steps").settings.numWalkers, 5);
  assert.equal(list.find((p) => p.id === "figure-dense-cloud").settings.numWalkers, 4000);
  assert.deepEqual(list.slice(10).map((p) => p.id), ["u2"]);
  assert.ok(!("progressBarWidth" in list[10].settings));
  // Unreadable JSON falls back to the built-ins.
  const broken = loadSketch({ storage: fakeStorage({ [PRESET_STORAGE_KEY]: "{nope" }) });
  assert.equal(broken.json("presets").length, 10);
  // No storage at all also works.
  const none = loadSketch({ storage: null });
  assert.equal(none.json("presets").length, 10);
});
