import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../../orchestration/orchestration-policy";
import { SepCmaEs } from "./sep-cma-es";

const clampBox = (lo: number, hi: number) => (v: number[]) =>
  v.map((x) => Math.min(hi, Math.max(lo, x)));

describe("SepCmaEs.ask", () => {
  test("returns default popSize 4 + floor(3 ln 43) = 15 for dim 43, bounds-projected", () => {
    const cma = new SepCmaEs({
      dim: 43,
      initialMean: new Array(43).fill(0.5),
      initialSigma: 0.3,
      bounds: clampBox(0, 1),
      rng: mulberry32(7),
    });
    const samples = cma.ask();
    expect(samples.length).toBe(15);
    for (const s of samples) {
      expect(s.length).toBe(43);
      for (const x of s) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
      }
    }
  });

  test("honors an explicit popSize", () => {
    const cma = new SepCmaEs({
      dim: 5,
      initialMean: [0, 0, 0, 0, 0],
      initialSigma: 1,
      bounds: clampBox(-10, 10),
      popSize: 6,
      rng: mulberry32(1),
    });
    expect(cma.ask().length).toBe(6);
  });
});

describe("SepCmaEs.tell", () => {
  test("rejects mismatched sample/fitness counts", () => {
    const cma = new SepCmaEs({
      dim: 3,
      initialMean: [0, 0, 0],
      initialSigma: 1,
      bounds: clampBox(-10, 10),
      popSize: 4,
      rng: mulberry32(2),
    });
    const samples = cma.ask();
    expect(() => cma.tell(samples, [1, 2])).toThrow();
  });

  test("moves the mean toward higher-fitness samples (higher-is-better convention)", () => {
    const cma = new SepCmaEs({
      dim: 2,
      initialMean: [0, 0],
      initialSigma: 1,
      bounds: clampBox(-10, 10),
      popSize: 8,
      rng: mulberry32(3),
    });
    const samples = cma.ask();
    // Fitness rewards large positive coordinates.
    cma.tell(samples, samples.map((s) => s[0] + s[1]));
    const mean = cma.mean;
    expect(mean[0]).toBeGreaterThan(0);
    expect(mean[1]).toBeGreaterThan(0);
  });
});

describe("SepCmaEs convergence", () => {
  test("converges on a shifted sphere (separable quadratic, higher-is-better)", () => {
    const target = [1.2, -1.8, 0.7, 2.4, -0.5, 3.0, -2.6, 1.0];
    const dim = target.length;
    const cma = new SepCmaEs({
      dim,
      initialMean: new Array(dim).fill(0),
      initialSigma: 2.5,
      bounds: clampBox(-5, 5),
      rng: mulberry32(42),
    });
    const fitness = (x: number[]) => -x.reduce((acc, v, j) => acc + (v - target[j]) ** 2, 0);
    for (let g = 0; g < 400 && !cma.converged(1e-6); g++) {
      const samples = cma.ask();
      cma.tell(samples, samples.map(fitness));
    }
    const mean = cma.mean;
    for (let j = 0; j < dim; j++) {
      expect(Math.abs(mean[j] - target[j])).toBeLessThan(0.2);
    }
  });

  test("stays inside the box when the optimum lies outside it", () => {
    const dim = 4;
    const cma = new SepCmaEs({
      dim,
      initialMean: new Array(dim).fill(0),
      initialSigma: 2,
      bounds: clampBox(-5, 5),
      rng: mulberry32(9),
    });
    // Optimum at +100 on every coordinate — far outside the box.
    const fitness = (x: number[]) => -x.reduce((acc, v) => acc + (v - 100) ** 2, 0);
    for (let g = 0; g < 400 && !cma.converged(1e-6); g++) {
      const samples = cma.ask();
      cma.tell(samples, samples.map(fitness));
      for (const s of samples) {
        for (const x of s) expect(x).toBeLessThanOrEqual(5);
      }
    }
    for (const v of cma.mean) expect(v).toBeGreaterThan(4);
  });
});
