import { describe, expect, it } from "vitest";
import { findNameMatch, nameTokens } from "./nameMatch";

const catalog = [
  { id: "titos", name: "Tito's Handmade Vodka" },
  { id: "well-vodka", name: "Vodka - Well" },
  { id: "coke", name: "Coke (Fountain or Bottle)" },
  { id: "diet-coke", name: "Diet Coke (Fountain or Bottle)" },
  { id: "sprite", name: "Sprite (Fountain or Bottle)" },
  { id: "ginger-ale", name: "Ginger Ale (Fountain or Bottle)" },
  { id: "lemonade", name: "Lemonade (Housemade or Pre-mix)" },
  { id: "tea", name: "Iced Tea (Housemade or Pre-mix)" },
  { id: "teq-blanco", name: "Tequila - Blanco" },
  { id: "teq-repo", name: "Tequila - Reposado" },
  { id: "ketchup", name: "Ketchup" },
];

describe("nameTokens", () => {
  it("drops possessives, punctuation, pack words and sizes; expands ticket abbreviations", () => {
    expect(nameTokens("Tito's Handmade Vodka")).toEqual(["tito", "vodka"]);
    expect(nameTokens("TITOS VODKA 750")).toEqual(["tito", "vodka"]);
    expect(nameTokens("2.5GBIB DT COKE")).toEqual(["diet", "coke"]);
    expect(nameTokens("2.5GBIB SEAG G ALE")).toEqual(["seagram", "ginger", "ale"]);
    expect(nameTokens("Coke (Fountain or Bottle)")).toEqual(["coke"]);
    expect(nameTokens("KETCHUP 6/#10")).toEqual(["ketchup"]);
  });
});

describe("findNameMatch — a draft-born item with a plausible name wins over a duplicate", () => {
  it("invoice line TITOS VODKA 750 → the existing Tito's Handmade Vodka, not Vodka - Well", () => {
    expect(findNameMatch(["TITOS VODKA 750"], catalog)?.id).toBe("titos");
  });
  it("the matcher's proposed new-item name is tried too", () => {
    expect(findNameMatch(["TITO'S 750ML", "Tito's Vodka"], catalog)?.id).toBe("titos");
  });
  it("bag-in-box syrup lines land on the fountain items; Diet never lands on Coke and vice versa", () => {
    expect(findNameMatch(["2.5GBIB COKE"], catalog)?.id).toBe("coke");
    expect(findNameMatch(["2.5GBIB DT COKE"], catalog)?.id).toBe("diet-coke");
    expect(findNameMatch(["2.5GBIB SPRITE"], catalog)?.id).toBe("sprite");
    expect(findNameMatch(["COKE ZERO 2.5GBIB"], catalog)).toBeNull();
  });
  it("qualifiers decide between siblings; a bare word that fits two items is not a match", () => {
    expect(findNameMatch(["TEQUILA BLANCO 1L"], catalog)?.id).toBe("teq-blanco");
    expect(findNameMatch(["TEQUILA REPOSADO 750"], catalog)?.id).toBe("teq-repo");
    expect(findNameMatch(["TEQUILA 750"], catalog)).toBeNull();
    // "Vodka - Well" carries the qualifier "well" the line lacks; a bare "vodka" covers only half of "Tito's Vodka" → nothing qualifies
    expect(findNameMatch(["VODKA 1.75L"], catalog)).toBeNull();
  });
  it("a brand word in front of a product we stock still lands on it; a generic word inside a different product does not", () => {
    expect(findNameMatch(["2.5GBIB SEAG G ALE"], catalog)?.id).toBe("ginger-ale");
    expect(findNameMatch(["PATRON TEQUILA BLANCO 750"], catalog)?.id).toBe("teq-blanco");
    expect(findNameMatch(["KETCHUP 6/#10"], catalog)?.id).toBe("ketchup");
    // "Ketchup" is only a third of "HEINZ TOMATO KETCHUP" and "Tomatoes" half of "TOMATO PASTE": the model decides
    expect(findNameMatch(["HEINZ TOMATO KETCHUP 6/#10"], catalog)).toBeNull();
    expect(findNameMatch(["TOMATO PASTE 6/#10"], [...catalog, { id: "tomatoes", name: "Tomatoes" }])).toBeNull();
    expect(findNameMatch(["COKE ZERO 2.5GBIB"], catalog)).toBeNull();
  });
});
