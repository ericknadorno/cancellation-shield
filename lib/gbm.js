// nexo — pure JS inference for LightGBM models exported by
// scripts/train_gbm.py. No dependencies. Walks each tree, sums the
// leaf values, applies sigmoid.
//
// Expected model JSON shape (matches export_model in train_gbm.py):
// {
//   algorithm: "gbm",
//   feature_names: [...],           // must match FEATURE_NAMES order
//   trees: [ { feature, threshold, left, right } | { leaf } , ... ],
//   num_trees: N,
//   best_iteration: int,            // use first N trees up to this
//   apply_sigmoid: true,            // for binary classification
//   training: { samples, created_at },
//   metrics: { auc, brier, log_loss, calibration_error }
// }
//
// Tree nodes:
//   leaf node:   { leaf: <number> }
//   split node:  { feature: <int>, threshold: <number>, left: <node>, right: <node>, default_left: <bool> }

import { FEATURE_NAMES, extractFeatureVector } from "./features.js";

function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

/**
 * Walk a single tree for a given feature vector (indexed by FEATURE_NAMES order).
 * Returns the leaf value.
 */
function walkTree(node, features) {
  let current = node;
  while (current && current.leaf === undefined) {
    const f = features[current.feature];
    // Handle missing values (null/undefined) via default_left direction.
    // For our numeric scorers, f is always a number, so this rarely fires.
    if (f === null || f === undefined || Number.isNaN(f)) {
      current = current.default_left ? current.left : current.right;
    } else if (f <= current.threshold) {
      current = current.left;
    } else {
      current = current.right;
    }
  }
  return current && typeof current.leaf === "number" ? current.leaf : 0;
}

/**
 * Check whether a model JSON is a GBM model (vs the old logistic format).
 */
export function isGBMModel(modelJson) {
  return modelJson && modelJson.algorithm === "gbm" && Array.isArray(modelJson.trees);
}

/**
 * Predict the probability that a reservation will cancel using a trained
 * GBM model. Takes the raw reservation object (same shape that
 * extractFeatureVector expects from lib/features.js).
 *
 * @param {object} reservation   Raw reservation (Mews-mapped)
 * @param {object} modelJson     Exported GBM JSON from train_gbm.py
 * @returns {number}             Probability in [0, 1]
 */
export function predictGBMProb(reservation, modelJson) {
  if (!isGBMModel(modelJson)) {
    throw new Error("predictGBMProb called with non-GBM model");
  }
  const fv = extractFeatureVector(reservation);

  // Build the numeric array in the same FEATURE_NAMES order the Python
  // trainer used. We trust modelJson.feature_names matches FEATURE_NAMES
  // — if a future feature is added to the JS side but not retrained into
  // the model, the GBM will simply ignore the new index.
  const featureNames = Array.isArray(modelJson.feature_names) && modelJson.feature_names.length > 0
    ? modelJson.feature_names
    : FEATURE_NAMES;

  const x = new Array(featureNames.length);
  for (let i = 0; i < featureNames.length; i++) {
    x[i] = fv[featureNames[i]];
  }

  // Sum leaf values across all trees (or up to best_iteration if set)
  const numTrees = Number.isInteger(modelJson.best_iteration) && modelJson.best_iteration > 0
    ? Math.min(modelJson.best_iteration, modelJson.trees.length)
    : modelJson.trees.length;

  let rawScore = 0;
  for (let t = 0; t < numTrees; t++) {
    rawScore += walkTree(modelJson.trees[t], x);
  }

  // LightGBM binary classification exports raw margins — apply sigmoid
  if (modelJson.apply_sigmoid !== false) {
    return sigmoid(rawScore);
  }
  return rawScore;
}

/**
 * Convenience wrapper that produces the same {score, level, prob, override, factors}
 * shape the existing api/score.js scoreHandTuned and scoreLearned functions return.
 * Called from api/score.js computeRisk when a GBM model is active.
 */
export function scoreWithGBM(reservation, modelJson) {
  const probFrac = predictGBMProb(reservation, modelJson);
  const rawProb = Math.round(probFrac * 100);
  // Clip to the same safety bounds the UI expects
  const prob = Math.max(3, Math.min(95, rawProb));
  const score = prob;
  const level = score >= 38 ? "HIGH" : score >= 18 ? "MEDIUM" : "LOW";
  return { score, level, override: "", prob };
}
