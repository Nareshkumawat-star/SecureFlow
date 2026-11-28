/**
 * Dedicated Worker Thread for CPU-bound file scanning (#2231).
 */

import { parentPort } from "node:worker_threads";
import { scanFile, type FileScanResult, type ScanFileOptions } from "./scanner.js";
import type { CompiledCustomRule } from "./custom-rules.js";

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

if (parentPort) {
  parentPort.on("message", (task: ScanWorkerTask) => {
    try {
      const { id, path, content, customIgnores, options } = task;
      const result = scanFile(path, content, customIgnores, options);
      parentPort!.postMessage({ id, ok: true, result } satisfies ScanWorkerResponse);
    } catch (err) {
      parentPort!.postMessage({
        id: task?.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ScanWorkerResponse);
    }
  });
}
