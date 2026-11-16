import { describe, expect, it } from "vitest";
import { otherSpeaker, personBubbleColor } from "./own-profile";

describe("whose line a person sees", () => {
  const ada = { role: "user", sender: { name: "Ada Lovelace", id: "p_ada" } };
  it("names another person's line on a team, and never the viewer's own", () => {
    expect(otherSpeaker(ada, "p_bob")).toBe("Ada Lovelace");
    expect(otherSpeaker(ada, "p_ada")).toBeNull();
  });
  it("names nothing where one person uses the server, nor a bot's or an unsigned line", () => {
    expect(otherSpeaker(ada, null)).toBeNull();
    expect(otherSpeaker({ role: "bot", sender: ada.sender }, "p_bob")).toBeNull();
    expect(otherSpeaker({ role: "user" }, "p_bob")).toBeNull();
    expect(otherSpeaker({ role: "user", sender: { name: "Someone" } }, "p_bob")).toBeNull();
  });
});

describe("another person's bubble color", () => {
  const people = Array.from({ length: 40 }, (_, i) => `p_${i.toString(16).padStart(8, "0")}`);
  it("is the same on every line of theirs, and differs between most people", () => {
    expect(personBubbleColor("p_olive")).toBe(personBubbleColor("p_olive"));
    expect(new Set(people.map((id) => personBubbleColor(id))).size).toBeGreaterThanOrEqual(6);
  });
  it("is never the bot's own color, and moves no one else", () => {
    for (const id of people) {
      expect(personBubbleColor(id, "green")).not.toBe("green");
      if (personBubbleColor(id) !== "green") expect(personBubbleColor(id, "green")).toBe(personBubbleColor(id));
    }
  });
});
