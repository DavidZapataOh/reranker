import numpy as np

# In-control ARL of a one-sided CUSUM on the daily logit rate of one canary prompt
# (n runs per day), when mu0 and sigma are estimated from m baseline days.
rng = np.random.default_rng(7)
N_RUNS = 10
TARGET_TWO_SIDED = 90
TARGET_ONE_SIDED = 2 * TARGET_TWO_SIDED  # two one-sided charts -> ARL0 ~ 90


def daily_logits(p, size):
    y = rng.binomial(N_RUNS, p, size)
    return np.log((y + 0.5) / (N_RUNS - y + 0.5))


def run_length(mu, sd, h, p, reps, max_t=3000):
    k = 0.5 * sd
    lengths = np.empty(reps)
    for r in range(reps):
        x = daily_logits(p, max_t)
        s = 0.0
        length = max_t
        for t, v in enumerate(x, 1):
            s = max(0.0, s + (v - mu) - k)
            if s > h * sd:
                length = t
                break
        lengths[r] = length
    return lengths.mean()


for p in (0.2, 0.5):
    ref = daily_logits(p, 400000)
    mu, sd = ref.mean(), ref.std()
    lo, hi = 0.5, 10.0
    for _ in range(16):
        h = (lo + hi) / 2
        if run_length(mu, sd, h, p, reps=400) < TARGET_ONE_SIDED:
            lo = h
        else:
            hi = h
    print(f"p={p} h={h:.2f} sd (known params)")
    for m in (14, 28, 42, 56, 90):
        arls = []
        for _ in range(80):
            base = daily_logits(p, m)
            arls.append(run_length(base.mean(), base.std(ddof=1), h, p, reps=80))
        arls = np.array(arls)
        ok = (arls >= 0.8 * TARGET_ONE_SIDED).mean()
        print(f"  m={m:3d} median={np.median(arls):6.0f} p10={np.percentile(arls, 10):6.0f} P(ARL>=0.8*target)={ok:.2f}")
