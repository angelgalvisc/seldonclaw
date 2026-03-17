import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns empty array for empty input", async () => {
    const result = await mapWithConcurrency([], 3, async (x) => x);
    expect(result).toEqual([]);
  });

  it("processes items and returns results in input order", async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await mapWithConcurrency(items, 3, async (x) => x * 2);
    expect(result).toEqual([20, 40, 60, 80, 100]);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];

    await mapWithConcurrency(items, 2, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return x;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("works with concurrency=1 (sequential)", async () => {
    const order: number[] = [];
    const items = [1, 2, 3];

    await mapWithConcurrency(items, 1, async (x) => {
      order.push(x);
      return x;
    });

    expect(order).toEqual([1, 2, 3]);
  });

  it("handles concurrency greater than item count", async () => {
    const items = [1, 2];
    const result = await mapWithConcurrency(items, 10, async (x) => x + 1);
    expect(result).toEqual([2, 3]);
  });

  it("passes index to the worker", async () => {
    const items = ["a", "b", "c"];
    const result = await mapWithConcurrency(items, 2, async (_item, index) => index);
    expect(result).toEqual([0, 1, 2]);
  });

  it("propagates worker errors", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (x) => {
        if (x === 2) throw new Error("fail");
        return x;
      })
    ).rejects.toThrow("fail");
  });
});
