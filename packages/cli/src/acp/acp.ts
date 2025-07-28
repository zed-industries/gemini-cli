/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/* ACP defines a schema for a protocol that allows GUI applications to interact with agents. */
export const NEW_SESSION_TOOL_NAME = 'acp/new_session';
export const LOAD_SESSION_TOOL_NAME = 'acp/load_session';
export const PROMPT_TOOL_NAME = 'acp/prompt';

// Basic schemas
export const PermissionOptionKindSchema = z.enum([
  'allowOnce',
  'allowAlways',
  'rejectOnce',
  'rejectAlways',
]);

export const ToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
]);

export const ToolCallStatusSchema = z.enum([
  'pending',
  'inProgress',
  'completed',
  'failed',
]);

// Content schemas
export const TextContentSchema = z.object({
  type: z.literal('text'),
});

export const ImageContentSchema = z.object({
  type: z.literal('image'),
});

export const AudioContentSchema = z.object({
  type: z.literal('audio'),
});

export const ResourceLinkSchema = z.object({
  type: z.literal('resource_link'),
});

export const EmbeddedResourceSchema = z.object({
  type: z.literal('resource'),
});

export const ContentBlockSchema = z.union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ResourceLinkSchema,
  EmbeddedResourceSchema,
]);

// Tool related schemas
export const McpToolIdSchema = z.object({
  mcpServer: z.string(),
  toolName: z.string(),
});

export const ClientToolsSchema = z.object({
  readTextFile: z.union([McpToolIdSchema, z.null()]),
  requestPermission: z.union([McpToolIdSchema, z.null()]),
  writeTextFile: z.union([McpToolIdSchema, z.null()]),
});

export const McpServerConfigSchema = z.object({
  args: z.array(z.string()),
  command: z.string(),
  env: z.record(z.string(), z.string()).nullable().optional(),
});

// Diff schemas
export const Diff1Schema = z.object({
  newText: z.string(),
  oldText: z.union([z.string(), z.null()]),
  path: z.string(),
});

export const DiffSchema = z.object({
  diff: Diff1Schema,
});

export const ToolCallContentSchema = z.union([ContentBlockSchema, DiffSchema]);

export const ToolCallLocationSchema = z.object({
  line: z.number().nullable().optional(),
  path: z.string(),
});

export const ToolCall1Schema = z.object({
  content: z.array(ToolCallContentSchema).optional(),
  kind: ToolKindSchema,
  label: z.string(),
  locations: z.array(ToolCallLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  status: ToolCallStatusSchema,
  toolCallId: z.string(),
});

// Session update schemas
export const UserMessageSchema = z
  .object({
    sessionUpdate: z.literal('userMessage'),
  })
  .and(ContentBlockSchema);

export const AgentMessageChunkSchema = z
  .object({
    sessionUpdate: z.literal('agentMessageChunk'),
  })
  .and(ContentBlockSchema);

export const AgentThoughtChunkSchema = z
  .object({
    sessionUpdate: z.literal('agentThoughtChunk'),
  })
  .and(ContentBlockSchema);

export const ToolCallSchema = z.object({
  sessionUpdate: z.literal('toolCall'),
});

export const ToolCallUpdateSchema = z.object({
  sessionUpdate: z.literal('toolCallUpdate'),
});

export const PlanSchema = z.object({
  sessionUpdate: z.literal('plan'),
});

export const SessionUpdateSchema = z.union([
  UserMessageSchema,
  AgentMessageChunkSchema,
  AgentThoughtChunkSchema,
  ToolCallSchema,
  ToolCallUpdateSchema,
  PlanSchema,
]);

// Request/Response schemas
export const NewSessionArgumentsSchema = z.object({
  clientTools: ClientToolsSchema,
  cwd: z.string(),
  mcpServers: z.record(z.string(), McpServerConfigSchema),
});

export const NewSessionOutputSchema = z.object({
  sessionId: z.string(),
});

export const LoadSessionSchema = z.object({
  clientTools: ClientToolsSchema,
  cwd: z.string(),
  mcpServers: z.record(z.string(), McpServerConfigSchema),
  sessionId: z.string(),
});

export const PromptSchema = z.object({
  prompt: z.array(ContentBlockSchema),
  sessionId: z.string(),
});

export const PermissionOptionSchema = z.object({
  kind: PermissionOptionKindSchema,
  label: z.string(),
  optionId: z.string(),
});

export const RequestPermissionArgumentsSchema = z.object({
  options: z.array(PermissionOptionSchema),
  sessionId: z.string(),
  toolCall: ToolCall1Schema,
});

export const RequestPermissionOutcomeSchema = z.union([
  z.object({
    outcome: z.literal('canceled'),
  }),
  z.object({
    optionId: z.string(),
    outcome: z.literal('selected'),
  }),
]);

export const RequestPermissionOutputSchema = z.object({
  outcome: RequestPermissionOutcomeSchema,
});

export const WriteTextFileSchema = z.object({
  content: z.string(),
  path: z.string(),
  sessionId: z.string(),
});

export const ReadTextFileArgumentsSchema = z.object({
  limit: z.number().nullable().optional(),
  line: z.number().nullable().optional(),
  path: z.string(),
  sessionId: z.string(),
});

export const ReadTextFileOutputSchema = z.object({
  content: z.string(),
});

export const AgentClientProtocolSchema = z.union([
  NewSessionArgumentsSchema,
  NewSessionOutputSchema,
  LoadSessionSchema,
  PromptSchema,
  SessionUpdateSchema,
  RequestPermissionArgumentsSchema,
  RequestPermissionOutputSchema,
  WriteTextFileSchema,
  ReadTextFileArgumentsSchema,
  ReadTextFileOutputSchema,
]);

// Type exports
export type AgentClientProtocol = z.infer<typeof AgentClientProtocolSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AgentMessageChunk = z.infer<typeof AgentMessageChunkSchema>;
export type AgentThoughtChunk = z.infer<typeof AgentThoughtChunkSchema>;
export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>;
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;
export type ToolKind = z.infer<typeof ToolKindSchema>;
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;
export type RequestPermissionOutcome = z.infer<
  typeof RequestPermissionOutcomeSchema
>;
export type NewSessionArguments = z.infer<typeof NewSessionArgumentsSchema>;
export type ClientTools = z.infer<typeof ClientToolsSchema>;
export type McpToolId = z.infer<typeof McpToolIdSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type NewSessionOutput = z.infer<typeof NewSessionOutputSchema>;
export type LoadSession = z.infer<typeof LoadSessionSchema>;
export type Prompt = z.infer<typeof PromptSchema>;
export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;
export type AudioContent = z.infer<typeof AudioContentSchema>;
export type ResourceLink = z.infer<typeof ResourceLinkSchema>;
export type EmbeddedResource = z.infer<typeof EmbeddedResourceSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolCallUpdate = z.infer<typeof ToolCallUpdateSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type RequestPermissionArguments = z.infer<
  typeof RequestPermissionArgumentsSchema
>;
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;
export type ToolCall1 = z.infer<typeof ToolCall1Schema>;
export type Diff = z.infer<typeof DiffSchema>;
export type Diff1 = z.infer<typeof Diff1Schema>;
export type ToolCallLocation = z.infer<typeof ToolCallLocationSchema>;
export type RequestPermissionOutput = z.infer<
  typeof RequestPermissionOutputSchema
>;
export type WriteTextFile = z.infer<typeof WriteTextFileSchema>;
export type ReadTextFileArguments = z.infer<typeof ReadTextFileArgumentsSchema>;
export type ReadTextFileOutput = z.infer<typeof ReadTextFileOutputSchema>;
