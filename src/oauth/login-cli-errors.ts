import { AnthropicTokenError } from "./anthropic";
import { publicOAuthAuthenticationErrorMessage } from "./index";
import { XaiTokenRequestError } from "./xai";

/** Keep terminal login failures within the public OAuth error vocabulary. */
export function reportOAuthLoginError(error: unknown): never {
  const status = error instanceof AnthropicTokenError ? error.httpStatus
    : error instanceof XaiTokenRequestError ? error.status : undefined;
  const diagnostic = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? `HTTP ${status}` : "oauth_authentication_failed";
  console.error(`\n❌ OAuth login failed (${diagnostic}): ${publicOAuthAuthenticationErrorMessage(error)}`);
  process.exit(1);
}
