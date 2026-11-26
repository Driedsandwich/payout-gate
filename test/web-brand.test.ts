import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { TAGLINE } from "../web/brand.js";

it("includes the replay title and brand tagline in the static HTML", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  expect(html).toContain("<title>Headgate · concurrent payout gate replay</title>");
  expect(html).toContain(`<meta name="description" content="${TAGLINE}">`);
});
