#!/usr/bin/env python3
"""Start `next dev` (port 3001) with .env exported literally (never source)."""
import os

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
env["PORT"] = "3001"
os.chdir("/home/hatch/workspace/marketr")
os.execvpe("npx", ["npx", "next", "dev", "-p", "3001"], env)
