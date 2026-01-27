import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@/core/errors";
import { RingBuffer } from "@/delivery/ring-buffer";

interface TestItem {
  id: string;
  value: number;
}

const keyExtractor = (item: TestItem) => item.id;

describe("RingBuffer", () => {
  let buffer: RingBuffer<TestItem>;

  beforeEach(() => {
    buffer = new RingBuffer<TestItem>(5, keyExtractor);
  });

  describe("constructor", () => {
    it("should create a buffer with the specified capacity", () => {
      const buf = new RingBuffer<TestItem>(10, keyExtractor);
      expect(buf.getCapacity()).toBe(10);
      expect(buf.getSize()).toBe(0);
    });

    it("should throw ValidationError for zero capacity", () => {
      expect(() => new RingBuffer<TestItem>(0, keyExtractor)).toThrow(
        ValidationError,
      );
    });

    it("should throw ValidationError for negative capacity", () => {
      expect(() => new RingBuffer<TestItem>(-1, keyExtractor)).toThrow(
        ValidationError,
      );
    });
  });

  describe("add", () => {
    it("should add items to buffer", () => {
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });

      expect(buffer.getSize()).toBe(2);
      expect(buffer.has("a")).toBe(true);
      expect(buffer.has("b")).toBe(true);
    });

    it("should update existing item with same key", () => {
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "a", value: 100 });

      expect(buffer.getSize()).toBe(1);
      expect(buffer.get("a")?.value).toBe(100);
    });

    it("should evict oldest when capacity is reached", () => {
      for (let i = 1; i <= 6; i++) {
        buffer.add({ id: `item-${i}`, value: i });
      }

      expect(buffer.getSize()).toBe(5);
      expect(buffer.has("item-1")).toBe(false); // evicted
      expect(buffer.has("item-2")).toBe(true);
      expect(buffer.has("item-6")).toBe(true);
    });

    it("should track overflow count when items are evicted", () => {
      for (let i = 1; i <= 7; i++) {
        buffer.add({ id: `item-${i}`, value: i });
      }

      expect(buffer.getOverflowCount()).toBe(2);
    });
  });

  describe("get", () => {
    it("should return item if exists", () => {
      buffer.add({ id: "a", value: 42 });

      const item = buffer.get("a");
      expect(item).toEqual({ id: "a", value: 42 });
    });

    it("should return null if item does not exist", () => {
      expect(buffer.get("nonexistent")).toBeNull();
    });
  });

  describe("has", () => {
    it("should return true if item exists", () => {
      buffer.add({ id: "a", value: 1 });
      expect(buffer.has("a")).toBe(true);
    });

    it("should return false if item does not exist", () => {
      expect(buffer.has("nonexistent")).toBe(false);
    });
  });

  describe("remove", () => {
    it("should remove item from buffer", () => {
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });

      buffer.remove("a");

      expect(buffer.has("a")).toBe(false);
      expect(buffer.has("b")).toBe(true);
      expect(buffer.getSize()).toBe(1);
    });

    it("should do nothing if item does not exist", () => {
      buffer.add({ id: "a", value: 1 });

      buffer.remove("nonexistent");

      expect(buffer.getSize()).toBe(1);
    });
  });

  describe("getAll", () => {
    it("should return all items in insertion order", () => {
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });

      const items = buffer.getAll();

      expect(items).toHaveLength(3);
      expect(items[0].id).toBe("a");
      expect(items[1].id).toBe("b");
      expect(items[2].id).toBe("c");
    });

    it("should return items in correct order after evictions", () => {
      for (let i = 1; i <= 7; i++) {
        buffer.add({ id: `item-${i}`, value: i });
      }

      const items = buffer.getAll();

      expect(items).toHaveLength(5);
      expect(items[0].id).toBe("item-3");
      expect(items[4].id).toBe("item-7");
    });

    it("should return empty array for empty buffer", () => {
      expect(buffer.getAll()).toEqual([]);
    });

    it("should skip null slots from removed items", () => {
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });
      buffer.add({ id: "c", value: 3 });

      buffer.remove("b");

      const items = buffer.getAll();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id)).toEqual(["a", "c"]);
    });
  });

  describe("getSize", () => {
    it("should return current number of items in buffer", () => {
      expect(buffer.getSize()).toBe(0);

      buffer.add({ id: "a", value: 1 });
      expect(buffer.getSize()).toBe(1);

      buffer.add({ id: "b", value: 2 });
      expect(buffer.getSize()).toBe(2);
    });

    it("should not exceed capacity", () => {
      for (let i = 0; i < 10; i++) {
        buffer.add({ id: `item-${i}`, value: i });
      }

      expect(buffer.getSize()).toBe(5);
    });
  });

  describe("clear", () => {
    it("should remove all items", () => {
      buffer.add({ id: "a", value: 1 });
      buffer.add({ id: "b", value: 2 });

      buffer.clear();

      expect(buffer.getSize()).toBe(0);
      expect(buffer.getAll()).toEqual([]);
      expect(buffer.has("a")).toBe(false);
    });

    it("should reset overflow count", () => {
      for (let i = 0; i < 10; i++) {
        buffer.add({ id: `item-${i}`, value: i });
      }

      buffer.clear();

      expect(buffer.getOverflowCount()).toBe(0);
    });
  });

  describe("getCapacity", () => {
    it("should return the capacity of the buffer", () => {
      const buf = new RingBuffer<TestItem>(42, keyExtractor);
      expect(buf.getCapacity()).toBe(42);
    });
  });

  describe("getOverflowCount", () => {
    it("should return 0 when no evictions have occurred", () => {
      buffer.add({ id: "a", value: 1 });
      expect(buffer.getOverflowCount()).toBe(0);
    });

    it("should count each eviction", () => {
      const smallBuffer = new RingBuffer<TestItem>(2, keyExtractor);

      smallBuffer.add({ id: "a", value: 1 });
      smallBuffer.add({ id: "b", value: 2 });
      expect(smallBuffer.getOverflowCount()).toBe(0);

      smallBuffer.add({ id: "c", value: 3 }); // evicts 'a'
      expect(smallBuffer.getOverflowCount()).toBe(1);

      smallBuffer.add({ id: "d", value: 4 }); // evicts 'b'
      expect(smallBuffer.getOverflowCount()).toBe(2);
    });
  });
});
