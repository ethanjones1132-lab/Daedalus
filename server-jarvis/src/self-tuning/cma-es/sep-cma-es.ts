/**
 * Separable CMA-ES (Ros & Hansen 2008) — diagonal-covariance evolution
 * strategy for box-constrained black-box optimization of the 43-dim θ vector.
 *
 * Diagonal (not full O(n²)) covariance: θ's dimensions have wildly different
 * natural scales (mid_loop_endgame_budget_ms ~45000 vs no_tool_ratio_ceiling
 * ~0.5) and no assumed cross-dimension correlation structure, so the linear
 * space/time variant is the right fit.
 *
 * Fitness convention: HIGHER IS BETTER (reward domain). Internally ranks
 * descending; all update math is the standard minimization form applied to
 * the negated ordering.
 *
 * Bounds: candidates are projected through `opts.bounds` in ask(); all
 * covariance/mean updates use the PROJECTED points, which keeps the search
 * distribution honest near box edges.
 */

export interface SepCmaEsOptions {
  dim: number;
  initialMean: number[];
  initialSigma: number;
  bounds: (v: number[]) => number[];
  popSize?: number; // default 4 + floor(3 * ln(dim)) — 15 for dim=43
  rng?: () => number; // uniform [0,1); inject for deterministic tests
}

export class SepCmaEs {
  private readonly n: number;
  private readonly lambda: number;
  private readonly mu: number;
  private readonly weights: number[];
  private readonly muEff: number;
  private readonly cSigma: number;
  private readonly dSigma: number;
  private readonly cC: number;
  private readonly c1: number;
  private readonly cMu: number;
  private readonly chiN: number;
  private readonly boundFn: (v: number[]) => number[];
  private readonly rand: () => number;

  private m: number[];
  private stepSize: number;
  private d: number[]; // sqrt of diagonal covariance (per-dim std devs)
  private pC: number[];
  private pSigma: number[];
  private gen = 0;
  private lastAsk: number[][] = [];

