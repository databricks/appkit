import { describe, expect, it } from "vitest";
import {
  type GeneratorTaskHandler,
  isAsyncGenerator,
  type PromiseTaskHandler,
  type TaskHandlerContext,
} from "@/domain/handler";

describe("Task Handler", () => {
  const controller = new AbortController();
  const mockedHandler: TaskHandlerContext = {
    taskId: "123",
    name: "my-task",
    userId: "user123",
    idempotencyKey: "abc123",
    attempt: 1,
    signal: controller.signal,
  };
  describe("Handler Types", () => {
    it("should type check GeneratorTaskHandler", async () => {
      const handler: GeneratorTaskHandler<{ value: number }, string> =
        async function* (input, _ctx) {
          yield {
            type: "progress",
            message: `Processing: ${input.value}`,
          };
          return "done";
        };

      const gen = handler({ value: 42 }, mockedHandler);
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual({
        type: "progress",
        message: "Processing: 42",
      });

      const second = await gen.next();
      expect(second.done).toBe(true);
      expect(second.value).toBe("done");
    });

    it("should type check PromiseTaskHandler", async () => {
      const handler: PromiseTaskHandler<{ value: number }, string> = async (
        input,
        _ctx,
      ) => {
        return `Result: ${input.value}`;
      };

      const result = await handler({ value: 42 }, mockedHandler);
      expect(result).toBe("Result: 42");
    });

    it("should allow void return in PromiseTaskHandler", async () => {
      const handler: PromiseTaskHandler<{ value: number }, void> = async (
        _input,
        _ctx,
      ) => {
        // no return value
      };

      const result = await handler({ value: 42 }, mockedHandler);
      expect(result).toBeUndefined();
    });
  });
  describe("isAsyncGenerator", () => {
    it("should return true for async generator", async () => {
      async function* gen() {
        yield 1;
      }
      const g = gen();
      expect(isAsyncGenerator(g)).toBe(true);
    });

    it("should return false for regular promise", () => {
      const p = Promise.resolve(1);
      expect(isAsyncGenerator(p)).toBe(false);
    });

    it("should return false for null", () => {
      expect(isAsyncGenerator(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isAsyncGenerator(undefined)).toBe(false);
    });

    it("should return false for plain object", () => {
      expect(isAsyncGenerator({})).toBe(false);
    });

    it("should return false for object with only Symbol.asyncIterator", () => {
      const fake = { [Symbol.asyncIterator]: () => {} };
      expect(isAsyncGenerator(fake)).toBe(false); // missing .next()
    });
  });
});
