import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { networkIsolation } from "../src/doctor.js";
import { infraKind } from "../src/sandbox.js";
import { posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";

/**
 * The self-test (`codemm doctor`, Check this computer) against a scripted container CLI. It must fail the way a
 * real check would: an engine that can't mount Codemm's folders fails it, and a pull that can't reach the network
 * says it's offline (`kind`, which a caller acts on without reading the words).
 */

// Answers only what the self-test sends, with Docker 27's wording. PULL_ERROR makes the pull fail with that text;
// MOUNT is ok (the container reads the mounted file), refuse (the engine won't mount it) or empty (it mounts a
// folder with nothing in it, as a VM that doesn't share the path can). Every call is logged.
const SCRIPT = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
  image) [ "$HAVE_IMAGE" = 1 ] && exit 0; echo "Error response from daemon: No such image: alpine:3.20" >&2; exit 1 ;;
  pull)
    echo "3.20@sha256:d9e8: Pulling from library/alpine"
    if [ -n "$PULL_ERROR" ]; then echo "$PULL_ERROR" >&2; exit 1; fi
    exit 0 ;;
  inspect) echo "172.17.0.2" ;;
  rm) exit 0 ;;
  run)
    case " $* " in *" -d "*) echo "cafebabe"; exit 0 ;; esac
    case " $* " in *" --network none "*) ;; *) echo pong; exit 0 ;; esac
    src=""
    for a; do case "$a" in type=bind,source=*) src="\${a#type=bind,source=}"; src="\${src%%,target=*}" ;; esac; done
    if [ -z "$src" ]; then
      case "$ISOLATION" in
        fail) echo "docker: Error response from daemon: failed to create task for container" >&2; exit 125 ;;
        reached) printf pong; echo reached; exit 0 ;;
        *) echo blocked; exit 0 ;;
      esac
    fi
    case "$MOUNT" in
      refuse) echo "docker: Error response from daemon: Mounts denied: The path $src is not shared from the host and is not known to Docker." >&2; exit 125 ;;
      empty) exit 0 ;;
      *) cat "$src"/probe.txt ;;
    esac ;;
