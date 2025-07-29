/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  GeminiChat,
  ToolRegistry,
  logToolCall,
  ToolResult,
  convertToFunctionResponse,
  // ToolCallConfirmationDetails,
  // ToolConfirmationOutcome,
  // isNodeError,
  // getErrorMessage,
  // isWithinRoot,
  getErrorStatus,
  MCPServerConfig,
  ToolConfirmationOutcome,
  ToolCallConfirmationDetails,
} from '@google/gemini-cli-core';
import * as acp from './acp.js';
import { z } from 'zod';
import { Content, Part, FunctionCall, PartListUnion } from '@google/genai';
import { Settings } from '../config/settings.js';
// import * as fs from 'fs/promises';
// import * as path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'crypto';
import { Extension } from '../config/extension.js';
import { CliArgs, loadCliConfig } from '../config/config.js';
import { ClientTools } from './clientTools.js';

export async function runAcpPeer(
  baseSettings: Settings,
  extensions: Extension[],
  argv: CliArgs,
) {
  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const server = new GeminiAgentServer(baseSettings, extensions, argv);
  await server.connect();
}

interface Session {
  clientTools: ClientTools;
  chat: GeminiChat;
  config: Config;
  pendingSend?: AbortController;
}

class GeminiAgentServer {
  #sessions: Map<string, Session> = new Map();
  #server: McpServer;

