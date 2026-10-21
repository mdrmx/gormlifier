// Render presets: named, complete sets of panel settings.
//
// This file holds data and pure helpers only (no DOM, no p5), so it can be
// loaded by index.html before sketch.js and tested on its own with Node.
//
// A preset is { id, name, group, settings }. `settings` must contain exactly
// one value for every key in PRESET_KEYS, using the same ids and value types as
// the SETTINGS schema in sketch.js (e.g. modelId is a library id such as
// "orchid", not the label shown in the dropdown). User-created presets can be
// appended to the list the sketch keeps, using the same shape.

// Every configurable rendering parameter, in panel order. sketch.js's
// SETTINGS must define exactly these keys (checked by the tests).
const PRESET_KEYS = [
  "numWalkers",
  "maxSteps",
  "stepSize",
  "outwardBias",
  "modelId",
  "modelHeight",
  "useTextureColour",
  "textureSampleSize",
  "walkerColour",
  "backgroundColour",
  "maxAlpha",
  "minAlpha",
  "fadeHeadroom",
  "walkerSize",
  "progressBarWidth",
];

// Values shared by all built-in presets.
const BUILTIN_COMMON = {
  modelHeight: 500,
  useTextureColour: true,
  textureSampleSize: 4096,
  walkerColour: 0,
  backgroundColour: 255,
  minAlpha: 0,
  walkerSize: 1,
  progressBarWidth: 300,
};

function builtinPreset(id, name, modelId, group, vary) {
  const [numWalkers, maxSteps, stepSize, outwardBias, maxAlpha, fadeHeadroom] =
    vary;
  return Object.freeze({
    id,
    name,
    group,
    settings: Object.freeze({
      ...BUILTIN_COMMON,
      modelId,
      numWalkers,
      maxSteps,
      stepSize,
      outwardBias,
      maxAlpha,
      fadeHeadroom,
    }),
  });
}

// Per-preset values: [walkers, steps, step size, outward bias, max alpha, fade].
const BUILTIN_PRESETS = Object.freeze([
  builtinPreset("orchid-dense-fine", "Orchid — Dense, Fine Trails", "orchid", "Orchid", [200000, 2, 30, 0.1, 255, 1.4]),
  builtinPreset("orchid-long-steps", "Orchid — Long Steps", "orchid", "Orchid", [200000, 1, 40, 0.6, 255, 1.4]),
  builtinPreset("orchid-compact-cluster", "Orchid — Compact Cluster", "orchid", "Orchid", [200000, 5, 10, 0.6, 255, 1.4]),
  builtinPreset("orchid-tight-outward-bias", "Orchid — Tight Outward Bias", "orchid", "Orchid", [200000, 5, 10, 0.05, 255, 1.4]),
  builtinPreset("figure-dense-cloud", "Figure — Dense Cloud", "figure", "Female figure", [4000, 20, 20, 0.05, 50, 1.1]),
  builtinPreset("figure-fine-diffusion", "Figure — Fine Diffusion", "figure", "Female figure", [2000, 100, 8, 0.05, 50, 1.1]),
  builtinPreset("figure-expanded-diffusion", "Figure — Expanded Diffusion", "figure", "Female figure", [2000, 100, 8, 0.1, 50, 1.1]),
  builtinPreset("figure-branching-form", "Figure — Branching Form", "figure", "Female figure", [2000, 4, 20, 0.2, 120, 1.2]),
  builtinPreset("figure-wide-branching-form", "Figure — Wide Branching Form", "figure", "Female figure", [2000, 4, 20, 0.9, 120, 1.2]),
  builtinPreset("figure-sparse-branching", "Figure — Sparse Branching", "figure", "Female figure", [800, 20, 3, 0.9, 90, 1.2]),
]);

// Returns a list of problems with `preset` (empty when it is valid): missing
// or unknown settings keys and empty id/name/group.
function validatePreset(preset) {
  const problems = [];
  for (const field of ["id", "name", "group"]) {
    if (typeof preset[field] !== "string" || !preset[field].trim()) {
      problems.push(`missing ${field}`);
    }
  }
  const settings = preset.settings || {};
  for (const key of PRESET_KEYS) {
    if (!(key in settings)) problems.push(`missing setting ${key}`);
  }
  for (const key of Object.keys(settings)) {
    if (!PRESET_KEYS.includes(key)) problems.push(`unknown setting ${key}`);
  }
  return problems;
}

// True when `values` (a full settings object read from the panel) equals the
// preset exactly on every key.
function settingsMatch(values, preset) {
  return PRESET_KEYS.every((key) => values[key] === preset.settings[key]);
}

if (typeof module !== "undefined") {
  module.exports = {
    PRESET_KEYS,
    BUILTIN_PRESETS,
    validatePreset,
    settingsMatch,
  };
}
