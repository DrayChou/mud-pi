import { expect, test } from "bun:test";
import { loadConfig } from "../config.ts";
import { Interpreter } from "./interpreter.ts";

test("compound inspect-and-store input deterministically picks up the named room item", async () => {
  const interpreter = new Interpreter();
  await interpreter.init(loadConfig());
  expect(await interpreter.parse("地上的 码头装卸单 上面是什么，拿起来看看，然后放进背包里")).toMatchObject({
    verb: "get",
    args: { item: "码头装卸单" },
  });
});

test("common room observation phrasing never waits for the interpreter model", async () => {
  const interpreter = new Interpreter();
  await interpreter.init(loadConfig());
  expect(await interpreter.parse("看看周围")).toMatchObject({ verb: "look", confidence: 1 });
  expect(await interpreter.parse("看看附近")).toMatchObject({ verb: "look", confidence: 1 });
});

test("simple Chinese pickup phrasing remains deterministic", async () => {
  const interpreter = new Interpreter();
  await interpreter.init(loadConfig());
  expect(await interpreter.parse("捡起锈铁刀")).toMatchObject({ verb: "get", args: { item: "锈铁刀" } });
});
