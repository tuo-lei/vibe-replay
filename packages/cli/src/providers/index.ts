import { claudeCodeProvider } from "./claude-code/index.js";
import { claudeDesktopProvider } from "./claude-desktop/index.js";
import { cursorProvider } from "./cursor/index.js";
import type { Provider } from "./types.js";

const providers: Provider[] = [claudeDesktopProvider, claudeCodeProvider, cursorProvider];

export function getAllProviders(): Provider[] {
  return providers;
}

export function getProvider(name: string): Provider | undefined {
  return providers.find((p) => p.name === name);
}
