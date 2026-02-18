import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import type { Action, ActionNodeRunTask, ActionStatus, OperationMetaTaskExecution, RunReport } from "@moonrepo/types";

// --- Report loading ---

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadReport(workspaceRoot: string): Promise<RunReport | null> {
  for (const fileName of ["ciReport.json", "runReport.json"]) {
    const reportPath = path.join(workspaceRoot, ".moon/cache", fileName);
    core.debug(`Finding run report at ${reportPath}`);
    if (await fileExists(reportPath)) {
      core.debug("Found!");
      const content = await readFile(reportPath, { encoding: "utf8" });
      return JSON.parse(content) as RunReport;
    }
  }
  return null;
}

// --- Target parsing & log reading ---

interface TargetIdentity {
  project: string;
  task: string;
}

function encodeComponent(component: string): string {
  let encoded = component.replaceAll("/", "-");
  encoded = encoded.replace(/[.-]+$/, "");
  encoded = encoded.replace(/^[.-]+/, "");
  return encoded;
}

function parseTarget(target: string): TargetIdentity {
  const parts = target.split(":");
  return {
    project: parts[0] ?? "unknown",
    task: parts[1] ?? "unknown",
  };
}

function commandOf(action: Action): string | null {
  for (const operation of action.operations) {
    if (operation.meta.type === "task-execution") {
      return (operation.meta as OperationMetaTaskExecution).command ?? null;
    }
  }
  return null;
}

async function readTaskLogs(
  workspaceRoot: string,
  { project, task }: TargetIdentity,
): Promise<{ stdout: string; stderr: string }> {
  const statusDir = path.join(workspaceRoot, ".moon/cache/states", encodeComponent(project), encodeComponent(task));

  const stdoutPath = path.join(statusDir, "stdout.log");
  const stderrPath = path.join(statusDir, "stderr.log");

  const stdout = (await fileExists(stdoutPath)) ? await readFile(stdoutPath, { encoding: "utf8" }) : "";
  const stderr = (await fileExists(stderrPath)) ? await readFile(stderrPath, { encoding: "utf8" }) : "";

  return { stdout, stderr };
}

// --- Failure filtering ---

const FAILURE_STATUSES = new Set<ActionStatus>(["failed", "failed-and-abort"]);

function isFailedTask(action: Action): action is Action & { node: ActionNodeRunTask } {
  return action.node.action === "run-task" && FAILURE_STATUSES.has(action.status);
}

function isRunTask(action: Action): action is Action & { node: ActionNodeRunTask } {
  return action.node.action === "run-task";
}

function allRunTaskTargets(report: RunReport): Set<string> {
  const targets = new Set<string>();
  for (const action of report.actions) {
    if (isRunTask(action)) {
      const id = parseTarget(action.node.params.target);
      targets.add(`${id.project}:${id.task}`);
    }
  }
  return targets;
}

// --- Formatting helpers ---

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

type Octokit = ReturnType<typeof github.getOctokit>;

// --- Console output ---

interface FailedTaskInfo {
  target: string;
  error: string | null;
  command: string | null;
  stdout: string;
  stderr: string;
}

function emitConsoleOutput(failures: FailedTaskInfo[]): void {
  for (const failure of failures) {
    const stderrTrimmed = failure.stderr.trim();
    const stdoutTrimmed = failure.stdout.trim();

    if (stderrTrimmed !== "") {
      core.startGroup(`stderr for ${failure.target}`);
      core.info(stripAnsi(stderrTrimmed));
      core.endGroup();
    }

    if (stdoutTrimmed !== "") {
      core.startGroup(`stdout for ${failure.target}`);
      core.info(stripAnsi(stdoutTrimmed));
      core.endGroup();
    }
  }
}

// --- Markdown generation ---

function commentToken(id: string): string {
  return `<!-- moon-ci-booster-${id} -->`;
}
const GITHUB_COMMENT_MAX_SIZE = 65536;

