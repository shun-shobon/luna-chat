import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { Octokit } from "octokit";

const packagePath = "package.json";
const preparationBranch = /^release\/prepare-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function updatePackageVersion(releaseType) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(packageJson.version);
  if (!match) {
    throw new Error(`Package version must be X.Y.Z: ${packageJson.version}`);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Package version is out of range: ${packageJson.version}`);
  }

  switch (releaseType) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
    default:
      throw new Error(`Unknown release type: ${releaseType}`);
  }

  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Next package version is out of range: ${packageJson.version}`);
  }

  const version = `${major}.${minor}.${patch}`;
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "oxfmt", packagePath], { stdio: "inherit" });
  return version;
}

async function closeExistingPreparationPullRequests(octokit, owner, repo) {
  const openPullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    base: "main",
    state: "open",
    per_page: 100,
  });

  for (const pullRequest of openPullRequests) {
    if (
      pullRequest.head.repo?.full_name !== `${owner}/${repo}` ||
      !preparationBranch.test(pullRequest.head.ref)
    ) {
      continue;
    }

    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pullRequest.number,
      state: "closed",
    });
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${pullRequest.head.ref}` });
  }
}

async function createReleasePullRequest(octokit, owner, repo, baseSha, version) {
  const tag = `v${version}`;
  const branch = `release/prepare-${tag}`;
  const { data: currentFile } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: packagePath,
    ref: baseSha,
  });
  if (
    Array.isArray(currentFile) ||
    currentFile.type !== "file" ||
    typeof currentFile.sha !== "string"
  ) {
    throw new Error("Invalid package.json response from GitHub");
  }

  await closeExistingPreparationPullRequests(octokit, owner, repo);
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: packagePath,
    branch,
    sha: currentFile.sha,
    content: readFileSync(packagePath).toString("base64"),
    message: `chore: バージョンを ${tag} に更新\n\nリリース準備のため package.json のバージョンを更新する。`,
  });

  const { data: pullRequest } = await octokit.rest.pulls.create({
    owner,
    repo,
    base: "main",
    head: branch,
    title: `chore: ${tag} のリリースを準備`,
    body: `package.json のバージョンを ${version} に更新します。マージ後に公開ワークフローが実行されます。`,
  });
  return pullRequest.html_url;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const baseSha = process.env.GITHUB_SHA;
  if (!token || !repository || !baseSha) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA are required");
  }
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Release preparation must run from main");
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }

  const version = updatePackageVersion(process.argv[2]);
  const octokit = new Octokit({ auth: token });
  console.log(await createReleasePullRequest(octokit, owner, repo, baseSha, version));
}

await main();
