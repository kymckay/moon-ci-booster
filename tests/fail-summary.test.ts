import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const indexJs = path.resolve("dist/index.js");

let tempDir: string;
let summaryFile: string;
let outputFile: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fail-summary-test-"));
  summaryFile = path.join(tempDir, "summary.md");
  outputFile = path.join(tempDir, "output.txt");
  fs.writeFileSync(summaryFile, "");
  fs.writeFileSync(outputFile, "");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function stripDebug(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.startsWith("::debug::"))
    .join("\n");
}

function baseEnv() {
  return {
    "INPUT_ACCESS-TOKEN": "fake-token-for-tests",
    "INPUT_WORKSPACE-ROOT": "",
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_WORKSPACE: "",
    GITHUB_REPOSITORY: "",
  };
}

describe("failures with default settings", () => {
  let stdout: string;

  beforeEach(async () => {
    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    const result = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
    stdout = result.stdout;
  });

  test("console output contains collapsible blocks for all tasks", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("step summary is a lightweight table", () => {
    const summary = fs.readFileSync(summaryFile, "utf8");
    expect(summary).toMatchSnapshot();
  });

  test("outputs contain has-failures and report", () => {
    const output = fs.readFileSync(outputFile, "utf8");
    expect(output).toMatch(/has-failures<<.*\ntrue\n/);
    expect(output).toMatch(/report<<.*\n/);
  });

  test("ansi codes are stripped from error messages", () => {
    const summary = fs.readFileSync(summaryFile, "utf8");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
    expect(summary).not.toMatch(/\u001b/);
  });
});

describe("no failures", () => {
  let stdout: string;

  beforeEach(async () => {
    const cwd = path.join(import.meta.dirname, "workspaces/no-failures");
    const result = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
    stdout = result.stdout;
  });

  test("console output", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("has-failures is false", () => {
    const output = fs.readFileSync(outputFile, "utf8");
    expect(output).toMatch(/has-failures<<.*\nfalse\n/);
  });
});

test("no report warns gracefully", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/no-report");
  const { stdout } = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
  expect(stripDebug(stdout)).toMatchSnapshot();
});

describe("per-task PR comments", () => {
  let server: http.Server;
  let createdComments: string[];
  let stdout: string;

  beforeEach(async () => {
    createdComments = [];

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (req.url?.includes("/commits/") && req.url?.includes("/pulls")) {
        res.end(JSON.stringify([{ number: 42 }]));
      } else if (req.url?.includes("/issues/42/comments") && req.method === "GET") {
        res.end(JSON.stringify([]));
      } else if (req.url?.includes("/issues/42/comments") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          createdComments.push(JSON.parse(body).body);
          res.end(JSON.stringify({ id: createdComments.length }));
        });
        return;
      } else {
        res.end(JSON.stringify([]));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    const result = await $({
      cwd,
      env: {
        ...process.env,
        ...baseEnv(),
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    })`node ${indexJs}`;

    stdout = result.stdout;
  });

  afterEach(() => {
    server.close();
  });

  test("creates one comment per failing task", () => {
    expect(createdComments).toHaveLength(3);
  });

  test("each comment contains the correct comment token", () => {
    expect(createdComments[0]).toContain("<!-- moon-ci-booster-c:make-error -->");
    expect(createdComments[1]).toContain("<!-- moon-ci-booster-b:make-error -->");
    expect(createdComments[2]).toContain("<!-- moon-ci-booster-a:make-error -->");
  });

  test("comments contain stderr but not stdout", () => {
    for (const comment of createdComments) {
      if (comment.includes("b:make-error")) {
        expect(comment).toContain("something went wrong in project b");
        expect(comment).not.toContain("Starting build");
        expect(comment).not.toContain("Compiling module B");
      }
    }
  });

  test("comment text matches snapshot", () => {
    expect(createdComments).toMatchSnapshot();
  });

  test("console output still contains collapsible blocks", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });
});

