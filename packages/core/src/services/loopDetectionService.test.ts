/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { GeminiClient } from '../core/client.js';
import {
  GeminiEventType,
  ServerGeminiContentEvent,
  ServerGeminiStreamEvent,
  ServerGeminiToolCallRequestEvent,
} from '../core/turn.js';
import * as loggers from '../telemetry/loggers.js';
import { LoopType } from '../telemetry/types.js';
import { LoopDetectionService } from './loopDetectionService.js';

vi.mock('../telemetry/loggers.js', () => ({
  logLoopDetected: vi.fn(),
}));

const TOOL_CALL_LOOP_THRESHOLD = 5;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;

describe('LoopDetectionService', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getTelemetryEnabled: () => true,
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    vi.clearAllMocks();
  });

  const createToolCallRequestEvent = (
    name: string,
    args: Record<string, unknown>,
  ): ServerGeminiToolCallRequestEvent => ({
    type: GeminiEventType.ToolCallRequest,
    value: {
      name,
      args,
      callId: 'test-id',
      isClientInitiated: false,
      prompt_id: 'test-prompt-id',
    },
  });

  const createContentEvent = (content: string): ServerGeminiContentEvent => ({
    type: GeminiEventType.Content,
    value: content,
  });

  const createRepetitiveContent = (id: number, length: number): string => {
    const baseString = `This is a unique sentence, id=${id}. `;
    let content = '';
    while (content.length < length) {
      content += baseString;
    }
    return content.slice(0, length);
  };

  describe('Tool Call Loop Detection', () => {
    it(`should not detect a loop for fewer than TOOL_CALL_LOOP_THRESHOLD identical calls`, () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.addAndCheck(event)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it(`should detect a loop on the TOOL_CALL_LOOP_THRESHOLD-th identical call`, () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(event);
      }
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should detect a loop on subsequent identical calls', () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        service.addAndCheck(event);
      }
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop for different tool calls', () => {
      const event1 = createToolCallRequestEvent('testTool', {
        param: 'value1',
      });
      const event2 = createToolCallRequestEvent('testTool', {
        param: 'value2',
      });
      const event3 = createToolCallRequestEvent('anotherTool', {
        param: 'value1',
      });

      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 2; i++) {
        expect(service.addAndCheck(event1)).toBe(false);
        expect(service.addAndCheck(event2)).toBe(false);
        expect(service.addAndCheck(event3)).toBe(false);
      }
    });

    it('should not reset tool call counter for other event types', () => {
      const toolCallEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });
      const otherEvent = {
        type: 'thought',
      } as unknown as ServerGeminiStreamEvent;

      // Send events just below the threshold
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.addAndCheck(toolCallEvent)).toBe(false);
      }

      // Send a different event type
      expect(service.addAndCheck(otherEvent)).toBe(false);

      // Send the tool call event again, which should now trigger the loop
      expect(service.addAndCheck(toolCallEvent)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });
  });

  describe('Content Loop Detection', () => {
    const generateRandomString = (length: number) => {
      let result = '';
      const characters =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const charactersLength = characters.length;
      for (let i = 0; i < length; i++) {
        result += characters.charAt(
          Math.floor(Math.random() * charactersLength),
        );
      }
      return result;
    };

    it('should not detect a loop for random content', () => {
      service.reset('');
      for (let i = 0; i < 1000; i++) {
        const content = generateRandomString(10);
        const isLoop = service.addAndCheck(createContentEvent(content));
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when a chunk of content repeats consecutively', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
      }
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop if repetitions are very far apart', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);
      const fillerContent = generateRandomString(500);

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        isLoop = service.addAndCheck(createContentEvent(fillerContent));
      }
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Content Loop Detection with Code Blocks', () => {
    it('should not detect a loop when repetitive content is inside a code block', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      service.addAndCheck(createContentEvent('```\n'));

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      const isLoop = service.addAndCheck(createContentEvent('\n```'));
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when repetitive content is outside a code block', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      service.addAndCheck(createContentEvent('```'));
      service.addAndCheck(createContentEvent('\nsome code\n'));
      service.addAndCheck(createContentEvent('```'));

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
      }
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should handle content with multiple code blocks and no loops', () => {
      service.reset('');
      service.addAndCheck(createContentEvent('```\ncode1\n```'));
      service.addAndCheck(createContentEvent('\nsome text\n'));
      const isLoop = service.addAndCheck(createContentEvent('```\ncode2\n```'));

      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should handle content with mixed code blocks and looping text', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      service.addAndCheck(createContentEvent('```'));
      service.addAndCheck(createContentEvent('\ncode1\n'));
      service.addAndCheck(createContentEvent('```'));

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
      }

      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop for a long code block with some repeating tokens', () => {
      service.reset('');
      const repeatingTokens =
        'for (let i = 0; i < 10; i++) { console.log(i); }';

      service.addAndCheck(createContentEvent('```\n'));

      for (let i = 0; i < 20; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatingTokens));
        expect(isLoop).toBe(false);
      }

      const isLoop = service.addAndCheck(createContentEvent('\n```'));
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking when a code fence is found', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

      // This should not trigger a loop because of the reset
      service.addAndCheck(createContentEvent('```'));

      // We are now in a code block, so loop detection should be off.
      // Let's add the repeated content again, it should not trigger a loop.
      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      const event = createContentEvent('');
      expect(service.addAndCheck(event)).toBe(false);
    });
  });

  describe('Reset Functionality', () => {
    it('tool call should reset content count', () => {
      const contentEvent = createContentEvent('Some content.');
      const toolEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });
      for (let i = 0; i < 9; i++) {
        service.addAndCheck(contentEvent);
      }

      service.addAndCheck(toolEvent);

      // Should start fresh
      expect(service.addAndCheck(createContentEvent('Fresh content.'))).toBe(
        false,
      );
    });
  });

  describe('General Behavior', () => {
    it('should return false for unhandled event types', () => {
      const otherEvent = {
        type: 'unhandled_event',
      } as unknown as ServerGeminiStreamEvent;
      expect(service.addAndCheck(otherEvent)).toBe(false);
      expect(service.addAndCheck(otherEvent)).toBe(false);
    });
  });
});

