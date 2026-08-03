import type { components } from './generated/schema.js';

export type ChatCompletionRequest =
  components['schemas']['ChatCompletionRequest'];
export type ChatCompletionResponse =
  components['schemas']['ChatCompletionResponse'];
export type ChatCompletionChunk = components['schemas']['ChatCompletionChunk'];
export type ErrorResponse = components['schemas']['ErrorResponse'];
export type ModelList = components['schemas']['ModelList'];
export type LivenessResponse = components['schemas']['LivenessResponse'];
export type ReadinessResponse = components['schemas']['ReadinessResponse'];