  constructor(
    private baseSettings: Settings,
    private extensions: Extension[],
    private argv: CliArgs,
  ) {
    this.#server = new McpServer({
      name: 'gemini-cli',
      version: '1.0.0', // todo!
    });

    this.#server.registerTool(
      acp.AGENT_METHODS.new_session,
      {
        inputSchema: acp.zod.newSessionArgumentsSchema.shape,
        outputSchema: acp.zod.newSessionOutputSchema.shape,
      },
      async (args) => ({
        content: [],
        structuredContent: await this.newSession(args),
      }),
    );
    this.#server.registerTool(
      acp.AGENT_METHODS.prompt,
      {
        inputSchema: acp.zod.promptSchema.shape,
      },
      async (args) => {
        await this.prompt(args);
        return { content: [] };
      },
    );
  }

  async connect() {
    const transport = new StdioServerTransport();
    await this.#server.connect(transport);
  }

  async newConfig(
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[],
  ): Promise<Config> {
    const settings: Settings = this.baseSettings;
    const config = await loadCliConfig(
      this.baseSettings,
      this.extensions,
      sessionId,
      this.argv,
    );

    const mergedMcpServers = { ...config.getMcpServers() };

    for (const { command, args, env: rawEnv, name } of mcpServers) {
      const env: Record<string, string> = {};
      for (const { name: envName, value } of rawEnv) {
        env[envName] = value;
      }
      mergedMcpServers[name] = new MCPServerConfig(command, args, env, cwd);
    }

    config.update({
      cwd,
      sessionId,
      targetDir: cwd,
      model: config.getModel(),
      debugMode: config.getDebugMode(),
      mcpServers: mergedMcpServers,
    });

    await config.initialize();

    if (settings.selectedAuthType) {
      try {
        await config.refreshAuth(settings.selectedAuthType);
      } catch (error) {
        // todo! handle auth
        console.error('Failed to refresh auth:', error);
        throw error;
      }
    }

    return config;
  }

  async newSession({
    cwd,
    mcpServers,
    clientTools,
  }: acp.NewSessionArguments): Promise<acp.NewSessionOutput> {
    const sessionId = randomUUID();
    const config = await this.newConfig(sessionId, cwd, mcpServers);
    const geminiClient = config.getGeminiClient();
    const chat = await geminiClient.startChat();
    const session = {
      chat,
      clientTools: new ClientTools(clientTools, await config.getToolRegistry()),
      config,
    };
    this.#sessions.set(sessionId, session);

    return {
      sessionId,
    };
  }

  // async initialize(_: acp.InitializeParams): Promise<acp.InitializeResponse> {
  //   let isAuthenticated = false;
  //   if (this.settings.merged.selectedAuthType) {
  //     try {
  //       await session.config.refreshAuth(this.settings.merged.selectedAuthType);
  //       isAuthenticated = true;
  //     } catch (error) {
  //       console.error('Failed to refresh auth:', error);
  //     }
  //   }
  //   return { protocolVersion: acp.LATEST_PROTOCOL_VERSION, isAuthenticated };
  // }

  // async authenticate(): Promise<void> {
  //   await clearCachedCredentialFile();
  //   await session.config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
  //   this.settings.setValue(
  //     SettingScope.User,
  //     'selectedAuthType',
  //     AuthType.LOGIN_WITH_GOOGLE,
  //   );
  // }

  // async cancelSendMessage(): Promise<void> {
  //   if (!this.pendingSend) {
  //     throw new Error('Not currently generating');
  //   }

  //   this.pendingSend.abort();
  //   delete this.pendingSend;
  // }

  async prompt(params: acp.Prompt): Promise<void> {
    if (!this.#sessions.has(params.sessionId)) {
      throw new Error('Session not found');
    }

    const sessionId = params.sessionId;
    const session = this.#sessions.get(params.sessionId)!;

    session.pendingSend?.abort();
    const pendingSend = new AbortController();
    session.pendingSend = pendingSend;

    const promptId = Math.random().toString(16).slice(2);
    const chat = session.chat;

    const toolRegistry: ToolRegistry = await session.config.getToolRegistry();
    const parts = await this.#resolvePrompt(params.prompt, pendingSend.signal);

    let nextMessage: Content | null = { role: 'user', parts };

    while (nextMessage !== null) {
      if (pendingSend.signal.aborted) {
        chat.addHistory(nextMessage);
        return;
      }

      const functionCalls: FunctionCall[] = [];

      try {
        const responseStream = await chat.sendMessageStream(
          {
            message: nextMessage?.parts ?? [],
            config: {
              abortSignal: pendingSend.signal,
              tools: [
                {
                  functionDeclarations: toolRegistry.getFunctionDeclarations(),
                },
              ],
            },
          },
          promptId,
        );
        nextMessage = null;

        for await (const resp of responseStream) {
          if (pendingSend.signal.aborted) {
            return;
          }

          if (resp.candidates && resp.candidates.length > 0) {
            const candidate = resp.candidates[0];
            for (const part of candidate.content?.parts ?? []) {
              if (!part.text) {
                continue;
              }

              const content: acp.ContentBlock = {
                type: 'text',
                text: part.text,
              };

              this.#sendSessionUpdate(sessionId, {
                sessionUpdate: part.thought
                  ? 'agentThoughtChunk'
                  : 'agentMessageChunk',
                content,
              });
            }
          }

          if (resp.functionCalls) {
            functionCalls.push(...resp.functionCalls);
          }
        }
      } catch (error) {
        if (getErrorStatus(error) === 429) {
          // todo! send tagged error?
          throw new Error('Rate limit exceeded. Try again later.');
        }

        throw error;
      }

      if (functionCalls.length > 0) {
        const toolResponseParts: Part[] = [];

        for (const fc of functionCalls) {
          const response = await this.#runTool(
            sessionId,
            pendingSend.signal,
            promptId,
            fc,
          );

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
  }

  async #sendSessionUpdate(
    sessionId: string,
    update: acp.SessionUpdate,
  ): Promise<void> {
    const params = {
      sessionId,
      ...update,
    };

    this.#server.server.notification({
      method: acp.AGENT_METHODS.session_update,
      params,
    });
  }

  async #runTool(
    sessionId: string,
    abortSignal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<PartListUnion> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;
    const session = this.#sessions.get(sessionId)!;

    const startTime = Date.now();

    const errorResponse = (error: Error) => {
      const durationMs = Date.now() - startTime;
      logToolCall(session.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
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

    const toolRegistry: ToolRegistry = await session.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name as string);

    if (!tool) {
      return errorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    const confirmationDetails = await tool.shouldConfirmExecute(
      args,
      abortSignal,
    );

    if (confirmationDetails && session.clientTools.requestPermission) {
      const content: acp.ToolCallContent[] = [];

      if (confirmationDetails.type === 'edit') {
        content.push({
          type: 'diff',
          path: confirmationDetails.fileName,
          oldText: confirmationDetails.originalContent,
          newText: confirmationDetails.newContent,
        });
      }

      const params: acp.RequestPermissionArguments = {
        sessionId,
        options: toPermissionOptions(confirmationDetails),
        toolCall: {
          toolCallId: callId,
          status: 'pending',
          label: tool.getDescription(args),
          content,
          locations: tool.toolLocations(args),
          kind: tool.kind,
        },
      };

      const output = await session.clientTools.requestPermission.call(
        params,
        abortSignal,
      );
      const outcome =
        output.outcome.outcome === 'canceled'
          ? ToolConfirmationOutcome.Cancel
          : z
              .nativeEnum(ToolConfirmationOutcome)
              .parse(output.outcome.optionId);

      await confirmationDetails.onConfirm(outcome);

      switch (outcome) {
        case ToolConfirmationOutcome.Cancel:
          return errorResponse(
            new Error(`Tool "${fc.name}" was canceled by the user.`),
          );
        case ToolConfirmationOutcome.ProceedOnce:
        case ToolConfirmationOutcome.ProceedAlways:
        case ToolConfirmationOutcome.ProceedAlwaysServer:
        case ToolConfirmationOutcome.ProceedAlwaysTool:
        case ToolConfirmationOutcome.ModifyWithEditor:
          break;
        default: {
          const resultOutcome: never = outcome;
          throw new Error(`Unexpected: ${resultOutcome}`);
        }
      }
    } else {
      await this.#sendSessionUpdate(sessionId, {
        sessionUpdate: 'toolCall',
        toolCallId: callId,
        status: 'inProgress',
        label: tool.getDescription(args),
        content: [],
        locations: tool.toolLocations(args),
        kind: tool.kind,
      });
    }

    try {
      const toolResult: ToolResult = await tool.execute(args, abortSignal);
      const content = toToolCallContent(toolResult);

      await this.#sendSessionUpdate(sessionId, {
        sessionUpdate: 'toolCallUpdate',
        toolCallId: callId,
        status: 'completed',
        content: content ? [content] : [],
      });

      const durationMs = Date.now() - startTime;
      logToolCall(session.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        function_name: fc.name,
        function_args: args,
        duration_ms: durationMs,
        success: true,
        prompt_id: promptId,
      });

      return convertToFunctionResponse(fc.name, callId, toolResult.llmContent);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      await this.#sendSessionUpdate(sessionId, {
        sessionUpdate: 'toolCallUpdate',
        toolCallId: callId,
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: error.message } },
        ],
      });

      return errorResponse(error);
    }
  }

  async #resolvePrompt(
    message: acp.ContentBlock[],
    _abortSignal: AbortSignal,
  ): Promise<Part[]> {
    return message.map((part) => {
      switch (part.type) {
        case 'text':
          return { text: part.text };
        case 'image':
        case 'audio':
          return { inlineData: { data: part.data, mimeType: part.mimeType } };
        case 'resource':
          return {
            inlineData: {
              mimeType: part.resource.mimeType ?? undefined,
              data:
                'text' in part.resource
                  ? part.resource.text
                  : part.resource.blob,
            },
          };
        case 'resource_link':
          return {
            fileData: {
              mimeData: part.mimeType,
              name: part.name,
              fileUri: part.uri,
            },
          };
        default: {
          const unreachable: never = part;
          throw new Error(`Unexpected chunk type: '${unreachable}'`);
        }
      }
    });

    // todo! @mentions
    // const atPathCommandParts = message.chunks.filter((part) => 'path' in part);

    // if (atPathCommandParts.length === 0) {
    //   return message.chunks.map((chunk) => {
    //     if ('text' in chunk) {
    //       return { text: chunk.text };
    //     } else {
    //       throw new Error('Unexpected chunk type');
    //     }
    //   });
    // }

    // // Get centralized file discovery service
    // const fileDiscovery = session.config.getFileService();
    // const respectGitIgnore = session.config.getFileFilteringRespectGitIgnore();

    // const pathSpecsToRead: string[] = [];
    // const atPathToResolvedSpecMap = new Map<string, string>();
    // const contentLabelsForDisplay: string[] = [];
    // const ignoredPaths: string[] = [];

    // const toolRegistry = await session.config.getToolRegistry();
    // const readManyFilesTool = toolRegistry.getTool('read_many_files');
    // const globTool = toolRegistry.getTool('glob');

    // if (!readManyFilesTool) {
    //   throw new Error('Error: read_many_files tool not found.');
    // }

    // for (const atPathPart of atPathCommandParts) {
    //   const pathName = atPathPart.path;

    //   // Check if path should be ignored by git
    //   if (fileDiscovery.shouldGitIgnoreFile(pathName)) {
    //     ignoredPaths.push(pathName);
    //     const reason = respectGitIgnore
    //       ? 'git-ignored and will be skipped'
    //       : 'ignored by custom patterns';
    //     console.warn(`Path ${pathName} is ${reason}.`);
    //     continue;
    //   }

    //   let currentPathSpec = pathName;
    //   let resolvedSuccessfully = false;

    //   try {
    //     const absolutePath = path.resolve(session.config.getTargetDir(), pathName);
    //     if (isWithinRoot(absolutePath, session.config.getTargetDir())) {
    //       const stats = await fs.stat(absolutePath);
    //       if (stats.isDirectory()) {
    //         currentPathSpec = pathName.endsWith('/')
    //           ? `${pathName}**`
    //           : `${pathName}/**`;
    //         this.#debug(
    //           `Path ${pathName} resolved to directory, using glob: ${currentPathSpec}`,
    //         );
    //       } else {
    //         this.#debug(
    //           `Path ${pathName} resolved to file: ${currentPathSpec}`,
    //         );
    //       }
    //       resolvedSuccessfully = true;
    //     } else {
    //       this.#debug(
    //         `Path ${pathName} is outside the project directory. Skipping.`,
    //       );
    //     }
    //   } catch (error) {
    //     if (isNodeError(error) && error.code === 'ENOENT') {
    //       if (session.config.getEnableRecursiveFileSearch() && globTool) {
    //         this.#debug(
    //           `Path ${pathName} not found directly, attempting glob search.`,
    //         );
    //         try {
    //           const globResult = await globTool.execute(
    //             {
    //               pattern: `**/*${pathName}*`,
    //               path: session.config.getTargetDir(),
    //             },
    //             abortSignal,
    //           );
    //           if (
    //             globResult.llmContent &&
    //             typeof globResult.llmContent === 'string' &&
    //             !globResult.llmContent.startsWith('No files found') &&
    //             !globResult.llmContent.startsWith('Error:')
    //           ) {
    //             const lines = globResult.llmContent.split('\n');
    //             if (lines.length > 1 && lines[1]) {
    //               const firstMatchAbsolute = lines[1].trim();
    //               currentPathSpec = path.relative(
    //                 session.config.getTargetDir(),
    //                 firstMatchAbsolute,
    //               );
    //               this.#debug(
    //                 `Glob search for ${pathName} found ${firstMatchAbsolute}, using relative path: ${currentPathSpec}`,
    //               );
    //               resolvedSuccessfully = true;
    //             } else {
    //               this.#debug(
    //                 `Glob search for '**/*${pathName}*' did not return a usable path. Path ${pathName} will be skipped.`,
    //               );
    //             }
    //           } else {
    //             this.#debug(
    //               `Glob search for '**/*${pathName}*' found no files or an error. Path ${pathName} will be skipped.`,
    //             );
    //           }
    //         } catch (globError) {
    //           console.error(
    //             `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
    //           );
    //         }
    //       } else {
    //         this.#debug(
    //           `Glob tool not found. Path ${pathName} will be skipped.`,
    //         );
    //       }
    //     } else {
    //       console.error(
    //         `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
    //       );
    //     }
    //   }

    //   if (resolvedSuccessfully) {
    //     pathSpecsToRead.push(currentPathSpec);
    //     atPathToResolvedSpecMap.set(pathName, currentPathSpec);
    //     contentLabelsForDisplay.push(pathName);
    //   }
    // }

    // // Construct the initial part of the query for the LLM
    // let initialQueryText = '';
    // for (let i = 0; i < message.chunks.length; i++) {
    //   const chunk = message.chunks[i];
    //   if ('text' in chunk) {
    //     initialQueryText += chunk.text;
    //   } else {
    //     // type === 'atPath'
    //     const resolvedSpec = atPathToResolvedSpecMap.get(chunk.path);
    //     if (
    //       i > 0 &&
    //       initialQueryText.length > 0 &&
    //       !initialQueryText.endsWith(' ') &&
    //       resolvedSpec
    //     ) {
    //       // Add space if previous part was text and didn't end with space, or if previous was @path
    //       const prevPart = message.chunks[i - 1];
    //       if (
    //         'text' in prevPart ||
    //         ('path' in prevPart && atPathToResolvedSpecMap.has(prevPart.path))
    //       ) {
    //         initialQueryText += ' ';
    //       }
    //     }
    //     if (resolvedSpec) {
    //       initialQueryText += `@${resolvedSpec}`;
    //     } else {
    //       // If not resolved for reading (e.g. lone @ or invalid path that was skipped),
    //       // add the original @-string back, ensuring spacing if it's not the first element.
    //       if (
    //         i > 0 &&
    //         initialQueryText.length > 0 &&
    //         !initialQueryText.endsWith(' ') &&
    //         !chunk.path.startsWith(' ')
    //       ) {
    //         initialQueryText += ' ';
    //       }
    //       initialQueryText += `@${chunk.path}`;
    //     }
    //   }
    // }
    // initialQueryText = initialQueryText.trim();

    // // Inform user about ignored paths
    // if (ignoredPaths.length > 0) {
    //   const ignoreType = respectGitIgnore ? 'git-ignored' : 'custom-ignored';
    //   this.#debug(
    //     `Ignored ${ignoredPaths.length} ${ignoreType} files: ${ignoredPaths.join(', ')}`,
    //   );
    // }

    // // Fallback for lone "@" or completely invalid @-commands resulting in empty initialQueryText
    // if (pathSpecsToRead.length === 0) {
    //   console.warn('No valid file paths found in @ commands to read.');
    //   return [{ text: initialQueryText }];
    // }

    // const processedQueryParts: Part[] = [{ text: initialQueryText }];

    // const toolArgs = {
    //   paths: pathSpecsToRead,
    //   respectGitIgnore, // Use configuration setting
    // };

    // const toolCall = await this.client.pushToolCall({
    //   icon: readManyFilesTool.icon,
    //   label: readManyFilesTool.getDescription(toolArgs),
    // });
    // try {
    //   const result = await readManyFilesTool.execute(toolArgs, abortSignal);
    //   const content = toToolCallContent(result) || {
    //     type: 'markdown',
    //     markdown: `Successfully read: ${contentLabelsForDisplay.join(', ')}`,
    //   };
    //   await this.client.updateToolCall({
    //     toolCallId: toolCall.id,
    //     status: 'finished',
    //     content,
    //   });

    //   if (Array.isArray(result.llmContent)) {
    //     const fileContentRegex = /^--- (.*?) ---\n\n([\s\S]*?)\n\n$/;
    //     processedQueryParts.push({
    //       text: '\n--- Content from referenced files ---',
    //     });
    //     for (const part of result.llmContent) {
    //       if (typeof part === 'string') {
    //         const match = fileContentRegex.exec(part);
    //         if (match) {
    //           const filePathSpecInContent = match[1]; // This is a resolved pathSpec
    //           const fileActualContent = match[2].trim();
    //           processedQueryParts.push({
    //             text: `\nContent from @${filePathSpecInContent}:\n`,
    //           });
    //           processedQueryParts.push({ text: fileActualContent });
    //         } else {
    //           processedQueryParts.push({ text: part });
    //         }
    //       } else {
    //         // part is a Part object.
    //         processedQueryParts.push(part);
    //       }
    //     }
    //     processedQueryParts.push({ text: '\n--- End of content ---' });
    //   } else {
    //     console.warn(
    //       'read_many_files tool returned no content or empty content.',
    //     );
    //   }

    //   return processedQueryParts;
    // } catch (error: unknown) {
    //   await this.client.updateToolCall({
    //     toolCallId: toolCall.id,
    //     status: 'error',
    //     content: {
    //       type: 'markdown',
    //       markdown: `Error reading files (${contentLabelsForDisplay.join(', ')}): ${getErrorMessage(error)}`,
    //     },
    //   });
    //   throw error;
    // }
  }
}

