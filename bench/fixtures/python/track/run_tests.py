import json
import os
import sys

TESTS = os.environ.get("TESTS", "/work/tests")
OUT = os.environ.get("OUT", "/tmp/report.json")
SRC = os.getcwd()

results = {}
order = []


def trim(text, limit=2000):
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "\n...(truncated)"


def add(name, status, msg):
    if name not in results:
        order.append(name)
        results[name] = {"name": name, "status": status, "message": msg}
    else:
        r = results[name]
        if r["status"] == "pass" and status != "pass":
            r["status"] = status
            r["message"] = msg


class Plugin:
    def pytest_runtest_logreport(self, report):
        name = report.nodeid
        if report.when == "call":
            if report.passed:
                add(name, "pass", "")
            elif report.failed:
                add(name, "fail", trim(report.longreprtext))
            else:
                add(name, "error", "skipped")
        else:
            if report.failed:
                add(name, "error", trim(report.longreprtext))
            elif report.skipped and report.when == "setup":
                add(name, "error", "skipped")

    def pytest_collectreport(self, report):
        if report.failed:
            add(report.nodeid or "collection", "error", trim(report.longreprtext))


def write():
    with open(OUT, "w") as f:
        json.dump({"tests": [results[n] for n in order]}, f)


def main():
    sys.path.insert(0, SRC)
    try:
        import pytest
        code = pytest.main([
            TESTS,
            "--rootdir=" + TESTS,
            "-p", "no:cacheprovider",
            "-q",
            "--no-header",
            "-o", "console_output_style=classic",
        ], plugins=[Plugin()])
        if not order and int(code) not in (0, 5):
            add("pytest", "error", "pytest exited with code %s" % int(code))
    except BaseException as e:  # noqa
        add("runner", "error", trim(repr(e)))
    write()
    return 0


if __name__ == "__main__":
    sys.exit(main())
