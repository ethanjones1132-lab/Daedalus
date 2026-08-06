import { describe, expect, test } from "bun:test";
import { DirectiveBudget, MAX_DIRECTIVES_PER_TURN } from "./directive-budget";

describe("DirectiveBudget", () => {
  // 2026-08-05: runExecutorStage created a fresh DirectiveBudget per call site
  // (concurrent planner‖executor + normal + high-complexity retry) so one turn
  // could spend ~3× MAX_DIRECTIVES_PER_TURN. Sharing one instance is the contract.
  test("a shared budget caps the sum across multiple executor call sites", () => {
    const shared = new DirectiveBudget();
    const sites = [shared, shared, shared];
    let accepted = 0;
    for (const budget of sites) {
      for (let i = 0; i < MAX_DIRECTIVES_PER_TURN; i++) {
        if (budget.claim("mid_loop_continue")) accepted += 1;
      }
    }
    expect(accepted).toBe(MAX_DIRECTIVES_PER_TURN);
    expect(shared.exhausted()).toBe(true);
  });

  test("allows directives up to the cap", () => {
    const b = new DirectiveBudget();
    for (let i = 0; i < MAX_DIRECTIVES_PER_TURN; i++) expect(b.claim("mid_loop_continue")).toBe(true);
  });

  test("refuses past the cap", () => {
    const b = new DirectiveBudget();
    for (let i = 0; i < MAX_DIRECTIVES_PER_TURN; i++) b.claim("mid_loop_continue");
    expect(b.claim("mid_loop_continue")).toBe(false);
    expect(b.exhausted()).toBe(true);
  });

  test("terminal directives are never refused", () => {
    const b = new DirectiveBudget();
    for (let i = 0; i < MAX_DIRECTIVES_PER_TURN + 5; i++) b.claim("mid_loop_continue");
    expect(b.claim("mid_loop_abort")).toBe(true);
    expect(b.claim("mark_verified")).toBe(true);
  });

  test("reports what consumed the budget", () => {
    const b = new DirectiveBudget();
    b.claim("mid_loop_continue");
    b.claim("mid_loop_force_write");
    b.claim("mid_loop_continue");
    expect(b.tally()).toEqual({ mid_loop_continue: 2, mid_loop_force_write: 1 });
  });
});
