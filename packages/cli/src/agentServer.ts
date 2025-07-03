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
  logToolCall,
  ToolResult,
  convertToFunctionResponse,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  clearCachedCredentialFile,
} from '@google/gemini-cli-core';
import * as acp from 'agentic-coding-protocol';
import {
  Agent,
  Client,
  Connection,
  SendUserMessageParams,
  SendUserMessageResponse,
  ToolCallContent,
  InitializeParams,
  InitializeResponse,
  AuthenticateParams,
  AuthenticateResponse,
  CancelSendMessageResponse,
} from 'agentic-coding-protocol';
import { Readable, Writable } from 'node:stream';
import { Content, Part, FunctionCall, PartListUnion } from '@google/genai';
import { LoadedSettings, SettingScope } from './config/settings.js';

export async function runAgentServer(config: Config, settings: LoadedSettings) {
  const stdout = Writable.toWeb(process.stdout);
  const stdin = Readable.toWeb(process.stdin) as ReadableStream;

  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;

  Connection.agentToClient(
    (client: Client) => new GeminiAgent(config, settings, client),
    stdout,
    stdin,
  );
}

class GeminiAgent implements Agent {
  chat?: GeminiChat;
  pendingSend?: AbortController;

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private client: Client,
  ) {}

  async initialize(_params: InitializeParams): Promise<InitializeResponse> {
    if (this.settings.merged.selectedAuthType) {
      let success = false;
      try {
        await this.config.refreshAuth(this.settings.merged.selectedAuthType);
        success = true;
      } catch (error) {
        console.error('Failed to refresh auth:', error);
      }

      return { isAuthenticated: success };
    }
    return { isAuthenticated: false };
  }

  async authenticate(
    _params: AuthenticateParams,
  ): Promise<AuthenticateResponse> {
    await clearCachedCredentialFile();
    await this.config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
    this.settings.setValue(
      SettingScope.User,
      'selectedAuthType',
      AuthType.LOGIN_WITH_GOOGLE,
    );

    return null;
  }

  async cancelSendMessage(): Promise<CancelSendMessageResponse> {
    if (!this.pendingSend) {
      throw new Error('Not currently generating');
    }

    this.pendingSend.abort();
    delete this.pendingSend;

    return null;
  }

  async sendUserMessage(
    params: SendUserMessageParams,
  ): Promise<SendUserMessageResponse> {
    this.pendingSend?.abort();
    const pendingSend = new AbortController();
    this.pendingSend = pendingSend;

    if (!this.chat) {
      const geminiClient = this.config.getGeminiClient();
      this.chat = await geminiClient.startChat();
    }

    const chat = this.chat!;

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

    let nextMessage: Content | null = { role: 'user', parts };

    while (nextMessage !== null) {
      if (pendingSend.signal.aborted) {
        // todo!("test this runs when we cancel while we are waiting for tool confirmation or running ")
        chat.addHistory(nextMessage);
        break;
      }

      const functionCalls: FunctionCall[] = [];

      const responseStream = await chat.sendMessageStream({
        message: nextMessage?.parts ?? [],
        config: {
          abortSignal: pendingSend.signal,
          tools: [
            { functionDeclarations: toolRegistry.getFunctionDeclarations() },
          ],
        },
      });
      nextMessage = null;

      for await (const resp of responseStream) {
        if (pendingSend.signal.aborted) {
          throw new Error('Aborted');
        }

        if (resp.candidates && resp.candidates.length > 0) {
          const candidate = resp.candidates[0];
          for (const part of candidate.content?.parts ?? []) {
            if (!part.text) {
              // todo!
              continue;
            }

            this.client.streamAssistantMessageChunk({
              chunk: {
                type: part.thought ? 'thought' : 'text',
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
          const response = await this.#runTool(pendingSend.signal, fc);

          const parts = Array.isArray(response) ? response : [response];

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

  async #runTool(
    abortSignal: AbortSignal,
    fc: FunctionCall,
  ): Promise<PartListUnion> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;

    const startTime = Date.now();

    const errorResponse = (error: Error) => {
      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        function_name: fc.name ?? '',
        function_args: args,
        duration_ms: durationMs,
        success: false,
        error: error.message,
      });

      return [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        },
      ];
    };

    if (!fc.name) {
      return errorResponse(new Error('Missing function name'));
    }

    const toolRegistry: ToolRegistry = await this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name as string);

    if (!tool) {
      return errorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    let toolCallId;
    const confirmationDetails = await tool.shouldConfirmExecute(
      args,
      abortSignal,
    );
    if (confirmationDetails) {
      let content: ToolCallContent | null = null;
      if (confirmationDetails.type === 'edit') {
        content = {
          type: 'diff',
          path: confirmationDetails.fileName,
          oldText: confirmationDetails.originalContent,
          newText: confirmationDetails.newContent,
        };
      }

      const result = await this.client.requestToolCallConfirmation({
        label: tool.getDescription(args),
        icon: tool.acpIcon,
        content,
        confirmation: toAcpToolCallConfirmation(confirmationDetails),
      });

      await confirmationDetails.onConfirm(toToolCallOutcome(result.outcome));
      switch (result.outcome) {
        case 'reject':
          return errorResponse(
            new Error(`Tool "${fc.name}" not allowed to run by the user.`),
          );

        case 'cancel':
          return errorResponse(
            new Error(`Tool "${fc.name}" was canceled by the user.`),
          );
        case 'allow':
        case 'alwaysAllow':
        case 'alwaysAllowMcpServer':
        case 'alwaysAllowTool':
          break;
        default:
          unreachable(result.outcome);
      }

      toolCallId = result.id;
    } else {
      const result = await this.client.pushToolCall({
        icon: tool.acpIcon,
        label: tool.getDescription(args),
      });

      toolCallId = result.id;
    }

    try {
      const toolResult: ToolResult = await tool.execute(args, abortSignal);

      let content: ToolCallContent | null = null;

      if (toolResult.returnDisplay) {
        if (typeof toolResult.returnDisplay === 'string') {
          content = {
            type: 'markdown',
            markdown: '```\n' + toolResult.returnDisplay + '\n```',
          };
        } else {
          content = {
            type: 'diff',
            path: toolResult.returnDisplay.fileName,
            oldText: toolResult.returnDisplay.originalContent,
            newText: toolResult.returnDisplay.newContent,
          };
        }
      }

      // todo! live updates?

      await this.client.updateToolCall({
        toolCallId,
        status: 'finished',
        content,
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

      return convertToFunctionResponse(fc.name, callId, toolResult.llmContent);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.client.updateToolCall({
        toolCallId,
        status: 'error',
        content: { type: 'markdown', markdown: error.message },
      });

      return errorResponse(error);
    }
  }
}

function toAcpToolCallConfirmation(
  confirmationDetails: ToolCallConfirmationDetails,
): acp.ToolCallConfirmation {
  switch (confirmationDetails.type) {
    case 'edit': {
      return { type: 'edit' };
    }
    case 'exec': {
      return {
        type: 'execute',
        rootCommand: confirmationDetails.rootCommand,
        command: confirmationDetails.command,
      };
    }
    case 'mcp': {
      return {
        type: 'mcp',
        serverName: confirmationDetails.serverName,
        toolName: confirmationDetails.toolName,
        toolDisplayName: confirmationDetails.toolDisplayName,
      };
    }
    case 'info': {
      return {
        type: 'fetch',
        urls: confirmationDetails.urls || [],
        description: confirmationDetails.urls?.length
          ? null
          : confirmationDetails.prompt,
      };
    }
    default: {
      return unreachable(confirmationDetails);
    }
  }
}

function toToolCallOutcome(
  outcome: acp.ToolCallConfirmationOutcome,
): ToolConfirmationOutcome {
  switch (outcome) {
    case 'allow':
      return ToolConfirmationOutcome.ProceedOnce;
    case 'alwaysAllow':
      return ToolConfirmationOutcome.ProceedAlways;
    case 'alwaysAllowMcpServer':
      return ToolConfirmationOutcome.ProceedAlwaysServer;
    case 'alwaysAllowTool':
      return ToolConfirmationOutcome.ProceedAlwaysTool;
    case 'reject':
    case 'cancel':
      return ToolConfirmationOutcome.Cancel;
    default:
      return unreachable(outcome);
  }
}
