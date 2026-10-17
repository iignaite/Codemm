import { describe, expect, it } from "vitest";
import { sandboxArgs } from "../src/sandbox.js";

describe("sandboxArgs", () => {
  const args = sandboxArgs(
    { image: "img", script: "echo hi", env: { A: "1" }, mounts: [{ host: "/h/src", container: "/work/src" }], memoryMb: 128, deadlineMs: 1000 },
    "codemm-x",
    "501:20",
  );
  const joined = args.join(" ");

  it.each([
    "--network none",
    "--read-only",
    "--tmpfs /tmp:rw,exec,nosuid,nodev,size=256m",
    "--memory 128m --memory-swap 128m",
    "--cpus 2 --pids-limit 256",
    "--security-opt no-new-privileges --cap-drop ALL",
    "--no-healthcheck --log-opt max-size=1m",
    "--entrypoint /bin/sh",
    "--user 501:20",
    "--label codemm=1",
    "-e HOME=/tmp",
  ])("always includes %s", (flag) => {
    expect(joined).toContain(flag);
  });

  it("mounts inputs read-only and passes the script last", () => {
    expect(args).toContain("type=bind,source=/h/src,target=/work/src,readonly");
    expect(args.slice(-3)).toEqual(["img", "-c", "echo hi"]);
  });
});
