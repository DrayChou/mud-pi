import { describe, expect, test } from "bun:test";
import { encodeGmcp, TelnetDecoder } from "./telnet.ts";

const IAC = 255;
const DO = 253;
const GMCP = 201;

describe("Telnet protocol", () => {
  test("decodes text while consuming negotiation commands across chunks", () => {
    const decoder = new TelnetDecoder();

    const first = decoder.push(Uint8Array.from([IAC, DO]));
    const second = decoder.push(Uint8Array.from([GMCP, ...new TextEncoder().encode("look\r\n")]));

    expect(first).toEqual({ text: "", commands: [] });
    expect(second.commands).toEqual([{ command: DO, option: GMCP }]);
    expect(second.text).toBe("look\r\n");
  });

  test("skips subnegotiation payload without leaking it into player input", () => {
    const decoder = new TelnetDecoder();
    const packet = Uint8Array.from([
      IAC, 250, GMCP,
      ...new TextEncoder().encode('Core.Hello {"client":"Mudlet"}'),
      IAC, 240,
      ...new TextEncoder().encode("map\n"),
    ]);

    expect(decoder.push(packet).text).toBe("map\n");
  });

  test("encodes a GMCP subnegotiation frame", () => {
    const packet = encodeGmcp("Char.Vitals", { hp: 10 });
    const prefix = [...packet.slice(0, 3)];
    const suffix = [...packet.slice(-2)];
    const body = new TextDecoder().decode(packet.slice(3, -2));

    expect(prefix).toEqual([IAC, 250, GMCP]);
    expect(suffix).toEqual([IAC, 240]);
    expect(body).toBe('Char.Vitals {"hp":10}');
  });
});
