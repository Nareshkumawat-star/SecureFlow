import { describe, it, expect } from "vitest";
import { SECRET_FAMILIES, detectSecretsInAddedLines } from "./secret-detector";
import {
  SeededPRNG,
  DEFAULT_ADVERSARIAL_SEED,
  generateAdversarialTestVectors,
  generateLargeSyntheticFileLines,
  assertRegexFinishesWithinBudget,
  RegexBudgetExceededError,
} from "./adversarial-generator";

describe("Deterministic Secret Detector ReDoS & Adversarial Tests (#1517)", () => {
  it("generates deterministic adversarial test vectors from a fixed seed", () => {
    const vectorsRun1 = generateAdversarialTestVectors(DEFAULT_ADVERSARIAL_SEED);
    const vectorsRun2 = generateAdversarialTestVectors(DEFAULT_ADVERSARIAL_SEED);

    expect(vectorsRun1.length).toBeGreaterThan(50);
    expect(vectorsRun1).toEqual(vectorsRun2);
  });

  describe("Detector Time Budget Assertions", () => {
    const adversarialVectors = generateAdversarialTestVectors(DEFAULT_ADVERSARIAL_SEED);
    // Codebase standard ReDoS execution budget is 100ms (matches DEFAULT_REGEX_TIMEOUT_MS)
    const TIME_BUDGET_MS = 100;

    for (const family of SECRET_FAMILIES) {
      it(`family '${family.id}' (${family.name}) finishes within ${TIME_BUDGET_MS}ms across all adversarial vectors`, () => {
        for (const vector of adversarialVectors) {
          const duration = assertRegexFinishesWithinBudget(family.pattern, vector, TIME_BUDGET_MS);
          expect(duration).toBeLessThanOrEqual(TIME_BUDGET_MS);
        }
      });
    }
  });

  describe("Deliberately slow regex failure test", () => {
    it("fails the time budget assertion when evaluating a deliberately slow regex with catastrophic backtracking", () => {
      // Known catastrophic backtracking regex with exponential O(2^n) time complexity
      const deliberatelySlowRegex = /(a+)+$/;
      // 22 characters triggers ~100-250ms of backtracking in V8, exceeding budget without timing out the runner
      const evilInput = "a".repeat(22) + "!";
      const strictBudgetMs = 10;

      expect(() => {
        assertRegexFinishesWithinBudget(deliberatelySlowRegex, evilInput, strictBudgetMs);
      }).toThrow(RegexBudgetExceededError);
    });

    it("verifies that multiple nested quantifier regexes trigger the time budget failure", () => {
      // Another classic ReDoS pattern: overlapping character classes with nested star
      const nestedGroupRegex = /^([a-zA-Z0-9]+)*$/;
      const evilPayload = "a".repeat(22) + "!";
      const strictBudgetMs = 10;

      expect(() => {
        assertRegexFinishesWithinBudget(nestedGroupRegex, evilPayload, strictBudgetMs);
      }).toThrow(RegexBudgetExceededError);
    });
  });

  describe("Full detector pipeline under adversarial stress", () => {
    it("processes all adversarial vectors through detectSecretsInAddedLines without hanging", () => {
      const adversarialVectors = generateAdversarialTestVectors(DEFAULT_ADVERSARIAL_SEED);
      const lines = adversarialVectors.map((content, idx) => ({
        number: idx + 1,
        content,
      }));

      const start = performance.now();
      const findings = detectSecretsInAddedLines("adversarial-test.ts", lines);
      const durationMs = performance.now() - start;

      // Entire batch of ~80 adversarial vectors must finish under 2.5s
      expect(durationMs).toBeLessThan(2500);
      expect(Array.isArray(findings)).toBe(true);
    });
  });

  describe("Large-file performance regression benchmark", () => {
    const LINE_COUNT = 5000;
    const REGRESSION_THRESHOLD_MS = 600; // Strict regression threshold in ms

    it(`scans a ${LINE_COUNT}-line file with mixed code and near-matches in under ${REGRESSION_THRESHOLD_MS}ms`, () => {
      const prng = new SeededPRNG(DEFAULT_ADVERSARIAL_SEED);
      const largeFileLines = generateLargeSyntheticFileLines(prng, LINE_COUNT);

      const start = performance.now();
      const findings = detectSecretsInAddedLines("synthetic-large-repo.ts", largeFileLines);
      const durationMs = performance.now() - start;

      const linesPerSec = Math.round(LINE_COUNT / (durationMs / 1000));
      console.log(
        `📊 [ReDoS Benchmark] Scanned ${LINE_COUNT} lines in ${durationMs.toFixed(1)}ms ` +
        `(${linesPerSec.toLocaleString()} lines/sec). Regression threshold: ${REGRESSION_THRESHOLD_MS}ms`,
      );

      expect(durationMs).toBeLessThan(REGRESSION_THRESHOLD_MS);
      expect(findings).toBeDefined();
    });
  });
});
