import { describe, expect, it } from "vitest";
import { RunInputSchema } from "../src/types.js";

describe("RunInputSchema", () => {
  const validInput = {
    userMessage: "Olá, preciso de ajuda",
    conversaId: "conv-platform-1",
    organizationId: "org-1",
    clientId: "cli-1",
  };

  it("accepts a minimal valid payload", () => {
    const parsed = RunInputSchema.parse(validInput);
    expect(parsed.userMessage).toBe("Olá, preciso de ajuda");
    expect(parsed.conversaId).toBe("conv-platform-1");
    expect(parsed.calendarConnectionId).toBeUndefined();
    expect(parsed.agenteResponsavelAtendimento).toBeUndefined();
  });

  it("accepts all optional fields when provided", () => {
    const parsed = RunInputSchema.parse({
      ...validInput,
      agenteResponsavelAtendimento: "process_info",
      calendarConnectionId: "cal-1",
      extra: { clientName: "Maria" },
    });
    expect(parsed.agenteResponsavelAtendimento).toBe("process_info");
    expect(parsed.calendarConnectionId).toBe("cal-1");
    expect(parsed.extra).toEqual({ clientName: "Maria" });
  });

  it("rejects an empty userMessage", () => {
    expect(() =>
      RunInputSchema.parse({ ...validInput, userMessage: "" }),
    ).toThrow();
  });

  it("rejects missing organizationId", () => {
    expect(() =>
      RunInputSchema.parse({ ...validInput, organizationId: "" }),
    ).toThrow();
  });

  it("accepts missing clientId (triagem sem pessoa vinculada)", () => {
    const parsed = RunInputSchema.parse({
      ...validInput,
      clientId: undefined,
    });
    expect(parsed.clientId).toBeUndefined();
  });

  it("treats empty clientId as omitted", () => {
    const parsed = RunInputSchema.parse({
      ...validInput,
      clientId: "",
    });
    expect(parsed.clientId).toBeUndefined();
  });
});
