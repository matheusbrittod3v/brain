import test from "node:test";
import assert from "node:assert/strict";
import { extractCodeAnchors, extractCodeSymbols } from "../src/index.js";

test("extracts @brain-rule and @brain-adr anchors deterministically", () => {
  const code = `
// @brain-adr ADR-021
// @brain-rule BR-SUB-014
export function cancelSubscription() {}
`;
  const anchors = extractCodeAnchors("src/subscription.service.ts", code);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].relationType, "DECIDED_BY");
  assert.equal(anchors[1].relationType, "GOVERNED_BY");
  assert.equal(anchors[1].targetId, "BR-SUB-014");
});

test("maps @brain-rule in spec files to VERIFIED_BY", () => {
  const testCode = `// @brain-rule BR-SUB-014\nit("cancels", () => {});`;
  const anchors = extractCodeAnchors("tests/subscription.spec.ts", testCode);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].relationType, "VERIFIED_BY");
});

test("preserves lowercase characters in valid knowledge IDs in code anchors", () => {
  const anchors = extractCodeAnchors("src/example.test.ts", "// @brain-rule BR-EVID-a12b3c\nit('verified', () => {});");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].targetId, "BR-EVID-a12b3c");
  assert.equal(anchors[0].relationType, "VERIFIED_BY");
});

test("extracts functions, classes, interfaces and HTTP routes across languages", () => {
  const src = `
export interface SubInput {}
export class SubscriptionService {}
export async function cancelSub() {}
app.post("/v1/subscriptions/cancel", () => {});
`;
  const syms = extractCodeSymbols("src/sub.ts", src);
  assert.equal(syms.length, 4);
  assert.equal(syms[3].kind, "route");
  assert.equal(syms[3].name, "/v1/subscriptions/cancel");
});

