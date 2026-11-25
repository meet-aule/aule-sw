"""aule-origin-guard.sh against a fake iptables and ip6tables that keep their
rules in a file: no firewall is touched."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

GUARD = Path(__file__).with_name("aule-origin-guard.sh")
PORTS = ["8090", "7880", "8092"]

# Keeps the raw table's chains as lists of rules, in a JSON file named after
# the command, and logs every call. "-C" exits 1 when the rule is not there,
# as iptables does; FAIL makes every call fail, as without root.
FAKE = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state = Path(os.environ["FAKE_STATE"]) / (Path(sys.argv[0]).name + ".json")
log = Path(os.environ["FAKE_STATE"]) / "calls.log"
with log.open("a") as out:
    out.write(Path(sys.argv[0]).name + " " + " ".join(sys.argv[1:]) + "\\n")
if os.environ.get("FAKE_FAIL"):
    print("Permission denied (you must be root)", file=sys.stderr)
    sys.exit(4)
args = sys.argv[1:]
assert args[:2] == ["-t", "raw"], args
op, chain, rule = args[2], args[3], args[4:]
chains = json.loads(state.read_text()) if state.exists() else {"PREROUTING": []}
if op == "-S":
    sys.exit(0 if chain in chains else 1)
if op == "-N":
    if chain in chains:
        sys.exit(1)
    chains[chain] = []
elif op == "-A":
    chains[chain].append(rule)
elif op == "-I":
    chains[chain].insert(0, rule)
elif op == "-C":
    sys.exit(0 if rule in chains.get(chain, []) else 1)
else:
    sys.exit(2)
state.write_text(json.dumps(chains))
"""


class OriginGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        bin_dir = self.state / "bin"
        bin_dir.mkdir()
        for name in ("iptables", "ip6tables"):
            fake = bin_dir / name
            fake.write_text(FAKE)
            fake.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_STATE": str(self.state)}

    def run_guard(self, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(GUARD)], env={**self.env, **env}, capture_output=True, text=True, check=False)

    def chains(self, command: str) -> dict[str, list[list[str]]]:
        return json.loads((self.state / f"{command}.json").read_text())

    def store_chain(self, command: str, loopback: str, cloudflare: str) -> None:
        """The chain as the store's origin-firewall.sh leaves it, with its own jump for 8080."""
        (self.state / f"{command}.json").write_text(
            json.dumps(
                {
                    "PREROUTING": [["-p", "tcp", "--dport", "8080", "-j", "AULE_ORIGIN"]],
                    "AULE_ORIGIN": [
                        ["-s", loopback, "-j", "RETURN"],
                        ["-m", "set", "--match-set", cloudflare, "src", "-j", "RETURN"],
                        ["-j", "DROP"],
                    ],
                }
            )
        )

    def jumps(self, command: str) -> list[str]:
        return sorted(rule[3] for rule in self.chains(command)["PREROUTING"] if rule[-1] == "AULE_ORIGIN")

    def test_each_port_gets_one_jump_into_the_stores_chain_however_often_it_runs(self) -> None:
        self.store_chain("iptables", "127.0.0.0/8", "cf4")
        self.store_chain("ip6tables", "::1/128", "cf6")
        before = {command: self.chains(command)["AULE_ORIGIN"] for command in ("iptables", "ip6tables")}
        for _ in range(3):
            run = self.run_guard()
            self.assertEqual(run.returncode, 0, run.stderr)
        for command in ("iptables", "ip6tables"):
            self.assertEqual(self.jumps(command), sorted(["8080", *PORTS]), command)
            # The chain and its Cloudflare ranges stay as the store's script left them.
            self.assertEqual(self.chains(command)["AULE_ORIGIN"], before[command], command)
        calls = (self.state / "calls.log").read_text()
        self.assertNotIn("ipset", calls)
        self.assertEqual(calls.count(" -I PREROUTING"), 2 * len(PORTS), "inserted once each, never again")

    def test_without_the_stores_chain_only_this_machine_gets_in_until_its_script_runs(self) -> None:
        run = self.run_guard()
        self.assertEqual(run.returncode, 0, run.stderr)
        for command, loopback in (("iptables", "127.0.0.0/8"), ("ip6tables", "::1/128")):
            self.assertEqual(self.chains(command)["AULE_ORIGIN"], [["-s", loopback, "-j", "RETURN"], ["-j", "DROP"]])
            self.assertEqual(self.jumps(command), sorted(PORTS))

    def test_a_firewall_that_refuses_is_a_failure(self) -> None:
        run = self.run_guard(FAKE_FAIL="1")
        self.assertNotEqual(run.returncode, 0)
        self.assertNotIn("origin guard:", run.stdout)

    def test_the_unit_runs_it_before_docker_starts(self) -> None:
        unit = GUARD.with_name("aule-origin-guard.service").read_text()
        self.assertIn("Before=docker.service", unit)
        self.assertIn("ExecStart=/etc/aule/aule-origin-guard.sh", unit)
        self.assertIn("WantedBy=multi-user.target docker.service", unit)


if __name__ == "__main__":
    unittest.main()
