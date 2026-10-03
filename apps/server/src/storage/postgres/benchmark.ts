// Storage benchmark runner against a real Postgres.
// Usage: npx tsx src/storage/postgres/benchmark.ts
// Creates a disposable database, seeds with the shared storage-benchmark
// helpers, times every read/write benchmark, and drops the database.
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  STORAGE_READ_BENCHMARKS,
  STORAGE_WRITE_BENCHMARKS,
  TIMING_SCALE,
  seedStorageBenchmark,
  seedStorageWriteBenchmark,
} from "@earendil-works/pi-durable/testing";
import pg from "pg";
import { PgPoolDatabase, PostgresDurableStorage } from "./index.js";
import { createDisposableDatabase, dropDisposableDatabase, resetDurableTables } from "./test-support.js";

const context = BACKGROUND_CONTEXT;
const READ_ITERATIONS = 50;
const WRITE_ITERATIONS = 50;

function stat(samples: number[]): { mean: number; median: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { mean, median: sorted[Math.floor(sorted.length / 2)]! };
}

function printRow(name: string, medianMs: number, perSecond: number, extra = ""): void {
  const ms = medianMs.toFixed(3).padStart(10);
  const rate = perSecond >= 1000 ? `${(perSecond / 1000).toFixed(1)}k` : perSecond.toFixed(0);
  console.log(`${name.padEnd(44)} ${ms} ms/op  ${rate.padStart(8)} ops/s  ${extra}`);
}

async function main(): Promise<void> {
  const database = await createDisposableDatabase();
  console.log(`Benchmark database: ${database.name}`);
  try {
    // Read benchmarks over the deterministic seed dataset.
    let db = new PgPoolDatabase(new pg.Pool({ connectionString: database.url, max: 2 }));
    let storage = await PostgresDurableStorage.open(db);
    const dataset = await seedStorageBenchmark(storage, TIMING_SCALE);
    console.log(
      `Seeded timing scale: ${TIMING_SCALE.entryCount} entries, ${TIMING_SCALE.taskCount} tasks, ${TIMING_SCALE.documentCount} documents`,
    );
    console.log("\nRead benchmarks:");
    for (const benchmark of STORAGE_READ_BENCHMARKS) {
      const observed = await benchmark.run(storage, dataset);
      const expectedValue = benchmark.expected(dataset);
      if (observed !== expectedValue) {
        throw new Error(`Benchmark ${benchmark.name} returned ${observed}, expected ${expectedValue}`);
      }
      const samples: number[] = [];
      for (let index = 0; index < READ_ITERATIONS; index++) {
        const start = performance.now();
        await benchmark.run(storage, dataset);
        samples.push(performance.now() - start);
      }
      const { mean, median } = stat(samples);
      printRow(benchmark.name, median, 1000 / median, `(mean ${mean.toFixed(3)} ms)`);
    }
    await storage.close(context);

    // Write benchmarks over a pristine schema.
    db = new PgPoolDatabase(new pg.Pool({ connectionString: database.url, max: 2 }));
    await resetDurableTables(db);
    storage = await PostgresDurableStorage.open(db);
    await seedStorageWriteBenchmark(storage);
    console.log("\nWrite benchmarks:");
    for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
      const observed = await benchmark.run(storage);
      if (observed !== benchmark.expected) {
        throw new Error(`Benchmark ${benchmark.name} returned ${observed}, expected ${benchmark.expected}`);
      }
      const samples: number[] = [];
      for (let index = 0; index < WRITE_ITERATIONS; index++) {
        const start = performance.now();
        const records = await benchmark.run(storage);
        samples.push((performance.now() - start) / records);
      }
      const { mean, median } = stat(samples);
      printRow(benchmark.name, median, 1000 / median, `(mean ${mean.toFixed(3)} ms/record)`);
    }
    await storage.close(context);
    console.log("\nDone.");
  } finally {
    await dropDisposableDatabase(database.name);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
