/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { EOL } from 'os';
import { spawn } from 'child_process';
import { globStream } from 'glob';
import { BaseTool, Kind, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { isGitRepository } from '../utils/gitUtils.js';
import { Config } from '../config/config.js';

// --- Interfaces ---

/**
 * Parameters for the GrepTool
 */
export interface GrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

// --- GrepLogic Class ---

/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export class GrepTool extends BaseTool<GrepToolParams, ToolResult> {
  static readonly Name = 'search_file_content'; // Keep static name

  constructor(private readonly config: Config) {
    super(
      GrepTool.Name,
      'SearchText',
      'Searches for a regular expression pattern within the content of files in a specified directory (or current working directory). Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers.',
      Kind.Search,
      {
        properties: {
          pattern: {
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
            type: Type.STRING,
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
            type: Type.STRING,
          },
          include: {
            description:
              "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
            type: Type.STRING,
          },
        },
        required: ['pattern'],
        type: Type.OBJECT,
      },
    );
  }

  // --- Validation Methods ---

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists.
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string {
    const targetPath = path.resolve(
      this.config.getTargetDir(),
      relativePath || '.',
    );

    // Security Check: Ensure the resolved path is still within the root directory.
    if (
      !targetPath.startsWith(this.config.getTargetDir()) &&
      targetPath !== this.config.getTargetDir()
    ) {
      throw new Error(
        `Path validation failed: Attempted path "${relativePath || '.'}" resolves outside the allowed root directory "${this.config.getTargetDir()}".`,
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(`Path does not exist: ${targetPath}`);
      }
      throw new Error(
        `Failed to access path stats for ${targetPath}: ${error}`,
      );
    }

    return targetPath;
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  validateToolParams(params: GrepToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern provided: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }

    try {
      this.resolveAndValidatePath(params.path);
    } catch (error) {
      return getErrorMessage(error);
    }

    return null; // Parameters are valid
  }

  // --- Core Execution ---

  /**
   * Executes the grep search with the given parameters
   * @param params Parameters for the grep search
   * @returns Result of the grep search
   */
  async execute(
    params: GrepToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Model provided invalid parameters. Error: ${validationError}`,
      };
    }

    let searchDirAbs: string;
    try {
      searchDirAbs = this.resolveAndValidatePath(params.path);
      const searchDirDisplay = params.path || '.';

      const matches: GrepMatch[] = await this.performGrepSearch({
        pattern: params.pattern,
        path: searchDirAbs,
        include: params.include,
        signal,
      });

      if (matches.length === 0) {
        const noMatchMsg = `No matches found for pattern "${params.pattern}" in path "${searchDirDisplay}"${params.include ? ` (filter: "${params.include}")` : ''}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }

      const matchesByFile = matches.reduce(
        (acc, match) => {
          const relativeFilePath =
            path.relative(
              searchDirAbs,
              path.resolve(searchDirAbs, match.filePath),
            ) || path.basename(match.filePath);
          if (!acc[relativeFilePath]) {
            acc[relativeFilePath] = [];
          }
          acc[relativeFilePath].push(match);
          acc[relativeFilePath].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {} as Record<string, GrepMatch[]>,
      );

      const matchCount = matches.length;
      const matchTerm = matchCount === 1 ? 'match' : 'matches';

      let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${params.pattern}" in path "${searchDirDisplay}"${params.include ? ` (filter: "${params.include}")` : ''}:\n---\n`;

      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }

      return {
        llmContent: llmContent.trim(),
        returnDisplay: `Found ${matchCount} ${matchTerm}`,
      };
    } catch (error) {
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  // --- Grep Implementation Logic ---

  /**
   * Checks if a command is available in the system's PATH.
   * @param {string} command The command name (e.g., 'git', 'grep').
   * @returns {Promise<boolean>} True if the command is available, false otherwise.
   */
  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const checkCommand = process.platform === 'win32' ? 'where' : 'command';
      const checkArgs =
        process.platform === 'win32' ? [command] : ['-v', command];
      try {
        const child = spawn(checkCommand, checkArgs, {
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Parses the standard output of grep-like commands (git grep, system grep).
   * Expects format: filePath:lineNumber:lineContent
   * Handles colons within file paths and line content correctly.
   * @param {string} output The raw stdout string.
   * @param {string} basePath The absolute directory the search was run from, for relative paths.
   * @returns {GrepMatch[]} Array of match objects.
   */
  private parseGrepOutput(output: string, basePath: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;

    const lines = output.split(EOL); // Use OS-specific end-of-line

    for (const line of lines) {
      if (!line.trim()) continue;

      // Find the index of the first colon.
      const firstColonIndex = line.indexOf(':');
      if (firstColonIndex === -1) continue; // Malformed

      // Find the index of the second colon, searching *after* the first one.
      const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
      if (secondColonIndex === -1) continue; // Malformed

      // Extract parts based on the found colon indices
      const filePathRaw = line.substring(0, firstColonIndex);
      const lineNumberStr = line.substring(
        firstColonIndex + 1,
        secondColonIndex,
      );
      const lineContent = line.substring(secondColonIndex + 1);

      const lineNumber = parseInt(lineNumberStr, 10);

      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);

        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          lineNumber,
          line: lineContent,
        });
      }
    }
    return results;
  }

  /**
   * Gets a description of the grep operation
   * @param params Parameters for the grep operation
   * @returns A string describing the grep
   */
  getDescription(params: GrepToolParams): string {
    let description = `'${params.pattern}'`;
    if (params.include) {
      description += ` in ${params.include}`;
    }
    if (params.path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        params.path,
      );
      if (resolvedPath === this.config.getTargetDir() || params.path === '.') {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(
          resolvedPath,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      }
    }
    return description;
  }

  /**
   * Performs the actual search using the prioritized strategies.
   * @param options Search options including pattern, absolute path, and include glob.
   * @returns A promise resolving to an array of match objects.
   */
  private async performGrepSearch(options: {
    pattern: string;
    path: string; // Expects absolute path
    include?: string;
    signal: AbortSignal;
  }): Promise<GrepMatch[]> {
    const { pattern, path: absolutePath, include } = options;
    let strategyUsed = 'none';

    try {
      // --- Strategy 1: git grep ---
      const isGit = isGitRepository(absolutePath);
      const gitAvailable = isGit && (await this.isCommandAvailable('git'));

      if (gitAvailable) {
        strategyUsed = 'git grep';
        const gitArgs = [
          'grep',
          '--untracked',
          '-n',
          '-E',
          '--ignore-case',
          pattern,
        ];
        if (include) {
          gitArgs.push('--', include);
        }

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('git', gitArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
            child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
            child.on('error', (err) =>
              reject(new Error(`Failed to start git grep: ${err.message}`)),
            );
            child.on('close', (code) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks).toString('utf8');
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else
                reject(
                  new Error(`git grep exited with code ${code}: ${stderrData}`),
                );
            });
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (gitError: unknown) {
          console.debug(
            `GrepLogic: git grep failed: ${getErrorMessage(gitError)}. Falling back...`,
          );
        }
      }

      // --- Strategy 2: System grep ---
      const grepAvailable = await this.isCommandAvailable('grep');
      if (grepAvailable) {
        strategyUsed = 'system grep';
        const grepArgs = ['-r', '-n', '-H', '-E'];
        const commonExcludes = ['.git', 'node_modules', 'bower_components'];
        commonExcludes.forEach((dir) => grepArgs.push(`--exclude-dir=${dir}`));
        if (include) {
          grepArgs.push(`--include=${include}`);
        }
        grepArgs.push(pattern);
        grepArgs.push('.');

        try {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('grep', grepArgs, {
              cwd: absolutePath,
              windowsHide: true,
            });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            const onData = (chunk: Buffer) => stdoutChunks.push(chunk);
            const onStderr = (chunk: Buffer) => {
              const stderrStr = chunk.toString();
              // Suppress common harmless stderr messages
              if (
                !stderrStr.includes('Permission denied') &&
                !/grep:.*: Is a directory/i.test(stderrStr)
              ) {
                stderrChunks.push(chunk);
              }
            };
            const onError = (err: Error) => {
              cleanup();
              reject(new Error(`Failed to start system grep: ${err.message}`));
            };
            const onClose = (code: number | null) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
              const stderrData = Buffer.concat(stderrChunks)
                .toString('utf8')
                .trim();
              cleanup();
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve(''); // No matches
              else {
                if (stderrData)
                  reject(
                    new Error(
                      `System grep exited with code ${code}: ${stderrData}`,
                    ),
                  );
                else resolve(''); // Exit code > 1 but no stderr, likely just suppressed errors
              }
            };

            const cleanup = () => {
              child.stdout.removeListener('data', onData);
              child.stderr.removeListener('data', onStderr);
              child.removeListener('error', onError);
              child.removeListener('close', onClose);
              if (child.connected) {
                child.disconnect();
              }
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onStderr);
            child.on('error', onError);
            child.on('close', onClose);
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (grepError: unknown) {
          console.debug(
            `GrepLogic: System grep failed: ${getErrorMessage(grepError)}. Falling back...`,
          );
        }
      }

      // --- Strategy 3: Pure JavaScript Fallback ---
      console.debug(
        'GrepLogic: Falling back to JavaScript grep implementation.',
      );
      strategyUsed = 'javascript fallback';
      const globPattern = include ? include : '**/*';
      const ignorePatterns = [
        '.git/**',
        'node_modules/**',
        'bower_components/**',
        '.svn/**',
        '.hg/**',
      ]; // Use glob patterns for ignores here

      const filesStream = globStream(globPattern, {
        cwd: absolutePath,
        dot: true,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
        signal: options.signal,
      });

      const regex = new RegExp(pattern, 'i');
      const allMatches: GrepMatch[] = [];

      for await (const filePath of filesStream) {
        const fileAbsolutePath = filePath as string;
        try {
          const content = await fsPromises.readFile(fileAbsolutePath, 'utf8');
          const lines = content.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              allMatches.push({
                filePath:
                  path.relative(absolutePath, fileAbsolutePath) ||
                  path.basename(fileAbsolutePath),
                lineNumber: index + 1,
                line,
              });
            }
          });
        } catch (readError: unknown) {
          // Ignore errors like permission denied or file gone during read
          if (!isNodeError(readError) || readError.code !== 'ENOENT') {
            console.debug(
              `GrepLogic: Could not read/process ${fileAbsolutePath}: ${getErrorMessage(readError)}`,
            );
          }
        }
      }

      return allMatches;
    } catch (error: unknown) {
      console.error(
        `GrepLogic: Error in performGrepSearch (Strategy: ${strategyUsed}): ${getErrorMessage(error)}`,
      );
      throw error; // Re-throw
    }
  }
}
