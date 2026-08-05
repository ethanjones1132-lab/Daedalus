import { describe, expect, test } from "bun:test";
import { DirectiveBudget, MAX_DIRECTIVES_PER_TURN } from "./directive-budget";

describe("DirectiveBudget", () => {
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
