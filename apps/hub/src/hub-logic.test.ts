import { describe, expect, it } from "vitest";
import { outputs, seats, shareOrigin, spacedCode, stations, type HubEntry } from "./hub-logic.ts";

const e = (id: string, role: string): HubEntry => ({ label: id, id, role, path: `/${id}?t=x` });

describe("hub logic", () => {
  it("orders workstations and splits outputs / seats", () => {
    const all = [e("studio", "studio"), e("out-program", "output"), e("control", "control"), e("seat-1", "seat"), e("host", "host")];
    expect(stations(all).map((s) => s.name)).toEqual(["Régie", "Animateur", "Studio"]);
    expect(outputs(all).map((x) => x.id)).toEqual(["out-program"]);
    expect(seats(all).map((x) => x.id)).toEqual(["seat-1"]);
  });

  it("links for other machines never point to localhost", () => {
    expect(shareOrigin("http://localhost:7300", ["http://192.168.1.17:7300"])).toBe("http://192.168.1.17:7300");
    expect(shareOrigin("http://127.0.0.1:7300", [])).toBe("http://127.0.0.1:7300");
    expect(shareOrigin("http://10.0.0.5:7300", ["http://192.168.1.17:7300"])).toBe("http://10.0.0.5:7300");
  });

  it("spaces codes for reading out loud", () => {
    expect(spacedCode("123456")).toBe("123 456");
    expect(spacedCode("12345678")).toBe("123 456 78");
    expect(spacedCode("ABCD2345")).toBe("ABCD 2345");
  });
});
