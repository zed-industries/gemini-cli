/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { PartUnion } from '@google/genai';
import mime from 'mime-types';
import { Client, ThreadId } from 'agentic-coding-protocol';
import { Buffer } from 'buffer';

// Constants for text file processing
const DEFAULT_MAX_LINES_TEXT_FILE = 2000;
const MAX_LINE_LENGTH_TEXT_FILE = 2000;

// Default values for encoding and separator format
export const DEFAULT_ENCODING: BufferEncoding = 'utf-8';

/**
 * Looks up the specific MIME type for a file path.
 * @param filePath Path to the file.
 * @returns The specific MIME type string (e.g., 'text/python', 'application/javascript') or undefined if not found or ambiguous.
 */
export function getSpecificMimeType(filePath: string): string | undefined {
  const lookedUpMime = mime.lookup(filePath);
  return typeof lookedUpMime === 'string' ? lookedUpMime : undefined;
}

/**
 * Checks if a path is within a given root directory.
 * @param pathToCheck The absolute path to check.
 * @param rootDirectory The absolute root directory.
 * @returns True if the path is within the root directory, false otherwise.
 */
export function isWithinRoot(
  pathToCheck: string,
  rootDirectory: string,
): boolean {
  const normalizedPathToCheck = path.normalize(pathToCheck);
  const normalizedRootDirectory = path.normalize(rootDirectory);

  // Ensure the rootDirectory path ends with a separator for correct startsWith comparison,
  // unless it's the root path itself (e.g., '/' or 'C:\').
  const rootWithSeparator =
    normalizedRootDirectory === path.sep ||
    normalizedRootDirectory.endsWith(path.sep)
      ? normalizedRootDirectory
      : normalizedRootDirectory + path.sep;

  return (
    normalizedPathToCheck === normalizedRootDirectory ||
    normalizedPathToCheck.startsWith(rootWithSeparator)
  );
}

interface FileStat {
  exists: boolean;
  isDirectory: boolean;
}
interface ReadFileOptions {
  limit?: number;
}

export abstract class ToolEnvironment {
  abstract stat(path: string): Promise<FileStat>;
  abstract readTextFile(path: string): Promise<string>;
  abstract readBinaryFile(
    path: string,
    options?: ReadFileOptions,
  ): Promise<Uint8Array>;
}

export class LocalToolEnvironment extends ToolEnvironment {
  async stat(path: string): Promise<FileStat> {
    if (!fs.existsSync(path)) {
      return { exists: false, isDirectory: false };
    }

    return { exists: true, isDirectory: fs.statSync(path).isDirectory() };
  }

  async readTextFile(path: string): Promise<string> {
    return await fs.promises.readFile(path, 'utf8');
  }

  async readBinaryFile(
    path: string,
    options: ReadFileOptions,
  ): Promise<Uint8Array> {
    if (options.limit !== undefined) {
      const buffer = Buffer.alloc(options.limit);
      const fd = fs.openSync(path, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, options.limit, 0);
      fs.closeSync(fd);
      return buffer.subarray(0, bytesRead);
    }
    return await fs.promises.readFile(path);
  }
}

export class AcpToolEnvironment extends ToolEnvironment {
  constructor(
    private client: Client,
    private threadId: ThreadId,
  ) {
    super();
  }

  stat(path: string): Promise<FileStat> {
    return this.client.stat({ path, threadId: this.threadId });
  }

  async readTextFile(path: string): Promise<string> {
    const file = await this.client.readTextFile({
      path,
      threadId: this.threadId,
    });
    return file.content;
  }

  async readBinaryFile(
    path: string,
    _options: ReadFileOptions,
  ): Promise<Uint8Array> {
    const file = await this.client.readBinaryFile({
      path,
      threadId: this.threadId,
    });
    return Buffer.from(file.content, 'base64');
  }
}

/**
 * Determines if a file is likely binary based on content sampling.
 * @param filePath Path to the file.
 * @returns True if the file appears to be binary.
 */
export async function isBinaryFile(
  filePath: string,
  env: ToolEnvironment,
): Promise<boolean> {
  try {
    const buffer = await env.readBinaryFile(filePath, { limit: 4096 });

    // Empty file is not considered binary for content checking
    if (buffer.length === 0) return false;

    let nonPrintableCount = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0) return true; // Null byte is a strong indicator
      if (buffer[i] < 9 || (buffer[i] > 13 && buffer[i] < 32)) {
        nonPrintableCount++;
      }
    }
    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / buffer.length > 0.3;
  } catch {
    // If any error occurs (e.g. file not found, permissions),
    // treat as not binary here; let higher-level functions handle existence/access errors.
    return false;
  }
}

/**
 * Detects the type of file based on extension and content.
 * @param filePath Path to the file.
 * @returns 'text', 'image', 'pdf', or 'binary'.
 */
