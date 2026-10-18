import { describe, expect, it } from "vitest";
import { buildProblem, buildStep, runtimeHelp, runtimeProblem, sandboxArgs, startHelp } from "../src/sandbox.js";

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

  it.each([
    ["darwin", /Start Docker Desktop/],
    ["win32", /Start Docker Desktop/],
    ["linux", /systemctl start docker.*docker group/s],
  ] as const)("says how to start the runtime on %s", (platform, text) => {
    expect(startHelp(platform)).toMatch(text);
    expect(startHelp(platform)).not.toMatch(/install/i);
  });

  it("says to start a stopped daemon, even though docker info exits 0 then", () => {
    const output = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n|\n";
    expect(runtimeProblem({ exit: 0, output }, "linux")).toBe(`The container runtime isn't running. ${startHelp("linux")}`);
    expect(runtimeProblem({ exit: 1, output: "" }, "darwin")).toBe(`The container runtime isn't running. ${startHelp("darwin")}`);
  });

  it("says to install a configured runtime that isn't there", () => {
    expect(runtimeProblem({ exit: -1, output: "spawn podman ENOENT" }, "darwin")).toBe(`No container runtime found. ${runtimeHelp("darwin")}`);
  });

  it("asks for Linux containers when Docker runs Windows containers", () => {
    expect(runtimeProblem({ exit: 0, output: "27.4.0|windows\n" })).toMatch(/Switch Docker Desktop to Linux containers/);
  });
});

describe("buildProblem", () => {
  it.each([
    ["BuildKit", "ERROR: failed to solve: alpine:3.20: failed to resolve source metadata: dial tcp: lookup registry-1.docker.io: no such host"],
    ["apt", "W: Failed to fetch http://deb.debian.org/debian/dists/bookworm/InRelease  Temporary failure resolving 'deb.debian.org'"],
    ["pip", "Failed to establish a new connection: [Errno -3] Temporary failure in name resolution"],
    ["npm", "npm error request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org"],
    ["curl", "curl: (6) Could not resolve host: example.com"],
    ["a dropped route", "dial tcp 104.18.1.1:443: connect: network is unreachable"],
  ])("blames the network, not the track, for %s offline output", (_, line) => {
    const problem = buildProblem(`#5 [2/3] RUN install\n${line}\n#5 ERROR: process did not complete successfully`);
    expect(problem?.kind).toBe("offline");
    expect(problem?.message).toMatch(/couldn't reach the network.*not a problem with the track files/s);
    expect(problem?.message).toContain(line.trim());
  });

  it("blames the disk, not the track, when Docker runs out of space", () => {
    expect(buildProblem("ERROR: failed to solve: write /var/lib/docker/tmp/x: no space left on device")).toEqual({
      kind: "disk", message: expect.stringMatching(/ran out of disk space.*not a problem with the track files/s),
    });
  });

  it.each([
    "/bin/sh: 1: gcc: not found\nERROR: process did not complete successfully: exit code: 127",
    "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve",
    '✘ [ERROR] Could not resolve "./missing-module"',
  ])("leaves ordinary build failures to the track: %s", (log) => {
    expect(buildProblem(log)).toBeUndefined();
  });
});

describe("buildStep", () => {
  it("reads BuildKit's step counts, multi-stage ones included", () => {
    expect(buildStep("#5 [2/7] RUN npm ci")).toEqual({ done: 2, total: 7 });
    expect(buildStep("#7 [builder 3/4] COPY . .")).toEqual({ done: 3, total: 4 });
  });

  it("reads BuildKit's padded counters, for builds of 10 steps or more", () => {
    expect(buildStep("#5 [ 2/10] RUN npm ci")).toEqual({ done: 2, total: 10 });
    expect(buildStep("#5 [builder  2/10] RUN npm ci")).toEqual({ done: 2, total: 10 });
  });

  it("reads the legacy builder's and Podman's step counts", () => {
    expect(buildStep("Step 3/7 : RUN apk add bash")).toEqual({ done: 3, total: 7 });
    expect(buildStep("STEP 1/2: FROM alpine:3.20")).toEqual({ done: 1, total: 2 });
    // Podman (Buildah) names the stage in a multi-stage build.
    expect(buildStep("[2/2] STEP 3/4: COPY --from=builder /out /app")).toEqual({ done: 3, total: 4 });
  });

  it("reads nothing else: internal steps, logs and nonsense counts", () => {
    for (const line of ["#1 [internal] load build definition from Dockerfile", "#5 0.312 added 12 packages", "#6 CACHED", "#5 [0/7] RUN x", "#5 [8/7] RUN x", "[2/7] not at the start"]) {
      expect(buildStep(line)).toBeUndefined();
    }
  });
});