describe('LoopDetectionService LLM Checks', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;
  let mockGeminiClient: GeminiClient;
  let abortController: AbortController;

  beforeEach(() => {
    mockGeminiClient = {
      getHistory: vi.fn().mockReturnValue([]),
      generateJson: vi.fn(),
    } as unknown as GeminiClient;

    mockConfig = {
      getGeminiClient: () => mockGeminiClient,
      getDebugMode: () => false,
      getTelemetryEnabled: () => true,
    } as unknown as Config;

    service = new LoopDetectionService(mockConfig);
    abortController = new AbortController();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const advanceTurns = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await service.turnStarted(abortController.signal);
    }
  };

  it('should not trigger LLM check before LLM_CHECK_AFTER_TURNS', async () => {
    await advanceTurns(29);
    expect(mockGeminiClient.generateJson).not.toHaveBeenCalled();
  });

  it('should trigger LLM check on the 30th turn', async () => {
    mockGeminiClient.generateJson = vi
      .fn()
      .mockResolvedValue({ confidence: 0.1 });
    await advanceTurns(30);
    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(1);
  });

  it('should detect a cognitive loop when confidence is high', async () => {
    // First check at turn 30
    mockGeminiClient.generateJson = vi
      .fn()
      .mockResolvedValue({ confidence: 0.85, reasoning: 'Repetitive actions' });
    await advanceTurns(30);
    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(1);

    // The confidence of 0.85 will result in a low interval.
    // The interval will be: 5 + (15 - 5) * (1 - 0.85) = 5 + 10 * 0.15 = 6.5 -> rounded to 7
    await advanceTurns(6); // advance to turn 36

    mockGeminiClient.generateJson = vi
      .fn()
      .mockResolvedValue({ confidence: 0.95, reasoning: 'Repetitive actions' });
    const finalResult = await service.turnStarted(abortController.signal); // This is turn 37

    expect(finalResult).toBe(true);
    expect(loggers.logLoopDetected).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        'event.name': 'loop_detected',
        loop_type: LoopType.LLM_DETECTED_LOOP,
      }),
    );
  });

  it('should not detect a loop when confidence is low', async () => {
    mockGeminiClient.generateJson = vi
      .fn()
      .mockResolvedValue({ confidence: 0.5, reasoning: 'Looks okay' });
    await advanceTurns(30);
    const result = await service.turnStarted(abortController.signal);
    expect(result).toBe(false);
    expect(loggers.logLoopDetected).not.toHaveBeenCalled();
  });

  it('should adjust the check interval based on confidence', async () => {
    // Confidence is 0.0, so interval should be MAX_LLM_CHECK_INTERVAL (15)
    mockGeminiClient.generateJson = vi
      .fn()
      .mockResolvedValue({ confidence: 0.0 });
    await advanceTurns(30); // First check at turn 30
    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(1);

    await advanceTurns(14); // Advance to turn 44
    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(1);

    await service.turnStarted(abortController.signal); // Turn 45
    expect(mockGeminiClient.generateJson).toHaveBeenCalledTimes(2);
  });

  it('should handle errors from generateJson gracefully', async () => {
    mockGeminiClient.generateJson = vi
      .fn()
      .mockRejectedValue(new Error('API error'));
    await advanceTurns(30);
    const result = await service.turnStarted(abortController.signal);
    expect(result).toBe(false);
    expect(loggers.logLoopDetected).not.toHaveBeenCalled();
  });
});
