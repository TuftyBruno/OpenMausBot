import { useMemo, type CSSProperties } from "react";
import type { MausColor } from "@/lib/mascot";
import { userBubbleStyle } from "@/lib/user-bubble-tone";
import { api, type ConfigStatus } from "@/state/store";

export type OwnProfile = NonNullable<ConfigStatus["profile"]>;

/** Settings → Profile on a Team Cloud: the signed-in person's own profile (PUT /api/me, open to every member). The
 * address is their sign-in's and never changes here. Elsewhere Settings → Profile is the server's one profile. */
export function saveTeamProfile(patch: Partial<Pick<OwnProfile, "name" | "aboutMe" | "avatarUrl">>): Promise<OwnProfile> {
  return api<OwnProfile>("/api/me", { method: "PUT", body: JSON.stringify(patch), timeoutMs: 10_000 });
}

/** On a Team Cloud, whose words a person's line is when they are not the viewer's: their name over the line. Null on the
 * viewer's own lines, and wherever one person uses the server (`viewer` null). */
export function otherSpeaker(message: { role: string; sender?: { name: string; id?: string } }, viewer: string | null): string | null {
  if (!viewer || message.role !== "user" || !message.sender?.id || message.sender.id === viewer) return null;
  return message.sender.name.trim() || null;
}

const PERSON_BUBBLE_COLORS: readonly MausColor[] = ["blue", "purple", "teal", "orange", "pink", "cyan", "coral", "yellow", "green", "red"];

/** Another person's bubble where several people use the server: the same color on every line of theirs, picked from their
 * sender id, and never `avoid` (the bot's own), so a person is not taken for the bot. */
export function personBubbleColor(id: string, avoid?: MausColor): MausColor {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  const color = PERSON_BUBBLE_COLORS[hash % PERSON_BUBBLE_COLORS.length]!;
  return color === avoid ? PERSON_BUBBLE_COLORS[(hash + 1) % PERSON_BUBBLE_COLORS.length]! : color;
}

export function usePersonBubbleStyle(id: string | undefined, flat: boolean, avoid?: MausColor): CSSProperties | undefined {
  return useMemo(() => (id ? userBubbleStyle(personBubbleColor(id, avoid), { flat }) : undefined), [id, flat, avoid]);
}
