// nexo — L2-regularized logistic regression + evaluation metrics.
// Pure JS, zero dependencies. Designed to be small enough to run inside
// a Vercel serverless function in well under the 60s execution budget,
// even on the largest training set we realistically hit (~20k rows).
//
// Algorithm: Newton-Raphson with L2 penalty on non-intercept coefs.
// Converges in ~10-20 iterations for this feature space (27 signals).

// ─── LOW-LEVEL LINEAR ALGEBRA ───

function sigmoid(z) {
  // Numerically stable
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

// Solve A * x = b using Gaussian elimination with partial pivoting.
// A is d×d (modified in place), b is length d. Returns x (length d).
function gaussSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);  // augmented

  for (let i = 0; i < n; i++) {
    // Partial pivot
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    if (maxRow !== i) [M[i], M[maxRow]] = [M[maxRow], M[i]];

    const pivot = M[i][i];
    if (Math.abs(pivot) < 1e-12) {
      throw new Error("Matrix is singular — training failed");
    }

    // Eliminate below
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / pivot;
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

// ─── TRAINING ───

/**
 * Fit L2-regularized logistic regression via Newton-Raphson.
 *
 * @param {number[][]} X   Feature matrix, shape (n, d). Does NOT include
 *                         an intercept column — this function prepends one.
 * @param {number[]}   y   Binary labels, length n. Must be 0 or 1.
 * @param {object}     opts
 * @param {number}     opts.lambda   L2 penalty strength (default: 1.0)
 * @param {number}     opts.maxIter  Max iterations (default: 50)
 * @param {number}     opts.tol      Convergence tolerance (default: 1e-6)
 * @returns {number[]} beta, length d+1. beta[0] is the intercept.
 */
export function fitLogistic(X, y, opts = {}) {
  const { lambda = 1.0, maxIter = 50, tol = 1e-6 } = opts;
  const n = X.length;
  if (n === 0) throw new Error("Empty training set");
  const d = X[0].length + 1;  // +1 for intercept

  // Prepend a 1 to each row for the intercept
  const Xa = X.map(row => [1, ...row]);

  let beta = new Array(d).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Predictions
    const p = new Array(n);
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < d; j++) z += Xa[i][j] * beta[j];
      p[i] = sigmoid(z);
    }

    // Gradient: X^T (p - y) + lambda * beta  (intercept excluded from penalty)
    const grad = new Array(d).fill(0);
    for (let j = 0; j < d; j++) {
      let g = 0;
      for (let i = 0; i < n; i++) g += Xa[i][j] * (p[i] - y[i]);
      if (j > 0) g += lambda * beta[j];
      grad[j] = g;
    }

    // Hessian: X^T W X + lambda I  (W = diag(p*(1-p)))
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) {
      const wi = p[i] * (1 - p[i]);
      for (let j = 0; j < d; j++) {
        const Xij = Xa[i][j];
        for (let k = j; k < d; k++) {
          H[j][k] += Xij * Xa[i][k] * wi;
        }
      }
    }
    // Symmetrize + L2 penalty on diagonal (skip intercept)
    for (let j = 0; j < d; j++) {
      for (let k = j + 1; k < d; k++) H[k][j] = H[j][k];
      if (j > 0) H[j][j] += lambda;
    }

    // Newton step: delta = H^-1 * grad
    let delta;
    try {
      delta = gaussSolve(H, grad);
    } catch (err) {
      // Fall back to gradient descent step
      const lr = 0.001;
      delta = grad.map(g => lr * g);
    }

    // Update
    let maxChange = 0;
    for (let j = 0; j < d; j++) {
      beta[j] -= delta[j];
      if (Math.abs(delta[j]) > maxChange) maxChange = Math.abs(delta[j]);
    }

    if (maxChange < tol) break;
  }

  return beta;
}

// ─── INFERENCE ───

/**
 * Predict probabilities for new samples.
 * @param {number[][]} X     Feature matrix (n, d), no intercept column.
 * @param {number[]}   beta  Coefficients from fitLogistic (length d+1).
 * @returns {number[]} probabilities in [0, 1]
 */
