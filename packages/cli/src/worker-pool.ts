/**
 * Worker Pool for Concurrent File Scanning (#2231).
 *
 * Distributes CPU-intensive file scans across multiple worker threads to keep
 * all CPU cores utilized, while ensuring deterministic output ordering, file size
 * limit checks with skip notices, and per-file error isolation without aborting.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  scanFile,
  type FileScanResult,
  type ScanFileOptions,
  MAX_SCANNED_BYTES,
} from "./scanner.js";
import type { CompiledCustomRule } from "./custom-rules.js";
import { getCacheEntry } from "./cache.js";
import { filterResultsWithBaseline, type BaselineFile } from "./baseline.js";
import { getDefaultConcurrency } from "./lib/output-args.js";

export interface ScanWorkerTask {
  id: number;
  path: string;
  content: string;
  customIgnores?: RegExp[] | undefined;
  options?: ScanFileOptions | CompiledCustomRule[] | undefined;
}

export interface ScanWorkerResponse {
  id: number;
  ok: boolean;
  result?: FileScanResult;
  error?: string;
}

/**
 * Worker pool options.
 */
export interface WorkerPoolOptions {
  /** Number of concurrent workers (defaults to CPU count) */
  concurrency?: number;
  /** Force in-process execution instead of worker threads (e.g. for testing) */
  inProcess?: boolean;
}

function resolveWorkerScriptPath(): string {
  const distSameDir = new URL("./scanner-worker.js", import.meta.url);
  if (fs.existsSync(distSameDir)) {
    return distSameDir.href;
  }
  const distFromSrc = new URL("../dist/scanner-worker.js", import.meta.url);
  if (fs.existsSync(distFromSrc)) {
    return distFromSrc.href;
  }
  const tsPath = new URL("./scanner-worker.ts", import.meta.url);
  if (fs.existsSync(tsPath)) {
    return tsPath.href;
  }
  return distSameDir.href;
}

interface WorkerState {
  worker: Worker | null;
  busy: boolean;
}

/**
 * Thread-safe worker pool for running file scans in parallel.
 */
export class WorkerPool {
  readonly concurrency: number;
  private readonly inProcess: boolean;
  private workers: WorkerState[] = [];
  private taskQueue: Array<{
    task: ScanWorkerTask;
    resolve: (res: FileScanResult) => void;
    reject: (err: Error) => void;
  }> = [];
  private initialized = false;
  private terminated = false;

  constructor(options: WorkerPoolOptions = {}) {
    this.concurrency = options.concurrency ?? getDefaultConcurrency();
    this.inProcess = options.inProcess ?? this.concurrency <= 1;
  }

  private initWorkers(): void {
    if (this.initialized || this.inProcess || this.concurrency <= 1) {
      this.initialized = true;
      return;
    }

    const workerUrl = resolveWorkerScriptPath();
    const count = this.concurrency;

    for (let i = 0; i < count; i++) {
      try {
        const worker = new Worker(new URL(workerUrl), {
          execArgv: process.execArgv,
        });
        const state: WorkerState = { worker, busy: false };

        worker.on("error", () => {
          state.busy = false;
          const idx = this.workers.indexOf(state);
          if (idx !== -1) {
            this.workers.splice(idx, 1);
          }
          this.processNextTask();
        });

        worker.on("exit", () => {
          state.busy = false;
          const idx = this.workers.indexOf(state);
          if (idx !== -1) {
            this.workers.splice(idx, 1);
          }
          this.processNextTask();
        });

        this.workers.push(state);
      } catch {
        // If thread creation fails (e.g. restricted environment), fall back to in-process
        break;
      }
    }

    this.initialized = true;
  }

  /**
   * Run a single file scan task through the pool.
   */
  async runTask(task: ScanWorkerTask): Promise<FileScanResult> {
    if (this.terminated) {
      throw new Error("Worker pool has been terminated");
    }

    // In-process execution (for concurrency: 1 or fallback)
    if (this.inProcess || this.concurrency <= 1) {
      return scanFile(task.path, task.content, task.customIgnores, task.options);
    }

    this.initWorkers();

    if (this.workers.length === 0) {
      return scanFile(task.path, task.content, task.customIgnores, task.options);
    }

    return new Promise<FileScanResult>((resolve, reject) => {
      this.taskQueue.push({ task, resolve, reject });
      this.processNextTask();
    });
  }

