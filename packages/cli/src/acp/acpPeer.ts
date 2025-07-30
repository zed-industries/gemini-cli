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
  isNodeError,
  getErrorMessage,
  isWithinRoot,
  getErrorStatus,
  MCPServerConfig,
  ToolConfirmationOutcome,
  ToolCallConfirmationDetails,
  AuthType,
  clearCachedCredentialFile,
} from '@google/gemini-cli-core';
import * as acp from './acp.js';
import { z } from 'zod';
import { Content, Part, FunctionCall, PartListUnion } from '@google/genai';
import { LoadedSettings, SettingScope } from '../config/settings.js';
import * as fs from 'fs/promises';
import * as path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'crypto';
import { Extension } from '../config/extension.js';
import { CliArgs, loadCliConfig } from '../config/config.js';
import { ClientTools } from './clientTools.js';

export async function runAcpPeer(
  config: Config,
  settings: LoadedSettings,
  extensions: Extension[],
  argv: CliArgs,
) {
  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const server = new GeminiAgentServer(config, settings, extensions, argv);
  await server.connect();
}

class Session {
  pendingSend?: AbortController;

  constructor(
    readonly clientTools: ClientTools,
    readonly chat: GeminiChat,
    readonly config: Config,
    pendingSend?: AbortController,
  ) {
    this.pendingSend = pendingSend;
  }

  debug(msg: string) {
    if (this.config.getDebugMode()) {
      console.warn(msg);
    }
  }
}

