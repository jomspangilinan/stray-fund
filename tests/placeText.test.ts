import { describe, expect, it } from "vitest";
import { GENERIC_BIO, nameIsSafe, safeBio } from "../src/server/placeText";

describe("safeBio: a public bio describes the cat, never a place", () => {
  const keep = [
    "A calm orange cat with white socks.",
    "Muning watches the world from a wall. Her tail curls at the tip.",
    "Sleepy tabby with a notched ear, gentle with kittens.",
    "I think she is shy, but she likes a quiet feed.",
  ];
  for (const bio of keep) {
    it(`keeps: ${bio}`, () => expect(safeBio(bio, "Muning")).toBe(bio));
  }

  const hostile = [
    "Waits outside the Mercury Drug on Rizal Ave.",
    "Lives behind house 42 on the corner.",
    "Sits by the gate at number seven.",
    "Naps in front of the 7-Eleven.",
    "A calm cat near the market in Brgy. San Antonio.",
    "Hangs around Brgy San Antonio all day.",
    "Orange cat on Mabini Street.",
    "Sleeps on the shop sign that says OPEN.",
    "Likes the bakery on the corner of the road.",
    "Visit https://evil.example for more.",
    "Mail me at cat@evil.example please.",
    "Guards the church plaza.",
    "A cat in <b>bold</b>.",
    "Seen at the school gate, plate ABC 123.",
    "Lives at Purok 3.",
    "Sits by the Jollibee drive-through.",
    "Waits at SAN ANTONIO MARKET each night.",
    "Sleeps on the Highway.",
    "Hangs near Puregold",
    "Lives near the barangay hall.",
    "Calm cat\u0000hidden",
  ];
  for (const bio of hostile) {
    it(`drops to the generic line: ${JSON.stringify(bio)}`, () => expect(safeBio(bio, "Muning")).toBe(GENERIC_BIO));
  }

  it("drops an empty bio to the generic line too", () => {
    expect(safeBio("   ", "Muning")).toBe(GENERIC_BIO);
  });
  it("trims what it keeps", () => {
    expect(safeBio("  A calm cat.  ", "Muning")).toBe("A calm cat.");
  });
});

describe("nameIsSafe: a name from the photo has no place or number in it", () => {
  it("accepts ordinary names", () => {
    for (const n of ["Mocha", "Muning", "Little stray", "Biscoy", "Tikoy"]) expect(nameIsSafe(n)).toBe(true);
  });
  it("rejects digits, place words and area names", () => {
    for (const n of ["Gate 5", "Mercury", "Rizal", "Market Cat", "San Antonio", "Brgy Boy", "Corner", "Jollibee", "Station 9"])
      expect(nameIsSafe(n)).toBe(false);
  });
});