esac
exit 0
`;

let log: string;
let home: string;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

beforeEach(() => {
  const dir = tempDir("codemm-fakecli-");
  const cli = join(dir, "docker");
  writeFileSync(cli, SCRIPT);
  chmodSync(cli, 0o755);
  log = join(dir, "calls.log");
  home = tempDir("codemm-home-");
  vi.stubEnv("CODEMM_CONTAINER_CLI", cli);
  vi.stubEnv("CODEMM_HOME", home);
  vi.stubEnv("FAKE_LOG", log);
  vi.stubEnv("HAVE_IMAGE", "1");
  vi.stubEnv("MOUNT", "ok");
  vi.stubEnv("ISOLATION", "blocked");
  vi.stubEnv("PULL_ERROR", "");
});
afterEach(() => vi.unstubAllEnvs());

describe.runIf(posix)("the self-test (network isolation)", () => {
  it("mounts a staged folder read-only, the way a check does, reads a file from it and removes the folder", async () => {
    expect(await networkIsolation()).toMatchObject({ ok: true });
    const mounts = calls().flatMap((c) => c.split(" ").filter((a) => a.startsWith("type=bind")));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(/^type=bind,source=.*,target=\/work\/src,readonly$/);
    const source = mounts[0]!.slice("type=bind,source=".length, mounts[0]!.indexOf(",target="));
    expect(source.startsWith(join(realpathSync.native(home), "runs"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readdirSync(join(realpathSync.native(home), "runs"))).toEqual([]);
  });

  it("fails with the engine's reason and the folder to share when it won't mount Codemm's folders", async () => {
    vi.stubEnv("MOUNT", "refuse");
    const check = await networkIsolation();
    expect(check).toMatchObject({ ok: false, kind: "docker" });
    expect(check.detail).toContain("Mounts denied");
    expect(check.detail).toContain(realpathSync.native(home));
    expect(check.detail).toMatch(/share/i);
    // It stops there: no test server is started for an engine that couldn't run a check anyway.
    expect(calls().some((c) => c.startsWith("run -d"))).toBe(false);
    expect(readdirSync(join(realpathSync.native(home), "runs"))).toEqual([]);
  });

  it("fails when the engine mounts a folder but the container sees nothing in it", async () => {
    vi.stubEnv("MOUNT", "empty");
    const check = await networkIsolation();
    expect(check).toMatchObject({ ok: false, kind: "docker" });
    expect(check.detail).toMatch(/empty|nothing/i);
    expect(check.detail).toContain(realpathSync.native(home));
  });

  it("calls a sandbox that reached the server a failure, and one that never ran inconclusive, not an alarm", async () => {
    vi.stubEnv("ISOLATION", "reached");
    expect(await networkIsolation()).toEqual({ name: "network isolation", ok: false, detail: "the sandbox reached the network" });
    vi.stubEnv("ISOLATION", "fail");
    const check = await networkIsolation();
    expect(check).toMatchObject({ ok: false, kind: "docker" });
    expect(check.detail).toMatch(/^inconclusive: .*didn't run/);
    expect(check.detail).toContain("failed to create task for container");
    expect(check.detail).not.toContain("reached the network");
  });

  it("fails the check, not the whole doctor, when Codemm's home can't hold a run folder", async () => {
    const file = join(tempDir("codemm-notadir-"), "file");
    writeFileSync(file, "x");
    vi.stubEnv("CODEMM_HOME", join(file, "home"));
    const check = await networkIsolation();
    expect(check).toMatchObject({ ok: false });
    expect(check.detail).toMatch(/couldn't make a folder/);
    expect(calls().some((c) => c.startsWith("run "))).toBe(false);
  });

  it("pulls the test image when it isn't there, and not when it is", async () => {
    expect(await networkIsolation()).toMatchObject({ ok: true });
    expect(calls().some((c) => c.startsWith("pull "))).toBe(false);
    writeFileSync(log, "");
    vi.stubEnv("HAVE_IMAGE", "0");
    expect(await networkIsolation()).toMatchObject({ ok: true });
    expect(calls().filter((c) => c.startsWith("pull "))).toHaveLength(1);
  });

  describe("a pull that fails", () => {
    const offline = [
      ["DNS", 'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 192.168.65.7:53: no such host'],
      ["a blocked connection", 'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp 104.18.121.25:443: i/o timeout'],
      ["a slow one", 'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout'],
      ["a proxy", 'Error response from daemon: Get "https://registry-1.docker.io/v2/": proxyconnect tcp: dial tcp 10.0.0.1:3128: connect: connection refused'],
      ["the containerd store", 'failed to resolve reference "docker.io/library/alpine:3.20": failed to do request: Head "https://registry-1.docker.io/v2/library/alpine/manifests/3.20": dial tcp: lookup registry-1.docker.io: server misbehaving'],
      ["Podman", 'Error: initializing source docker://alpine:3.20: pinging container registry registry-1.docker.io: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host'],
      ["a network that is down", "Error response from daemon: Get \"https://registry-1.docker.io/v2/\": dial tcp 104.18.121.25:443: connect: network is unreachable"],
    ] as const;

    for (const [why, error] of offline) {
      it(`reports ${why} as offline, with the engine's words`, async () => {
        vi.stubEnv("HAVE_IMAGE", "0");
        vi.stubEnv("PULL_ERROR", error);
        const check = await networkIsolation();
        expect(check).toMatchObject({ ok: false, kind: "offline" });
        expect(check.detail).not.toMatch(/inconclusive/i);
        expect(check.detail).toMatch(/couldn't reach the network/);
        // The same words the desktop's text classification reads as offline.
        expect(infraKind(check.detail)).toBe("offline");
        // Nothing past the pull ran.
        expect(calls().some((c) => c.startsWith("run "))).toBe(false);
      });
    }

    it("says Docker Hub's limit was reached, still offline for the app, with what to do", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", "Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit");
      const check = await networkIsolation();
      expect(check).toMatchObject({ ok: false, kind: "offline" });
      expect(check.detail).toMatch(/Docker Hub's download limit/);
      expect(check.detail).toMatch(/sign in to Docker Hub/);
    });

    it("says a proxy or firewall is intercepting HTTPS when the certificate isn't trusted", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", 'Error response from daemon: Get "https://registry-1.docker.io/v2/": tls: failed to verify certificate: x509: certificate signed by unknown authority');
      const check = await networkIsolation();
      expect(check).toMatchObject({ ok: false, kind: "offline" });
      expect(check.detail).toMatch(/intercepting/);
      expect(check.detail).toContain("x509");
    });

    it("says Docker's sign-in helper failed, as Docker's own problem", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", "Error response from daemon: error getting credentials - err: exit status 1, out: ``");
      const check = await networkIsolation();
      expect(check).toMatchObject({ ok: false, kind: "docker" });
      expect(check.detail).toMatch(/sign-in helper/);
      expect(check.detail).toContain("error getting credentials");
      expect(check.detail).not.toMatch(/^inconclusive/);
    });

    it("doesn't call a stopped Podman machine offline, though it refuses connections", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", "Cannot connect to Podman. Please verify your connection to the Linux system: dial tcp 127.0.0.1:50128: connect: connection refused");
      const check = await networkIsolation();
      expect(check).toMatchObject({ ok: false, kind: "docker" });
      expect(check.detail).toMatch(/^inconclusive: the container engine isn't answering/);
    });

    it("doesn't call Codemm's own deadline offline: a slow connection and a stuck engine look alike", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", "(timed out after 180000 ms)");
      const check = await networkIsolation();
      expect(check).toMatchObject({ ok: false, kind: "docker" });
      expect(check.detail).toMatch(/^inconclusive: Docker took more than 3 minutes/);
    });

    it("is a disk problem when Docker is out of space", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", "failed to register layer: write /var/lib/docker/tmp/x: no space left on device");
      expect(await networkIsolation()).toMatchObject({ ok: false, kind: "disk" });
    });

    it("stays inconclusive, as Docker's problem, for a failure it doesn't know", async () => {
      vi.stubEnv("HAVE_IMAGE", "0");
      vi.stubEnv("PULL_ERROR", "Error response from daemon: pull access denied for alpine, repository does not exist");
      const check = await networkIsolation();
      expect(check).toMatchObject({ ok: false, kind: "docker" });
      expect(check.detail).toMatch(/^inconclusive/);
      expect(check.detail).toContain("pull access denied");
    });
  });
});