export async function detectFileType(
  filePath: string,
  env: ToolEnvironment,
): Promise<'text' | 'image' | 'pdf' | 'binary'> {
  const ext = path.extname(filePath).toLowerCase();
  const lookedUpMimeType = mime.lookup(filePath); // Returns false if not found, or the mime type string

  if (lookedUpMimeType && lookedUpMimeType.startsWith('image/')) {
    return 'image';
  }
  if (lookedUpMimeType && lookedUpMimeType === 'application/pdf') {
    return 'pdf';
  }

  // Stricter binary check for common non-text extensions before content check
  // These are often not well-covered by mime-types or might be misidentified.
  if (
    [
      '.zip',
      '.tar',
      '.gz',
      '.exe',
      '.dll',
      '.so',
      '.class',
      '.jar',
      '.war',
      '.7z',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.odt',
      '.ods',
      '.odp',
      '.bin',
      '.dat',
      '.obj',
      '.o',
      '.a',
      '.lib',
      '.wasm',
      '.pyc',
      '.pyo',
    ].includes(ext)
  ) {
    return 'binary';
  }

  // Fallback to content-based check if mime type wasn't conclusive for image/pdf
  // and it's not a known binary extension.
  if (await isBinaryFile(filePath, env)) {
    return 'binary';
  }

  return 'text';
}

export interface ProcessedFileReadResult {
  llmContent: PartUnion; // string for text, Part for image/pdf/unreadable binary
  returnDisplay: string;
  error?: string; // Optional error message for the LLM if file processing failed
  isTruncated?: boolean; // For text files, indicates if content was truncated
  originalLineCount?: number; // For text files
  linesShown?: [number, number]; // For text files [startLine, endLine] (1-based for display)
}

/**
 * Reads and processes a single file, handling text, images, and PDFs.
 * @param filePath Absolute path to the file.
 * @param rootDirectory Absolute path to the project root for relative path display.
 * @param offset Optional offset for text files (0-based line number).
 * @param limit Optional limit for text files (number of lines to read).
 * @returns ProcessedFileReadResult object.
 */
export async function processSingleFileContent(
  filePath: string,
  rootDirectory: string,
  env: ToolEnvironment,
  offset?: number,
  limit?: number,
): Promise<ProcessedFileReadResult> {
  try {
    const stat = await env.stat(filePath);
    if (!stat.exists) {
      // Sync check is acceptable before async read
      return {
        llmContent: '',
        returnDisplay: 'File not found.',
        error: `File not found: ${filePath}`,
      };
    }
    if (stat.isDirectory) {
      return {
        llmContent: '',
        returnDisplay: 'Path is a directory.',
        error: `Path is a directory, not a file: ${filePath}`,
      };
    }

    const fileType = await detectFileType(filePath, env);
    const relativePathForDisplay = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');

    switch (fileType) {
      case 'binary': {
        return {
          llmContent: `Cannot display content of binary file: ${relativePathForDisplay}`,
          returnDisplay: `Skipped binary file: ${relativePathForDisplay}`,
        };
      }
      case 'text': {
        const content = await env.readTextFile(filePath);
        const lines = content.split('\n');
        const originalLineCount = lines.length;

        const startLine = offset || 0;
        const effectiveLimit =
          limit === undefined ? DEFAULT_MAX_LINES_TEXT_FILE : limit;
        // Ensure endLine does not exceed originalLineCount
        const endLine = Math.min(startLine + effectiveLimit, originalLineCount);
        // Ensure selectedLines doesn't try to slice beyond array bounds if startLine is too high
        const actualStartLine = Math.min(startLine, originalLineCount);
        const selectedLines = lines.slice(actualStartLine, endLine);

        let linesWereTruncatedInLength = false;
        const formattedLines = selectedLines.map((line) => {
          if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
            linesWereTruncatedInLength = true;
            return (
              line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '... [truncated]'
            );
          }
          return line;
        });

        const contentRangeTruncated = endLine < originalLineCount;
        const isTruncated = contentRangeTruncated || linesWereTruncatedInLength;

        let llmTextContent = '';
        if (contentRangeTruncated) {
          llmTextContent += `[File content truncated: showing lines ${actualStartLine + 1}-${endLine} of ${originalLineCount} total lines. Use offset/limit parameters to view more.]\n`;
        } else if (linesWereTruncatedInLength) {
          llmTextContent += `[File content partially truncated: some lines exceeded maximum length of ${MAX_LINE_LENGTH_TEXT_FILE} characters.]\n`;
        }
        llmTextContent += formattedLines.join('\n');

        return {
          llmContent: llmTextContent,
          returnDisplay: isTruncated ? '(truncated)' : '',
          isTruncated,
          originalLineCount,
          linesShown: [actualStartLine + 1, endLine],
        };
      }
      case 'image':
      case 'pdf': {
        const contentBuffer = await fs.promises.readFile(filePath);
        const base64Data = contentBuffer.toString('base64');
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: mime.lookup(filePath) || 'application/octet-stream',
            },
          },
          returnDisplay: `Read ${fileType} file: ${relativePathForDisplay}`,
        };
      }
      default: {
        // Should not happen with current detectFileType logic
        const exhaustiveCheck: never = fileType;
        return {
          llmContent: `Unhandled file type: ${exhaustiveCheck}`,
          returnDisplay: `Skipped unhandled file type: ${relativePathForDisplay}`,
          error: `Unhandled file type for ${filePath}`,
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const displayPath = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');
    return {
      llmContent: `Error reading file ${displayPath}: ${errorMessage}`,
      returnDisplay: `Error reading file ${displayPath}: ${errorMessage}`,
      error: `Error reading file ${filePath}: ${errorMessage}`,
    };
  }
}
