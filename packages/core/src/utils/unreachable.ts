/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function unreachable(value?: never): never {
  throw new Error(value ? `Unexpected: ${value}` : 'Unreachable');
}
