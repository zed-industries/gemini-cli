/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '@google/gemini-cli-core';
import * as acp from './acp.js';
import { LoadedSettings } from '../config/settings.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// ... set up server resources, tools, and prompts ...

export async function runAcpPeer(_config: Config, _settings: LoadedSettings) {
  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const server = new McpServer({
    name: 'gemini-cli',
    version: '1.0.0', // todo!
  });

  server.registerTool(
    acp.NEW_SESSION_TOOL_NAME,
    {
      inputSchema: acp.NewSessionArgumentsSchema.shape,
      outputSchema: acp.NewSessionOutputSchema.shape,
    },
    async ({ cwd }) => {
      console.log('hi', cwd);

      return { content: [], structuredContent: { sessionId: '1234567890' } };
    },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
