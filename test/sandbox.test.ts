import { describe, expect, it } from "vitest";
import { runtimeHelp, runtimeProblem, sandboxArgs } from "../src/sandbox.js";

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

describe("the sandbox user", () => {
  const run = { image: "img", script: "true", env: {}, mounts: [], memoryMb: 64, deadlineMs: 1000 };

  it("is the host user on POSIX", () => {
    if (!process.getuid || !process.getgid) return;
    expect(sandboxArgs(run, "codemm-x").join(" ")).toContain(`--user ${process.getuid()}:${process.getgid()}`);
  });

  it("is still unprivileged where the host has no uid (Windows)", () => {
    const { getuid, getgid } = process;
    Object.assign(process, { getuid: undefined, getgid: undefined });
    try {
      expect(sandboxArgs(run, "codemm-x").join(" ")).toContain("--user 65534:65534");
    } finally {
      Object.assign(process, { getuid, getgid });
    }
  });
});

describe("runtime guidance", () => {
  it.each([
    ["darwin", /Docker Desktop for Mac/],
    ["win32", /Docker Desktop for Windows.*WSL 2.*Linux containers/s],
    ["linux", /Docker Engine.*Podman/s],
  ] as const)("names the right runtime on %s", (platform, text) => {
    expect(runtimeHelp(platform)).toMatch(text);
  });

  it("accepts a running Linux engine", () => {
    expect(runtimeProblem({ exit: 0, output: "27.4.0|linux\n" })).toBeUndefined();
  });

  it("reports a stopped daemon, even though docker info exits 0 then", () => {
    const output = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n|\n";
    expect(runtimeProblem({ exit: 0, output }, "linux")).toBe(`The container runtime isn't running. ${runtimeHelp("linux")}`);
    expect(runtimeProblem({ exit: 1, output: "" }, "darwin")).toMatch(/isn't running.*Docker Desktop for Mac/);
  });

  it("asks for Linux containers when Docker runs Windows containers", () => {
    expect(runtimeProblem({ exit: 0, output: "27.4.0|windows\n" })).toMatch(/Switch Docker Desktop to Linux containers/);
  });
});
