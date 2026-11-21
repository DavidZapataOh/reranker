"""Reference CUSUM and Beta-Binomial BOCPD runs for @reranker/stats changepoint detection.

CUSUM follows simulations/cusum_h_arl.py and simulations/canary_baseline.py; BOCPD follows
Adams and MacKay (2007, arXiv:0710.3742) with a constant hazard and a Beta-Binomial predictive.

Regenerate from the repository root:
  uvx --with numpy --with scipy python -I packages/stats/test-vectors/changepoint/generate.py \
    packages/stats/test-vectors/changepoint
  pnpm exec biome format --write packages/stats/test-vectors/changepoint
"""

import json
import sys
from pathlib import Path

import numpy as np
from scipy.special import betaln, gammaln, logsumexp

N = 10
rng = np.random.default_rng(20261120)


def empirical_logit(y, n):
    return float(np.log((y + 0.5) / (n - y + 0.5)))


def cusum_case(p, shift, h):
    base_y = rng.binomial(N, p, 42)
    base = np.array([empirical_logit(y, N) for y in base_y])
    mu0, sigma = float(base.mean()), float(base.std(ddof=1))
    lp = np.log(p / (1 - p)) + shift
    ys = rng.binomial(N, 1 / (1 + np.exp(-lp)), 30)
    up = down = 0.0
    steps = []
    for y in ys:
        x = empirical_logit(int(y), N)
        up = max(0.0, up + (x - mu0) - 0.5 * sigma)
        down = max(0.0, down + (mu0 - x) - 0.5 * sigma)
        steps.append({"up": up, "down": down, "alarm": bool(up > h * sigma or down > h * sigma)})
    return {
        "input": {"baselineYs": base_y.tolist(), "n": N, "p": p, "h": h, "ys": ys.tolist()},
        "output": {"mu0": mu0, "sigma": sigma, "steps": steps},
    }


def bocpd_run(ys, ns, lam=30.0, a0=1.0, b0=1.0, max_r=400, prune=1e-6):
    log_r, a, b = np.array([0.0]), np.array([a0]), np.array([b0])
    log_h, log_1mh = np.log(1 / lam), np.log1p(-1 / lam)
    out = []
    for y, n in zip(ys, ns):
        log_pred = (
            gammaln(n + 1) - gammaln(y + 1) - gammaln(n - y + 1)
            + betaln(y + a, n - y + b) - betaln(a, b)
        )
        joint = log_r + log_pred
        log_r = np.concatenate(([logsumexp(joint + log_h)], joint + log_1mh))
        log_r -= logsumexp(log_r)
        a = np.concatenate(([a0], a + y))
        b = np.concatenate(([b0], b + n - y))
        # The last run length stands for "max_r or more": it takes the mass of the run that
        # outgrew it, with that run's counts.
        if len(log_r) > max_r + 1:
            log_r[max_r] = np.logaddexp(log_r[max_r], log_r[max_r + 1])
            a[max_r], b[max_r] = a[max_r + 1], b[max_r + 1]
            log_r, a, b = log_r[: max_r + 1], a[: max_r + 1], b[: max_r + 1]
        keep = len(log_r)
        while keep > 1 and np.exp(log_r[keep - 1]) < prune:
            keep -= 1
        if keep < len(log_r):
            log_r, a, b = log_r[:keep], a[:keep], b[:keep]
            log_r -= logsumexp(log_r)
        out.append(int(np.argmax(log_r)))
    return out, log_r.tolist()


def bocpd_case(p, shift_at, p_after, days, n_missing=False):
    ps = [p if t < shift_at else p_after for t in range(days)]
    # An incomplete day enters with its real number of runs.
    ns = [int(rng.integers(5, 11)) if n_missing and t % 7 == 3 else N for t in range(days)]
    ys = [int(rng.binomial(n, q)) for n, q in zip(ns, ps)]
    maps, final = bocpd_run(ys, ns)
    return {"input": {"ys": ys, "ns": ns}, "output": {"mapRunLengths": maps, "finalLogR": final}}


def main(out_dir):
    cusum = [
        cusum_case(p, shift, h)
        for p, h in ((0.2, 2.84), (0.5, 3.52))
        for shift in (0.0, 0.5, -1.0)
    ]
    bocpd = [
        bocpd_case(0.2, 60, 0.6, 70),
        bocpd_case(0.5, 1000, 0.5, 120),
        bocpd_case(0.3, 40, 0.05, 80, n_missing=True),
        bocpd_case(0.5, 1000, 0.5, 450),
    ]
    meta = {"generator": "generate.py", "numpy": np.__version__, "seed": 20261120}
    Path(out_dir, "cusum.json").write_text(json.dumps({**meta, "cases": cusum}))
    Path(out_dir, "bocpd.json").write_text(json.dumps({**meta, "cases": bocpd}))


if __name__ == "__main__":
    main(sys.argv[1])
