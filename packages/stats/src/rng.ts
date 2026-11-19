export interface Rng {
  /** Uniform in [0, 1) with 2^-32 resolution. */
  next(): number;
}

const TWO_POW_32 = 2 ** 32;

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/**
 * xoshiro128** (Blackman and Vigna) seeded with the first 16 bytes of a
 * sha256 hex digest, read as four little-endian 32-bit words.
 */
export function rngFromSeed(seedHex: string): Rng {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) {
    throw new RangeError("seed must be a 64-character hex sha256 digest");
  }
  const word = (i: number): number =>
    Number.parseInt(
      seedHex.slice(i * 8 + 6, i * 8 + 8) +
        seedHex.slice(i * 8 + 4, i * 8 + 6) +
        seedHex.slice(i * 8 + 2, i * 8 + 4) +
        seedHex.slice(i * 8, i * 8 + 2),
      16,
    ) | 0;
  let s0 = word(0);
  let s1 = word(1);
  let s2 = word(2);
  let s3 = word(3);
  // The all-zero state is the generator's only fixed point.
  if ((s0 | s1 | s2 | s3) === 0) throw new RangeError("seed state must not be all zero");

  return {
    next() {
      const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9);
      const t = s1 << 9;
      s2 ^= s0;
      s3 ^= s1;
      s1 ^= s2;
      s0 ^= s3;
      s2 ^= t;
      s3 = rotl(s3, 11);
      return (result >>> 0) / TWO_POW_32;
    },
  };
}

export function exponential(rng: Rng): number {
  // 1 - U lies in (0, 1], so the logarithm is always finite.
  return -Math.log(1 - rng.next());
}

/** Polar Box–Muller; the second variate is discarded so the stream stays stateless. */
export function standardNormal(rng: Rng): number {
  for (;;) {
    const u = 2 * rng.next() - 1;
    const v = 2 * rng.next() - 1;
    const s = u * u + v * v;
    if (s > 0 && s < 1) return u * Math.sqrt((-2 * Math.log(s)) / s);
  }
}

function assertShape(name: string, value: number): void {
  if (!(value > 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} must be finite and positive, got ${value}`);
  }
}

function marsagliaTsang(rng: Rng, shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng.next();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Gamma(shape, 1) by Marsaglia–Tsang, boosted through Γ(shape + 1) · U^(1/shape) below 1. */
export function gamma(rng: Rng, shape: number): number {
  assertShape("shape", shape);
  if (shape >= 1) return marsagliaTsang(rng, shape);
  return marsagliaTsang(rng, shape + 1) * (1 - rng.next()) ** (1 / shape);
}

export function beta(rng: Rng, a: number, b: number): number {
  assertShape("a", a);
  assertShape("b", b);
  const x = gamma(rng, a);
  return x / (x + gamma(rng, b));
}
