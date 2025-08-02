/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(),
    readdirSync: vi.fn(),
  },
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));
import { LSTool } from './ls.js';
import { Config } from '../config/config.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';

describe('LSTool', () => {
  let lsTool: LSTool;
  let mockConfig: Config;
  let mockWorkspaceContext: WorkspaceContext;
  let mockFileService: FileDiscoveryService;
  const mockPrimaryDir = '/home/user/project';
  const mockSecondaryDir = '/home/user/other-project';

  beforeEach(() => {
    vi.resetAllMocks();

    // Mock WorkspaceContext
    mockWorkspaceContext = {
      getDirectories: vi
        .fn()
        .mockReturnValue([mockPrimaryDir, mockSecondaryDir]),
      isPathWithinWorkspace: vi
        .fn()
        .mockImplementation(
          (path) =>
            path.startsWith(mockPrimaryDir) ||
            path.startsWith(mockSecondaryDir),
        ),
      addDirectory: vi.fn(),
    } as unknown as WorkspaceContext;

    // Mock FileService
    mockFileService = {
      shouldGitIgnoreFile: vi.fn().mockReturnValue(false),
      shouldGeminiIgnoreFile: vi.fn().mockReturnValue(false),
    } as unknown as FileDiscoveryService;

    // Mock Config
    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue(mockPrimaryDir),
      getWorkspaceContext: vi.fn().mockReturnValue(mockWorkspaceContext),
      getFileService: vi.fn().mockReturnValue(mockFileService),
      getFileFilteringOptions: vi.fn().mockReturnValue({
        respectGitIgnore: true,
        respectGeminiIgnore: true,
      }),
    } as unknown as Config;

    lsTool = new LSTool(mockConfig);
  });

  describe('parameter validation', () => {
    it('should accept valid absolute paths within workspace', () => {
      const params = {
        path: '/home/user/project/src',
      };

      const error = lsTool.validateToolParams(params);
      expect(error).toBeNull();
    });

    it('should reject relative paths', () => {
      const params = {
        path: './src',
      };

      const error = lsTool.validateToolParams(params);
      expect(error).toBe('Path must be absolute: ./src');
    });

    it('should reject paths outside workspace with clear error message', () => {
      const params = {
        path: '/etc/passwd',
      };

      const error = lsTool.validateToolParams(params);
      expect(error).toBe(
        'Path must be within one of the workspace directories: /home/user/project, /home/user/other-project',
      );
    });

    it('should accept paths in secondary workspace directory', () => {
      const params = {
        path: '/home/user/other-project/lib',
      };

      const error = lsTool.validateToolParams(params);
      expect(error).toBeNull();
    });
  });

  describe('execute', () => {
    it('should list files in a directory', async () => {
      const testPath = '/home/user/project/src';
      const mockFiles = ['file1.ts', 'file2.ts', 'subdir'];
      const mockStats = {
        isDirectory: vi.fn(),
        mtime: new Date(),
        size: 1024,
      };

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        // For individual files
        if (pathStr.toString().endsWith('subdir')) {
          return { ...mockStats, isDirectory: () => true, size: 0 } as fs.Stats;
        }
        return { ...mockStats, isDirectory: () => false } as fs.Stats;
      });

      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('[DIR] subdir');
      expect(result.llmContent).toContain('file1.ts');
      expect(result.llmContent).toContain('file2.ts');
      expect(result.returnDisplay).toBe('Listed 3 item(s).');
    });

    it('should list files from secondary workspace directory', async () => {
      const testPath = '/home/user/other-project/lib';
      const mockFiles = ['module1.js', 'module2.js'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        if (path.toString() === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 2048,
        } as fs.Stats;
      });

      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('module1.js');
      expect(result.llmContent).toContain('module2.js');
      expect(result.returnDisplay).toBe('Listed 2 item(s).');
    });

    it('should handle empty directories', async () => {
      const testPath = '/home/user/project/empty';

      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      vi.mocked(fs.readdirSync).mockReturnValue([]);

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toBe(
        'Directory /home/user/project/empty is empty.',
      );
      expect(result.returnDisplay).toBe('Directory is empty.');
    });

    it('should respect ignore patterns', async () => {
      const testPath = '/home/user/project/src';
      const mockFiles = ['test.js', 'test.spec.js', 'index.js'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 1024,
        } as fs.Stats;
      });
      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);

      const result = await lsTool.execute(
        { path: testPath, ignore: ['*.spec.js'] },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('test.js');
      expect(result.llmContent).toContain('index.js');
      expect(result.llmContent).not.toContain('test.spec.js');
      expect(result.returnDisplay).toBe('Listed 2 item(s).');
    });

    it('should respect gitignore patterns', async () => {
      const testPath = '/home/user/project/src';
      const mockFiles = ['file1.js', 'file2.js', 'ignored.js'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 1024,
        } as fs.Stats;
      });
      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);
      (mockFileService.shouldGitIgnoreFile as any).mockImplementation(
        (path: string) => path.includes('ignored.js'),
      );

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('file1.js');
      expect(result.llmContent).toContain('file2.js');
      expect(result.llmContent).not.toContain('ignored.js');
      expect(result.returnDisplay).toBe('Listed 2 item(s). (1 git-ignored)');
    });

    it('should respect geminiignore patterns', async () => {
      const testPath = '/home/user/project/src';
      const mockFiles = ['file1.js', 'file2.js', 'private.js'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 1024,
        } as fs.Stats;
      });
      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);
      (mockFileService.shouldGeminiIgnoreFile as any).mockImplementation(
        (path: string) => path.includes('private.js'),
      );

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('file1.js');
      expect(result.llmContent).toContain('file2.js');
      expect(result.llmContent).not.toContain('private.js');
      expect(result.returnDisplay).toBe('Listed 2 item(s). (1 gemini-ignored)');
    });

    it('should handle non-directory paths', async () => {
      const testPath = '/home/user/project/file.txt';

      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => false,
      } as fs.Stats);

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('Path is not a directory');
      expect(result.returnDisplay).toBe('Error: Path is not a directory.');
    });

    it('should handle non-existent paths', async () => {
      const testPath = '/home/user/project/does-not-exist';

      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('Error listing directory');
      expect(result.returnDisplay).toBe('Error: Failed to list directory.');
    });

    it('should sort directories first, then files alphabetically', async () => {
      const testPath = '/home/user/project/src';
      const mockFiles = ['z-file.ts', 'a-dir', 'b-file.ts', 'c-dir'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        if (path.toString() === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        if (path.toString().endsWith('-dir')) {
          return {
            isDirectory: () => true,
            mtime: new Date(),
            size: 0,
          } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 1024,
        } as fs.Stats;
      });

      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      const lines = (
        typeof result.llmContent === 'string' ? result.llmContent : ''
      ).split('\n');
      const entries = lines.slice(1).filter((line: string) => line.trim()); // Skip header
      expect(entries[0]).toBe('[DIR] a-dir');
      expect(entries[1]).toBe('[DIR] c-dir');
      expect(entries[2]).toBe('b-file.ts');
      expect(entries[3]).toBe('z-file.ts');
    });

    it('should handle permission errors gracefully', async () => {
      const testPath = '/home/user/project/restricted';

      vi.mocked(fs.statSync).mockReturnValue({
        isDirectory: () => true,
      } as fs.Stats);
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('Error listing directory');
      expect(result.llmContent).toContain('permission denied');
      expect(result.returnDisplay).toBe('Error: Failed to list directory.');
    });

    it('should validate parameters and return error for invalid params', async () => {
      const result = await lsTool.execute(
        { path: '../outside' },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('Invalid parameters provided');
      expect(result.returnDisplay).toBe('Error: Failed to execute tool.');
    });

    it('should handle errors accessing individual files during listing', async () => {
      const testPath = '/home/user/project/src';
      const mockFiles = ['accessible.ts', 'inaccessible.ts'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        if (path.toString() === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        if (path.toString().endsWith('inaccessible.ts')) {
          throw new Error('EACCES: permission denied');
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 1024,
        } as fs.Stats;
      });

      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);

      // Spy on console.error to verify it's called
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      // Should still list the accessible file
      expect(result.llmContent).toContain('accessible.ts');
      expect(result.llmContent).not.toContain('inaccessible.ts');
      expect(result.returnDisplay).toBe('Listed 1 item(s).');

      // Verify error was logged
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error accessing'),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('getDescription', () => {
    it('should return shortened relative path', () => {
      const params = {
        path: path.join(mockPrimaryDir, 'deeply', 'nested', 'directory'),
      };

      const description = lsTool.getDescription(params);
      expect(description).toBe(path.join('deeply', 'nested', 'directory'));
    });

    it('should handle paths in secondary workspace', () => {
      const params = {
        path: path.join(mockSecondaryDir, 'lib'),
      };

      const description = lsTool.getDescription(params);
      expect(description).toBe(path.join('..', 'other-project', 'lib'));
    });
  });

  describe('workspace boundary validation', () => {
    it('should accept paths in primary workspace directory', () => {
      const params = { path: `${mockPrimaryDir}/src` };
      expect(lsTool.validateToolParams(params)).toBeNull();
    });

    it('should accept paths in secondary workspace directory', () => {
      const params = { path: `${mockSecondaryDir}/lib` };
      expect(lsTool.validateToolParams(params)).toBeNull();
    });

    it('should reject paths outside all workspace directories', () => {
      const params = { path: '/etc/passwd' };
      const error = lsTool.validateToolParams(params);
      expect(error).toContain(
        'Path must be within one of the workspace directories',
      );
      expect(error).toContain(mockPrimaryDir);
      expect(error).toContain(mockSecondaryDir);
    });

    it('should list files from secondary workspace directory', async () => {
      const testPath = `${mockSecondaryDir}/tests`;
      const mockFiles = ['test1.spec.ts', 'test2.spec.ts'];

      vi.mocked(fs.statSync).mockImplementation((path: any) => {
        if (path.toString() === testPath) {
          return { isDirectory: () => true } as fs.Stats;
        }
        return {
          isDirectory: () => false,
          mtime: new Date(),
          size: 512,
        } as fs.Stats;
      });

      vi.mocked(fs.readdirSync).mockReturnValue(mockFiles as any);

      const result = await lsTool.execute(
        { path: testPath },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('test1.spec.ts');
      expect(result.llmContent).toContain('test2.spec.ts');
      expect(result.returnDisplay).toBe('Listed 2 item(s).');
    });
  });
});
