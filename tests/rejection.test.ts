import { expect, test } from "bun:test";
import { describeRejection } from "../src/rejection";
import { redactBeaconEvent } from "../src/index";

test("preserves non-enumerable browser exception diagnostics without a synthetic stack", () => {
  const reason = Object.create(null, {
    name: { value: "SecurityError" },
    message: { value: "Storage unavailable" },
    code: { value: 18 },
  });
  expect(JSON.stringify(reason)).toBe("{}");
  const { error, extra } = describeRejection(reason);
  expect(error.name).toBe("SecurityError");
  expect(error.message).toBe("Storage unavailable");
  expect(error.stack).toBeUndefined();
  expect(extra.code).toBe(18);
});
test("captures event resource diagnostics and applies existing URL redaction", () => {
  const script = document.createElement("script");
  script.src = "https://example.com/script.js?token=private&visitor=person";
  const reason = new Event("error");
  Object.defineProperty(reason, "target", { value: script });
  const { error, extra } = describeRejection(reason);
  const event = redactBeaconEvent({
    name: error.name,
    message: error.message,
    extra,
    level: "error",
  });
  expect(event.extra?.type).toBe("error");
  expect(event.extra?.resourceTag).toBe("SCRIPT");
  expect(event.extra?.resourceUrl).toContain("script.js");
  expect(JSON.stringify(event)).not.toContain("private");
  expect(JSON.stringify(event)).not.toContain("person");
});
test("does not serialize arbitrary payloads, bodies, or form input", () => {
  const reason = {
    status: 403,
    body: "private body",
    password: "secret",
    target: { tagName: "INPUT", value: "private input", src: "private url" },
  };
  Object.assign(reason, { cycle: reason });
  const result = describeRejection(reason);
  expect(result.error.message).toContain("status 403");
  expect(JSON.stringify(result)).not.toMatch(/private|secret|cycle/);
});
test("throwing getters and revoked proxies cannot break rejection reporting", () => {
  const reason = new Proxy(
    {},
    {
      get() {
        throw new Error("no access");
      },
    },
  );
  expect(describeRejection(reason).error.message).toContain("object");
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  expect(describeRejection(revoked.proxy).error.message).toContain("object");
});
test("keeps cross-realm stacks and gives opaque objects an honest description", () => {
  expect(
    describeRejection({
      message: "failed",
      name: "RemoteError",
      stack: "original stack",
    }).error.stack,
  ).toBe("original stack");
  expect(describeRejection({}).error.message).toBe(
    "Unhandled promise rejection (Object)",
  );
  expect(describeRejection({}).error.stack).toBeUndefined();
});

test("retains existing cross-realm error cause chains", () => {
  const cause = new Error("underlying failure");
  expect(
    describeRejection({ message: "outer", stack: "original", cause }).error
      .cause,
  ).toBe(cause);
});