  constructor(opts: SepCmaEsOptions) {
    if (opts.dim <= 0) throw new Error("dim must be positive");
    if (opts.initialMean.length !== opts.dim) {
      throw new Error(`initialMean length ${opts.initialMean.length} != dim ${opts.dim}`);
    }
    if (!(opts.initialSigma > 0)) throw new Error("initialSigma must be > 0");
    this.n = opts.dim;
    this.lambda = opts.popSize ?? 4 + Math.floor(3 * Math.log(opts.dim));
    this.mu = Math.floor(this.lambda / 2);
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log((this.lambda + 1) / 2) - Math.log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.weights = raw.map((w) => w / sum);
    this.muEff = 1 / this.weights.reduce((a, w) => a + w * w, 0);

    const n = this.n;
    this.cSigma = (this.muEff + 2) / (n + this.muEff + 5);
    this.dSigma = 1 + 2 * Math.max(0, Math.sqrt((this.muEff - 1) / (n + 1)) - 1) + this.cSigma;
    this.cC = (4 + this.muEff / n) / (n + 4 + (2 * this.muEff) / n);
    this.c1 = 2 / ((n + 1.3) ** 2 + this.muEff);
    this.cMu = Math.min(
      1 - this.c1,
      (2 * (this.muEff - 2 + 1 / this.muEff)) / ((n + 2) ** 2 + this.muEff),
    );
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));

    this.boundFn = opts.bounds;
    this.rand = opts.rng ?? Math.random;
    this.m = [...opts.initialMean];
    this.stepSize = opts.initialSigma;
    this.d = new Array(n).fill(1);
    this.pC = new Array(n).fill(0);
    this.pSigma = new Array(n).fill(0);
  }

  /** λ candidate vectors, already bounds-projected. */
  ask(): number[][] {
    const out: number[][] = [];
    for (let k = 0; k < this.lambda; k++) {
      const x = new Array<number>(this.n);
      for (let j = 0; j < this.n; j++) {
        x[j] = this.m[j] + this.stepSize * this.d[j] * this.gauss();
      }
      out.push(this.boundFn(x));
    }
    this.lastAsk = out;
    return out;
  }

  /** Rank + update. `fitness[i]` corresponds to `samples[i]`; higher is better. */
  tell(samples: number[][], fitness: number[]): void {
    if (samples.length !== this.lambda || fitness.length !== this.lambda) {
      throw new Error(`tell expects ${this.lambda} samples/fitness values`);
    }
    const order = samples
      .map((x, i) => ({ x, f: fitness[i] }))
      .sort((a, b) => b.f - a.f) // descending: higher fitness first
      .slice(0, this.mu);

    const mOld = this.m;
    const ySel = new Array<number>(this.n).fill(0);
    // Weighted recombination over the μ best (y = x - m_old, in projected space).
    order.forEach(({ x }, rank) => {
      const w = this.weights[rank];
      for (let j = 0; j < this.n; j++) ySel[j] += w * (x[j] - mOld[j]);
    });

    // z_sel = C^{-1/2} y_sel / sigma (diagonal C ⇒ per-coordinate divide).
    const zSel = new Array<number>(this.n);
    for (let j = 0; j < this.n; j++) zSel[j] = ySel[j] / (this.stepSize * this.d[j]);

    this.m = mOld.map((v, j) => v + ySel[j]);

    // Conjugate evolution path for sigma.
    const psFactor = Math.sqrt(this.cSigma * (2 - this.cSigma) * this.muEff);
    for (let j = 0; j < this.n; j++) {
      this.pSigma[j] = (1 - this.cSigma) * this.pSigma[j] + psFactor * zSel[j];
    }
    const psNorm = Math.hypot(...this.pSigma);
    this.gen += 1;
    const hSig =
      psNorm / Math.sqrt(1 - (1 - this.cSigma) ** (2 * this.gen)) / this.chiN <
      1.4 + 2 / (this.n + 1)
        ? 1
        : 0;

    // Evolution path for covariance (rank-one).
    const pcFactor = hSig * Math.sqrt(this.cC * (2 - this.cC) * this.muEff);
    for (let j = 0; j < this.n; j++) {
      this.pC[j] = (1 - this.cC) * this.pC[j] + (pcFactor * ySel[j]) / this.stepSize;
    }

    // Diagonal covariance update: rank-one + rank-μ, in y/sigma space.
    const rankMu = new Array<number>(this.n).fill(0);
    order.forEach(({ x }, rank) => {
      const w = this.weights[rank];
      for (let j = 0; j < this.n; j++) {
        const y = (x[j] - mOld[j]) / this.stepSize;
        rankMu[j] += w * y * y;
      }
    });
    for (let j = 0; j < this.n; j++) {
      const cOld = this.d[j] * this.d[j];
      const cNew =
        (1 - this.c1 - this.cMu) * cOld +
        this.c1 * (this.pC[j] * this.pC[j] + (1 - hSig) * this.cC * (2 - this.cC) * cOld) +
        this.cMu * rankMu[j];
      this.d[j] = Math.sqrt(Math.max(cNew, 1e-20));
    }

    // Step-size update.
    this.stepSize *= Math.exp((this.cSigma / this.dSigma) * (psNorm / this.chiN - 1));
  }

  get mean(): number[] {
    return [...this.m];
  }

  get sigma(): number {
    return this.stepSize;
  }

  get generation(): number {
    return this.gen;
  }

  /** Convergence: step size has collapsed below tolerance. */
  converged(sigmaTol = 1e-3): boolean {
    return this.stepSize < sigmaTol;
  }

  private gauss(): number {
    // Box-Muller; guard u1 away from 0.
    let u1 = this.rand();
    while (u1 <= 0) u1 = this.rand();
    const u2 = this.rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
