/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { StandardFileSystemService } from './fileSystemService.js';

vi.mock('fs/promises');

describe('StandardFileSystemService', () => {
  let fileSystem: StandardFileSystemService;

  beforeEach(() => {
    vi.resetAllMocks();
    fileSystem = new StandardFileSystemService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readTextFile', () => {
    it('should read file content using fs', async () => {
      const testContent = 'Hello, World!';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt');

      expect(fs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
      expect(result).toBe(testContent);
    });

    it('should apply line filtering when options are provided', async () => {
      const testContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt', {
        line: 2,
        limit: 2,
      });

      expect(result).toBe('Line 2\nLine 3');
    });

    it('should handle line option without limit', async () => {
      const testContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt', {
        line: 3,
      });

      expect(result).toBe('Line 3\nLine 4\nLine 5');
    });

    it('should handle limit option without line', async () => {
      const testContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt', {
        limit: 3,
      });

      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should handle out of bounds line numbers gracefully', async () => {
      const testContent = 'Line 1\nLine 2\nLine 3';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt', {
        line: 10,
        limit: 5,
      });

      expect(result).toBe('');
    });

    it('should handle negative line numbers by treating them as 0', async () => {
      const testContent = 'Line 1\nLine 2\nLine 3';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt', {
        line: -5,
        limit: 2,
      });

      expect(result).toBe('Line 1\nLine 2');
    });

    it('should handle files with no newlines', async () => {
      const testContent = 'Single line content';
      vi.mocked(fs.readFile).mockResolvedValue(testContent);

      const result = await fileSystem.readTextFile('/test/file.txt', {
        line: 1,
        limit: 1,
      });

      expect(result).toBe('Single line content');
    });

    it('should propagate fs.readFile errors', async () => {
      const error = new Error('ENOENT: File not found');
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(fileSystem.readTextFile('/test/file.txt')).rejects.toThrow(
        'ENOENT: File not found',
      );
    });
  });

  describe('writeTextFile', () => {
    it('should write file content using fs', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      await fileSystem.writeTextFile('/test/file.txt', 'Hello, World!');

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/file.txt',
        'Hello, World!',
        'utf-8',
      );
    });
  });
});
