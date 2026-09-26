#!/usr/bin/env python3
"""Start the Marketr standalone preview server with .env exported literally
(never `source` — values contain $/backticks). Re-exec as node."""
import os, sys

env = dict(os.environ)
with open("/home/hatch/workspace/marketr/.env") as f:
    for line in f:
        line = line.rstrip("\n")
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        env[k] = v
env["HOSTNAME"] = "0.0.0.0"
env["PORT"] = "3000"
os.execvpe("node", ["node", "/home/hatch/workspace/marketr/.next/standalone/server.js"], env)
