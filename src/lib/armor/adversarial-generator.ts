/**
 * Adversarial String & Payload Generator for ReDoS & Regex Performance Testing (#1517).
 *
 * Uses a deterministic seeded PRNG (Mulberry32) to generate reproducible test vectors:
 * - Long repeated character sequences
 * - Detector-specific near-matches (AWS, GitHub, Slack, PEM, Quoted Assignments)
 * - Pathological backtracking triggers
 * - Seeded random fuzzed strings
 * - Large multi-line synthetic code files for performance regression benchmarking
 */

export const DEFAULT_ADVERSARIAL_SEED = 0x1517;

/**
 * Fast, deterministic 32-bit PRNG (Mulberry32).
 * Produces identical sequences across platforms for the same seed.
 */
export class SeededPRNG {
  private state: number;

  constructor(seed: number = DEFAULT_ADVERSARIAL_SEED) {
    this.state = seed >>> 0;
  }

  /**
   * Generates a pseudo-random float in [0, 1).
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generates a pseudo-random integer in [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Picks a random item from a non-empty array.
   */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(0, items.length - 1)]!;
  }

  /**
   * Generates a random alphanumeric string of length `len`.
   */
  string(
    len: number,
    charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-",
  ): string {
    let result = "";
    for (let i = 0; i < len; i++) {
      result += charset[this.nextInt(0, charset.length - 1)];
    }
    return result;
  }
}

/**
 * Error thrown when a regular expression exceeds its allowed execution time budget.
 */
export class RegexBudgetExceededError extends Error {
  constructor(regexStr: string, durationMs: number, budgetMs: number) {
    super(
      `Evaluation of regex ${regexStr} exceeded time budget of ${budgetMs}ms (took ${durationMs.toFixed(2)}ms)`,
    );
    this.name = "RegexBudgetExceededError";
  }
}

/**
 * Asserts that evaluating a RegExp against an input string completes within a specified time budget.
 *
 * @param regex - The regular expression to evaluate.
 * @param input - The input string to test.
 * @param budgetMs - Maximum allowed execution time in milliseconds (default: 25ms).
 * @returns The measured execution duration in milliseconds.
 * @throws {RegexBudgetExceededError} If execution duration exceeds `budgetMs`.
 */
export function assertRegexFinishesWithinBudget(
  regex: RegExp,
  input: string,
  budgetMs = 25,
): number {
  regex.lastIndex = 0;
  const start = performance.now();

  // Test regex matching execution
  regex.exec(input);

  const durationMs = performance.now() - start;
  regex.lastIndex = 0;

  if (durationMs > budgetMs) {
    throw new RegexBudgetExceededError(regex.toString(), durationMs, budgetMs);
  }

  return durationMs;
}

/**
 * Generates deterministic adversarial test vectors designed to stress regex engines:
 * - Long repeated characters
 * - Near-matches for AWS, GitHub, Slack, PEM, Quoted Assignments
 * - Pathological backtracking structures
 * - Seeded random fuzz strings
 */
