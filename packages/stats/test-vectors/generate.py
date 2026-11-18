"""Reference values for @reranker/stats, computed with SciPy and statsmodels.

Regenerate from the repository root:
  uvx --with scipy --with statsmodels python -I packages/stats/test-vectors/generate.py \
    > packages/stats/test-vectors/intervals.json
  pnpm exec biome format --write packages/stats/test-vectors/intervals.json
"""

import json
import sys

import scipy
import statsmodels
from scipy.stats import beta, norm
from statsmodels.stats.proportion import proportion_confint

LEVELS = [0.95, 0.9, 0.99]
GRID = [(y, n) for n in (40, 120, 200) for y in (0, 1, 2, 5, 12, 20, 39, 40) if y <= n]
# Effective-size inputs are fractional: y* = p_hat * n_eff.
FRACTIONAL = [(7.3, 37.6), (0.4, 23.9), (36.2, 36.9)]
PROBABILITIES = [1e-300, 1e-20, 1e-10, 1e-5, 0.001, 0.005, 0.025, 0.05, 0.1, 0.3, 0.425, 0.5,
                 0.575, 0.9, 0.95, 0.975, 0.995, 0.999, 1 - 1e-10]


def cases():
    for level in LEVELS:
        for y, n in GRID + FRACTIONAL:
            yield level, y, n


def jeffreys(level, y, n):
    alpha = 1 - level
    # Raw quantiles: the y = 0 / y = n endpoint convention belongs to the code under test.
    lower, upper = beta.ppf([alpha / 2, 1 - alpha / 2], y + 0.5, n - y + 0.5)
    return {"level": level, "y": y, "n": n, "lower": float(lower), "upper": float(upper)}


def wilson(level, y, n):
    lower, upper = proportion_confint(y, n, alpha=1 - level, method="wilson")
    return {"level": level, "y": y, "n": n, "lower": float(lower), "upper": float(upper)}


json.dump(
    {
        "generator": {
            "python": sys.version.split()[0],
            "scipy": scipy.__version__,
            "statsmodels": statsmodels.__version__,
        },
        "jeffreys": [jeffreys(*c) for c in cases()],
        "wilson": [wilson(*c) for c in cases()],
        "normalQuantile": [{"p": p, "z": float(norm.ppf(p))} for p in PROBABILITIES],
    },
    sys.stdout,
    indent=2,
)
sys.stdout.write("\n")
