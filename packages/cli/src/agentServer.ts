/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Writable, Readable } from 'node:stream';
import {
  Agent,
  Client,
  Connection,
  ListThreadsParams,
  ListThreadsResponse,
  OpenThreadParams,
  OpenThreadResponse,
} from 'agentic-coding-protocol';

export function runAgentServer() {
  const stdout = Writable.toWeb(process.stdout);
  const stdin = Readable.toWeb(process.stdin) as ReadableStream;
  Connection.agentToClient(GeminiAgent, stdout, stdin);
}

class GeminiAgent implements Agent {
  constructor(private client: Client) {}

  async listThreads(params: ListThreadsParams): Promise<ListThreadsResponse> {
    const threads = [
      { id: '1', title: 'Bar', created_at: '2025-01-01T00:00:00Z' },
    ];

    return {
      threads,
    };
  }
  openThread(params: OpenThreadParams): Promise<OpenThreadResponse> {
    throw new Error('Method not implemented.');
  }
}