function toToolCallContent(toolResult: ToolResult): acp.ToolCallContent | null {
  if (toolResult.returnDisplay) {
    if (typeof toolResult.returnDisplay === 'string') {
      return {
        type: 'content',
        content: { type: 'text', text: toolResult.returnDisplay },
      };
    } else {
      return {
        type: 'diff',
        path: toolResult.returnDisplay.fileName,
        oldText: toolResult.returnDisplay.originalContent,
        newText: toolResult.returnDisplay.newContent,
      };
    }
  } else {
    return null;
  }
}

function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
): acp.PermissionOption[] {
  switch (confirmation.type) {
    case 'edit':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          label: 'Allow All Edits',
          kind: 'allowAlways',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          label: 'Allow',
          kind: 'allowOnce',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          label: 'Reject',
          kind: 'rejectOnce',
        },
      ];
    case 'exec':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          label: `Always Allow ${confirmation.rootCommand}`,
          kind: 'allowAlways',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          label: 'Allow',
          kind: 'allowOnce',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          label: 'Reject',
          kind: 'rejectOnce',
        },
      ];
    case 'mcp':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlwaysServer,
          label: `Always Allow ${confirmation.serverName}`,
          kind: 'allowAlways',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedAlwaysTool,
          label: `Always Allow ${confirmation.toolName}`,
          kind: 'allowAlways',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          label: 'Allow',
          kind: 'allowOnce',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          label: 'Reject',
          kind: 'rejectOnce',
        },
      ];
    case 'info':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          label: `Always Allow`,
          kind: 'allowAlways',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          label: 'Allow',
          kind: 'allowOnce',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          label: 'Reject',
          kind: 'rejectOnce',
        },
      ];
    default: {
      const unreachable: never = confirmation;
      throw new Error(`Unexpected: ${unreachable}`);
    }
  }
}

// function toToolCallOutcome(
//   outcome: acp.ToolCallConfirmationOutcome,
// ): ToolConfirmationOutcome {
//   switch (outcome) {
//     case 'allow':
//       return ToolConfirmationOutcome.ProceedOnce;
//     case 'alwaysAllow':
//       return ToolConfirmationOutcome.ProceedAlways;
//     case 'alwaysAllowMcpServer':
//       return ToolConfirmationOutcome.ProceedAlwaysServer;
//     case 'alwaysAllowTool':
//       return ToolConfirmationOutcome.ProceedAlwaysTool;
//     case 'reject':
//     case 'cancel':
//       return ToolConfirmationOutcome.Cancel;
//     default: {
//       const unreachable: never = outcome;
//       throw new Error(`Unexpected: ${unreachable}`);
//     }
//   }
// }
