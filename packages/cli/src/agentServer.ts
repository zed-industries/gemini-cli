/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  Config,
  executeToolCall,
  GeminiChat,
  ToolCallRequestInfo,
  ToolRegistry,
  unreachable,
} from '@google/gemini-cli-core';
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
  SendMessageParams,
  SendMessageResponse,
} from 'agentic-coding-protocol';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Content, Part, FunctionCall } from '@google/genai';

export async function runAgentServer(config: Config) {
  // todo!("make authentication part of the protocol")
  await config.refreshAuth(AuthType.USE_GEMINI);

  const stdout = Writable.toWeb(process.stdout);
  const stdin = Readable.toWeb(process.stdin) as ReadableStream;
  Connection.agentToClient(
    (client: Client) => new GeminiAgent(config, client),
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
        modifiedAt: new Date().toISOString(), // todo!()
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
    const threadId = randomUUID();

    this.threads.set(threadId, chat);

    // todo!("Save thread so that it can be resumed later.");
    // const logger = new Logger(this.config.getSessionId());
    // await logger.initialize();
    // const history = chat.getHistory();
    // await logger.saveCheckpoint(history, thread_id);

    return { threadId };
  }
  async getThreadEntries(
    params: GetThreadEntriesParams,
  ): Promise<GetThreadEntriesResponse> {
    const thread = this.threads.get(params.threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${params.threadId}`);
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

  async sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    const chat = this.threads.get(params.threadId);
    if (!chat) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    // todo!  the CLI only seems to support one thread at a time.
    // should we remove the thread id param from all events and set the active one via a method?
    this.config.setToolEnvironment(
      new AcpToolEnvironment(this.client, params.threadId),
    );

    const toolRegistry: ToolRegistry = await this.config.getToolRegistry();

    const parts = params.message.chunks.map((chunk) => {
      switch (chunk.type) {
        case 'text':
          return {
            text: chunk.chunk,
          };
        default:
          return unreachable(chunk.type);
      }
    });

    const abortController = new AbortController();
    let nextMessage: Content | null = { role: 'user', parts };

    while (nextMessage !== null) {
      const functionCalls: FunctionCall[] = [];

      const responseStream = await chat.sendMessageStream({
        message: nextMessage?.parts ?? [],
        config: {
          abortSignal: abortController.signal,
          tools: [
            { functionDeclarations: toolRegistry.getFunctionDeclarations() },
          ],
        },
      });
      nextMessage = null;

      for await (const resp of responseStream) {
        if (abortController.signal.aborted) {
          throw new Error('Aborted');
        }

        if (resp.candidates && resp.candidates.length > 0) {
          const candidate = resp.candidates[0];
          for (const part of candidate.content?.parts ?? []) {
            if (part.thought || !part.text) {
              // todo!
              continue;
            }

            this.client.streamMessageChunk?.({
              threadId: params.threadId,
              chunk: {
                type: 'text',
                chunk: part.text,
              },
            });
          }
        }

        if (resp.functionCalls) {
          functionCalls.push(...resp.functionCalls);
        }
      }

      if (functionCalls.length > 0) {
        const toolResponseParts: Part[] = [];

        for (const fc of functionCalls) {
          const callId = fc.id ?? `${fc.name}-${Date.now()}`;
          const requestInfo: ToolCallRequestInfo = {
            callId,
            name: fc.name as string,
            args: (fc.args ?? {}) as Record<string, unknown>,
          };

          const toolResponse = await executeToolCall(
            this.config,
            requestInfo,
            toolRegistry,
            abortController.signal,
          );

          // todo! report properly
          if (toolResponse.error) {
            this.client.streamMessageChunk?.({
              threadId: params.threadId,
              chunk: {
                type: 'text',
                chunk: `\n\n[DEBUG] ${requestInfo.name} error:\n${toolResponse.error}\n\n`,
              },
            });
          } else {
            this.client.streamMessageChunk?.({
              threadId: params.threadId,
              chunk: {
                type: 'text',
                chunk: `\n\n[DEBUG] ${requestInfo.name} output:\n${toolResponse.resultDisplay}\n\n`,
              },
            });
          }

          if (toolResponse.responseParts) {
            const parts = Array.isArray(toolResponse.responseParts)
              ? toolResponse.responseParts
              : [toolResponse.responseParts];
            for (const part of parts) {
              if (typeof part === 'string') {
                toolResponseParts.push({ text: part });
              } else if (part) {
                toolResponseParts.push(part);
              }
            }
          }

          nextMessage = { role: 'user', parts: toolResponseParts };
        }
      }
    }

    return null;
  }
}
