/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import z from 'zod';
import { Tool, ToolRegistry } from '@google/gemini-cli-core';
import { FunctionResponse, PartListUnion } from '@google/genai';
import * as acp from './acp.js';

export class ClientTools {
  #tools: acp.ClientTools;
  #registry: ToolRegistry;

  requestPermission: ClientTool<
    acp.RequestPermissionArguments,
    acp.RequestPermissionOutput
  > | null;

  readTextFile: ClientTool<
    acp.ReadTextFileArguments,
    acp.ReadTextFileOutput
  > | null;

  writeTextFile: ClientTool<acp.WriteTextFile> | null;

  constructor(tools: acp.ClientTools, registry: ToolRegistry) {
    this.#tools = tools;
    this.#registry = registry;
    this.requestPermission = this.#buildTool(
      'requestPermission',
      acp.zod.requestPermissionOutputSchema,
    );
    this.readTextFile = this.#buildTool(
      'readTextFile',
      acp.zod.readTextFileOutputSchema,
    );
    this.writeTextFile = this.#buildTool('writeTextFile');
  }

  #buildTool<In, Out = null>(
    name: keyof acp.ClientTools,
    outputSchema?: z.ZodType<Out>,
  ): ClientTool<In, Out extends null ? null : Out> | null {
    const toolId = this.#tools[name];
    if (!toolId) return null;

    const tool = this.#registry.getServerTool(
      toolId.mcpServer,
      toolId.toolName,
    );

    if (!tool) {
      throw new Error(
        `${toolId.mcpServer}/${toolId.toolName} not found in tool registry`,
      );
    }

    return new ClientTool(tool, outputSchema) as ClientTool<
      In,
      Out extends null ? null : Out
    >;
  }
}

export class ClientTool<Input, Output = null> {
  #tool: Tool;
  #outputSchema: z.ZodType<Output> | null;

  constructor(tool: Tool, outputSchema?: z.ZodType<Output>) {
    this.#tool = tool;
    this.#outputSchema = outputSchema || null;
  }

  async call(params: Input, abortSignal: AbortSignal): Promise<Output> {
    const result = await this.#tool.execute(params, abortSignal);
    const response = getFunctionResponse(result.llmContent);

    if (!response) {
      throw new Error('No function response found');
    }

    if (this.#outputSchema) {
      if (response.response && 'structuredContent' in response.response) {
        return this.#outputSchema.parse(response.response.structuredContent);
      } else {
        throw new Error('Expected structured content but none was found');
      }
    }

    return null as Output;
  }
}

function getFunctionResponse(content: PartListUnion): FunctionResponse | null {
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part.functionResponse) {
        return part.functionResponse;
      }
    }
  } else if (typeof content === 'object' && content.functionResponse) {
    return content.functionResponse;
  }
  return null;
}
