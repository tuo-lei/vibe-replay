/** Named speaker helpers for multi-party replay cards. */

export function isGenericHumanSpeaker(name?: string): boolean {
  return !name || /^(user|you|human)$/i.test(name);
}

export function userSpeakerLabel(name?: string): string {
  return isGenericHumanSpeaker(name) ? "You" : name!;
}

export function assistantSpeakerLabel(name?: string): string {
  return name?.trim() || "Assistant";
}
