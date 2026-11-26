import { describe, expect, it } from "vitest";

import { BoundedQueue, MAX_QUEUE_SIZE } from "../core/queue";

describe("BoundedQueue", () => {
  it("uses a capacity of 100 and drops new items when full", () => {
    const queue = new BoundedQueue<number>();

    for (let value = 0; value < MAX_QUEUE_SIZE; value += 1) {
      expect(queue.enqueue(value)).toBe(true);
    }

    expect(queue.enqueue(MAX_QUEUE_SIZE)).toBe(false);
    expect(queue.size).toBe(MAX_QUEUE_SIZE);
    expect(queue.take(MAX_QUEUE_SIZE)).toEqual(
      Array.from({ length: MAX_QUEUE_SIZE }, (_, index) => index),
    );
  });

  it("takes items from the head in FIFO order", () => {
    const queue = new BoundedQueue<string>(4);
    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");

    expect(queue.peek()).toBe("first");
    expect(queue.take(2)).toEqual(["first", "second"]);
    expect(queue.peek()).toBe("third");
    expect(queue.size).toBe(1);
    expect(queue.take(10)).toEqual(["third"]);
    expect(queue.peek()).toBeUndefined();
    expect(queue.take(1)).toEqual([]);
  });

  it("requeues only the prefix that fits without reordering queued items", () => {
    const queue = new BoundedQueue<string>(4);
    queue.enqueue("queued-1");
    queue.enqueue("queued-2");

    expect(queue.requeueFront(["retry-1", "retry-2", "retry-3"])).toBe(1);
    expect(queue.size).toBe(4);
    expect(queue.take(4)).toEqual([
      "retry-1",
      "retry-2",
      "queued-1",
      "queued-2",
    ]);
  });

  it("does not disturb a full queue when requeueing", () => {
    const queue = new BoundedQueue<number>(2);
    queue.enqueue(1);
    queue.enqueue(2);

    expect(queue.requeueFront([-1, 0])).toBe(2);
    expect(queue.take(2)).toEqual([1, 2]);
  });

  it("clears the queue and reports how many items were removed", () => {
    const queue = new BoundedQueue<number>(3);
    queue.enqueue(1);
    queue.enqueue(2);

    expect(queue.clear()).toBe(2);
    expect(queue.size).toBe(0);
    expect(queue.clear()).toBe(0);
    expect(queue.enqueue(3)).toBe(true);
  });

  it("rejects invalid capacities and ignores invalid take counts", () => {
    expect(() => new BoundedQueue(0)).toThrow(RangeError);
    expect(() => new BoundedQueue(1.5)).toThrow(RangeError);

    const queue = new BoundedQueue<number>();
    queue.enqueue(1);

    expect(queue.take(0)).toEqual([]);
    expect(queue.take(Number.NaN)).toEqual([]);
    expect(queue.size).toBe(1);
  });
});
