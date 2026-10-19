import { describe, expect, it } from "vitest";
import { GateError } from "../src/gates.js";
import { baseImages, buildProblem, buildStep, inspectRecord, runtimeCode, runtimeDown, runtimeHelp, runtimeIssue, runtimeProblem, runtimeState, runtimeStateOf, sandboxArgs, startHelp, startRefusal } from "../src/sandbox.js";

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
  it("reads a network line as the network, even when it also names Codemm's disk wording", () => {
    expect(buildProblem("not enough disk space; could not resolve host example.test")).toMatchObject({ kind: "offline", code: "offline" });
  });

  it("leaves a certificate that expired, or names another host, to the track: that's the server's, not interception", () => {
    expect(buildProblem("ERROR: failed to solve: tls: failed to verify certificate: x509: certificate has expired or is not yet valid")).toBeUndefined();
    expect(buildProblem("curl: (60) SSL: no alternative certificate subject name matches target host name 'mirror.example'")).toBeUndefined();
    expect(buildProblem("x509: certificate is valid for a.example, not b.example")).toBeUndefined();
  });

  it("blames Docker's credential helper, not the track, so the agent keeps its files", () => {
    // Recorded in the macOS journey: the Docker CLI found couldn't reach Docker Desktop's credential helper.
    const log = '#2 ERROR: error getting credentials - err: exec: "docker-credential-osxkeychain": executable file not found in $PATH, out: ``';
    expect(buildProblem(`#1 [internal] load build definition\n${log}`)).toEqual({
      kind: "docker",
      code: "credentials",
      message: expect.stringMatching(/^Docker couldn't run its credential helper \(.*docker-credential-osxkeychain.*\), so nothing was installed\..*not a problem with the track files.*restarting Docker Desktop/s),
    });
  });

  it.each([
    ["Docker Hub's rate limit", "rate-limit", "ERROR: failed to solve: node:22: failed to copy: httpReadSeeker: failed open: unexpected status code 429 Too Many Requests - Server message: toomanyrequests: You have reached your pull rate limit.", /^The track build hit Docker Hub's pull rate limit \(.*\), so nothing was installed\. .*sign in to Docker Desktop/s],
    ["an intercepted certificate (Go)", "tls", "ERROR: failed to solve: alpine:3.20: failed to do request: Head \"https://registry-1.docker.io/v2/\": tls: failed to verify certificate: x509: certificate signed by unknown authority", /^The track build couldn't verify a server's certificate \(.*\), so nothing was installed\. A VPN, proxy or security software/s],
    ["an intercepted certificate (pip)", "tls", "Could not fetch URL https://pypi.org/simple/pip/: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate", /^The track build couldn't verify a server's certificate/],
    ["an intercepted certificate (npm)", "tls", "npm error code SELF_SIGNED_CERT_IN_CHAIN\nnpm error request to https://registry.npmjs.org/x failed, reason: self-signed certificate in certificate chain", /^The track build couldn't verify a server's certificate/],
    ["an i/o timeout", "network-timeout", "ERROR: failed to solve: DeadlineExceeded: failed to fetch oauth token: Post \"https://auth.docker.io/token\": dial tcp 3.94.224.37:443: i/o timeout", /^The track build's connection timed out or dropped \(.*\), so nothing was installed\. .*VPN, proxy or firewall/s],
    ["a TLS handshake timeout", "network-timeout", "ERROR: failed to solve: python:3.13: failed to resolve source metadata: Get \"https://registry-1.docker.io/v2/\": net/http: TLS handshake timeout", /^The track build's connection timed out or dropped/],
    ["a cancelled request", "network-timeout", "Error response from daemon: Get \"https://registry-1.docker.io/v2/\": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)", /^The track build's connection timed out or dropped/],
    ["a pull cut short", "network-timeout", "ERROR: failed to solve: failed to copy: httpReadSeeker: failed open: failed to do request: Get \"https://production.cloudflare.docker.com/x\": unexpected EOF", /^The track build's connection timed out or dropped/],
    ["a proxy that refuses", "offline", "ERROR: failed to solve: alpine:3.20: failed to do request: Head \"https://registry-1.docker.io/v2/\": proxyconnect tcp: dial tcp 127.0.0.1:3128: connect: connection refused", /^The track build couldn't reach the network \(.*\), so nothing was installed\. .*VPN, proxy or firewall/s],
  ])("blames the network, not the track, for %s", (_, code, line, message) => {
    const problem = buildProblem(`#5 [2/3] RUN install\n${line}\n#5 ERROR: process did not complete successfully`);
    expect(problem).toEqual({ kind: "offline", code, message: expect.stringMatching(message) });
    expect(problem!.message).toMatch(/not a problem with the track files/);
  });

  it("leaves an unexpected EOF that isn't a download to the track: a compiler says it about a broken file", () => {
    expect(buildProblem("#7 1.204 ./main.go:9:1: syntax error: unexpected EOF, expected }\nERROR: process did not complete successfully: exit code: 1")).toBeUndefined();
  });

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
      kind: "disk", code: "docker-disk", message: expect.stringMatching(/ran out of disk space.*not a problem with the track files.*larger disk/s),
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

describe("runtimeCode", () => {
  it("reads a runtime's own failure as Docker's disk or the network when it says so, and as the given code otherwise", () => {
    expect(runtimeCode("docker: Error response from daemon: write /var/lib/docker/x: no space left on device.", "container-list")).toBe("docker-disk");
    expect(runtimeCode("docker: Error response from daemon: dial tcp: network is unreachable.", "container-list")).toBe("offline");
    expect(runtimeCode("Error: could not resolve host registry-1.docker.io", "image-inspect")).toBe("offline");
    expect(runtimeCode("docker: Error response from daemon: Conflict.", "image-inspect")).toBe("image-inspect");
    // Docker 29 leaves Config.Volumes out, and an inspect template that reads it fails: Docker answers, so it's no stopped runtime.
    expect(runtimeCode('template: :1:12: executing "" at <.Config.Volumes>: map has no entry for key "Volumes"', "image-inspect")).toBe("image-inspect");
  });
});

describe("runtimeState and runtimeDown", () => {
  const ready = { exit: 0, output: "27.4.0|linux\n" };
  const down = (output: string) => ({ exit: 0, output: `${output}\n|\n` });

  it("asks a silent engine once more, for longer, then calls it busy, never stopped", async () => {
    const asked: number[] = [];
    expect(await runtimeState(async (ms) => (asked.push(ms), null))).toBe("busy");
    expect(asked).toEqual([20_000, 60_000]);
    const busy = await runtimeDown(async () => null);
    expect(busy).toEqual({ code: "runtime-busy", message: expect.stringMatching(/^The container runtime isn't answering\. It may be busy.*wait a minute, then retry/s), help: expect.any(String) });
    expect(busy!.message).not.toMatch(/isn't running/);
  });

  it("takes the second answer of an engine that was slow to wake", async () => {
    const answers = [null, ready];
    expect(await runtimeState(async () => answers.shift()!)).toBe("ready");
  });

  it("asks again, a moment later, an engine that answers it isn't ready: Docker Desktop does while it resumes", async () => {
    const settling = [down("request returned Internal Server Error for API route and version http://%2Fdocker.sock/v1.47/info"), down("error during connect: Get \"http://docker/v1.47/info\": EOF")];
    const asked: number[] = [];
    expect(await runtimeState(async (ms) => (asked.push(ms), settling.shift() ?? ready), 0)).toBe("busy");
    expect(asked).toEqual([20_000, 60_000]);
    const answers = [settling[0] ?? down("Internal Server Error"), ready];
    expect(await runtimeState(async () => answers.shift()!, 0)).toBe("ready");
  });

  it("asks once when the engine answers, even to say it's down", async () => {
    const asked: number[] = [];
    expect(await runtimeState(async (ms) => (asked.push(ms), { exit: 1, output: "Cannot connect to the Docker daemon" }))).toBe("down");
    expect(asked).toEqual([20_000]);
    expect(await runtimeDown(async () => ready)).toBeUndefined();
  });

  it.each([
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", "runtime-down", /^The container runtime isn't running\. Start Docker Desktop/],
    ["Cannot connect to the Docker daemon at unix:///Users/me/.docker/run/docker.sock. Is the docker daemon running?", "runtime-down", /^The container runtime isn't running\./],
    ["Error response from daemon: Docker Desktop is manually paused. Unpause it through the Whale menu.", "runtime-paused", /^Docker Desktop is paused\. Unpause Docker Desktop/],
    ["permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock", "socket-permission", /docker group/],
    ["Cannot connect to the Docker daemon at unix:///Users/me/.colima/default/docker.sock. Is the docker daemon running?", "runtime-context", /current context points at unix:\/\/\/Users\/me\/\.colima\/default\/docker\.sock.*docker context use/s],
    ['context "orbstack": context not found: open /Users/me/.docker/contexts/meta/x/meta.json: no such file or directory', "runtime-context", /current context doesn't exist/],
  ] as const)("names why a runtime that answered isn't running: %s", (output, code, message) => {
    expect(runtimeIssue(down(output), "darwin")).toEqual({ code, message: expect.stringMatching(message), help: expect.any(String) });
  });

  it("codes every other state", () => {
    expect(runtimeIssue({ exit: -1, output: "spawn docker ENOENT" })?.code).toBe("no-runtime");
    expect(runtimeIssue({ exit: 0, output: "27.4.0|windows\n" })?.code).toBe("windows-containers");
    expect(runtimeIssue(null)?.code).toBe("runtime-busy");
  });
});

describe("runtimeStateOf", () => {
  it("reads the engine's answer as missing, down, Windows containers or ready, as the desktop's computer check shows it", () => {
    expect(runtimeStateOf({ exit: -1, output: "spawn docker ENOENT" })).toBe("missing");
    expect(runtimeStateOf({ exit: 0, output: "Cannot connect to the Docker daemon|\n" })).toBe("down");
    expect(runtimeStateOf({ exit: 1, output: "" })).toBe("down");
    expect(runtimeStateOf({ exit: 0, output: "27.4.0|windows\n" })).toBe("windows");
    expect(runtimeStateOf({ exit: 0, output: "27.4.0|linux\n" })).toBe("ready");
  });
});

describe("gate failures", () => {
  it("are the track's or the exercise's, whatever their details or output say", () => {
    // This computer's problems throw with their own code instead (buildProblem, the judge).
    for (const said of ["01: error (write: no space left on device)", "failed to create container runtime task", "Cannot connect to the Docker daemon", "could not resolve host: deb.debian.org"]) {
      expect(new GateError("probe pass", `the io pass probe should pass every test:\n  ${said}`, `\nIt printed:\n${said}`)).toMatchObject({ kind: undefined, code: undefined });
    }
  });
});

describe("startRefusal", () => {
  it.each([
    ["Error response from daemon: Range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs available", "docker-cpus", /fewer than the 2 CPUs/],
    ["Error response from daemon: failed to create task: unknown log opt 'max-size' for journald log driver", "docker-log-driver", /logging driver/],
    ["docker: Error response from daemon: Mounts denied: The path /var/folders/x is not shared from the host and is not known to Docker.", "docker-file-sharing", /file sharing/],
    ["docker: Error response from daemon: write /var/lib/docker/x: no space left on device.", "docker-disk", /^Docker ran out of disk space$/],
    ["docker: Error response from daemon: OCI runtime create failed: CANARY-SECRET", "container-start", /^the runtime refused it$/],
  ] as const)("names why the runtime refused a container in its own fixed words: %s", (stderr, code, why) => {
    const refusal = startRefusal(stderr);
    expect(refusal).toEqual({ code, why: expect.stringMatching(why) });
    expect(refusal.why).not.toMatch(/CANARY|var\/folders/);
  });
});

describe("inspectRecord", () => {
  it("reads Docker's and newer Podman's one-line record, among warnings", () => {
    expect(inspectRecord('WARNING: something\n{"Id":"sha256:a","Config":{}}\n')).toEqual({ Id: "sha256:a", Config: {} });
  });

  it("reads Podman 4.3's indented array of records", () => {
    const podman43 = JSON.stringify([{ Id: "sha256:b", Config: { Volumes: { "/data": {} } } }], null, 4);
    expect(inspectRecord(podman43)).toEqual({ Id: "sha256:b", Config: { Volumes: { "/data": {} } } });
  });

  it("gives nothing for output that holds no record", () => {
    expect(inspectRecord("template parsing error: map has no entry for key")).toBeUndefined();
    expect(inspectRecord("")).toBeUndefined();
  });
});

describe("baseImages", () => {
  it("lists the images a Dockerfile builds from, skipping stages, scratch and build arguments", () => {
    const dockerfile = [
      "# syntax=docker/dockerfile:1",
      "ARG BASE=alpine:3.20",
      "FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS build",
      "RUN mvn -q package",
      "from eclipse-temurin:21-jre",
      "COPY --from=build /app /app",
      "FROM build AS test",
      "FROM scratch",
      "FROM ${BASE}",
      "FROM eclipse-temurin:21-jre",
      "RUN <<EOF",
      "from redis import Redis",
      "FROM python:3.12",
      "EOF",
      "RUN cat <<< \"here-string\" && echo $((1 << 3))",
      "FROM golang:1.22",
      "RUN echo \\",
      "  FROM node:22",
    ].join("\n");
    expect(baseImages(dockerfile)).toEqual(["maven:3.9-eclipse-temurin-21", "eclipse-temurin:21-jre", "golang:1.22"]);
  });
});
