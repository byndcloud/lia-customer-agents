import { describe, expect, it } from "vitest";
import {
  CHATBOT_QUEUE_CLAIM_WINDOW_SLACK_SECONDS,
  chatbotQueueClaimWindowSeconds,
  DEFAULT_QUEUE_DELAY_SECONDS,
} from "../src/config/env.js";

describe("chatbotQueueClaimWindowSeconds", () => {
  it("subtrai a folga do delay da fila, mínimo 1", () => {
    expect(CHATBOT_QUEUE_CLAIM_WINDOW_SLACK_SECONDS).toBe(2);
    expect(chatbotQueueClaimWindowSeconds(20)).toBe(18);
    expect(chatbotQueueClaimWindowSeconds(22)).toBe(20);
    expect(chatbotQueueClaimWindowSeconds(3)).toBe(1);
    expect(chatbotQueueClaimWindowSeconds(1)).toBe(1);
  });
});

describe("DEFAULT_QUEUE_DELAY_SECONDS", () => {
  it("é o fallback documentado quando env não define delay", () => {
    expect(DEFAULT_QUEUE_DELAY_SECONDS).toBe(20);
  });
});
