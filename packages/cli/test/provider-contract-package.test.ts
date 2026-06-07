import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ContentBlock as ContractContentBlock,
  ParsedTurn as ContractParsedTurn,
  Provider as ContractProvider,
  ProviderParseResult as ContractProviderParseResult,
  SessionInfo as ContractSessionInfo,
} from "@vibe-replay/provider-contract";
import { getAllProviders } from "../src/providers/index.js";
import type {
  ContentBlock as CliContentBlock,
  ParsedTurn as CliParsedTurn,
  Provider as CliProvider,
  ProviderParseResult as CliProviderParseResult,
  SessionInfo as CliSessionInfo,
} from "../src/types.js";

describe("provider contract package boundary", () => {
  it("keeps CLI provider type re-exports assignable to the provider contract", () => {
    expectTypeOf<CliProvider>().toEqualTypeOf<ContractProvider>();
    expectTypeOf<CliSessionInfo>().toEqualTypeOf<ContractSessionInfo>();
    expectTypeOf<CliProviderParseResult>().toEqualTypeOf<ContractProviderParseResult>();
    expectTypeOf<CliParsedTurn>().toEqualTypeOf<ContractParsedTurn>();
    expectTypeOf<CliContentBlock>().toEqualTypeOf<ContractContentBlock>();
  });

  it("exposes the same built-in provider registry through the contract type", () => {
    const providers: ContractProvider[] = getAllProviders();

    expect(providers.map((provider) => provider.name)).toEqual([
      "claude-cowork",
      "claude-desktop",
      "claude-code",
      "codex",
      "cursor",
      "pi",
    ]);
    for (const provider of providers) {
      expect(provider.displayName).toBeTruthy();
      expect(typeof provider.discover).toBe("function");
      expect(typeof provider.parse).toBe("function");
    }
  });
});
