/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FileSystemService,
  FileSystemServiceOptions,
} from '@google/gemini-cli-core';
import * as acp from './acp.js';

/**
 * ACP client-based implementation of FileSystemService
 */
export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly client: acp.Client,
    private readonly sessionId: string,
    private readonly capabilities: acp.FileSystemCapability,
    private readonly fallback: FileSystemService,
  ) {}

  async readTextFile(
    filePath: string,
    options?: FileSystemServiceOptions,
  ): Promise<string> {
    if (!this.capabilities.readTextFile) {
      return this.fallback.readTextFile(filePath, options);
    }

    const response = await this.client.readTextFile({
      path: filePath,
      sessionId: this.sessionId,
      line: options?.line ?? null,
      limit: options?.limit ?? null,
    });

    return response.content;
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(filePath, content);
    }

    await this.client.writeTextFile({
      path: filePath,
      content,
      sessionId: this.sessionId,
    });
  }
}
