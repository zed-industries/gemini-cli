/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import { strict as assert } from 'assert';
import { TestRig, printDebugInfo, validateModelOutput } from './test-helper.js';

test('should be able to save to memory', async () => {
  const rig = new TestRig();
  await rig.setup('should be able to save to memory');

  const prompt = `remember that my favorite color is  blue.

  what is my favorite color? tell me that and surround it with $ symbol`;
  const result = await rig.run(prompt);

  const foundToolCall = await rig.waitForToolCall('save_memory');

  // Add debugging information
  if (!foundToolCall || !result.toLowerCase().includes('blue')) {
    const allTools = printDebugInfo(rig, result, {
      'Found tool call': foundToolCall,
      'Contains blue': result.toLowerCase().includes('blue'),
    });

    console.error(
      'Memory tool calls:',
      allTools
        .filter((t) => t.toolRequest.name === 'save_memory')
        .map((t) => t.toolRequest.args),
    );
  }

  assert.ok(foundToolCall, 'Expected to find a save_memory tool call');

  // Validate model output - will throw if no output, warn if missing expected content
  validateModelOutput(result, 'blue', 'Save memory test');
});