function formatTaskComment(failure: FailedTaskInfo): string {
  const headerLines: string[] = [commentToken(failure.target), "", `## :x: \`${failure.target}\``, ""];

  if (failure.error) {
    headerLines.push(`**Error:** ${stripAnsi(failure.error)}`);
    headerLines.push("");
  }

  if (failure.command) {
    headerLines.push(`**Command:** \`${failure.command}\``);
    headerLines.push("");
  }

  const stderrTrimmed = failure.stderr.trim();
  const stdoutTrimmed = failure.stdout.trim();

  // Prefer stderr; fall back to stdout when stderr is empty
  const output = stderrTrimmed !== "" ? stderrTrimmed : stdoutTrimmed;
  const outputLabel = stderrTrimmed !== "" ? "stderr" : "stdout";

  if (output === "") {
    return headerLines.join("\n");
  }

  const outputStripped = stripAnsi(output);
  const header = headerLines.join("\n");
  const prefix = `<details><summary><strong>${outputLabel}</strong></summary>\n\n\`\`\`\n`;
  const suffix = "\n```\n\n</details>\n";
  const overhead = header.length + prefix.length + suffix.length;

  if (overhead + outputStripped.length <= GITHUB_COMMENT_MAX_SIZE) {
    return `${header}${prefix}${outputStripped}${suffix}`;
  }

  const truncationNotice = "\n\n> **Note:** Output was truncated to fit within GitHub comment size limits.\n";
  const budget = GITHUB_COMMENT_MAX_SIZE - overhead - truncationNotice.length - 2; // 2 for "… "
  const truncatedOutput = `… ${outputStripped.slice(-budget)}`;
  return `${header}${prefix}${truncatedOutput}${suffix}${truncationNotice}`;
}

function formatStepSummary(failures: FailedTaskInfo[]): string {
  const lines: string[] = [
    "## :x: Moon CI Failure Summary",
    "",
    `**${failures.length} task${failures.length === 1 ? "" : "s"} failed**`,
    "",
    "| Target | Error |",
    "| --- | --- |",
  ];

  for (const failure of failures) {
    const error = failure.error ? stripAnsi(failure.error) : "";
    lines.push(`| \`${failure.target}\` | ${error} |`);
  }

  lines.push("");
  return lines.join("\n");
}

function enforceCommentSizeLimit(markdown: string): string {
  if (markdown.length <= GITHUB_COMMENT_MAX_SIZE) {
    return markdown;
  }
  const truncationNotice = "\n\n> **Note:** Output was truncated to fit within GitHub comment size limits.\n";
  const budget = GITHUB_COMMENT_MAX_SIZE - truncationNotice.length;
  return markdown.slice(0, budget) + truncationNotice;
}

// --- PR commenting ---

async function resolvePRNumber(octokit: Octokit): Promise<number | null> {
  const {
    payload: { pull_request: pr, issue },
    repo,
  } = github.context;

  let id = pr?.number ?? issue?.number;

  if (!id) {
    core.debug("No pull request or issue found from context, trying to find pull requests associated with commit");
    const { data: pullRequests } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...repo,
      commit_sha: github.context.sha,
    });
    id = pullRequests[0]?.number;
  }

  if (!id) {
    core.warning("No pull request or issue found, will not add a comment.");
  }

  return id ?? null;
}

async function postOrUpdateComment(
  octokit: Octokit,
  prNumber: number,
  existingComments: Array<{ id: number; body?: string | null }>,
  markdown: string,
  token: string,
): Promise<void> {
  const { repo } = github.context;
  const existing = existingComments.find((c) => c.body?.includes(token));

  if (existing) {
    core.debug(`Updating existing comment #${existing.id} for token ${token}`);
    await octokit.rest.issues.updateComment({
      ...repo,
      body: markdown,
      comment_id: existing.id,
    });
  } else {
    core.debug(`Creating new comment for token ${token}`);
    await octokit.rest.issues.createComment({
      ...repo,
      body: markdown,
      issue_number: prNumber,
    });
  }
}

