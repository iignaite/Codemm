import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as app from "../../src/app.js";
import { cli } from "../../src/sandbox.js";
import { dockerUp, fixtureTrack } from "./helpers.js";
import { tempDir } from "../temp.js";

/** Two Codemm homes on one Docker, both installing the same id@version with different files. */
describe.runIf(dockerUp)("two Codemm homes (Docker)", () => {
  const images: string[] = [];
  afterAll(async () => {
    for (const image of images) await cli(["image", "rm", "-f", image]);
  });

  const install = async (home: string, label: string) => {
    process.env.CODEMM_HOME = home;
    const t = fixtureTrack("shell-io").files;
    const files = { ...t, "track.yaml": t["track.yaml"]!.replace("id: shell-io", "id: shell-homes"), Dockerfile: `${t.Dockerfile}LABEL codemm.test=${label}\n` };
    await app.saveTrack(files);
    const record = JSON.parse(readFileSync(join(home, "tracks", "shell-homes@1", "track.json"), "utf8"));
    images.push(record.imageId);
    return record as { image: string; imageId: string };
  };

  it("keep their own tags, so neither home's image is left untagged by the other", async () => {
    const a = await install(tempDir("codemm-home-"), "home-a");
    const b = await install(tempDir("codemm-home-"), "home-b");
    expect(a.image).not.toBe(b.image);
    expect(a.imageId).not.toBe(b.imageId);
    const tagged = async (tag: string) => (await cli(["image", "inspect", "--format", "{{.Id}}", tag])).output.trim();
    expect(await tagged(a.image)).toBe(a.imageId);
    expect(await tagged(b.image)).toBe(b.imageId);
  });
});
