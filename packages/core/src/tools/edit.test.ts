/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockEnsureCorrectEdit = vi.hoisted(() => vi.fn());
const mockGenerateJson = vi.hoisted(() => vi.fn());
const mockOpenDiff = vi.hoisted(() => vi.fn());

vi.mock('../utils/editCorrector.js', () => ({
  ensureCorrectEdit: mockEnsureCorrectEdit,
}));

vi.mock('../core/client.js', () => ({
  GeminiClient: vi.fn().mockImplementation(() => ({
    generateJson: mockGenerateJson,
  })),
}));

vi.mock('../utils/editor.js', () => ({
  openDiff: mockOpenDiff,
}));

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { EditTool, EditToolParams } from './edit.js';
import { DefaultToolEnvironment, FileDiff } from './tools.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ApprovalMode, Config } from '../config/config.js';
import { Content, Part, SchemaUnion } from '@google/genai';

describe('EditTool', () => {
  let tool: EditTool;
  let tempDir: string;
  let rootDir: string;
  let mockConfig: Config;
  let geminiClient: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-test-'));
    rootDir = path.join(tempDir, 'root');
    fs.mkdirSync(rootDir);

    geminiClient = {
      generateJson: mockGenerateJson, // mockGenerateJson is already defined and hoisted
    };

    mockConfig = {
      getGeminiClient: vi.fn().mockReturnValue(geminiClient),
      getTargetDir: () => rootDir,
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      // getGeminiConfig: () => ({ apiKey: 'test-api-key' }), // This was not a real Config method
      // Add other properties/methods of Config if EditTool uses them
      // Minimal other methods to satisfy Config type if needed by EditTool constructor or other direct uses:
      getApiKey: () => 'test-api-key',
      getModel: () => 'test-model',
      getSandbox: () => false,
      getDebugMode: () => false,
      getQuestion: () => undefined,
      getFullContext: () => false,
      getToolDiscoveryCommand: () => undefined,
      getToolCallCommand: () => undefined,
      getMcpServerCommand: () => undefined,
      getMcpServers: () => undefined,
      getUserAgent: () => 'test-agent',
      getUserMemory: () => '',
      setUserMemory: vi.fn(),
      getGeminiMdFileCount: () => 0,
      setGeminiMdFileCount: vi.fn(),
      getToolRegistry: () => ({}) as any, // Minimal mock for ToolRegistry
      getToolEnv: () => DefaultToolEnvironment,
    } as unknown as Config;

    // Reset mocks before each test
    (mockConfig.getApprovalMode as Mock).mockClear();
    // Default to not skipping confirmation
    (mockConfig.getApprovalMode as Mock).mockReturnValue(ApprovalMode.DEFAULT);

    // Reset mocks and set default implementation for ensureCorrectEdit
    mockEnsureCorrectEdit.mockReset();
    mockEnsureCorrectEdit.mockImplementation(
      async (_, currentContent, params) => {
        let occurrences = 0;
        if (params.old_string && currentContent) {
          // Simple string counting for the mock
          let index = currentContent.indexOf(params.old_string);
          while (index !== -1) {
            occurrences++;
            index = currentContent.indexOf(params.old_string, index + 1);
          }
        } else if (params.old_string === '') {
          occurrences = 0; // Creating a new file
        }
        return Promise.resolve({ params, occurrences });
      },
    );

    // Default mock for generateJson to return the snippet unchanged
    mockGenerateJson.mockReset();
    mockGenerateJson.mockImplementation(
      async (contents: Content[], schema: SchemaUnion) => {
        // The problematic_snippet is the last part of the user's content
        const userContent = contents.find((c: Content) => c.role === 'user');
        let promptText = '';
        if (userContent && userContent.parts) {
          promptText = userContent.parts
            .filter((p: Part) => typeof (p as any).text === 'string')
            .map((p: Part) => (p as any).text)
            .join('\n');
        }
        const snippetMatch = promptText.match(
          /Problematic target snippet:\n```\n([\s\S]*?)\n```/,
        );
        const problematicSnippet =
          snippetMatch && snippetMatch[1] ? snippetMatch[1] : '';

        if (((schema as any).properties as any)?.corrected_target_snippet) {
          return Promise.resolve({
            corrected_target_snippet: problematicSnippet,
          });
        }
        if (((schema as any).properties as any)?.corrected_new_string) {
          // For new_string correction, we might need more sophisticated logic,
          // but for now, returning original is a safe default if not specified by a test.
          const originalNewStringMatch = promptText.match(
            /original_new_string \(what was intended to replace original_old_string\):\n```\n([\s\S]*?)\n```/,
          );
          const originalNewString =
            originalNewStringMatch && originalNewStringMatch[1]
              ? originalNewStringMatch[1]
              : '';
          return Promise.resolve({ corrected_new_string: originalNewString });
        }
        return Promise.resolve({}); // Default empty object if schema doesn't match
      },
    );

    tool = new EditTool(mockConfig);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('_applyReplacement', () => {
    // Access private method for testing
    // Note: `tool` is initialized in `beforeEach` of the parent describe block
    it('should return newString if isNewFile is true', () => {
      expect((tool as any)._applyReplacement(null, 'old', 'new', true)).toBe(
        'new',
      );
      expect(
        (tool as any)._applyReplacement('existing', 'old', 'new', true),
      ).toBe('new');
    });

    it('should return newString if currentContent is null and oldString is empty (defensive)', () => {
      expect((tool as any)._applyReplacement(null, '', 'new', false)).toBe(
        'new',
      );
    });

    it('should return empty string if currentContent is null and oldString is not empty (defensive)', () => {
      expect((tool as any)._applyReplacement(null, 'old', 'new', false)).toBe(
        '',
      );
    });

    it('should replace oldString with newString in currentContent', () => {
      expect(
        (tool as any)._applyReplacement(
          'hello old world old',
          'old',
          'new',
          false,
        ),
      ).toBe('hello new world new');
    });

    it('should return currentContent if oldString is empty and not a new file', () => {
      expect(
        (tool as any)._applyReplacement('hello world', '', 'new', false),
      ).toBe('hello world');
    });
  });

  describe('validateToolParams', () => {
    it('should return null for valid params', () => {
      const params: EditToolParams = {
        file_path: path.join(rootDir, 'test.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('should return error for relative path', () => {
      const params: EditToolParams = {
        file_path: 'test.txt',
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toMatch(
        /File path must be absolute/,
      );
    });

    it('should return error for path outside root', () => {
      const params: EditToolParams = {
        file_path: path.join(tempDir, 'outside-root.txt'),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.validateToolParams(params)).toMatch(
        /File path must be within the root directory/,
      );
    });
  });

  describe('shouldConfirmExecute', () => {
    const testFile = 'edit_me.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
    });

    it('should return false if params are invalid', async () => {
      const params: EditToolParams = {
        file_path: 'relative.txt',
        old_string: 'old',
        new_string: 'new',
      };
      expect(
        await tool.shouldConfirmExecute(params, new AbortController().signal),
      ).toBe(false);
    });

    it('should request confirmation for valid edit', async () => {
      fs.writeFileSync(filePath, 'some old content here');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      // ensureCorrectEdit will be called by shouldConfirmExecute
      mockEnsureCorrectEdit.mockResolvedValueOnce({ params, occurrences: 1 });
      const confirmation = await tool.shouldConfirmExecute(
        params,
        new AbortController().signal,
      );
      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Edit: ${testFile}`,
          fileName: testFile,
          fileDiff: expect.any(String),
        }),
      );
    });

    it('should return false if old_string is not found (ensureCorrectEdit returns 0)', async () => {
      fs.writeFileSync(filePath, 'some content here');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'not_found',
        new_string: 'new',
      };
      mockEnsureCorrectEdit.mockResolvedValueOnce({ params, occurrences: 0 });
      expect(
        await tool.shouldConfirmExecute(params, new AbortController().signal),
      ).toBe(false);
    });

    it('should return false if multiple occurrences of old_string are found (ensureCorrectEdit returns > 1)', async () => {
      fs.writeFileSync(filePath, 'old old content here');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      mockEnsureCorrectEdit.mockResolvedValueOnce({ params, occurrences: 2 });
      expect(
        await tool.shouldConfirmExecute(params, new AbortController().signal),
      ).toBe(false);
    });

    it('should request confirmation for creating a new file (empty old_string)', async () => {
      const newFileName = 'new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const params: EditToolParams = {
        file_path: newFilePath,
        old_string: '',
        new_string: 'new file content',
      };
      // ensureCorrectEdit might not be called if old_string is empty,
      // as shouldConfirmExecute handles this for diff generation.
      // If it is called, it should return 0 occurrences for a new file.
      mockEnsureCorrectEdit.mockResolvedValueOnce({ params, occurrences: 0 });
      const confirmation = await tool.shouldConfirmExecute(
        params,
        new AbortController().signal,
      );
      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Edit: ${newFileName}`,
          fileName: newFileName,
          fileDiff: expect.any(String),
        }),
      );
    });

    it('should use corrected params from ensureCorrectEdit for diff generation', async () => {
      const originalContent = 'This is the original string to be replaced.';
      const originalOldString = 'original string';
      const originalNewString = 'new string';

      const correctedOldString = 'original string to be replaced'; // More specific
      const correctedNewString = 'completely new string'; // Different replacement
      const expectedFinalContent = 'This is the completely new string.';

      fs.writeFileSync(filePath, originalContent);
      const params: EditToolParams = {
        file_path: filePath,
        old_string: originalOldString,
        new_string: originalNewString,
      };

      // The main beforeEach already calls mockEnsureCorrectEdit.mockReset()
      // Set a specific mock for this test case
      let mockCalled = false;
      mockEnsureCorrectEdit.mockImplementationOnce(
        async (_, content, p, client) => {
          mockCalled = true;
          expect(content).toBe(originalContent);
          expect(p).toBe(params);
          expect(client).toBe(geminiClient);
          return {
            params: {
              file_path: filePath,
              old_string: correctedOldString,
              new_string: correctedNewString,
            },
            occurrences: 1,
          };
        },
      );

      const confirmation = (await tool.shouldConfirmExecute(
        params,
        new AbortController().signal,
      )) as FileDiff;

      expect(mockCalled).toBe(true); // Check if the mock implementation was run
      // expect(mockEnsureCorrectEdit).toHaveBeenCalledWith(originalContent, params, expect.anything()); // Keep this commented for now
      expect(confirmation).toEqual(
        expect.objectContaining({
          title: `Confirm Edit: ${testFile}`,
          fileName: testFile,
        }),
      );
      // Check that the diff is based on the corrected strings leading to the new state
      expect(confirmation.fileDiff).toContain(`-${originalContent}`);
      expect(confirmation.fileDiff).toContain(`+${expectedFinalContent}`);

      // Verify that applying the correctedOldString and correctedNewString to originalContent
      // indeed produces the expectedFinalContent, which is what the diff should reflect.
      const patchedContent = originalContent.replace(
        correctedOldString, // This was the string identified by ensureCorrectEdit for replacement
        correctedNewString, // This was the string identified by ensureCorrectEdit as the replacement
      );
      expect(patchedContent).toBe(expectedFinalContent);
    });
  });

  describe('execute', () => {
    const testFile = 'execute_me.txt';
    let filePath: string;

    beforeEach(() => {
      filePath = path.join(rootDir, testFile);
      // Default for execute tests, can be overridden
      mockEnsureCorrectEdit.mockImplementation(async (_, content, params) => {
        let occurrences = 0;
        if (params.old_string && content) {
          let index = content.indexOf(params.old_string);
          while (index !== -1) {
            occurrences++;
            index = content.indexOf(params.old_string, index + 1);
          }
        } else if (params.old_string === '') {
          occurrences = 0;
        }
        return { params, occurrences };
      });
    });

    it('should return error if params are invalid', async () => {
      const params: EditToolParams = {
        file_path: 'relative.txt',
        old_string: 'old',
        new_string: 'new',
      };
      const result = await tool.execute(params, new AbortController().signal);
      expect(result.llmContent).toMatch(/Error: Invalid parameters provided/);
      expect(result.returnDisplay).toMatch(/Error: File path must be absolute/);
    });

    it('should edit an existing file and return diff with fileName', async () => {
      const initialContent = 'This is some old text.';
      const newContent = 'This is some new text.'; // old -> new
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };

      // Specific mock for this test's execution path in calculateEdit
      // ensureCorrectEdit is NOT called by calculateEdit, only by shouldConfirmExecute
      // So, the default mockEnsureCorrectEdit should correctly return 1 occurrence for 'old' in initialContent

      // Simulate confirmation by setting shouldAlwaysEdit
      (tool as any).shouldAlwaysEdit = true;

      const result = await tool.execute(params, new AbortController().signal);

      (tool as any).shouldAlwaysEdit = false; // Reset for other tests

      expect(result.llmContent).toMatch(/Successfully modified file/);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);
      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(initialContent);
      expect(display.fileDiff).toMatch(newContent);
      expect(display.fileName).toBe(testFile);
    });

    it('should create a new file if old_string is empty and file does not exist, and return created message', async () => {
      const newFileName = 'brand_new_file.txt';
      const newFilePath = path.join(rootDir, newFileName);
      const fileContent = 'Content for the new file.';
      const params: EditToolParams = {
        file_path: newFilePath,
        old_string: '',
        new_string: fileContent,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const result = await tool.execute(params, new AbortController().signal);

      expect(result.llmContent).toMatch(/Created new file/);
      expect(fs.existsSync(newFilePath)).toBe(true);
      expect(fs.readFileSync(newFilePath, 'utf8')).toBe(fileContent);
      expect(result.returnDisplay).toBe(`Created ${newFileName}`);
    });

    it('should return error if old_string is not found in file', async () => {
      fs.writeFileSync(filePath, 'Some content.', 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'nonexistent',
        new_string: 'replacement',
      };
      // The default mockEnsureCorrectEdit will return 0 occurrences for 'nonexistent'
      const result = await tool.execute(params, new AbortController().signal);
      expect(result.llmContent).toMatch(
        /0 occurrences found for old_string in/,
      );
      expect(result.returnDisplay).toMatch(
        /Failed to edit, could not find the string to replace./,
      );
    });

    it('should return error if multiple occurrences of old_string are found', async () => {
      fs.writeFileSync(filePath, 'multiple old old strings', 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };
      // The default mockEnsureCorrectEdit will return 2 occurrences for 'old'
      const result = await tool.execute(params, new AbortController().signal);
      expect(result.llmContent).toMatch(
        /Expected 1 occurrence but found 2 for old_string in file/,
      );
      expect(result.returnDisplay).toMatch(
        /Failed to edit, expected 1 occurrence but found 2/,
      );
    });

    it('should successfully replace multiple occurrences when expected_replacements specified', async () => {
      fs.writeFileSync(filePath, 'old text old text old text', 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        expected_replacements: 3,
      };

      // Simulate confirmation by setting shouldAlwaysEdit
      (tool as any).shouldAlwaysEdit = true;

      const result = await tool.execute(params, new AbortController().signal);

      (tool as any).shouldAlwaysEdit = false; // Reset for other tests

      expect(result.llmContent).toMatch(/Successfully modified file/);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'new text new text new text',
      );
      const display = result.returnDisplay as FileDiff;
      expect(display.fileDiff).toMatch(/old text old text old text/);
      expect(display.fileDiff).toMatch(/new text new text new text/);
      expect(display.fileName).toBe(testFile);
    });

    it('should return error if expected_replacements does not match actual occurrences', async () => {
      fs.writeFileSync(filePath, 'old text old text', 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        expected_replacements: 3, // Expecting 3 but only 2 exist
      };
      const result = await tool.execute(params, new AbortController().signal);
      expect(result.llmContent).toMatch(
        /Expected 3 occurrences but found 2 for old_string in file/,
      );
      expect(result.returnDisplay).toMatch(
        /Failed to edit, expected 3 occurrences but found 2/,
      );
    });

    it('should return error if trying to create a file that already exists (empty old_string)', async () => {
      fs.writeFileSync(filePath, 'Existing content', 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: '',
        new_string: 'new content',
      };
      const result = await tool.execute(params, new AbortController().signal);
      expect(result.llmContent).toMatch(/File already exists, cannot create/);
      expect(result.returnDisplay).toMatch(
        /Attempted to create a file that already exists/,
      );
    });

    it('should include modification message when proposed content is modified', async () => {
      const initialContent = 'This is some old text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        modified_by_user: true,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const result = await tool.execute(params, new AbortController().signal);

      expect(result.llmContent).toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should not include modification message when proposed content is not modified', async () => {
      const initialContent = 'This is some old text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
        modified_by_user: false,
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const result = await tool.execute(params, new AbortController().signal);

      expect(result.llmContent).not.toMatch(
        /User modified the `new_string` content/,
      );
    });

    it('should not include modification message when modified_by_user is not provided', async () => {
      const initialContent = 'This is some old text.';
      fs.writeFileSync(filePath, initialContent, 'utf8');
      const params: EditToolParams = {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      };

      (mockConfig.getApprovalMode as Mock).mockReturnValueOnce(
        ApprovalMode.AUTO_EDIT,
      );
      const result = await tool.execute(params, new AbortController().signal);

      expect(result.llmContent).not.toMatch(
        /User modified the `new_string` content/,
      );
    });
  });

  describe('getDescription', () => {
    it('should return "No file changes to..." if old_string and new_string are the same', () => {
      const testFileName = 'test.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string: 'identical_string',
        new_string: 'identical_string',
      };
      // shortenPath will be called internally, resulting in just the file name
      expect(tool.getDescription(params)).toBe(
        `No file changes to ${testFileName}`,
      );
    });

    it('should return a snippet of old and new strings if they are different', () => {
      const testFileName = 'test.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string: 'this is the old string value',
        new_string: 'this is the new string value',
      };
      // shortenPath will be called internally, resulting in just the file name
      // The snippets are truncated at 30 chars + '...'
      expect(tool.getDescription(params)).toBe(
        `${testFileName}: this is the old string value => this is the new string value`,
      );
    });

    it('should handle very short strings correctly in the description', () => {
      const testFileName = 'short.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string: 'old',
        new_string: 'new',
      };
      expect(tool.getDescription(params)).toBe(`${testFileName}: old => new`);
    });

    it('should truncate long strings in the description', () => {
      const testFileName = 'long.txt';
      const params: EditToolParams = {
        file_path: path.join(rootDir, testFileName),
        old_string:
          'this is a very long old string that will definitely be truncated',
        new_string:
          'this is a very long new string that will also be truncated',
      };
      expect(tool.getDescription(params)).toBe(
        `${testFileName}: this is a very long old string... => this is a very long new string...`,
      );
    });
  });
});
