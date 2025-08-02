/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getErrorMessage,
  loadServerHierarchicalMemory,
} from '@google/gemini-cli-core';
import { MessageType } from '../types.js';
import {
  CommandKind,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Commands for interacting with memory.',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'show',
      description: 'Show the current memory contents.',
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        const memoryContent = context.services.config?.getUserMemory() || '';
        const fileCount = context.services.config?.getGeminiMdFileCount() || 0;

        const messageContent =
          memoryContent.length > 0
            ? `Current memory content from ${fileCount} file(s):\n\n---\n${memoryContent}\n---`
            : 'Memory is currently empty.';

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: messageContent,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'add',
      description: 'Add content to the memory.',
      kind: CommandKind.BUILT_IN,
      action: (context, args): SlashCommandActionReturn | void => {
        if (!args || args.trim() === '') {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Usage: /memory add <text to remember>',
          };
        }

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `Attempting to save to memory: "${args.trim()}"`,
          },
          Date.now(),
        );

        return {
          type: 'tool',
          toolName: 'save_memory',
          toolArgs: { fact: args.trim() },
        };
      },
    },
    {
      name: 'refresh',
      description: 'Refresh the memory from the source.',
      kind: CommandKind.BUILT_IN,
      action: async (context) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: 'Refreshing memory from source files...',
          },
          Date.now(),
        );

        try {
          const config = await context.services.config;
          if (config) {
            const { memoryContent, fileCount } =
              await loadServerHierarchicalMemory(
                config.getWorkingDir(),
                config.getDebugMode(),
                config.getFileService(),
                config.getExtensionContextFilePaths(),
                context.services.settings.merged.memoryImportFormat || 'tree', // Use setting or default to 'tree'
                config.getFileFilteringOptions(),
                context.services.settings.merged.memoryDiscoveryMaxDirs,
              );
            config.setUserMemory(memoryContent);
            config.setGeminiMdFileCount(fileCount);

            const successMessage =
              memoryContent.length > 0
                ? `Memory refreshed successfully. Loaded ${memoryContent.length} characters from ${fileCount} file(s).`
                : 'Memory refreshed successfully. No memory content found.';

            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: successMessage,
              },
              Date.now(),
            );
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Error refreshing memory: ${errorMessage}`,
            },
            Date.now(),
          );
        }
      },
    },
  ],
};
