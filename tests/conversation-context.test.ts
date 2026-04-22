import { beforeEach, describe, expect, it, vi } from "vitest";

const activeServiceMaybeSingleMock = vi.fn();
const responseMaybeSingleMock = vi.fn();

vi.mock("../src/db/client.js", () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      if (table === "whatsapp_atendimentos") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                order: () => ({
                  maybeSingle: activeServiceMaybeSingleMock,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "whatsapp_conversation_responses") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                not: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: responseMaybeSingleMock,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table mock: ${table}`);
    },
  }),
}));

import { getLastResponseIfActive } from "../src/services/conversationContext.js";

describe("getLastResponseIfActive", () => {
  beforeEach(() => {
    activeServiceMaybeSingleMock.mockReset();
    responseMaybeSingleMock.mockReset();
  });

  it("returns lastResponseId when active service has response row", async () => {
    activeServiceMaybeSingleMock.mockResolvedValueOnce({
      data: {
        id: "service-1",
        iniciado_em: "2026-04-22T12:00:00Z",
        tipo_responsavel: "chatbot",
      },
      error: null,
    });
    responseMaybeSingleMock.mockResolvedValueOnce({
      data: {
        response_id: "resp_123",
        created_at: "2026-04-22T12:01:00Z",
        whatsapp_mensagem: {
          conversa_id: "conv-1",
          created_at: "2026-04-22T12:01:00Z",
        },
      },
      error: null,
    });

    const result = await getLastResponseIfActive("conv-1");

    expect(result).toEqual({
      lastResponseId: "resp_123",
      isNewService: false,
      chainDecisionReason: "response_found",
    });
  });

  it("returns null when active service has no response row", async () => {
    activeServiceMaybeSingleMock.mockResolvedValueOnce({
      data: {
        id: "service-1",
        iniciado_em: "2026-04-22T12:00:00Z",
        tipo_responsavel: "chatbot",
      },
      error: null,
    });
    responseMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const result = await getLastResponseIfActive("conv-1");

    expect(result).toEqual({
      lastResponseId: null,
      isNewService: false,
      chainDecisionReason: "no_response_row_for_service",
    });
  });

  it("returns null when response query errors (strict no-chain fallback)", async () => {
    activeServiceMaybeSingleMock.mockResolvedValueOnce({
      data: {
        id: "service-1",
        iniciado_em: "2026-04-22T12:00:00Z",
        tipo_responsavel: "chatbot",
      },
      error: null,
    });
    responseMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: "db timeout" },
    });

    const result = await getLastResponseIfActive("conv-1");

    expect(result).toEqual({
      lastResponseId: null,
      isNewService: false,
      chainDecisionReason: "query_error_fallback_to_null",
    });
  });

  it("returns null and marks new service when no active service exists", async () => {
    activeServiceMaybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    const result = await getLastResponseIfActive("conv-1");

    expect(result).toEqual({
      lastResponseId: null,
      isNewService: true,
      chainDecisionReason: "no_active_service",
    });
    expect(responseMaybeSingleMock).not.toHaveBeenCalled();
  });
});