export function generateAdversarialTestVectors(
  seed: number = DEFAULT_ADVERSARIAL_SEED,
): string[] {
  const prng = new SeededPRNG(seed);
  const vectors: string[] = [];

  // 1. Long repeated character sequences (stress character classes and greedy matches)
  const repeatChars = ["a", "A", "0", " ", "\t", "-", "_", "=", ":", '"', "'", "/", "\\"];
  const lengths = [1000, 5000, 15000];
  for (const ch of repeatChars) {
    for (const len of lengths) {
      vectors.push(ch.repeat(len));
    }
  }

  // 2. AWS Access Key ID near-matches
  // Pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g
  vectors.push(
    "AKIA" + "A".repeat(15), // 1 short of 16
    "AKIA" + "A".repeat(17), // 1 longer than 16
    "AKIA" + "0".repeat(5000), // Massive trailing run
    "AKIA" + "!@#$%^&*()_+-=[]{}|;", // Invalid characters
    "AKIA".repeat(1000), // Repeated prefix
    "ASIA" + "Z".repeat(5000),
    "ABIA" + "1".repeat(5000),
    "ACCA" + "9".repeat(5000),
    "AKI" + "A".repeat(5000), // Incomplete prefix
    "const AWS_KEY = 'AKIA" + "B".repeat(15) + "';", // In code context (1 short)
    "const AWS_KEY = 'AKIA" + "B".repeat(17) + "';", // In code context (1 long)
  );

  // 3. GitHub Token near-matches
  // Pattern: /\b(?:gh[oprsu]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g
  vectors.push(
    "ghp_" + "a".repeat(35), // 1 short of 36
    "ghp_" + "a".repeat(37), // 1 longer
    "ghp_" + "a".repeat(5000), // Massive alphanumeric run
    "ghp_".repeat(1000), // Repeated prefix
    "github_pat_" + "x".repeat(21), // 1 short of 22
    "github_pat_" + "_".repeat(5000), // Underscore flood
    "github_pat_".repeat(500),
    "gho_" + "1".repeat(5000),
    "ghu_" + "2".repeat(5000),
    "ghs_" + "3".repeat(5000),
    "ghr_" + "4".repeat(5000),
    "ghx_" + "a".repeat(36), // Invalid prefix letter
  );

  // 4. Slack Token near-matches
  // Pattern: /\bxox[baprse]-[a-zA-Z0-9-]{10,}\b/g
  vectors.push(
    "xoxb-" + "a".repeat(9), // 1 short of 10
    "xoxb-" + "-".repeat(5000), // Hyphen flood
    "xoxb-".repeat(1000), // Repeated prefix
    "xox" + "-".repeat(5000), // Missing suffix letter
    "xoxp-" + "a".repeat(5000),
    "xoxa-" + "b".repeat(5000),
    "xoxr-" + "c".repeat(5000),
    "xoxs-" + "d".repeat(5000),
    "xoxe-" + "e".repeat(5000),
    "xoxz-" + "a".repeat(20), // Invalid type character
  );

  // 5. PEM Private Key near-matches
  // Pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g
  vectors.push(
    "-----BEGIN ", // Unclosed header
    "-----BEGIN RSA PRIVATE KEY", // Missing closing dashes
    "-----BEGIN " + "RSA ".repeat(1000), // Repeated algorithm
    "-----BEGIN " + "PRIVATE KEY-----".repeat(500),
    "-".repeat(2000) + "BEGIN PRIVATE KEY",
    "-----BEGIN FOOBAR PRIVATE KEY-----", // Unknown type
    "-----BEGIN RSA PUBLIC KEY-----", // Public key instead of private
    "-----BEGIN PRIVATE KEY" + "-".repeat(2000),
  );

  // 6. Quoted Secret Assignment near-matches
  // Pattern: /(?:(?<=[^\w])|^)(?:[a-zA-Z0-9_.-]*(?:secret|token|password|passwd|pwd|api_key|apikey)[a-zA-Z0-9_.-]*)\s*[:=]\s*(["'`])([^"'\`\n]{16,})\1/gi
  vectors.push(
    'const secret = "' + "a".repeat(10000), // Unclosed double quote
    "const secret = '" + "b".repeat(10000), // Unclosed single quote
    "const secret = `" + "c".repeat(10000), // Unclosed backtick
    'password = "' + "a".repeat(15) + '";', // 15 chars (1 short of 16-char threshold)
    'token = "' + "a".repeat(10000) + '"', // Extremely long quoted payload
    'secret_token_password_apikey = "' + "x".repeat(5000) + '"',
    "const " + "secret_".repeat(500) + 'token = "supersecretvalue123456";', // Massive variable name
    "password: " + "=:".repeat(1000) + ' "val";', // Repeated assignment operators
    'api_key: ' + '"'.repeat(1000), // Quote storm
    'const pwd = "' + "escaped\\\"quote\\\"".repeat(200) + '";', // Escaped quotes
    'api_key = "placeholder_changeme_example";', // Placeholder value
  );

  // 7. Pathological backtracking & delimiter stress patterns
  vectors.push(
    "(((((((((".repeat(200) + ")))))))))".repeat(200),
    "secretpasswordtokenapikey".repeat(200),
    "::==::==::".repeat(500),
    "a=b;a=b;a=b;".repeat(500),
    "/* " + "*".repeat(5000) + " */",
    "// " + "comment ".repeat(1000),
  );

  // 8. Deterministic random fuzz strings (seeded)
  for (let i = 0; i < 20; i++) {
    const len = prng.nextInt(500, 3000);
    const fuzzType = prng.nextInt(0, 3);
    if (fuzzType === 0) {
      vectors.push(prng.string(len));
    } else if (fuzzType === 1) {
      vectors.push("const " + prng.string(20) + ' = "' + prng.string(len) + '";');
    } else if (fuzzType === 2) {
      vectors.push("AKIA" + prng.string(len, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
    } else {
      vectors.push("ghp_" + prng.string(len, "abcdefghijklmnopqrstuvwxyz0123456789"));
    }
  }

  return vectors;
}

/**
 * Generates an array of line objects representing a large synthetic source file (~250 KB - 500 KB)
 * containing realistic code interleaved with near-matches and adversarial strings for benchmark testing.
 */
export function generateLargeSyntheticFileLines(
  prng: SeededPRNG = new SeededPRNG(DEFAULT_ADVERSARIAL_SEED),
  lineCount = 5000,
): Array<{ number: number; content: string }> {
  const lines: Array<{ number: number; content: string }> = [];

  const keywords = ["secret", "token", "password", "apiKey", "auth", "session", "credential"];
  const varTypes = ["const", "let", "var", "readonly"];

  for (let i = 1; i <= lineCount; i++) {
    let content = "";
    const lineType = i % 10;

    switch (lineType) {
      case 0:
        // Realistic function or class declaration
        content = `export function processHandler${i}(payload: Record<string, unknown>): boolean {`;
        break;
      case 1:
        // Normal variable assignment
        content = `  const counter_${i} = ${i * 42};`;
        break;
      case 2:
        // Benign string variable
        content = `  const label_${i} = "item_${i}_${prng.string(12)}";`;
        break;
      case 3:
        // Code comment
        content = `  // Step ${i}: Compute checksum and validate payload integrity`;
        break;
      case 4:
        // Near-match: AWS-like prefix with non-matching length
        content = `  const awsRef_${i} = "AKIA${prng.string(12, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}";`;
        break;
      case 5:
        // Near-match: GitHub-like prefix with invalid suffix
        content = `  const ghRef_${i} = "ghp_${prng.string(10, "abcdefghijklmnopqrstuvwxyz0123456789")}";`;
        break;
      case 6:
        // Near-match: Secret variable name with low-entropy value (exempt per #1517)
        content = `  ${prng.pick(varTypes)} ${prng.pick(keywords)}_${i} = "aaaaaaaaaaaaaaaa";`;
        break;
      case 7:
        // Near-match: Secret variable name with placeholder (exempt per #1517)
        content = `  ${prng.pick(varTypes)} ${prng.pick(keywords)}_${i} = "changeme-placeholder-${i}";`;
        break;
      case 8:
        // Repeated characters / delimiter stress line
        content = `  const buffer_${i} = "${"x".repeat(60)}";`;
        break;
      case 9:
        // Block closing
        content = `  return counter_${i} > 0;\n}`;
        break;
    }

    lines.push({ number: i, content });
  }

  return lines;
}
