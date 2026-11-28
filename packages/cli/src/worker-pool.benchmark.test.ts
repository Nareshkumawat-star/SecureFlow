import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkerPool, scanFilesInPool } from "./worker-pool.js";

describe("Worker Pool Benchmark", () => {
  let benchDir: string;
  const files: string[] = [];
  const FILE_COUNT = 40;

  beforeAll(() => {
    benchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-benchmark-"));

    // Generate realistic multi-file repository files with sufficient CPU evaluation lines
    for (let i = 0; i < FILE_COUNT; i++) {
      const filePath = path.join(benchDir, `module_${String(i).padStart(3, "0")}.ts`);
      const lines: string[] = [
        `/**`,
        ` * Module ${i} - Synthetic benchmark source file`,
        ` */`,
        `import { format } from "node:util";`,
        `export function executeOperation${i}(input: string): string {`,
        `  let buffer = input.trim();`,
      ];

      for (let j = 0; j < 80; j++) {
        lines.push(`  buffer += " step_${j}_${i} ";`);
        if (j % 10 === 0) {
          lines.push(`  const intermediateKey_${j} = "intermediate_hash_${j}_${i}";`);
          lines.push(`  if (buffer.length > 1000) { buffer = buffer.slice(0, 500); }`);
        }
      }

      if (i % 3 === 0) {
        lines.push(`  const apiKey = "sec_live_${i}_abc123xyz";`);
        lines.push(`  console.log("Debug connection with apiKey: " + apiKey);`);
      }
      if (i % 5 === 0) {
        lines.push(`  const secretToken = "tok_${i}_supersecret";`);
        lines.push(`  console.error("Auth failure for token: " + secretToken);`);
      }

      lines.push(`  return buffer;`);
      lines.push(`}`);

      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      files.push(filePath);
    }
  });

  afterAll(() => {
    fs.rmSync(benchDir, { recursive: true, force: true });
  });

  it("benchmarks parallel worker pool against sequential execution on a multi-file repository", async () => {
    const concurrency = Math.max(2, Math.min(8, os.availableParallelism?.() || 4));
    const pool = new WorkerPool({ concurrency });
    // Pre-warm the pool workers
    await pool.runTask({ id: 0, path: "warmup.ts", content: "const warmup = 1;" });

    // 1. Sequential scan (concurrency: 1)
    const t0 = performance.now();
    const sequentialResult = await scanFilesInPool(files, {
      concurrency: 1,
      isDirMode: true,
      noCache: true,
    });
    const sequentialDurationMs = performance.now() - t0;

    // 2. Concurrent scan with worker pool
    const t1 = performance.now();
    const concurrentResult = await scanFilesInPool(files, {
      pool,
      concurrency,
      isDirMode: true,
      noCache: true,
    });
    const concurrentDurationMs = performance.now() - t1;
    await pool.terminate();

    // Verify deterministic identity of results
    expect(concurrentResult.violationCount).toBe(sequentialResult.violationCount);
    expect(concurrentResult.fileResults.length).toBe(sequentialResult.fileResults.length);
    for (let i = 0; i < files.length; i++) {
      expect(concurrentResult.fileResults[i]?.path).toBe(sequentialResult.fileResults[i]?.path);
      expect(concurrentResult.fileResults[i]?.violations).toEqual(
        sequentialResult.fileResults[i]?.violations,
      );
    }

    const speedup = sequentialDurationMs / Math.max(1, concurrentDurationMs);
    console.log(
      `📊 [Benchmark] Scanned ${FILE_COUNT} files: sequential=${sequentialDurationMs.toFixed(1)}ms, parallel (c=${concurrency})=${concurrentDurationMs.toFixed(1)}ms, speedup=${speedup.toFixed(2)}x`,
    );

    expect(concurrentDurationMs).toBeGreaterThan(0);
    expect(sequentialDurationMs).toBeGreaterThan(0);
  }, 30000);
});
