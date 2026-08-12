import { describe, expect, test } from "vitest";
import { captureTraceValue } from "../serialization";

describe("captureTraceValue", () => {
  test("sorts object keys and redacts sensitive keys case-insensitively", () => {
    expect(
      captureTraceValue({ prompt: "hello", Authorization: "Bearer secret" }),
    ).toEqual({
      value: '{"Authorization":"[REDACTED]","prompt":"hello"}',
      originalBytes: 47,
      sha256:
        "d828c3e891ddb30e1c13de236bde9b7833fc29a279769125fc23353d235d9082",
      truncated: false,
    });
  });

  test("redacts default and custom sensitive keys recursively", () => {
    expect(
      captureTraceValue(
        {
          nested: [{ keep: "c", ToKeN: "a", CustomSecret: "b" }],
        },
        { redactKeys: ["customsecret"] },
      ),
    ).toEqual({
      value:
        '{"nested":[{"CustomSecret":"[REDACTED]","ToKeN":"[REDACTED]","keep":"c"}]}',
      originalBytes: 74,
      sha256:
        "0c5ace5e27c98b82a34f392a38c54ab515ee16ae247ac4b4644ea278eeb1ef49",
      truncated: false,
    });
  });

  test("redacts credential keys across camelCase, separator, and case variants", () => {
    const captured = captureTraceValue({
      accessToken: "camel-access",
      "ACCESS.TOKEN": "dot-access",
      access_token: "snake-access",
      refreshToken: "camel-refresh",
      "refresh token": "space-refresh",
      clientSecret: "camel-client",
      "CLIENT-SECRET": "kebab-client",
      sdkToken: "camel-sdk",
      SDK_TOKEN: "snake-sdk",
    });

    expect(JSON.parse(captured.value)).toEqual({
      "ACCESS.TOKEN": "[REDACTED]",
      "CLIENT-SECRET": "[REDACTED]",
      SDK_TOKEN: "[REDACTED]",
      accessToken: "[REDACTED]",
      access_token: "[REDACTED]",
      clientSecret: "[REDACTED]",
      refreshToken: "[REDACTED]",
      "refresh token": "[REDACTED]",
      sdkToken: "[REDACTED]",
    });
    expect(captured.value).not.toContain("camel-access");
    expect(captured.value).not.toContain("camel-refresh");
    expect(captured.value).not.toContain("camel-client");
    expect(captured.value).not.toContain("camel-sdk");
  });

  test("normalizes custom redaction keys without redacting benign supersets", () => {
    const captured = captureTraceValue(
      {
        customSecret: "private",
        CUSTOM_SECRET: "also-private",
        accessTokenCount: 4,
        clientSecretName: "display-name",
        refreshTokenizedAt: "2026-08-11",
        sdkTokenizer: "sentencepiece",
        secretSauce: "benign",
      },
      { redactKeys: ["custom-secret"] },
    );

    expect(JSON.parse(captured.value)).toEqual({
      CUSTOM_SECRET: "[REDACTED]",
      accessTokenCount: 4,
      clientSecretName: "display-name",
      customSecret: "[REDACTED]",
      refreshTokenizedAt: "2026-08-11",
      sdkTokenizer: "sentencepiece",
      secretSauce: "benign",
    });
  });

  test("hashes the complete value and truncates only at UTF-8 boundaries", () => {
    expect(captureTraceValue("😀a", { maxBytes: 5 })).toEqual({
      value: '"😀',
      originalBytes: 7,
      sha256:
        "5f83696371a62d8dac1f76186954ebb46376bb3fef359d15a44b5c5db0b51211",
      truncated: true,
    });
  });

  test("retains up to 64 KiB by default", () => {
    const result = captureTraceValue("a".repeat(70 * 1024));

    expect(new TextEncoder().encode(result.value)).toHaveLength(64 * 1024);
    expect(result.originalBytes).toBe(70 * 1024 + 2);
    expect(result.truncated).toBe(true);
  });
});
