import { describe, expect, it } from "vitest";
import { parseCli } from "../src/args.js";

describe("parseCli", () => {
  it("reads commands, repeated options and --name=value", () => {
    expect(parseCli(["init", "--host", "claude", "--host=codex", "--workspace=/w"])).toEqual({
      command: "init", args: [], options: { host: ["claude", "codex"], workspace: ["/w"] },
    });
    expect(parseCli(["track", "add", "./c"]).args).toEqual(["add", "./c"]);
    expect(parseCli(["--version"]).command).toBe("version");
    expect(parseCli([]).command).toBe("help");
    expect(parseCli(["mcp", "--progress", "/tmp/job.json"]).options).toEqual({ progress: ["/tmp/job.json"] });
    expect(parseCli(["mcp", "--course", "c", "--tools", "next_step,save_exercise", "--desktop"]).options).toEqual({
      course: ["c"], tools: ["next_step,save_exercise"], desktop: ["true"],
    });
  });

  it.each([
    [["init", "--wokspace", "/w"], /Unknown option --wokspace/],
    [["init", "--workspace"], /--workspace needs a value/],
    [["init", "--workspace", "--host", "codex"], /--workspace needs a value/],
    [["init", "extra"], /init takes no arguments/],
    [["skip"], /skip needs 1 argument/],
    [["doctor", "--fix=yes"], /--fix doesn't take a value/],
    [["frobnicate"], /Unknown command/],
    [["constructor"], /Unknown command "constructor"/],
    [["toString"], /Unknown command "toString"/],
    [["--version", "--bogus"], /Unknown option --bogus/],
    [["--help", "extra"], /help takes no arguments/],
  ])("rejects %j", (argv, error) => {
    expect(() => parseCli(argv as string[])).toThrow(error);
  });
});
