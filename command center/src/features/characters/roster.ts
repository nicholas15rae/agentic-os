import type { CharacterEventKind, Corner } from "./logic";

/**
 * UI fixes 2: the overlay characters (data only; the drawings live in `drawings.tsx`). Original
 * designs, no real-person likeness. Add one here plus its drawing to give it a corner.
 */
export interface CharacterDef {
  id: string;
  name: string;
  description: string;
  /** Its corner until you pick another. */
  corner: Corner;
  /** Which happenings make it pop up. */
  reactsTo: CharacterEventKind[];
  /** What it says: per happening, and when tapped. `{n}` = things done today. */
  lines: Partial<Record<CharacterEventKind, string[]>> & { tap: string[]; done: string[] };
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: "gabagool",
    name: "Gabagool",
    description: "The coins mascot: a cheeky slice of gabagool holding a gold coin. Pops up when you get things done and on streaks.",
    corner: "br",
    reactsTo: ["done", "streak", "reward", "hello"],
    lines: {
      tap: ["Ay, that tickles.", "You rang?", "Still here. Still marbled.", "Coins don't earn themselves.", "Go on, finish something."],
      done: ["Nice one. That's a coin.", "Done and dusted.", "Look at you go.", "Another one off the list."],
      streak: ["{n} done today. You're on a roll.", "That's {n}. Coins are raining.", "{n} today. Somebody's cooking."],
      reward: ["Coins! Treat yourself.", "Cha-ching."],
      hello: ["Hey. I'll be in the corner."],
    },
  },
];

export const characterById = (id: string): CharacterDef | undefined => CHARACTERS.find((c) => c.id === id);
