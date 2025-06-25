/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, Config, GeminiChat } from '@gemini-cli/core';
import {
  Agent,
  Client,
  Connection,
  CreateThreadParams,
  CreateThreadResponse,
  GetThreadsParams,
  GetThreadsResponse,
  GetThreadEntriesParams,
  GetThreadEntriesResponse,
  OpenThreadParams,
  OpenThreadResponse,
  ThreadEntry,
} from 'agentic-coding-protocol';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

export async function runAgentServer(config: Config) {
  // todo!("make authentication part of the protocol")
  await config.refreshAuth(AuthType.USE_GEMINI);

  const stdout = Writable.toWeb(process.stdout);
  const stdin = Readable.toWeb(process.stdin) as ReadableStream;
  Connection.agentToClient(
    (client) => new GeminiAgent(config, client),
    stdout,
    stdin,
  );
}

class GeminiAgent implements Agent {
  threads: Map<string, GeminiChat> = new Map();

  constructor(
    private config: Config,
    private client: Client,
  ) {}

  async getThreads(_params: GetThreadsParams): Promise<GetThreadsResponse> {
    return {
      threads: Array.from(this.threads.entries()).map(([id, _chat]) => ({
        id,
        title: 'todo!()',
        modified_at: new Date().toISOString(), // todo!()
      })),
    };
  }
  async openThread(_params: OpenThreadParams): Promise<OpenThreadResponse> {
    throw new Error('Method not implemented.');
  }
  async createThread(
    _params: CreateThreadParams,
  ): Promise<CreateThreadResponse> {
    const geminiClient = this.config.getGeminiClient();
    const chat = await geminiClient.startChat();
    const thread_id = randomUUID();

    this.threads.set(thread_id, chat);

    // todo!("Save thread so that it can be resumed later.");
    // const logger = new Logger(this.config.getSessionId());
    // await logger.initialize();
    // const history = chat.getHistory();
    // await logger.saveCheckpoint(history, thread_id);

    return { thread_id };
  }
  async getThreadEntries(
    params: GetThreadEntriesParams,
  ): Promise<GetThreadEntriesResponse> {
    const thread = this.threads.get(params.thread_id);
    if (!thread) {
      throw new Error(`Thread not found: ${params.thread_id}`);
    }
    const entries = thread.getHistory().map<ThreadEntry>((content) => ({
      type: 'message',
      role: content.role === 'user' ? 'user' : 'assistant',
      chunks:
        content.parts
          // todo! Map the other types of content
          ?.filter((part) => !!part.text)
          .map((part) => ({
            type: 'text',
            chunk: part.text || '',
          })) || [],
    }));
    return { entries };
  }
}
