import numpy as np

# Engine-level regime rule: open a regime when >= 30% of the 50 canary prompts
# are in alarm on the same day. Per-prompt CUSUM (k = 0.5 sd, h from cusum_h_arl.py), mu0 and sd
# estimated from m baseline days. Measures false regimes in 90 in-control days, and the
# delay to detect a real shift of `shift` logits applied to every prompt.
rng = np.random.default_rng(11)
N_RUNS, PROMPTS, HORIZON = 10, 50, 90
H = {0.2: 2.84, 0.5: 3.52}


def logits(p, shape):
    y = rng.binomial(N_RUNS, p, shape)
    return np.log((y + 0.5) / (N_RUNS - y + 0.5))


def simulate(m, shift, trials=400):
    false_regime, delays = 0, []
    for _ in range(trials):
        ps = rng.choice([0.2, 0.5], PROMPTS)
        hs = np.array([H[p] for p in ps])
        base = np.stack([logits(p, m) for p in ps])
        mu, sd = base.mean(1), base.std(1, ddof=1)
        sd = np.where(sd == 0, 1e-6, sd)
        up = np.zeros(PROMPTS); dn = np.zeros(PROMPTS)
        hit = None
        for t in range(1, HORIZON + 1):
            p_t = ps
            if shift:
                lp = np.log(ps / (1 - ps)) + shift
                p_t = 1 / (1 + np.exp(-lp))
            x = np.array([logits(p, 1)[0] for p in p_t])
            up = np.maximum(0, up + (x - mu) - 0.5 * sd)
            dn = np.maximum(0, dn + (mu - x) - 0.5 * sd)
            alarm = (up > hs * sd) | (dn > hs * sd)
            if alarm.mean() >= 0.30:
                hit = t
                break
        if shift == 0:
            false_regime += hit is not None
        else:
            delays.append(hit if hit else HORIZON + 1)
    if shift == 0:
        return f"m={m}: P(false regime in {HORIZON} d)={false_regime / trials:.3f}"
    d = np.array(delays)
    return f"m={m} shift={shift}: median delay={np.median(d):.0f} d, p90={np.percentile(d, 90):.0f} d"


for m in (7, 14, 21, 28, 35, 42, 56):
    print(simulate(m, 0))
    print(simulate(m, 0.5, trials=200))
    print(simulate(m, 1.0, trials=200))
