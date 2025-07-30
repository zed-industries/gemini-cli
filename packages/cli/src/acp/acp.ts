/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

export * as zod from './zod.js';
import * as generated from './zod.js';

export type AuthenticateArguments = z.infer<
  typeof generated.authenticateArgumentsSchema
>;

export type WriteTextFile = z.infer<typeof generated.writeTextFileSchema>;

export type ReadTextFileArguments = z.infer<
  typeof generated.readTextFileArgumentsSchema
>;

export type ReadTextFileOutput = z.infer<
  typeof generated.readTextFileOutputSchema
>;

export type AuthMethod = z.infer<typeof generated.authMethodSchema>;

export type Role = z.infer<typeof generated.roleSchema>;

export type TextResourceContents = z.infer<
  typeof generated.textResourceContentsSchema
>;

export type BlobResourceContents = z.infer<
  typeof generated.blobResourceContentsSchema
>;

export type ToolKind = z.infer<typeof generated.toolKindSchema>;

export type ToolCallLocation = z.infer<typeof generated.toolCallLocationSchema>;

export type ToolCallStatus = z.infer<typeof generated.toolCallStatusSchema>;

export type PlanEntry = z.infer<typeof generated.planEntrySchema>;

export type PermissionOptionKind = z.infer<
  typeof generated.permissionOptionKindSchema
>;

export type RequestPermissionOutcome = z.infer<
  typeof generated.requestPermissionOutcomeSchema
>;

export type McpToolId = z.infer<typeof generated.mcpToolIdSchema>;

export type EnvVariable = z.infer<typeof generated.envVariableSchema>;

export type ClientTools = z.infer<typeof generated.clientToolsSchema>;

export type McpServer = z.infer<typeof generated.mcpServerSchema>;

export type Annotations = z.infer<typeof generated.annotationsSchema>;

export type PermissionOption = z.infer<typeof generated.permissionOptionSchema>;

export type RequestPermissionOutput = z.infer<
  typeof generated.requestPermissionOutputSchema
>;

export type NewSessionArguments = z.infer<
  typeof generated.newSessionArgumentsSchema
>;

export type NewSessionOutput = z.infer<typeof generated.newSessionOutputSchema>;

export type LoadSession = z.infer<typeof generated.loadSessionSchema>;

export type EmbeddedResourceResource = z.infer<
  typeof generated.embeddedResourceResourceSchema
>;

export type ContentBlock = z.infer<typeof generated.contentBlockSchema>;

export type ToolCallContent = z.infer<typeof generated.toolCallContentSchema>;

export type Prompt = z.infer<typeof generated.promptSchema>;

export type ToolCall = z.infer<typeof generated.toolCallSchema>;

export type SessionUpdate = z.infer<typeof generated.sessionUpdateSchema>;

export type RequestPermissionArguments = z.infer<
  typeof generated.requestPermissionArgumentsSchema
>;

export type AgentClientProtocol = z.infer<
  typeof generated.agentClientProtocolSchema
>;

export const AGENT_METHODS = {
  authenticate: 'acp/authenticate',
  new_session: 'acp/new_session',
  load_session: 'acp/load_session',
  prompt: 'acp/prompt',
  session_update: 'acp/session_update',
};
