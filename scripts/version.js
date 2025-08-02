/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// A script to handle versioning and ensure all related changes are in a single, atomic commit.

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// 1. Get the version type from the command line arguments.
const versionType = process.argv[2];
if (!versionType) {
  console.error('Error: No version type specified.');
  console.error('Usage: npm run version <patch|minor|major|prerelease>');
  process.exit(1);
}

// 2. Bump the version in the root and all workspace package.json files.
run(`npm version ${versionType} --no-git-tag-version --allow-same-version`);

// 3. Get all workspaces and filter out the one we don't want to version.
const workspacesToExclude = ['gemini-cli-vscode-ide-companion'];
const lsOutput = JSON.parse(
  execSync('npm ls --workspaces --json --depth=0').toString(),
);
const allWorkspaces = Object.keys(lsOutput.dependencies || {});
const workspacesToVersion = allWorkspaces.filter(
  (wsName) => !workspacesToExclude.includes(wsName),
);

for (const workspaceName of workspacesToVersion) {
  run(
    `npm version ${versionType} --workspace ${workspaceName} --no-git-tag-version --allow-same-version`,
  );
}

// 4. Get the new version number from the root package.json
const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const newVersion = readJson(rootPackageJsonPath).version;

// 4. Update the sandboxImageUri in the root package.json
const rootPackageJson = readJson(rootPackageJsonPath);
if (rootPackageJson.config?.sandboxImageUri) {
  rootPackageJson.config.sandboxImageUri =
    rootPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(`Updated sandboxImageUri in root to use version ${newVersion}`);
  writeJson(rootPackageJsonPath, rootPackageJson);
}

// 5. Update the sandboxImageUri in the cli package.json
const cliPackageJsonPath = resolve(process.cwd(), 'packages/cli/package.json');
const cliPackageJson = readJson(cliPackageJsonPath);
if (cliPackageJson.config?.sandboxImageUri) {
  cliPackageJson.config.sandboxImageUri =
    cliPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(
    `Updated sandboxImageUri in cli package to use version ${newVersion}`,
  );
  writeJson(cliPackageJsonPath, cliPackageJson);
}

// 6. Run `npm install` to update package-lock.json.
run('npm install');

console.log(`Successfully bumped versions to v${newVersion}.`);
