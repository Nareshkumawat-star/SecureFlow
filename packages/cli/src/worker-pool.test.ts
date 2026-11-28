import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkerPool, scanFilesInPool } from "./worker-pool.js";
import { scanFile } from "./scanner.js";

describe("WorkerPool", () => {
  it("initializes with requested concurrency and runs tasks in-process when concurrency is 1", async () => {
    const pool = new WorkerPool({ concurrency: 1 });
    expect(pool.concurrency).toBe(1);

    const result = await pool.runTask({
      id: 1,
      path: "test.ts",
      content: 'console.log("api_key =", apiKey);',
    });

    expect(result.path).toBe("test.ts");
    expect(result.violations.length).toBeGreaterThan(0);
    await pool.terminate();
  });

  it("can run tasks concurrently with worker threads", async () => {
    const pool = new WorkerPool({ concurrency: 2 });
    const tasks = [
      pool.runTask({ id: 1, path: "a.ts", content: "const a = 1;" }),
      pool.runTask({ id: 2, path: "b.ts", content: 'console.log("api_key =", apiKey);' }),
      pool.runTask({ id: 3, path: "c.ts", content: "const c = 3;" }),
    ];

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(3);
    expect(results[0]?.path).toBe("a.ts");
    expect(results[0]?.violations).toHaveLength(0);
    expect(results[1]?.path).toBe("b.ts");
    expect(results[1]?.violations.length).toBeGreaterThan(0);
    expect(results[2]?.path).toBe("c.ts");

    await pool.terminate();
  });
});

describe("scanFilesInPool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-pool-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces identical results between sequential (concurrency 1) and parallel scan", async () => {
    const fileA = path.join(tmpDir, "fileA.ts");
    const fileB = path.join(tmpDir, "fileB.ts");
    const fileC = path.join(tmpDir, "fileC.ts");

    fs.writeFileSync(fileA, 'console.log("secret token:", secretToken);');
    fs.writeFileSync(fileB, "const safe = 42;\nfunction run() { return safe; }");
    fs.writeFileSync(fileC, 'console.error("private key:", privateKey);\nconsole.log("db:", dbPassword);');

    const files = [fileA, fileB, fileC];

    const sequential = await scanFilesInPool(files, { concurrency: 1, isDirMode: true });
    const parallel = await scanFilesInPool(files, { concurrency: 4, isDirMode: true });

    expect(parallel.violationCount).toBe(sequential.violationCount);
    expect(parallel.fileResults.length).toBe(sequential.fileResults.length);
    for (let i = 0; i < files.length; i++) {
      expect(parallel.fileResults[i]?.path).toBe(sequential.fileResults[i]?.path);
      expect(parallel.fileResults[i]?.violations).toEqual(sequential.fileResults[i]?.violations);
    }
  });

  it("guarantees strictly deterministic output ordering matching filesToScan order", async () => {
    const files: string[] = [];
    for (let i = 0; i < 8; i++) {
      const fPath = path.join(tmpDir, `order_${String(i).padStart(2, "0")}.ts`);
      fs.writeFileSync(
        fPath,
        i % 2 === 0
          ? `// file ${i}\nconsole.log("apiKey", apiKey);`
          : `// clean file ${i}\nconst val = ${i};`,
      );
      files.push(fPath);
    }

    // Run parallel scan multiple times with high concurrency
    for (let run = 0; run < 2; run++) {
      const res = await scanFilesInPool(files, { concurrency: 4, isDirMode: true });
      expect(res.fileResults.map((r) => r.path)).toEqual(files);
    }
  }, 15000);

  it("skips files above size limit with a notice and continues scanning other files", async () => {
    const smallFile = path.join(tmpDir, "small.ts");
    const largeFile = path.join(tmpDir, "large.ts");
    const normalFile = path.join(tmpDir, "normal.ts");

    fs.writeFileSync(smallFile, 'console.log("api_key:", apiKey);');
    fs.writeFileSync(largeFile, "x".repeat(200)); // 200 bytes
    fs.writeFileSync(normalFile, "const clean = true;");

    const notices: string[] = [];
    const res = await scanFilesInPool([smallFile, largeFile, normalFile], {
      concurrency: 2,
      isDirMode: true,
      maxFileSizeBytes: 100, // Limit to 100 bytes
      onNotice: (msg) => notices.push(msg),
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("exceeds limit");
    expect(notices[0]).toContain("large.ts");

    expect(res.fileResults).toHaveLength(3);
    expect(res.fileResults[0]?.path).toBe(smallFile);
    expect(res.fileResults[0]?.violations.length).toBeGreaterThan(0);

    expect(res.fileResults[1]?.path).toBe(largeFile);
    expect(res.fileResults[1]?.skipped).toContain("file size exceeds limit");
    expect(res.fileResults[1]?.violations).toHaveLength(0);

    expect(res.fileResults[2]?.path).toBe(normalFile);
    expect(res.fileResults[2]?.skipped).toBeUndefined();
    expect(res.skippedCount).toBe(1);
  });

  it("reports errors per file without aborting the scan", async () => {
    const validFileA = path.join(tmpDir, "validA.ts");
    const nonExistentFile = path.join(tmpDir, "does-not-exist.ts");
    const validFileB = path.join(tmpDir, "validB.ts");

    fs.writeFileSync(validFileA, 'console.log("token:", userToken);');
    fs.writeFileSync(validFileB, 'console.log("api_key:", apiKey);');

    const errors: Array<{ file: string; err: Error }> = [];
    const res = await scanFilesInPool([validFileA, nonExistentFile, validFileB], {
      concurrency: 2,
      isDirMode: true,
      onError: (file, err) => errors.push({ file, err }),
    });

    // Scan should complete without aborting
    expect(res.fileResults).toHaveLength(2);
    expect(res.unreadable).toContain(nonExistentFile);
    expect(res.violationCount).toBe(2);
  });

  it("concurrency 1 reproduces sequential behaviour exactly matching scanFile", async () => {
    const file = path.join(tmpDir, "single.ts");
    const content = 'console.log("auth_token =", authToken);\nconsole.error("pass =", password);';
    fs.writeFileSync(file, content);

    const directResult = scanFile(file, content);
    const poolResult = await scanFilesInPool([file], { concurrency: 1, isDirMode: true });

    expect(poolResult.fileResults[0]?.violations).toEqual(directResult.violations);
    expect(poolResult.violationCount).toBe(directResult.violations.length);
  });
});
