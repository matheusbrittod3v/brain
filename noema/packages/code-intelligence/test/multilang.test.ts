import test from "node:test";
import assert from "node:assert/strict";
import { extractCodeSymbols, extractFileDependencies } from "../src/index.js";

test("extracts Python classes, functions, methods, routes and dependencies", () => {
  const py = `
import os, json as j
from fastapi import APIRouter, Depends
from app.billing.rules import validate_invoice

class InvoiceService:
    def calculate_total(self, amount):
        return amount * 1.1

@router.post("/v1/invoices")
async def create_invoice():
    return {"ok": True}
`;
  const syms = extractCodeSymbols("app/services/invoice.py", py);
  assert.ok(syms.some((s) => s.kind === "class" && s.name === "InvoiceService"));
  assert.ok(syms.some((s) => s.kind === "method" && s.name === "calculate_total"));
  assert.ok(syms.some((s) => s.kind === "route" && s.name === "/v1/invoices"));
  assert.ok(syms.some((s) => s.kind === "function" && s.name === "create_invoice"));

  const deps = extractFileDependencies("app/services/invoice.py", py);
  assert.deepEqual(deps.sort(), ["app.billing.rules", "fastapi", "json", "os"]);
});

test("extracts Go structs, interfaces, methods, functions, routes and dependencies", () => {
  const go = `
package main

import (
    "fmt"
    mux "github.com/gorilla/mux"
    _ "github.com/lib/pq"
)

type Store interface {
    Get(id string) error
}

type PostgresStore struct {
    dsn string
}

func (s *PostgresStore) Get(id string) error {
    return nil
}

func registerRoutes(r *mux.Router) {
    r.HandleFunc("/v1/health", healthHandler)
}
`;
  const syms = extractCodeSymbols("cmd/server/main.go", go);
  assert.ok(syms.some((s) => s.kind === "interface" && s.name === "Store"));
  assert.ok(syms.some((s) => s.kind === "class" && s.name === "PostgresStore"));
  assert.ok(syms.some((s) => s.kind === "method" && s.name === "Get"));
  assert.ok(syms.some((s) => s.kind === "function" && s.name === "registerRoutes"));
  assert.ok(syms.some((s) => s.kind === "route" && s.name === "/v1/health"));

  const deps = extractFileDependencies("cmd/server/main.go", go);
  assert.deepEqual(deps.sort(), ["fmt", "github.com/gorilla/mux", "github.com/lib/pq"]);
});

test("extracts Java classes, interfaces, methods and Spring routes", () => {
  const java = `
package com.noema.orders;

public interface OrderRepository {
}

public class OrderController {
    @GetMapping("/v1/orders")
    public String listOrders() {
        return "ok";
    }
}
`;
  const syms = extractCodeSymbols("src/OrderController.java", java);
  assert.ok(syms.some((s) => s.kind === "interface" && s.name === "OrderRepository"));
  assert.ok(syms.some((s) => s.kind === "class" && s.name === "OrderController"));
  assert.ok(syms.some((s) => s.kind === "route" && s.name === "/v1/orders"));
  assert.ok(syms.some((s) => s.kind === "method" && s.name === "listOrders"));
});

test("extracts Rust structs, traits, functions, impl methods and routes", () => {
  const rs = `
pub trait BillingEngine {
    fn charge(&self);
}

pub struct StripeEngine {
    pub key: String,
}

impl BillingEngine for StripeEngine {
    fn charge(&self) {
        println!("charging");
    }
}

#[post("/v1/charge")]
pub async fn handle_charge() {}
`;
  const syms = extractCodeSymbols("src/billing.rs", rs);
  assert.ok(syms.some((s) => s.kind === "interface" && s.name === "BillingEngine"));
  assert.ok(syms.some((s) => s.kind === "class" && s.name === "StripeEngine"));
  assert.ok(syms.some((s) => s.kind === "method" && s.name === "charge"));
  assert.ok(syms.some((s) => s.kind === "route" && s.name === "/v1/charge"));
  assert.ok(syms.some((s) => s.kind === "function" && s.name === "handle_charge"));
});

test("extracts TS/JS ESM imports, re-exports and CommonJS requires", () => {
  const tsCode = `
import { z } from "zod";
export { foo } from "./foo.js";
const path = require("node:path");
`;
  const deps = extractFileDependencies("src/index.ts", tsCode);
  assert.deepEqual(deps.sort(), ["./foo.js", "node:path", "zod"]);
});
