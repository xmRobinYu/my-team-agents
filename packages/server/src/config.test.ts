import { writeFile } from "node:fs";
import { describe, expect, it } from "vitest";
import { openExecutionStore } from "./config.js";

describe("openExecutionStore", () => {
  it("creates the SQLite file outside the package directory", () => {
    process.env.MTA_DB_PATH = "/tmp/mta-probe.sqlite";
    const { store } = openExecutionStore();
    expect(store.getUsage()).toEqual([]);
    store.close();
  });
});