  private processNextTask(): void {
    if (this.taskQueue.length === 0) return;

    if (this.workers.length === 0) {
      while (this.taskQueue.length > 0) {
        const item = this.taskQueue.shift()!;
        try {
          const res = scanFile(
            item.task.path,
            item.task.content,
            item.task.customIgnores,
            item.task.options,
          );
          item.resolve(res);
        } catch (e: any) {
          item.reject(e);
        }
      }
      return;
    }

    // Find first idle worker
    const idle = this.workers.find((w) => !w.busy && w.worker);
    if (!idle || !idle.worker) return;

    const queueItem = this.taskQueue.shift();
    if (!queueItem) return;

    idle.busy = true;
    const { task, resolve, reject } = queueItem;

    const cleanup = () => {
      idle.worker?.off("message", onMessage);
      idle.worker?.off("error", onError);
    };

    const onMessage = (response: ScanWorkerResponse) => {
      if (response.id === task.id) {
        cleanup();
        idle.busy = false;
        if (response.ok && response.result) {
          resolve(response.result);
        } else {
          reject(new Error(response.error || "Worker scan error"));
        }
        this.processNextTask();
      }
    };

    const onError = (err: Error) => {
      cleanup();
      idle.busy = false;
      try {
        const res = scanFile(
          task.path,
          task.content,
          task.customIgnores,
          task.options,
        );
        resolve(res);
      } catch {
        reject(err);
      }
      this.processNextTask();
    };

    idle.worker.on("message", onMessage);
    idle.worker.once("error", onError);

    idle.worker.postMessage(task);
  }

  /**
   * Terminate all workers cleanly.
   */
  async terminate(): Promise<void> {
    this.terminated = true;
    const terminations = this.workers.map((w) => {
      if (w.worker) {
        return w.worker.terminate();
      }
      return Promise.resolve(0);
    });
    await Promise.all(terminations);
    this.workers = [];
  }
}

export interface ScanFilesInPoolOptions {
  pool?: WorkerPool | undefined;
  concurrency?: number | undefined;
  maxFileSizeBytes?: number | undefined;
  customIgnores?: RegExp[] | undefined;
  optionsOrCustomRules?: ScanFileOptions | CompiledCustomRule[] | undefined;
  repoRoot?: string | undefined;
  isDirMode?: boolean | undefined;
  isSinceMode?: boolean | undefined;
  isStagedMode?: boolean | undefined;
  noCache?: boolean | undefined;
  customCacheDir?: string | undefined;
  loadedBaseline?: BaselineFile | null | undefined;
  readStagedContent?: ((filePath: string) => string | null) | undefined;
  getStagedDiffLineNumbers?: ((filePath: string, repoRoot?: string) => Set<number> | null) | undefined;
  onProgress?: ((current: number, total: number, filePath: string) => void) | undefined;
  onNotice?: ((message: string) => void) | undefined;
  onError?: ((filePath: string, error: Error) => void) | undefined;
}

export interface ScanFilesInPoolResult {
  fileResults: FileScanResult[];
  unreadable: string[];
  newlyAnalyzed: Array<{ filePath: string; content: string; result: FileScanResult }>;
  stagedForAi: Array<{ path: string; content: string }>;
  cachedAiFindings: any[];
  analyzedCount: number;
  cachedCount: number;
  skippedCount: number;
  violationCount: number;
  baselineSuppressedCount: number;
  fileTimings: Map<string, { elapsedMs: number; cached: boolean }>;
}

/**
 * Scan a list of files concurrently using a worker pool.
 * Guarantees strictly deterministic output ordering matching filesToScan order.
 */