describe("stale comment deletion", () => {
  let server: http.Server;
  let deletedCommentIds: number[];

  beforeEach(async () => {
    deletedCommentIds = [];

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (req.url?.includes("/commits/") && req.url?.includes("/pulls")) {
        res.end(JSON.stringify([{ number: 42 }]));
      } else if (req.url?.includes("/issues/42/comments") && req.method === "GET") {
        // c:bar passed in this shard's report, so its comment (103) should be deleted.
        // c:make-error is still failing, so comment 100 should be kept (updated).
        // old:gone-task was NOT run by this shard, so comment 101 must be left alone.
        res.end(
          JSON.stringify([
            { id: 100, body: "<!-- moon-ci-booster-c:make-error -->\nold failure" },
            { id: 101, body: "<!-- moon-ci-booster-old:gone-task -->\nstale failure" },
            { id: 102, body: "unrelated comment" },
            { id: 103, body: "<!-- moon-ci-booster-c:bar -->\nold failure for now-passing task" },
          ]),
        );
      } else if (req.url?.includes("/issues/42/comments") && req.method === "POST") {
        req.on("data", () => {});
        req.on("end", () => {
          res.end(JSON.stringify({ id: 200 }));
        });
        return;
      } else if (req.url?.includes("/issues/comments/") && req.method === "PATCH") {
        req.on("data", () => {});
        req.on("end", () => {
          res.end(JSON.stringify({ id: 200 }));
        });
        return;
      } else if (req.url?.includes("/issues/comments/") && req.method === "DELETE") {
        const idMatch = req.url.match(/\/issues\/comments\/(\d+)/);
        if (idMatch) {
          deletedCommentIds.push(Number(idMatch[1]));
        }
        res.end(JSON.stringify({}));
      } else {
        res.end(JSON.stringify([]));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    await $({
      cwd,
      env: {
        ...process.env,
        ...baseEnv(),
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    })`node ${indexJs}`;
  });

  afterEach(() => {
    server.close();
  });

  test("deletes comment for now-passing task but keeps failed, unknown, and unrelated ones", () => {
    // Only c:bar (id 103) should be deleted — it passed in this shard.
    // old:gone-task (id 101) is NOT deleted because this shard didn't run it.
    expect(deletedCommentIds).toEqual([103]);
  });
});

describe("stderr truncation for large output", () => {
  let server: http.Server;
  let createdComments: string[];
  let workDir: string;

  beforeEach(async () => {
    createdComments = [];

    // Build a workspace with one failing task that has a massive stderr log
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "truncation-test-"));
    const statesDir = path.join(workDir, ".moon/cache/states/big/fail");
    fs.mkdirSync(statesDir, { recursive: true });

    // Create a stderr log well over the 65536 character limit
    const lineCount = 5000;
    const lines: string[] = [];
    for (let i = 1; i <= lineCount; i++) {
      lines.push(`line ${i}: ${"x".repeat(20)} some build output here`);
    }
    lines.push("FINAL ERROR: this is the important error at the end");
    fs.writeFileSync(path.join(statesDir, "stderr.log"), lines.join("\n"));
    fs.writeFileSync(path.join(statesDir, "stdout.log"), "");

    const ciReport = {
      actions: [
        {
          allowFailure: false,
          createdAt: "2024-07-14T09:03:50.544893399",
          duration: { secs: 0, nanos: 100000 },
          error: "Task big:fail failed.",
          finishedAt: "2024-07-14T09:03:50.545018275",
          flaky: false,
          label: "RunTask(big:fail)",
          node: {
            action: "run-task",
            params: {
              args: [],
              env: {},
              interactive: false,
              persistent: false,
              runtime: { platform: "system", requirement: null, overridden: false },
              target: "big:fail",
              timeout: null,
              id: 0,
            },
          },
          nodeIndex: 1,
          operations: [],
          startedAt: "2024-07-14T09:03:50.544950983",
          status: "failed",
        },
      ],
      context: {
        affectedOnly: false,
        initialTargets: [],
        passthroughArgs: [],
        primaryTargets: ["big:fail"],
        profile: null,
        targetStates: {},
        touchedFiles: [],
      },
      duration: { secs: 0, nanos: 100000 },
    };
    fs.writeFileSync(path.join(workDir, ".moon/cache/ciReport.json"), JSON.stringify(ciReport));

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (req.url?.includes("/commits/") && req.url?.includes("/pulls")) {
        res.end(JSON.stringify([{ number: 99 }]));
      } else if (req.url?.includes("/issues/99/comments") && req.method === "GET") {
        res.end(JSON.stringify([]));
      } else if (req.url?.includes("/issues/99/comments") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          createdComments.push(JSON.parse(body).body);
          res.end(JSON.stringify({ id: 1 }));
        });
        return;
      } else {
        res.end(JSON.stringify([]));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await $({
      cwd: workDir,
      env: {
        ...process.env,
        ...baseEnv(),
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    })`node ${indexJs}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test("truncates from the start of stderr, preserving the end", () => {
    expect(createdComments).toHaveLength(1);
    const comment = createdComments[0];

    // The comment must fit within GitHub's limit
    expect(comment.length).toBeLessThanOrEqual(65536);

    // The important error at the end should be preserved
    expect(comment).toContain("FINAL ERROR: this is the important error at the end");

    // Early lines should be truncated away
    expect(comment).not.toContain("line 1:");

    // Should show truncation indicator and notice
    expect(comment).toContain("…");
    expect(comment).toContain("Output was truncated");
  });
});

describe("stdout fallback when stderr is empty", () => {
  let server: http.Server;
  let createdComments: string[];
  let workDir: string;

  beforeEach(async () => {
    createdComments = [];

    // Build a workspace with one failing task that has stdout but no stderr
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdout-fallback-test-"));
    const statesDir = path.join(workDir, ".moon/cache/states/app/build");
    fs.mkdirSync(statesDir, { recursive: true });

    fs.writeFileSync(path.join(statesDir, "stderr.log"), "");
    fs.writeFileSync(
      path.join(statesDir, "stdout.log"),
      "Compiling app...\nModule not found: @missing/dep\nBuild failed with 1 error\n",
    );

    const ciReport = {
      actions: [
        {
          allowFailure: false,
          createdAt: "2024-07-14T09:03:50.544893399",
          duration: { secs: 0, nanos: 100000 },
          error: "Task app:build failed.",
          finishedAt: "2024-07-14T09:03:50.545018275",
          flaky: false,
          label: "RunTask(app:build)",
          node: {
            action: "run-task",
            params: {
              args: [],
              env: {},
              interactive: false,
              persistent: false,
              runtime: { platform: "system", requirement: null, overridden: false },
              target: "app:build",
              timeout: null,
              id: 0,
            },
          },
          nodeIndex: 1,
          operations: [],
          startedAt: "2024-07-14T09:03:50.544950983",
          status: "failed",
        },
      ],
      context: {
        affectedOnly: false,
        initialTargets: [],
        passthroughArgs: [],
        primaryTargets: ["app:build"],
        profile: null,
        targetStates: {},
        touchedFiles: [],
      },
      duration: { secs: 0, nanos: 100000 },
    };
    fs.writeFileSync(path.join(workDir, ".moon/cache/ciReport.json"), JSON.stringify(ciReport));

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (req.url?.includes("/commits/") && req.url?.includes("/pulls")) {
        res.end(JSON.stringify([{ number: 99 }]));
      } else if (req.url?.includes("/issues/99/comments") && req.method === "GET") {
        res.end(JSON.stringify([]));
      } else if (req.url?.includes("/issues/99/comments") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          createdComments.push(JSON.parse(body).body);
          res.end(JSON.stringify({ id: 1 }));
        });
        return;
      } else {
        res.end(JSON.stringify([]));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await $({
      cwd: workDir,
      env: {
        ...process.env,
        ...baseEnv(),
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    })`node ${indexJs}`;
  });

  afterEach(() => {
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test("falls back to stdout in the PR comment when stderr is empty", () => {
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0]).toMatchSnapshot();
  });
});
