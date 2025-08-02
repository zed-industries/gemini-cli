/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { aboutCommand } from './aboutCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import * as versionUtils from '../../utils/version.js';
import { MessageType } from '../types.js';

vi.mock('../../utils/version.js', () => ({
  getCliVersion: vi.fn(),
}));

describe('aboutCommand', () => {
  let mockContext: CommandContext;
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getModel: vi.fn(),
        },
        settings: {
          merged: {
            selectedAuthType: 'test-auth',
          },
        },
      },
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext);

    vi.mocked(versionUtils.getCliVersion).mockResolvedValue('test-version');
    vi.spyOn(mockContext.services.config!, 'getModel').mockReturnValue(
      'test-model',
    );
    process.env.GOOGLE_CLOUD_PROJECT = 'test-gcp-project';
    Object.defineProperty(process, 'platform', {
      value: 'test-os',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(aboutCommand.name).toBe('about');
    expect(aboutCommand.description).toBe('show version info');
  });

  it('should call addItem with all version info', async () => {
    process.env.SANDBOX = '';
    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ABOUT,
        cliVersion: 'test-version',
        osVersion: 'test-os',
        sandboxEnv: 'no sandbox',
        modelVersion: 'test-model',
        selectedAuthType: 'test-auth',
        gcpProject: 'test-gcp-project',
      },
      expect.any(Number),
    );
  });

  it('should show the correct sandbox environment variable', async () => {
    process.env.SANDBOX = 'gemini-sandbox';
    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxEnv: 'gemini-sandbox',
      }),
      expect.any(Number),
    );
  });

  it('should show sandbox-exec profile when applicable', async () => {
    process.env.SANDBOX = 'sandbox-exec';
    process.env.SEATBELT_PROFILE = 'test-profile';
    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxEnv: 'sandbox-exec (test-profile)',
      }),
      expect.any(Number),
    );
  });
});
