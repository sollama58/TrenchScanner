import { describe, expect, it } from "vitest";
import { privyOAuthReturn } from "./privyBridge";

describe("privyOAuthReturn", () => {
  it("spots Privy's Google or X return in the address, and nothing else", () => {
    expect(privyOAuthReturn("?privy_oauth_code=abc&privy_oauth_state=def&privy_oauth_provider=google")).toBe(
      true,
    );
    expect(privyOAuthReturn("?tab=live&privy_oauth_state=def")).toBe(true);
    expect(privyOAuthReturn("")).toBe(false);
    expect(privyOAuthReturn("?wallet=abc")).toBe(false);
    expect(privyOAuthReturn("?my_privy_oauth_code=abc")).toBe(false);
  });
});