export function predictProb(X, beta) {
  return X.map(row => {
    let z = beta[0];
    for (let j = 0; j < row.length; j++) z += row[j] * beta[j + 1];
    return sigmoid(z);
  });
}

// ─── METRICS ───

/**
 * AUC-ROC via the Mann-Whitney U formulation. Robust to ties.
 */
export function auc(y, pred) {
  const n = y.length;
  if (n === 0) return 0.5;

  const pairs = y.map((yi, i) => [pred[i], yi]);
  pairs.sort((a, b) => a[0] - b[0]);

  let nPos = 0, nNeg = 0;
  for (const [, yi] of pairs) {
    if (yi === 1) nPos++;
    else nNeg++;
  }
  if (nPos === 0 || nNeg === 0) return 0.5;

  // Average rank for ties
  let sumRankPos = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && pairs[j][0] === pairs[i][0]) j++;
    // Ranks i..j-1 all get the average rank (i+1 + j) / 2 (1-indexed)
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (pairs[k][1] === 1) sumRankPos += avgRank;
    }
    i = j;
  }

  const U = sumRankPos - nPos * (nPos + 1) / 2;
  return U / (nPos * nNeg);
}

/**
 * Brier score = mean squared error between probability and outcome.
 * Lower is better. 0 is perfect, 0.25 is "always predict 50%".
 */
export function brier(y, pred) {
  if (y.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < y.length; i++) s += (pred[i] - y[i]) ** 2;
  return s / y.length;
}

/**
 * Log-loss (negative log-likelihood). Lower is better.
 */
export function logLoss(y, pred, eps = 1e-9) {
  if (y.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < y.length; i++) {
    const p = Math.max(eps, Math.min(1 - eps, pred[i]));
    s += y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p);
  }
  return -s / y.length;
}

/**
 * 10-bucket reliability diagram. Returns an array of
 * { bin, avg_pred, actual_rate, count } for the dashboard.
 */
export function reliabilityBuckets(y, pred, nBuckets = 10) {
  const buckets = Array.from({ length: nBuckets }, () => ({ sumPred: 0, sumY: 0, count: 0 }));
  for (let i = 0; i < y.length; i++) {
    const p = Math.max(0, Math.min(1, pred[i]));
    const idx = Math.min(nBuckets - 1, Math.floor(p * nBuckets));
    buckets[idx].sumPred += p;
    buckets[idx].sumY   += y[i];
    buckets[idx].count++;
  }
  return buckets.map((b, i) => ({
    bin: (i + 0.5) / nBuckets,
    avg_pred:    b.count > 0 ? b.sumPred / b.count : 0,
    actual_rate: b.count > 0 ? b.sumY   / b.count : 0,
    count: b.count
  }));
}

/**
 * Expected Calibration Error (ECE). Lower is better.
 * Weighted by bucket size, penalty is |avg_pred - actual_rate|.
 */
export function expectedCalibrationError(y, pred, nBuckets = 10) {
  const buckets = reliabilityBuckets(y, pred, nBuckets);
  const n = y.length;
  if (n === 0) return 0;
  let ece = 0;
  for (const b of buckets) {
    ece += (b.count / n) * Math.abs(b.avg_pred - b.actual_rate);
  }
  return ece;
}

// ─── TRAIN/TEST SPLIT ───

/**
 * Deterministic 80/20 split based on a stable hash of the row index.
 * Deterministic so successive training runs can compare apples to apples.
 */
export function trainTestSplit(X, y, testFrac = 0.2, seed = 42) {
  const n = X.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  // Seeded Fisher-Yates
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const nTest = Math.round(n * testFrac);
  const testIdx = new Set(indices.slice(0, nTest));

  const Xtr = [], ytr = [], Xte = [], yte = [];
  for (let i = 0; i < n; i++) {
    if (testIdx.has(i)) { Xte.push(X[i]); yte.push(y[i]); }
    else                 { Xtr.push(X[i]); ytr.push(y[i]); }
  }
  return { Xtr, ytr, Xte, yte };
}
