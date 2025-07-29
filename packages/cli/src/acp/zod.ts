/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

export const newSessionOutputSchema = z.object({
  sessionId: z.string(),
});

export const writeTextFileArgumentsSchema = z.object({
  content: z.string(),
  path: z.string(),
  sessionId: z.string(),
});

export const readTextFileArgumentsSchema = z.object({
  limit: z.number().optional().nullable(),
  line: z.number().optional().nullable(),
  path: z.string(),
  sessionId: z.string(),
});

export const readTextFileOutputSchema = z.object({
  content: z.string(),
});

export const roleSchema = z.union([z.literal('assistant'), z.literal('user')]);

export const textResourceContentsSchema = z.object({
  mimeType: z.string().optional().nullable(),
  text: z.string(),
  uri: z.string(),
});

export const blobResourceContentsSchema = z.object({
  blob: z.string(),
  mimeType: z.string().optional().nullable(),
  uri: z.string(),
});

export const toolKindSchema = z.union([
  z.literal('read'),
  z.literal('edit'),
  z.literal('delete'),
  z.literal('move'),
  z.literal('search'),
  z.literal('execute'),
  z.literal('think'),
  z.literal('fetch'),
  z.literal('other'),
]);

export const toolCallLocationSchema = z.object({
  line: z.number().optional().nullable(),
  path: z.string(),
});

export const toolCallStatusSchema = z.union([
  z.literal('pending'),
  z.literal('inProgress'),
  z.literal('completed'),
  z.literal('failed'),
]);

export const planEntrySchema = z.object({
  content: z.string(),
  priority: z.union([z.literal('high'), z.literal('medium'), z.literal('low')]),
  status: z.union([
    z.literal('pending'),
    z.literal('in_progress'),
    z.literal('completed'),
  ]),
});

export const permissionOptionKindSchema = z.union([
  z.literal('allowOnce'),
  z.literal('allowAlways'),
  z.literal('rejectOnce'),
  z.literal('rejectAlways'),
]);

export const requestPermissionOutcomeSchema = z.union([
  z.object({
    outcome: z.literal('canceled'),
  }),
  z.object({
    optionId: z.string(),
    outcome: z.literal('selected'),
  }),
]);

export const mcpToolIdSchema = z.object({
  mcpServer: z.string(),
  toolName: z.string(),
});

export const envVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const clientToolsSchema = z.object({
  readTextFile: mcpToolIdSchema.nullable(),
  requestPermission: mcpToolIdSchema.nullable(),
  writeTextFile: mcpToolIdSchema.nullable(),
});

export const mcpServerSchema = z.object({
  args: z.array(z.string()),
  command: z.string(),
  env: z.array(envVariableSchema),
  name: z.string(),
});

export const annotationsSchema = z.object({
  audience: z.array(roleSchema).optional().nullable(),
  lastModified: z.string().optional().nullable(),
  priority: z.number().optional().nullable(),
});

export const permissionOptionSchema = z.object({
  kind: permissionOptionKindSchema,
  label: z.string(),
  optionId: z.string(),
});

export const requestPermissionOutputSchema = z.object({
  outcome: requestPermissionOutcomeSchema,
});

export const newSessionArgumentsSchema = z.object({
  clientTools: clientToolsSchema,
  cwd: z.string(),
  mcpServers: z.array(mcpServerSchema),
});

export const loadSessionSchema = z.object({
  clientTools: clientToolsSchema,
  cwd: z.string(),
  mcpServers: z.array(mcpServerSchema),
  sessionId: z.string(),
});

export const embeddedResourceResourceSchema = z.union([
  textResourceContentsSchema,
  blobResourceContentsSchema,
]);

export const contentBlockSchema = z.union([
  z.object({
    annotations: annotationsSchema.optional().nullable(),
    text: z.string(),
    type: z.literal('text'),
  }),
  z.object({
    annotations: annotationsSchema.optional().nullable(),
    data: z.string(),
    mimeType: z.string(),
    type: z.literal('image'),
  }),
  z.object({
    annotations: annotationsSchema.optional().nullable(),
    data: z.string(),
    mimeType: z.string(),
    type: z.literal('audio'),
  }),
  z.object({
    annotations: annotationsSchema.optional().nullable(),
    description: z.string().optional().nullable(),
    mimeType: z.string().optional().nullable(),
    name: z.string(),
    size: z.number().optional().nullable(),
    title: z.string().optional().nullable(),
    type: z.literal('resource_link'),
    uri: z.string(),
  }),
  z.object({
    annotations: annotationsSchema.optional().nullable(),
    resource: embeddedResourceResourceSchema,
    type: z.literal('resource'),
  }),
]);

export const toolCallContentSchema = z.union([
  z.object({
    content: contentBlockSchema,
    type: z.literal('content'),
  }),
  z.object({
    newText: z.string(),
    oldText: z.string().nullable(),
    path: z.string(),
    type: z.literal('diff'),
  }),
]);

export const promptSchema = z.object({
  prompt: z.array(contentBlockSchema),
  sessionId: z.string(),
});

export const toolCallSchema = z.object({
  content: z.array(toolCallContentSchema).optional(),
  kind: toolKindSchema,
  label: z.string(),
  locations: z.array(toolCallLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  status: toolCallStatusSchema,
  toolCallId: z.string(),
});

export const sessionUpdateSchema = z.union([
  z.object({
    content: contentBlockSchema,
    sessionUpdate: z.literal('userMessageChunk'),
  }),
  z.object({
    content: contentBlockSchema,
    sessionUpdate: z.literal('agentMessageChunk'),
  }),
  z.object({
    content: contentBlockSchema,
    sessionUpdate: z.literal('agentThoughtChunk'),
  }),
  z.object({
    content: z.array(toolCallContentSchema).optional(),
    kind: toolKindSchema,
    label: z.string(),
    locations: z.array(toolCallLocationSchema).optional(),
    rawInput: z.unknown().optional(),
    sessionUpdate: z.literal('toolCall'),
    status: toolCallStatusSchema,
    toolCallId: z.string(),
  }),
  z.object({
    content: z.array(toolCallContentSchema).optional().nullable(),
    kind: toolKindSchema.optional().nullable(),
    label: z.string().optional().nullable(),
    locations: z.array(toolCallLocationSchema).optional().nullable(),
    rawInput: z.unknown().optional(),
    sessionUpdate: z.literal('toolCallUpdate'),
    status: toolCallStatusSchema.optional().nullable(),
    toolCallId: z.string(),
  }),
  z.object({
    entries: z.array(planEntrySchema),
    sessionUpdate: z.literal('plan'),
  }),
]);

export const requestPermissionArgumentsSchema = z.object({
  options: z.array(permissionOptionSchema),
  sessionId: z.string(),
  toolCall: toolCallSchema,
});

export const agentClientProtocolSchema = z.union([
  newSessionArgumentsSchema,
  newSessionOutputSchema,
  loadSessionSchema,
  promptSchema,
  sessionUpdateSchema,
  requestPermissionArgumentsSchema,
  requestPermissionOutputSchema,
  writeTextFileArgumentsSchema,
  readTextFileArgumentsSchema,
  readTextFileOutputSchema,
]);
