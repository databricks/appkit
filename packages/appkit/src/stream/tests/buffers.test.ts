import { describe, expect, test } from "vitest";
import { EventRingBuffer, RingBuffer } from "../buffers";
import type { BufferedEvent } from "../types";

interface Item {
  id: string;
  value: number;
}

function createBuffer(capacity: number): RingBuffer<Item> {
  return new RingBuffer<Item>(capacity, (item) => item.id);
}

function createEvent(id: string): BufferedEvent {
  return {
    id,
    type: "message",
    data: JSON.stringify({ id }),
    timestamp: Date.now(),
  };
}

describe("RingBuffer", () => {
  describe("add with holes created by remove()", () => {
    test("should insert into a freed slot instead of overwriting a live entry", () => {
      const buffer = createBuffer(3);

      // fill to capacity; writeIndex wraps back to the slot of "a"
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });

      // remove a non-oldest entry, creating a hole that is NOT at writeIndex
      buffer.remove("b");
      expect(buffer.getSize()).toBe(2);

      // adding "d" must use the freed slot, not destroy live entry "a"
      buffer.add({ id: "d", value: 4 });

      expect(buffer.getSize()).toBe(3);
      expect(buffer.get("a")).toEqual({ id: "a", value: 1 });
      expect(buffer.get("c")).toEqual({ id: "c", value: 3 });
      expect(buffer.get("d")).toEqual({ id: "d", value: 4 });
      expect(buffer.has("b")).toBe(false);
    });

    test("should keep every live entry reachable across repeated remove/add cycles", () => {
      const buffer = createBuffer(4);
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });
      buffer.add({ id: "d", value: 4 });

      buffer.remove("c");
      buffer.add({ id: "e", value: 5 });
      buffer.remove("a");
      buffer.add({ id: "f", value: 6 });

      expect(buffer.getSize()).toBe(4);
      for (const id of ["b", "d", "e", "f"]) {
        expect(buffer.has(id)).toBe(true);
        expect(buffer.get(id)).not.toBeNull();
      }
      // every keyIndex entry points at the right item (no slot collisions)
      const all = buffer.getAll();
      expect(all.map((item) => item.id).sort()).toEqual(["b", "d", "e", "f"]);
    });
  });

  describe("getAll after remove()", () => {
    test("should return every surviving entry, including ones outside the size-window", () => {
      const buffer = createBuffer(3);
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });

      // removing the newest entry shrinks the size; "a" used to fall outside
      // the window walked back from writeIndex and was silently skipped
      buffer.remove("c");

      const all = buffer.getAll();
      expect(all.map((item) => item.id).sort()).toEqual(["a", "b"]);
    });

    test("should return all survivors with multiple holes", () => {
      const buffer = createBuffer(5);
      for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) {
        buffer.add({ id, value: i });
      }

      buffer.remove("e");
      buffer.remove("c");

      const all = buffer.getAll();
      expect(all.map((item) => item.id).sort()).toEqual(["a", "b", "d"]);
      expect(buffer.getSize()).toBe(3);
    });
  });

  describe("add-only ring semantics (event buffer behavior)", () => {
    test("should overwrite the oldest entry when full and keep insertion order in getAll", () => {
      const buffer = createBuffer(3);
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });
      buffer.add({ id: "d", value: 4 });
      buffer.add({ id: "e", value: 5 });

      expect(buffer.has("a")).toBe(false);
      expect(buffer.has("b")).toBe(false);
      expect(buffer.getAll().map((item) => item.id)).toEqual(["c", "d", "e"]);
      expect(buffer.getSize()).toBe(3);
    });

    test("should keep insertion order in getAll when not yet full", () => {
      const buffer = createBuffer(5);
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });

      expect(buffer.getAll().map((item) => item.id)).toEqual(["a", "b", "c"]);
    });

    test("should update an existing key in place without consuming a slot", () => {
      const buffer = createBuffer(2);
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "a", value: 2 });

      expect(buffer.getSize()).toBe(1);
      expect(buffer.get("a")).toEqual({ id: "a", value: 2 });
    });
  });
});

describe("EventRingBuffer", () => {
  test("should replay events after a given event id in order", () => {
    const buffer = new EventRingBuffer(5);
    for (const id of ["1", "2", "3", "4"]) {
      buffer.add(createEvent(id));
    }

    const replayed = buffer.getEventsSince("2");
    expect(replayed.map((event) => event.id)).toEqual(["3", "4"]);
  });

  test("should replay correctly after the ring wraps", () => {
    const buffer = new EventRingBuffer(3);
    for (const id of ["1", "2", "3", "4", "5"]) {
      buffer.add(createEvent(id));
    }

    // buffer now holds 3, 4, 5 (oldest overwritten)
    const replayed = buffer.getEventsSince("3");
    expect(replayed.map((event) => event.id)).toEqual(["4", "5"]);
  });

  test("should return no events when the last event id is not in the buffer", () => {
    const buffer = new EventRingBuffer(3);
    for (const id of ["1", "2", "3", "4"]) {
      buffer.add(createEvent(id));
    }

    // "1" was overwritten by the ring; replay cannot find it
    expect(buffer.getEventsSince("1")).toEqual([]);
  });
});
