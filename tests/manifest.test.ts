import { describe, expect, test } from "bun:test";
import { manifest } from "../src/manifest";

describe("Beacon manifest", () => {
  test("keeps both privacy protections enabled by default", () => {
    const properties = manifest.settings.properties;

    expect(properties.redact.default).toBe(true);
    expect(properties.filterKnownNoise.default).toBe(true);
  });

  test("never exposes host credentials as Studio settings", () => {
    const properties = manifest.settings.properties;

    expect(properties).not.toHaveProperty("key");
    expect(properties).not.toHaveProperty("transport");
    expect(properties).not.toHaveProperty("beforeSend");
    expect(properties).not.toHaveProperty("getReplayId");
  });
});
