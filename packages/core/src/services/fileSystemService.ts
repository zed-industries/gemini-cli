/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';

/**
 * Options for FileSystemService operations
 */
export interface FileSystemServiceOptions {
  /** Optional line number to start reading from (1-based) */
  line?: number;
  /** Optional maximum number of lines to read */
  limit?: number;
}

/**
 * Interface for file system operations that may be delegated to different implementations
 */
export interface FileSystemService {
  /**
   * Read text content from a file
   *
   * @param filePath - The path to the file to read
   * @param options - Optional reading options (line offset and limit)
   * @returns The file content as a string
   */
  readTextFile(
    filePath: string,
    options?: FileSystemServiceOptions,
  ): Promise<string>;

  /**
   * Write text content to a file
   *
   * @param filePath - The path to the file to write
   * @param content - The content to write
   */
  writeTextFile(filePath: string, content: string): Promise<void>;
}

/**
 * Standard file system implementation
 */
export class StandardFileSystemService implements FileSystemService {
  async readTextFile(
    filePath: string,
    options?: FileSystemServiceOptions,
  ): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');

    // todo! check if we actually need this
    // Apply line filtering if requested
    if (options?.line !== undefined || options?.limit !== undefined) {
      const lines = content.split('\n');
      const startLine = Math.max(0, (options.line ?? 1) - 1); // Convert to 0-based and handle negative
      const endLine = options.limit ? startLine + options.limit : lines.length;

      return lines.slice(startLine, endLine).join('\n');
    }

    return content;
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }
}