export async function scanFilesInPool(
  filesToScan: string[],
  options: ScanFilesInPoolOptions = {},
): Promise<ScanFilesInPoolResult> {
  const {
    concurrency = getDefaultConcurrency(),
    maxFileSizeBytes = MAX_SCANNED_BYTES,
    customIgnores,
    optionsOrCustomRules,
    repoRoot,
    isDirMode,
    isSinceMode,
    isStagedMode,
    noCache = false,
    customCacheDir,
    loadedBaseline,
    readStagedContent,
    getStagedDiffLineNumbers,
    onProgress,
    onNotice,
    onError,
  } = options;

  const total = filesToScan.length;
  const ownsPool = !options.pool;
  const pool = options.pool ?? new WorkerPool({ concurrency });

  interface ProcessedSlot {
    index: number;
    filePath: string;
    result?: FileScanResult;
    unreadable?: boolean;
    cached?: boolean;
    cachedAiFindings?: any[];
    newlyAnalyzed?: { filePath: string; content: string; result: FileScanResult };
    stagedForAi?: { path: string; content: string };
    elapsedMs: number;
    baselineSuppressed: number;
  }

  // Pre-allocate slots to maintain deterministic input order
  const slots: ProcessedSlot[] = new Array(total);
  let completed = 0;

  // Worker queue processing
  const tasksToProcess = filesToScan.map((filePath, index) => ({ filePath, index }));
  const workerQueue = [...tasksToProcess];

  const processFile = async (item: { filePath: string; index: number }) => {
    const { filePath, index } = item;
    const startFileTime = performance.now();
    let content: string | null = null;
    let baselineSuppressed = 0;

    // 1. File size check & reading
    if (isDirMode || isSinceMode) {
      try {
        const resolvedPath = repoRoot ? path.resolve(repoRoot, filePath) : filePath;
        if (fs.existsSync(resolvedPath)) {
          const stat = fs.statSync(resolvedPath);
          if (stat.size > maxFileSizeBytes) {
            const sizeKb = (stat.size / 1024).toFixed(1);
            const limitKb = (maxFileSizeBytes / 1024).toFixed(0);
            onNotice?.(
              `⚠️  [SecureFlow] Skipped ${filePath}: file size (${sizeKb} KB) exceeds limit (${limitKb} KB)`,
            );
            slots[index] = {
              index,
              filePath,
              result: {
                path: filePath,
                violations: [],
                skipped: `file size exceeds limit (${sizeKb} KB > ${limitKb} KB)`,
              },
              elapsedMs: performance.now() - startFileTime,
              baselineSuppressed: 0,
            };
            return;
          }
          content = fs.readFileSync(resolvedPath, "utf-8");
        } else if (readStagedContent) {
          content = readStagedContent(filePath);
        }
      } catch (err) {
        onError?.(filePath, err instanceof Error ? err : new Error(String(err)));
        content = null;
      }
    } else if (readStagedContent) {
      try {
        content = readStagedContent(filePath);
      } catch (err) {
        onError?.(filePath, err instanceof Error ? err : new Error(String(err)));
        content = null;
      }
    }

    if (content === null) {
      slots[index] = {
        index,
        filePath,
        unreadable: true,
        elapsedMs: performance.now() - startFileTime,
        baselineSuppressed: 0,
      };
      return;
    }

    // Secondary size check on content bytes
    const contentBytes = Buffer.byteLength(content, "utf-8");
    if (contentBytes > maxFileSizeBytes) {
      const sizeKb = (contentBytes / 1024).toFixed(1);
      const limitKb = (maxFileSizeBytes / 1024).toFixed(0);
      onNotice?.(
        `⚠️  [SecureFlow] Skipped ${filePath}: file size (${sizeKb} KB) exceeds limit (${limitKb} KB)`,
      );
      slots[index] = {
        index,
        filePath,
        result: {
          path: filePath,
          violations: [],
          skipped: `file size exceeds limit (${sizeKb} KB > ${limitKb} KB)`,
        },
        elapsedMs: performance.now() - startFileTime,
        baselineSuppressed: 0,
      };
      return;
    }

    // 2. Cache lookup
    const cached = !noCache
      ? getCacheEntry({ filePath, content, cacheDir: customCacheDir })
      : null;

    if (cached) {
      const elapsedMs = performance.now() - startFileTime;
      const result: FileScanResult = {
        ...cached.result,
        path: filePath,
      };

      if (isStagedMode && getStagedDiffLineNumbers) {
        const diffLines = getStagedDiffLineNumbers(filePath, repoRoot);
        if (diffLines && diffLines.size > 0) {
          result.violations = result.violations.filter((v) => diffLines.has(v.line));
        }
      }

      let effectiveResult = result;
      if (loadedBaseline) {
        const filtered = filterResultsWithBaseline([result], loadedBaseline);
        effectiveResult = filtered.results[0]!;
        baselineSuppressed = filtered.suppressedCount;
      }

      slots[index] = {
        index,
        filePath,
        result: effectiveResult,
        cached: true,
        cachedAiFindings: cached.aiFindings ? [...cached.aiFindings] : [],
        elapsedMs,
        baselineSuppressed,
      };
      return;
    }

    // 3. Scan execution via WorkerPool
    try {
      const task: ScanWorkerTask = {
        id: index,
        path: filePath,
        content,
      };
      if (customIgnores) {
        task.customIgnores = customIgnores;
      }
      if (optionsOrCustomRules) {
        task.options = optionsOrCustomRules;
      }
      const rawResult = await pool.runTask(task);

      if (isStagedMode && getStagedDiffLineNumbers) {
        const diffLines = getStagedDiffLineNumbers(filePath, repoRoot);
        if (diffLines && diffLines.size > 0) {
          rawResult.violations = rawResult.violations.filter((v) => diffLines.has(v.line));
        }
      }

      const elapsedMs = performance.now() - startFileTime;
      let effectiveResult = rawResult;
      if (loadedBaseline) {
        const filtered = filterResultsWithBaseline([rawResult], loadedBaseline);
        effectiveResult = filtered.results[0]!;
        baselineSuppressed = filtered.suppressedCount;
      }

      const slotItem: ProcessedSlot = {
        index,
        filePath,
        result: effectiveResult,
        cached: false,
        newlyAnalyzed: { filePath, content, result: rawResult },
        elapsedMs,
        baselineSuppressed,
      };
      if (!effectiveResult.skipped) {
        slotItem.stagedForAi = { path: filePath, content };
      }
      slots[index] = slotItem;
    } catch (err) {
      onError?.(filePath, err instanceof Error ? err : new Error(String(err)));
      slots[index] = {
        index,
        filePath,
        unreadable: true,
        elapsedMs: performance.now() - startFileTime,
        baselineSuppressed: 0,
      };
    }
  };

  // Run concurrency workers pulling from workerQueue
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, total || 1));
  const activeWorkers = Array.from({ length: effectiveConcurrency }, async () => {
    while (workerQueue.length > 0) {
      const item = workerQueue.shift();
      if (!item) break;
      await processFile(item);
      completed++;
      onProgress?.(completed, total, item.filePath);
    }
  });

  await Promise.all(activeWorkers);
  if (ownsPool) {
    await pool.terminate();
  }

  // Assemble final results strictly preserving deterministic input order
  const fileResults: FileScanResult[] = [];
  const unreadable: string[] = [];
  const newlyAnalyzed: Array<{ filePath: string; content: string; result: FileScanResult }> = [];
  const stagedForAi: Array<{ path: string; content: string }> = [];
  const cachedAiFindings: any[] = [];
  const fileTimings = new Map<string, { elapsedMs: number; cached: boolean }>();

  let analyzedCount = 0;
  let cachedCount = 0;
  let skippedCount = 0;
  let violationCount = 0;
  let baselineSuppressedCount = 0;

  for (let i = 0; i < total; i++) {
    const slot = slots[i];
    if (!slot) continue;

    fileTimings.set(slot.filePath, { elapsedMs: slot.elapsedMs, cached: Boolean(slot.cached) });
    baselineSuppressedCount += slot.baselineSuppressed;

    if (slot.unreadable) {
      unreadable.push(slot.filePath);
      continue;
    }

    if (slot.result) {
      fileResults.push(slot.result);
      violationCount += slot.result.violations.length;

      if (slot.result.skipped) {
        skippedCount++;
      }

      if (slot.cached) {
        cachedCount++;
        if (slot.cachedAiFindings && slot.cachedAiFindings.length > 0) {
          cachedAiFindings.push(
            ...slot.cachedAiFindings.map((f) => ({ ...f, fileLocation: slot.filePath })),
          );
        }
      } else {
        analyzedCount++;
        if (slot.newlyAnalyzed) {
          newlyAnalyzed.push(slot.newlyAnalyzed);
        }
        if (slot.stagedForAi) {
          stagedForAi.push(slot.stagedForAi);
        }
      }
    }
  }

  return {
    fileResults,
    unreadable,
    newlyAnalyzed,
    stagedForAi,
    cachedAiFindings,
    analyzedCount,
    cachedCount,
    skippedCount,
    violationCount,
    baselineSuppressedCount,
    fileTimings,
  };
}
