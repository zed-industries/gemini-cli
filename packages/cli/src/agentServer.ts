/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  Config,
  GeminiChat,
  ToolRegistry,
  unreachable,
  AcpToolEnvironment,
  logToolCall,
  ToolResult,
  convertToFunctionResponse,
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
  ThreadId,
  ToolCallContent,
} from 'agentic-coding-protocol';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Content, Part, FunctionCall, PartListUnion } from '@google/genai';

export async function runAgentServer(
  config: Config,
  authMethod: AuthType = AuthType.USE_GEMINI,
) {
  // todo!("make authentication part of the protocol")
  await config.refreshAuth(authMethod);

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
  ) { }

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

            this.client.streamMessageChunk({
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
          const response = await this.#runTool(params.threadId, fc);

          const parts = Array.isArray(response)
            ? response
            : [response];

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

    return null;
  }

  async #runTool(threadId: ThreadId, fc: FunctionCall): Promise<PartListUnion> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;

    const startTime = Date.now();

    const errorResponse = (error: Error) => {
      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        function_name: fc.name ?? "",
        function_args: args,
        duration_ms: durationMs,
        success: false,
        error: error.message,
      });

      return [{
        functionResponse: {
          id: callId,
          name: fc.name ?? "",
          response: { error: error.message },
        },
      }];
    };

    if (!fc.name) {
      return errorResponse(new Error("Missing function name"));
    }

    const toolRegistry: ToolRegistry = await this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name as string);

    if (!tool) {
      return errorResponse(new Error(
        `Tool "${fc.name}" not found in registry.`,
      ));
    }

    // todo! call tool.shouldConfirmExecute?

    const result = await this.client.requestToolCall({ threadId, toolName: fc.name as string, description: tool.getDescription(args) });

    if (result.type === "rejected") {
      return errorResponse(new Error(
        `Tool "${fc.name}" not allowed to run by the user.`,
      ));
    }

    try {
      const abortSignal = new AbortController().signal;
      const toolResult: ToolResult = await tool.execute(
        args,
        abortSignal,
      );

      let content: ToolCallContent | null = null;

      if (toolResult.returnDisplay) {
        if (typeof toolResult.returnDisplay === "string") {
          content = { type: "markdown", markdown: '```\n' + toolResult.returnDisplay + '\n```' };
        } else {
          // todo! send as a type: "diff"
          content = { type: "markdown", markdown: '```diff\n' + toolResult.returnDisplay.fileDiff + '\n```' };
        }
      }

      await this.client.updateToolCall({
        threadId,
        toolCallId: result.id,
        status: "finished",
        content
      });

      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        function_name: fc.name,
        function_args: args,
        duration_ms: durationMs,
        success: true,
      });

      return convertToFunctionResponse(
        fc.name,
        callId,
        toolResult.llmContent,
      );
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      return errorResponse(error);
    }
  }
}
