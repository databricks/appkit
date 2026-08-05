import { describe, expect, test } from "vitest";
import { formatFieldLabel } from "./format";

describe("formatFieldLabel", () => {
  test.each([
    ["totalCost", "Total Cost"],
    ["user_name", "User Name"],
    ["userID", "User Id"],
    ["getHTTPUrl", "Get Http Url"],
    ["TOTAL_SPEND", "Total Spend"],
    ["", ""],
    ['<script>alert("x")</script>', "Scriptalertxscript"],
  ])("formats %j as %j", (field, expected) => {
    expect(formatFieldLabel(field)).toBe(expected);
  });
});