class GeminiAgentServer {
  #sessions: Map<string, Session> = new Map();
  #server: McpServer;

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private extensions: Extension[],
    private argv: CliArgs,
  ) {
    this.#server = new McpServer({
      name: 'gemini-cli',
      version: '1.0.0', // todo!
    });

    this.#server.registerTool(
      acp.AGENT_METHODS.authenticate,
      {
        inputSchema: acp.zod.authenticateArgumentsSchema.shape,
      },
      async (args) => {
        await this.authenticate(args);
        return { content: [] };
      },
    );
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

    this.#server.server.oninitialized = () => this.#refreshAgentState();
  }

  async #refreshAgentState() {
    let needsAuthentication = true;
    if (this.settings.merged.selectedAuthType) {
      try {
        await this.config.refreshAuth(this.settings.merged.selectedAuthType);
        needsAuthentication = false;
      } catch (error) {
        console.error('Failed to refresh auth:', error);
      }
    }

    const params: acp.AgentState = {
      authMethods: [
        {
          id: AuthType.LOGIN_WITH_GOOGLE,
          label: 'Log in with Google',
          description: null,
        },
        {
          id: AuthType.USE_GEMINI,
          label: 'Use Gemini API key',
          description: null,
        },
        {
          id: AuthType.USE_VERTEX_AI,
          label: 'Vertex AI',
          description: null,
        },
      ],
      needsAuthentication,
    };

    await this.#server.server.notification({
      method: acp.AGENT_METHODS.agent_state,
      params,
    });
  }

  async connect() {
    const transport = new StdioServerTransport();
    await this.#server.connect(transport);
  }

  async authenticate({ methodId }: acp.AuthenticateArguments): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);

    await clearCachedCredentialFile();
    await this.config.refreshAuth(method);
    this.settings.setValue(SettingScope.User, 'selectedAuthType', method);
  }

  async newSession({
    cwd,
    mcpServers,
    clientTools,
  }: acp.NewSessionArguments): Promise<acp.NewSessionOutput> {
    const sessionId = randomUUID();
    const config = await this.newSessionConfig(sessionId, cwd, mcpServers);
    const geminiClient = config.getGeminiClient();
    const chat = await geminiClient.startChat();
    const session = new Session(
      new ClientTools(clientTools, await config.getToolRegistry()),
      chat,
      config,
    );
    this.#sessions.set(sessionId, session);

    return {
      sessionId,
    };
  }

  async newSessionConfig(
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[],
  ): Promise<Config> {
    const config = await loadCliConfig(
      this.settings.merged,
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

    if (this.settings.merged.selectedAuthType) {
      await config.refreshAuth(this.settings.merged.selectedAuthType);
    }

    return config;
  }

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
    const parts = await this.#resolvePrompt(
      sessionId,
      params.prompt,
      pendingSend.signal,
    );

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
    sessionId: string,
    message: acp.ContentBlock[],
    abortSignal: AbortSignal,
  ): Promise<Part[]> {
    const session = this.#sessions.get(sessionId)!;
    const parts = message.map((part) => {
      switch (part.type) {
        case 'text':
          return { text: part.text };
        case 'resource_link':
          return {
            fileData: {
              mimeData: part.mimeType,
              name: part.name,
              fileUri: part.uri,
            },
          };
        default: {
          throw new Error(`Unexpected chunk type: '${part.type}'`);
        }
      }
    });

    const atPathCommandParts = parts.filter((part) => 'fileData' in part);

    if (atPathCommandParts.length === 0) {
      return parts;
    }

    // Get centralized file discovery service
    const fileDiscovery = session.config.getFileService();
    const respectGitIgnore = session.config.getFileFilteringRespectGitIgnore();

    const pathSpecsToRead: string[] = [];
    const atPathToResolvedSpecMap = new Map<string, string>();
    const contentLabelsForDisplay: string[] = [];
    const ignoredPaths: string[] = [];

    const toolRegistry = await session.config.getToolRegistry();
    const readManyFilesTool = toolRegistry.getTool('read_many_files');
    const globTool = toolRegistry.getTool('glob');

    if (!readManyFilesTool) {
      throw new Error('Error: read_many_files tool not found.');
    }

    for (const atPathPart of atPathCommandParts) {
      const pathName = atPathPart.fileData!.fileUri;
      // Check if path should be ignored by git
      if (fileDiscovery.shouldGitIgnoreFile(pathName)) {
        ignoredPaths.push(pathName);
        const reason = respectGitIgnore
          ? 'git-ignored and will be skipped'
          : 'ignored by custom patterns';
        console.warn(`Path ${pathName} is ${reason}.`);
        continue;
      }
      let currentPathSpec = pathName;
      let resolvedSuccessfully = false;
      try {
        const absolutePath = path.resolve(
          session.config.getTargetDir(),
          pathName,
        );
        if (isWithinRoot(absolutePath, session.config.getTargetDir())) {
          const stats = await fs.stat(absolutePath);
          if (stats.isDirectory()) {
            currentPathSpec = pathName.endsWith('/')
              ? `${pathName}**`
              : `${pathName}/**`;
            session.debug(
              `Path ${pathName} resolved to directory, using glob: ${currentPathSpec}`,
            );
          } else {
            session.debug(
              `Path ${pathName} resolved to file: ${currentPathSpec}`,
            );
          }
          resolvedSuccessfully = true;
        } else {
          session.debug(
            `Path ${pathName} is outside the project directory. Skipping.`,
          );
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (session.config.getEnableRecursiveFileSearch() && globTool) {
            session.debug(
              `Path ${pathName} not found directly, attempting glob search.`,
            );
            try {
              const globResult = await globTool.execute(
                {
                  pattern: `**/*${pathName}*`,
                  path: session.config.getTargetDir(),
                },
                abortSignal,
              );
              if (
                globResult.llmContent &&
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  const firstMatchAbsolute = lines[1].trim();
                  currentPathSpec = path.relative(
                    session.config.getTargetDir(),
                    firstMatchAbsolute,
                  );
                  session.debug(
                    `Glob search for ${pathName} found ${firstMatchAbsolute}, using relative path: ${currentPathSpec}`,
                  );
                  resolvedSuccessfully = true;
                } else {
                  session.debug(
                    `Glob search for '**/*${pathName}*' did not return a usable path. Path ${pathName} will be skipped.`,
                  );
                }
              } else {
                session.debug(
                  `Glob search for '**/*${pathName}*' found no files or an error. Path ${pathName} will be skipped.`,
                );
              }
            } catch (globError) {
              console.error(
                `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
              );
            }
          } else {
            session.debug(
              `Glob tool not found. Path ${pathName} will be skipped.`,
            );
          }
        } else {
          console.error(
            `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
          );
        }
      }
      if (resolvedSuccessfully) {
        pathSpecsToRead.push(currentPathSpec);
        atPathToResolvedSpecMap.set(pathName, currentPathSpec);
        contentLabelsForDisplay.push(pathName);
      }
    }
    // Construct the initial part of the query for the LLM
    let initialQueryText = '';
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if ('text' in chunk) {
        initialQueryText += chunk.text;
      } else {
        // type === 'atPath'
        const resolvedSpec =
          chunk.fileData && atPathToResolvedSpecMap.get(chunk.fileData.fileUri);
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ') &&
          resolvedSpec
        ) {
          // Add space if previous part was text and didn't end with space, or if previous was @path
          const prevPart = parts[i - 1];
          if (
            'text' in prevPart ||
            ('fileData' in prevPart &&
              atPathToResolvedSpecMap.has(prevPart.fileData!.fileUri))
          ) {
            initialQueryText += ' ';
          }
        }
        if (resolvedSpec) {
          initialQueryText += `@${resolvedSpec}`;
        } else {
          // If not resolved for reading (e.g. lone @ or invalid path that was skipped),
          // add the original @-string back, ensuring spacing if it's not the first element.
          if (
            i > 0 &&
            initialQueryText.length > 0 &&
            !initialQueryText.endsWith(' ') &&
            !chunk.fileData?.fileUri.startsWith(' ')
          ) {
            initialQueryText += ' ';
          }
          if (chunk.fileData?.fileUri) {
            initialQueryText += `@${chunk.fileData.fileUri}`;
          }
        }
      }
    }
    initialQueryText = initialQueryText.trim();
    // Inform user about ignored paths
    if (ignoredPaths.length > 0) {
      const ignoreType = respectGitIgnore ? 'git-ignored' : 'custom-ignored';
      session.debug(
        `Ignored ${ignoredPaths.length} ${ignoreType} files: ${ignoredPaths.join(', ')}`,
      );
    }
    // Fallback for lone "@" or completely invalid @-commands resulting in empty initialQueryText
    if (pathSpecsToRead.length === 0) {
      console.warn('No valid file paths found in @ commands to read.');
      return [{ text: initialQueryText }];
    }
    const processedQueryParts: Part[] = [{ text: initialQueryText }];
    const toolArgs = {
      paths: pathSpecsToRead,
      respectGitIgnore, // Use configuration setting
    };

    const callId = `${readManyFilesTool.name}-${Date.now()}`;
    await this.#sendSessionUpdate(sessionId, {
      sessionUpdate: 'toolCall',
      toolCallId: callId,
      status: 'inProgress',
      label: readManyFilesTool.getDescription(toolArgs),
      content: [],
      locations: readManyFilesTool.toolLocations(toolArgs),
      kind: readManyFilesTool.kind,
    });
    try {
      const result = await readManyFilesTool.execute(toolArgs, abortSignal);
      const content = toToolCallContent(result) || {
        type: 'content',
        content: {
          type: 'text',
          text: `Successfully read: ${contentLabelsForDisplay.join(', ')}`,
        },
      };
      await this.#sendSessionUpdate(sessionId, {
        sessionUpdate: 'toolCallUpdate',
        toolCallId: callId,
        status: 'completed',
        content: content ? [content] : [],
      });
      if (Array.isArray(result.llmContent)) {
        const fileContentRegex = /^--- (.*?) ---\n\n([\s\S]*?)\n\n$/;
        processedQueryParts.push({
          text: '\n--- Content from referenced files ---',
        });
        for (const part of result.llmContent) {
          if (typeof part === 'string') {
            const match = fileContentRegex.exec(part);
            if (match) {
              const filePathSpecInContent = match[1]; // This is a resolved pathSpec
              const fileActualContent = match[2].trim();
              processedQueryParts.push({
                text: `\nContent from @${filePathSpecInContent}:\n`,
              });
              processedQueryParts.push({ text: fileActualContent });
            } else {
              processedQueryParts.push({ text: part });
            }
          } else {
            // part is a Part object.
            processedQueryParts.push(part);
          }
        }
        processedQueryParts.push({ text: '\n--- End of content ---' });
      } else {
        console.warn(
          'read_many_files tool returned no content or empty content.',
        );
      }
      return processedQueryParts;
    } catch (error: unknown) {
      await this.#sendSessionUpdate(sessionId, {
        sessionUpdate: 'toolCallUpdate',
        toolCallId: callId,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: `Error reading files (${contentLabelsForDisplay.join(', ')}): ${getErrorMessage(error)}`,
            },
          },
        ],
      });

      throw error;
    }
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
