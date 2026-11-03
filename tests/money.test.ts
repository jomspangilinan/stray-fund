import { describe, expect, it } from "vitest";
import { formatPeso, fromPayPalValue, parsePesoInput, toPayPalValue } from "../src/lib/money";

describe("money", () => {
  it("parses PayPal values to centavos", () => {
    expect(fromPayPalValue("1500.50")).toBe(150050);
    expect(fromPayPalValue("1500")).toBe(150000);
    expect(fromPayPalValue("1500.5")).toBe(150050);
    expect(fromPayPalValue("0.01")).toBe(1);
  });

  it("rejects malformed PayPal values", () => {
    for (const bad of ["1.234", "", "abc", "-1.00", "1,500.00", " 1", "1e3", "NaN"]) {
      expect(() => fromPayPalValue(bad)).toThrow();
    }
  });

  it("formats centavos as PayPal values", () => {
    expect(toPayPalValue(150050)).toBe("1500.50");
    expect(toPayPalValue(0)).toBe("0.00");
    expect(toPayPalValue(5)).toBe("0.05");
    expect(toPayPalValue(150000)).toBe("1500.00");
  });

  it("rejects invalid centavo amounts", () => {
    for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => toPayPalValue(bad)).toThrow();
    }
  });

  it("formats pesos", () => {
    expect(formatPeso(150000)).toBe("₱1,500.00");
    expect(formatPeso(5)).toBe("₱0.05");
    expect(formatPeso(-150000)).toBe("-₱1,500.00");
    expect(formatPeso(123456789)).toBe("₱1,234,567.89");
  });
});

describe("parsePesoInput", () => {
  it("parses whole and decimal pesos to centavos", () => {
    expect(parsePesoInput("500")).toBe(50_000);
    expect(parsePesoInput("1,500")).toBe(150_000);
    expect(parsePesoInput("99.5")).toBe(9_950);
    expect(parsePesoInput(" 100.25 ")).toBe(10_025);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1e3", "12345678"]) {
      expect(parsePesoInput(bad)).toBeNull();
    }
  });
});