async function deletePassingComments(
  octokit: Octokit,
  existingComments: Array<{ id: number; body?: string | null }>,
  passingTargets: Set<string>,
): Promise<void> {
  const { repo } = github.context;

  for (const comment of existingComments) {
    if (!comment.body?.includes("<!-- moon-ci-booster-")) continue;

    const match = comment.body.match(/<!-- moon-ci-booster-(.+?) -->/);
    if (!match) continue;

    const target = match[1] as string;
    if (passingTargets.has(target)) {
      core.debug(`Deleting comment #${comment.id} for now-passing target ${target}`);
      await octokit.rest.issues.deleteComment({
        ...repo,
        comment_id: comment.id,
      });
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const accessToken = core.getInput("access-token");
  // biome-ignore lint/complexity/useLiteralKeys: TS strict requires bracket notation for index signatures
  const workspaceRoot = core.getInput("workspace-root") || process.env["GITHUB_WORKSPACE"] || process.cwd();
  core.debug(`Using workspace root ${workspaceRoot}`);

  if (!accessToken) {
    throw new Error("An `access-token` input is required.");
  }

  const report = await loadReport(workspaceRoot);
  if (!report) {
    core.warning("Run report does not exist, has `moon ci` or `moon run` ran?");
    core.setOutput("has-failures", "false");
    core.setOutput("comment-created", "false");
    return;
  }

  const failedActions = report.actions.filter(isFailedTask);

  if (failedActions.length === 0) {
    core.info("No failing tasks found.");
    core.setOutput("has-failures", "false");
    core.setOutput("comment-created", "false");

    // Clean up comments for tasks that passed in this shard
    // biome-ignore lint/complexity/useLiteralKeys: TS strict requires bracket notation for index signatures
    const inCI = !!process.env["GITHUB_REPOSITORY"];
    if (inCI) {
      const octokit = github.getOctokit(accessToken);
      const prNumber = await resolvePRNumber(octokit);
      if (prNumber) {
        const { data: comments } = await octokit.rest.issues.listComments({
          ...github.context.repo,
          issue_number: prNumber,
        });
        await deletePassingComments(octokit, comments, allRunTaskTargets(report));
      }
    }
    return;
  }

  core.setOutput("has-failures", "true");

  const failures: FailedTaskInfo[] = [];
  for (const action of failedActions) {
    const target = action.node.params.target;
    const identity = parseTarget(target);
    const { stdout, stderr } = await readTaskLogs(workspaceRoot, identity);

    failures.push({
      target: `${identity.project}:${identity.task}`,
      error: action.error ?? null,
      command: commandOf(action),
      stdout,
      stderr,
    });
  }

  emitConsoleOutput(failures);

  const summaryMarkdown = formatStepSummary(failures);
  core.setOutput("report", summaryMarkdown);
  await core.summary.addRaw(summaryMarkdown).write();

  // biome-ignore lint/complexity/useLiteralKeys: TS strict requires bracket notation for index signatures
  const inCI = !!process.env["GITHUB_REPOSITORY"];
  if (inCI) {
    const octokit = github.getOctokit(accessToken);
    try {
      const prNumber = await resolvePRNumber(octokit);
      if (!prNumber) {
        core.setOutput("comment-created", "false");
        return;
      }

      const { data: existingComments } = await octokit.rest.issues.listComments({
        ...github.context.repo,
        issue_number: prNumber,
      });

      const failedTargets = new Set(failures.map((f) => f.target));
      for (const failure of failures) {
        const markdown = enforceCommentSizeLimit(formatTaskComment(failure));
        const token = commentToken(failure.target);
        await postOrUpdateComment(octokit, prNumber, existingComments, markdown, token);
      }

      const passingTargets = allRunTaskTargets(report);
      for (const t of failedTargets) passingTargets.delete(t);
      await deletePassingComments(octokit, existingComments, passingTargets);

      core.setOutput("comment-created", "true");
    } catch (error: unknown) {
      core.warning(String(error));
      core.notice("\nFailed to create comment on pull request. Perhaps this is ran in a fork?\n");
      core.setOutput("comment-created", "false");
    }
  } else {
    core.debug("No GITHUB_REPOSITORY set, skipping PR comment");
    core.setOutput("comment-created", "false");
  }
}

try {
  await main();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
