import test from "node:test";
import assert from "node:assert/strict";
import { chunkCodeByAst } from "../src/index.js";

test("chunks Python file by extracted code symbols within token budget", () => {
  const py = `import math
from decimal import Decimal

def compute_tax(amount):
    rate = Decimal("0.15")
    return amount * rate

def apply_discount(amount, pct):
    if pct <= 0:
        return amount
    return amount * (1 - pct)

class InvoiceCalculator:
    def finalize(self, total):
        return round(total, 2)
`;
  const chunks = chunkCodeByAst("billing/calc.py", py, 70);
  assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok((chunk.tokenCount ?? 0) <= 70, `Chunk exceeded maxTokens: ${chunk.tokenCount}`);
    assert.ok(chunk.symbolName, "Expected symbolName on code chunk");
    assert.equal(chunk.breadcrumb, undefined, "Should not fall back to markdown breadcrumbs");
  }
  const allText = chunks.map((c) => c.text).join("\n");
  assert.ok(allText.includes("compute_tax"));
  assert.ok(allText.includes("apply_discount"));
  assert.ok(allText.includes("InvoiceCalculator"));
});

test("chunks Go and Rust files by symbol boundaries", () => {
  const go = `package billing

import "fmt"

type Invoice struct {
    ID string
    Total int
}

func FormatInvoice(inv Invoice) string {
    return fmt.Sprintf("%s:%d", inv.ID, inv.Total)
}

func ValidateInvoice(inv Invoice) bool {
    return inv.Total > 0
}
`;
  const goChunks = chunkCodeByAst("billing/invoice.go", go, 60);
  assert.ok(goChunks.length >= 2);
  assert.ok(goChunks.every((c) => (c.tokenCount ?? 0) <= 60));
  assert.ok(goChunks.some((c) => c.symbolName?.includes("Invoice")));
  assert.ok(goChunks.some((c) => c.symbolName?.includes("ValidateInvoice")));

  const rs = `use std::fmt;

pub struct Payment {
    pub cents: u64,
}

pub fn validate_payment(p: &Payment) -> bool {
    p.cents > 0
}
`;
  const rsChunks = chunkCodeByAst("src/payment.rs", rs, 200);
  assert.equal(rsChunks.length, 1);
  assert.ok(rsChunks[0]!.symbolName?.includes("Payment"));
  assert.ok(rsChunks[0]!.symbolName?.includes("validate_payment"));
});
