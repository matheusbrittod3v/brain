import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../dist/src/server.js";

test("API refuses startup when NOEMA_LOCAL_API_KEY is missing", () => {
  const configuredKey = process.env.NOEMA_LOCAL_API_KEY;
  delete process.env.NOEMA_LOCAL_API_KEY;
  try {
    assert.throws(() => buildApp(), /NOEMA_LOCAL_API_KEY/);
  } finally {
    if (configuredKey === undefined) delete process.env.NOEMA_LOCAL_API_KEY;
    else process.env.NOEMA_LOCAL_API_KEY = configuredKey;
  }
});

test("API refuses startup when NOEMA_LOCAL_API_KEY is empty or whitespace", () => {
  const configuredKey = process.env.NOEMA_LOCAL_API_KEY;
  try {
    for (const invalidKey of ["", "   "]) {
      process.env.NOEMA_LOCAL_API_KEY = invalidKey;
      assert.throws(() => buildApp(), /NOEMA_LOCAL_API_KEY/);
    }
  } finally {
    if (configuredKey === undefined) delete process.env.NOEMA_LOCAL_API_KEY;
    else process.env.NOEMA_LOCAL_API_KEY = configuredKey;
  }
});
